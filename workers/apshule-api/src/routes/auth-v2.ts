import { Hono, type Context } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { authMiddleware, createAccessToken, hashPassword, requireRealSuperAdmin, verifyPassword } from "../auth.js";
import { readJson, requiredString, optionalString, validEmail, publicUser } from "../http.js";
import { sendEmail } from "../email.js";
import type { AppEnv, UserRecord } from "../types.js";

const auth2 = new Hono<AppEnv>();
const admin = new Hono<AppEnv>();
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newReferralCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `ASP-${Array.from(bytes, (byte) => codeAlphabet[byte % codeAlphabet.length]).join("")}`;
}

async function uniqueReferralCode(sql: ReturnType<typeof getDb>): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = newReferralCode();
    const exists = await sql`SELECT 1 FROM users WHERE upper(referral_code) = ${code} LIMIT 1`;
    if (!exists.length) return code;
  }
  throw new ApiError(503, "CODE_GENERATION_FAILED", "Could not create a unique referral code.");
}

async function issueUserToken(c: Context<AppEnv>, user: UserRecord) {
  const issued = await createAccessToken(c.env, {
    id: user.id, email: user.email, role: user.role, schoolId: user.school_id,
    sector: user.sector, sessionVersion: user.session_version ?? 0,
    mustChangePassword: user.must_change_password === true,
  });
  return c.json({ token: issued.token, user: publicUser(user as unknown as Record<string, unknown>) });
}

auth2.post("/login-school", async (c) => {
  const body = await readJson(c);
  const schoolCode = requiredString(body, "school_code", { max: 32 }).trim().toLowerCase();
  const email = requiredString(body, "email", { max: 254 }).trim().toLowerCase();
  const password = requiredString(body, "password", { max: 128 });
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT s.id AS school_id, s.login_password_hash, u.password_hash AS user_password_hash,
      u.id, u.name, u.email, u.phone,
      u.role, u.sector, u.waitlist, u.school_id AS user_school_id, u.education_level,
      u.class_level, u.subjects_taught, u.assigned_classes, u.lin, u.school_verified,
      u.address, u.profile_pic, u.session_version, u.must_change_password,
      u.subscription, u.subscription_active, u.subscription_date, u.login_count,
      u.last_login, u.detected_location, u.created_at
    FROM schools s JOIN users u ON u.school_id=s.id AND lower(u.email)=${email}
    WHERE lower(s.short_code)=${schoolCode}
      AND ((u.role='school' AND lower(s.login_email)=${email})
        OR (u.role='teacher' AND u.sector='education' AND u.is_active IS TRUE))
    LIMIT 1`;
  const row = rows[0] as (UserRecord & { login_password_hash: string; user_password_hash: string; school_id: string }) | undefined;
  const passwordHash = row?.role === "teacher" ? row.user_password_hash : row?.login_password_hash;
  if (!row || !passwordHash || !(await verifyPassword(password, passwordHash))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "School code, email, or password is incorrect.");
  }
  const updated = await sql`
    UPDATE users SET login_count=COALESCE(login_count,0)+1,last_login=NOW()
    WHERE id=${row.id}
    RETURNING id,name,email,phone,role,sector,waitlist,school_id,education_level,class_level,
      subjects_taught,assigned_classes,lin,school_verified,address,profile_pic,session_version,
      must_change_password,subscription,subscription_active,subscription_date,login_count,last_login,
      detected_location,created_at`;
  return issueUserToken(c, updated[0] as UserRecord);
});

auth2.post("/login-regno", async (c) => {
  const body = await readJson(c);
  const regNo = requiredString(body, "reg_no", { max: 80 }).trim().toLowerCase().replace(/\s+/gu, "");
  const password = requiredString(body, "password", { max: 128 });
  const roleHint = body.role_hint === "teacher" ? "teacher" : "student";
  const schoolCode = roleHint === "student"
    ? requiredString(body, "school_code", { max: 32 }).trim().toLowerCase()
    : optionalString(body, "school_code", { max: 32 })?.trim().toLowerCase() ?? "";
  if (schoolCode && !/^[a-z0-9-]{2,32}$/u.test(schoolCode)) {
    throw new ApiError(400, "VALIDATION_ERROR", "School code is invalid.");
  }
  const sql = getDb(c.env);
  let row: (UserRecord & { password_hash: string }) | undefined;
  if (roleHint === "student") {
    const rows = await sql`
      SELECT u.id,u.name,u.email,u.phone,u.password_hash,u.role,u.sector,u.waitlist,u.school_id,
        u.education_level,u.class_level,u.subjects_taught,u.assigned_classes,u.lin,u.school_verified,
        u.address,u.profile_pic,u.session_version,u.must_change_password,u.subscription,
        u.subscription_active,u.subscription_date,u.login_count,u.last_login,u.detected_location,u.created_at
      FROM learners l JOIN users u ON u.id=l.user_id JOIN schools s ON s.id=l.school_id
      WHERE lower(regexp_replace(l.reg_no, '\\s+', '', 'g'))=${regNo} AND l.active IS TRUE
        AND (${schoolCode}='' OR lower(s.short_code)=${schoolCode})
      LIMIT 2`;
    if (rows.length === 1) row = rows[0] as UserRecord & { password_hash: string };
  } else {
    const rows = await sql`
      SELECT u.id,u.name,u.email,u.phone,u.password_hash,u.role,u.sector,u.waitlist,u.school_id,
        u.education_level,u.class_level,u.subjects_taught,u.assigned_classes,u.lin,u.school_verified,
        u.address,u.profile_pic,u.session_version,u.must_change_password,u.subscription,
        u.subscription_active,u.subscription_date,u.login_count,u.last_login,u.detected_location,u.created_at
      FROM users u LEFT JOIN schools s ON s.id=u.school_id
      WHERE lower(regexp_replace(COALESCE(u.reg_no,''), '\\s+', '', 'g'))=${regNo}
        AND u.role='teacher' AND u.sector='education'
        AND (${schoolCode}='' OR lower(s.short_code)=${schoolCode})
      LIMIT 2`;
    if (rows.length === 1) row = rows[0] as UserRecord & { password_hash: string };
  }
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Registration number or password is incorrect.");
  }
  const updated = await sql`
    UPDATE users SET login_count=COALESCE(login_count,0)+1,last_login=NOW()
    WHERE id=${row.id}
    RETURNING id,name,email,phone,role,sector,waitlist,school_id,education_level,class_level,
      subjects_taught,assigned_classes,lin,school_verified,address,profile_pic,session_version,
      must_change_password,subscription,subscription_active,subscription_date,login_count,last_login,
      detected_location,created_at`;
  return issueUserToken(c, updated[0] as UserRecord);
});

auth2.post("/signup-independent", async (c) => {
  const body = await readJson(c);
  const name = requiredString(body, "name", { max: 120 });
  const email = requiredString(body, "email", { max: 254 }).trim().toLowerCase();
  const phone = optionalString(body, "phone", { max: 40 }) ?? null;
  const password = requiredString(body, "password", { min: 8, max: 128 });
  const role = requiredString(body, "role", { max: 20 });
  if (!validEmail(email) || !["individual", "teacher"].includes(role)) {
    throw new ApiError(400, "VALIDATION_ERROR", "A valid email and education role are required.");
  }
  if (body.termsAccepted !== true || body.privacyAccepted !== true) {
    throw new ApiError(400, "CONSENT_REQUIRED", "Accept the Terms of Service and Privacy Policy before creating an account.");
  }
  const sql = getDb(c.env);
  const referralCode = optionalString(body, "referred_by_code", { max: 20 })?.trim().toUpperCase() ?? null;
  let referrerId: string | null = null;
  if (referralCode) {
    const referrer = await sql`SELECT id FROM users WHERE upper(referral_code)=${referralCode} AND sector='education' LIMIT 1`;
    if (!referrer[0]) throw new ApiError(400, "INVALID_REFERRAL_CODE", "That referral code was not found.");
    referrerId = String(referrer[0].id);
  }
  const passwordHash = await hashPassword(password);
  const ownCode = await uniqueReferralCode(sql);
  let user: UserRecord;
  try {
    const rows = await sql`
      INSERT INTO users(name,email,phone,password_hash,role,sector,waitlist,referral_code,referred_by,referred_at,teacher_type)
      VALUES(${name},${email},${phone},${passwordHash},${role},'education',FALSE,${ownCode},${referrerId},${referrerId ? new Date().toISOString() : null},${role === "teacher" ? "independent" : null})
      RETURNING id,name,email,phone,role,sector,waitlist,school_id,education_level,class_level,
        subjects_taught,assigned_classes,lin,school_verified,address,profile_pic,session_version,
        must_change_password,subscription,subscription_active,subscription_date,login_count,last_login,
        detected_location,created_at`;
    user = rows[0] as UserRecord;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiError(409, "EMAIL_IN_USE", "An account with this email already exists.");
    throw error;
  }
  if (referrerId) {
    await sql`INSERT INTO referral_signups(referrer_id,referred_user_id,signup_fee,commission,commission_percent,status)
      VALUES(${referrerId},${user.id},0,0,0,'pending')`;
  }
  await sql`
    INSERT INTO user_consent(user_id,consent_type,version,consented,ip,user_agent)
    VALUES(${user.id},'tos','v1.0 (2026-10-08)',TRUE,${c.req.header("CF-Connecting-IP") ?? null},${c.req.header("User-Agent") ?? null}),
      (${user.id},'privacy','v1.0 (2026-10-08)',TRUE,${c.req.header("CF-Connecting-IP") ?? null},${c.req.header("User-Agent") ?? null}),
      (${user.id},'data_processing','v1.0 (2026-10-08)',TRUE,${c.req.header("CF-Connecting-IP") ?? null},${c.req.header("User-Agent") ?? null})`;
  return issueUserToken(c, user);
});

auth2.post("/apply-team", async (c) => {
  const body = await readJson(c);
  const name = requiredString(body, "full_name", { max: 120 });
  const email = requiredString(body, "email", { max: 254 }).trim().toLowerCase();
  const phone = requiredString(body, "phone", { max: 40 });
  if (!validEmail(email)) throw new ApiError(400, "VALIDATION_ERROR", "A valid email is required.");
  const code = optionalString(body, "referred_by_code", { max: 20 })?.trim().toUpperCase() ?? null;
  let referrerId: string | null = null;
  if (code) {
    const rows = await getDb(c.env)`SELECT id FROM users WHERE upper(referral_code)=${code} AND sector='education' LIMIT 1`;
    if (!rows[0]) throw new ApiError(400, "INVALID_REFERRAL_CODE", "That referral code was not found.");
    referrerId = String(rows[0].id);
  }
  const rows = await getDb(c.env)`
    INSERT INTO apshule_team_applications(full_name,email,phone,education_background,current_school,
      subjects_taught,teaching_level,address,referred_by)
    VALUES(${name},${email},${phone},${optionalString(body,"education_background",{max:2000}) ?? null},
      ${optionalString(body,"current_school",{max:200}) ?? null},${optionalString(body,"subjects_taught",{max:500}) ?? null},
      ${optionalString(body,"teaching_level",{max:120}) ?? null},${optionalString(body,"address",{max:500}) ?? null},${referrerId})
    RETURNING id`;
  return c.json({ ok: true, application_id: rows[0]!.id, message: "We'll review within 3 days." }, 201);
});

auth2.get("/referral/:code", async (c) => {
  const code = c.req.param("code").trim().toUpperCase();
  const rows = await getDb(c.env)`SELECT name FROM users WHERE upper(referral_code)=${code} AND sector='education' LIMIT 1`;
  if (!rows[0]) throw new ApiError(404, "REFERRAL_NOT_FOUND", "Inviter not found.");
  return c.json({ name: rows[0].name });
});

auth2.post("/generate-short-code", authMiddleware, requireRealSuperAdmin, async (c) => {
  const body = await readJson(c);
  const schoolId = requiredString(body, "school_id", { max: 80 });
  const name = requiredString(body, "school_name", { max: 160 });
  const acronym = name.split(/\s+/u).filter(Boolean).map((word) => word[0]).join("").replace(/[^a-z0-9]/giu, "").slice(0, 6).toUpperCase();
  const sql = getDb(c.env);
  for (let i = 0; i < 8; i += 1) {
    const candidate = acronym.length >= 2 && i === 0 ? acronym : `S${newReferralCode().slice(4)}`;
    const rows = await sql`UPDATE schools SET short_code=${candidate} WHERE id=${schoolId}
      AND NOT EXISTS(SELECT 1 FROM schools WHERE lower(short_code)=lower(${candidate}) AND id<>${schoolId})
      RETURNING id,short_code`;
    if (rows[0]) return c.json({ school: rows[0] });
  }
  throw new ApiError(409, "SHORT_CODE_UNAVAILABLE", "Could not allocate a unique school code.");
});

auth2.get("/me/referral", authMiddleware, async (c) => {
  const user = c.get("user");
  if (user.sector !== "education") throw new ApiError(403, "EDUCATION_ONLY", "Referrals are available for Education accounts only.");
  const sql = getDb(c.env);
  const [identity, counts] = await Promise.all([
    sql`SELECT referral_code FROM users WHERE id=${user.id}`,
    sql`SELECT COALESCE(SUM(CASE WHEN status='pending' THEN amount ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS paid
      FROM referral_earnings WHERE user_id=${user.id}`,
  ]);
  const countRows = await sql`SELECT COUNT(*) AS total FROM referral_signups WHERE referrer_id=${user.id}`;
  const code = String(identity[0]?.referral_code ?? "");
  return c.json({ referral_code: code, referral_link: `https://appshule.com/join?ref=${encodeURIComponent(code)}`,
    total_referrals: Number(countRows[0]?.total ?? 0), earnings_pending: Number(counts[0]?.pending ?? 0),
    earnings_paid: Number(counts[0]?.paid ?? 0) });
});

admin.get("/team-applications", authMiddleware, requireRealSuperAdmin, async (c) => {
  const status = c.req.query("status");
  if (status && !["pending", "approved", "rejected"].includes(status)) throw new ApiError(400, "VALIDATION_ERROR", "Invalid status.");
  const rows = status
    ? await getDb(c.env)`SELECT a.*,u.name AS referrer_name,u.referral_code FROM apshule_team_applications a LEFT JOIN users u ON u.id=a.referred_by WHERE a.status=${status} ORDER BY a.applied_at DESC`
    : await getDb(c.env)`SELECT a.*,u.name AS referrer_name,u.referral_code FROM apshule_team_applications a LEFT JOIN users u ON u.id=a.referred_by ORDER BY a.applied_at DESC`;
  return c.json({ applications: rows });
});

admin.patch("/team-applications/:id", authMiddleware, requireRealSuperAdmin, async (c) => {
  const body = await readJson(c);
  const status = requiredString(body, "status", { max: 20 });
  if (!["approved", "rejected"].includes(status)) throw new ApiError(400, "VALIDATION_ERROR", "Status must be approved or rejected.");
  const sql = getDb(c.env);
  const apps = await sql`UPDATE apshule_team_applications SET status=${status},reviewed_by=${c.get("user").id},reviewed_at=NOW()
    WHERE id=${c.req.param("id")} AND status='pending' RETURNING *`;
  const application = apps[0] as Record<string, unknown> | undefined;
  if (!application) throw new ApiError(404, "APPLICATION_NOT_FOUND", "Pending application was not found.");
  if (status === "approved") {
    const existing = await sql`SELECT id FROM users WHERE lower(email)=lower(${String(application.email)}) LIMIT 1`;
    let userId: string;
    if (existing[0]) {
      userId = String(existing[0].id);
      await sql`UPDATE users SET role='apshule_team_teacher',sector='education',school_id=NULL,waitlist=FALSE,teacher_type='apshule_team'
        WHERE id=${userId}`;
    } else {
      const oneTimePassword = newReferralCode() + newReferralCode();
      const passHash = await hashPassword(oneTimePassword);
      const code = await uniqueReferralCode(sql);
      const users = await sql`INSERT INTO users(name,email,phone,password_hash,role,sector,waitlist,referral_code,teacher_type,must_change_password)
        VALUES(${application.full_name},${application.email},${application.phone},${passHash},'apshule_team_teacher','education',FALSE,${code},'apshule_team',TRUE)
        RETURNING id`;
      userId = String(users[0]!.id);
    }
    c.executionCtx.waitUntil(sendEmail(c.env, { to: String(application.email), subject: "Your APSHULE Team application was approved",
      html: `<p>Hello ${String(application.full_name)},</p><p>Your APSHULE Team application was approved. Sign in with your email and use the password setup flow to access your account.</p>` }));
    return c.json({ ok: true, status, user_id: userId, notes: body.notes ?? null });
  }
  return c.json({ ok: true, status, notes: body.notes ?? null });
});

admin.post("/generate-short-code", authMiddleware, requireRealSuperAdmin, async (c) => {
  const body = await readJson(c);
  const schoolId = requiredString(body, "school_id", { max: 80 });
  const name = requiredString(body, "school_name", { max: 160 });
  const acronym = name.split(/\s+/u).filter(Boolean).map((word) => word[0]).join("").replace(/[^a-z0-9]/giu, "").slice(0, 6).toUpperCase();
  const sql = getDb(c.env);
  for (let i = 0; i < 8; i += 1) {
    const candidate = acronym.length >= 2 && i === 0 ? acronym : `S${newReferralCode().slice(4)}`;
    const rows = await sql`UPDATE schools SET short_code=${candidate} WHERE id=${schoolId}
      AND NOT EXISTS(SELECT 1 FROM schools WHERE lower(short_code)=lower(${candidate}) AND id<>${schoolId})
      RETURNING id,short_code`;
    if (rows[0]) return c.json({ school: rows[0] });
  }
  throw new ApiError(409, "SHORT_CODE_UNAVAILABLE", "Could not allocate a unique school code.");
});

export { admin as authV2AdminRoutes };
export default auth2;
