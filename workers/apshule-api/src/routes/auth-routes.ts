import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { createAccessToken, hashPassword, authMiddleware, verifyPassword } from "../auth.js";
import {
  optionalString,
  publicUser,
  readJson,
  requiredString,
  validEmail,
} from "../http.js";
import { otpEmailTemplate, sendEmail, welcomeEmailTemplate } from "../email.js";
import type { AppEnv, UserRecord, UserRole } from "../types.js";

const authRoutes = new Hono<AppEnv>();
const OTP_LIFETIME_SECONDS = 120;
const OTP_RESEND_AFTER_SECONDS = 30;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_REQUESTS_PER_HOUR = 3;
const OTP_REQUEST_MESSAGE = "If registered, an OTP has been sent";
const INVALID_OTP_MESSAGE = "Invalid or expired code. Request a new one.";
const RESET_CONFIRM_ERROR = "Reset session expired. Start over.";
const encoder = new TextEncoder();

const teacherSubjects = new Set([
  "Mathematics",
  "English",
  "Science",
  "Social Studies",
  "Biology",
  "Chemistry",
  "Physics",
  "History",
  "Geography",
  "Kiswahili",
  "Commerce",
  "ICT",
  "Agriculture",
  "Literature",
  "Entrepreneurship",
  "Economics",
  "Fine Art",
  "Physical Education",
  "Religious Education",
  "Literacy",
]);

const classLevels = new Set([
  "Baby",
  "Middle",
  "Top",
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "P6",
  "P7",
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
]);

function optionalChoice(
  body: Record<string, unknown>,
  key: string,
  choices: Set<string>,
): string | null {
  const value = optionalString(body, key, { max: 20, allowNull: true });
  if (value === undefined || value === null || value === "") return null;
  if (!choices.has(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a supported class level.`);
  }
  return value;
}

function stringList(
  body: Record<string, unknown>,
  key: string,
  choices: Set<string>,
): string[] {
  const value = body[key];
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.length > choices.size ||
    value.some((item) => typeof item !== "string" || !choices.has(item.trim()))
  ) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `${key} must contain only supported values.`,
    );
  }
  return [...new Set(value.map((item: string) => item.trim()))];
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function secretHashHex(value: string, secret?: string): Promise<string> {
  if (!secret) {
    throw new ApiError(500, "SERVER_CONFIG_ERROR", "Password reset is unavailable.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function generateOtp(): string {
  const range = 900_000;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0]! >= limit);
  return String(100_000 + (value[0]! % range));
}

function generateResetToken(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

authRoutes.post("/signup", async (c) => {
  const body = await readJson(c);
  const name = requiredString(body, "name", { max: 120 });
  const email = requiredString(body, "email", { max: 254 }).toLowerCase();
  const password = requiredString(body, "password", { min: 8, max: 128 });
  const sectorValue = body.sector === undefined
    ? "education"
    : requiredString(body, "sector", { max: 50 });
  const supportedSectors = new Set(["education", "mfi", "clinic", "farm"]);
  if (!supportedSectors.has(sectorValue)) {
    throw new ApiError(400, "UNKNOWN_SECTOR", "Unknown sector.");
  }
  const sector = sectorValue;
  if (sector === "mfi") {
    throw new ApiError(
      403,
      "MFI_INVITE_ONLY",
      "MFI accounts are created by a Super Admin.",
    );
  }
  if (sector === "clinic") {
    throw new ApiError(
      403,
      "CLINIC_INVITE_ONLY",
      "Clinic accounts are created by a clinic administrator.",
    );
  }
  if (sector === "farm") {
    throw new ApiError(
      403,
      "FARM_INVITE_ONLY",
      "Farm accounts are created by a Super Admin or farm administrator.",
    );
  }
  const isEducation = sector === "education";
  const roleValue = body.role === undefined
    ? "individual"
    : requiredString(body, "role", { max: 30 });
  if (roleValue !== "individual" && roleValue !== "teacher") {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "role must be individual or teacher.",
    );
  }
  const role = roleValue as UserRole;
  const phone = typeof body.phone === "string" ? body.phone.trim() : null;
  const educationLevel = isEducation && role === "individual"
    ? optionalString(body, "educationLevel", { max: 80, allowNull: true }) ?? null
    : null;
  const classLevel = isEducation && role === "individual"
    ? optionalChoice(body, "classLevel", classLevels)
    : null;
  const linValue = isEducation && role === "individual"
    ? optionalString(body, "lin", { max: 50, allowNull: true })
    : null;
  const lin = linValue?.trim() || null;
  const subjectsTaught = isEducation && role === "teacher"
    ? stringList(body, "subjectsTaught", teacherSubjects)
    : [];
  const assignedClasses = isEducation && role === "teacher"
    ? stringList(body, "assignedClasses", classLevels)
    : [];

  if (!validEmail(email)) {
    throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
  }
  if (phone && phone.length > 40) {
    throw new ApiError(400, "VALIDATION_ERROR", "phone must be no longer than 40 characters.");
  }
  const passwordHash = await hashPassword(password);
  const sql = getDb(c.env);
  let user: UserRecord;
  try {
    const rows = await sql`
      INSERT INTO users (
        name, email, phone, password_hash, role, education_level, class_level,
        subjects_taught, assigned_classes, lin, sector, waitlist
      )
      VALUES (
        ${name}, ${email}, ${phone}, ${passwordHash}, ${role}, ${educationLevel},
        ${classLevel}, ${subjectsTaught}, ${assignedClasses}, ${lin}, ${sector},
        ${!isEducation}
      )
      RETURNING id, name, email, phone, role, sector, waitlist, school_id, education_level,
        class_level, subjects_taught, assigned_classes, lin, school_verified, address,
        profile_pic, session_version, subscription, subscription_active, subscription_date,
        login_count, last_login, detected_location, created_at
    `;
    user = rows[0] as UserRecord;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "EMAIL_IN_USE", "An account with this email already exists.");
    }
    throw error;
  }

  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: user.email,
      subject: "Welcome to APSHULE",
      html: welcomeEmailTemplate(
        user.name,
        user.role,
        null,
        c.env.APP_URL,
      ),
    }),
  );

  if (!isEducation) {
    return c.json({
      waitlist: true,
      message: "We'll email you when this sector launches.",
    });
  }

  const issued = await createAccessToken(c.env, {
    id: user.id,
    email: user.email,
    role: user.role,
    schoolId: user.school_id,
    sector: user.sector,
    sessionVersion: user.session_version ?? 0,
  });
  return c.json({ token: issued.token, user: publicUser(user as unknown as Record<string, unknown>) });
});

authRoutes.post("/login", async (c) => {
  const body = await readJson(c);
  const email = requiredString(body, "email", { max: 254 }).toLowerCase();
  const password = requiredString(body, "password", { max: 128 });
  if (!validEmail(email)) {
    throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
  }

  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, name, email, phone, password_hash, role, sector, waitlist,
      school_id, education_level,
      class_level, subjects_taught, assigned_classes, lin, school_verified, address,
      profile_pic, session_version, subscription, subscription_active, subscription_date, login_count,
      last_login, detected_location, created_at
    FROM users
    WHERE lower(email) = ${email}
    LIMIT 1
  `;
  const row = rows[0] as
    | (UserRecord & { password_hash: string })
    | undefined;

  if (!row || !(await verifyPassword(password, row.password_hash))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  }
  if (
    row.sector === "mfi" &&
    (
      row.waitlist ||
      !["mfi_admin", "loan_officer", "loan_manager", "loan_director", "borrower"].includes(row.role)
    )
  ) {
    throw new ApiError(
      403,
      "MFI_ACCESS_NOT_PROVISIONED",
      "This MFI account has not been provisioned by an organization administrator.",
    );
  }
  if (row.sector === "mfi" && row.role === "mfi_admin") {
    const organizations = await sql`
      SELECT id
      FROM mfi_organizations
      WHERE created_by = ${row.id}
      LIMIT 1
    `;
    if (!organizations[0]) {
      throw new ApiError(
        403,
        "MFI_ACCESS_NOT_PROVISIONED",
        "This MFI administrator is not linked to an organization.",
      );
    }
  }
  if (row.sector === "mfi" && ["loan_officer", "loan_manager", "loan_director"].includes(row.role)) {
    const officers = await sql`
      SELECT id
      FROM mfi_officers
      WHERE user_id = ${row.id}
        AND active IS TRUE
      LIMIT 1
    `;
    if (!officers[0]) {
      throw new ApiError(
        403,
        "MFI_ACCESS_NOT_PROVISIONED",
        "This staff account is inactive or is not linked to an organization.",
      );
    }
  }
  if (row.sector === "mfi" && row.role === "borrower") {
    const customers = await sql`
      SELECT id
      FROM mfi_customers
      WHERE user_id = ${row.id}
        AND portal_enabled IS TRUE
      LIMIT 1
    `;
    if (!customers[0]) {
      throw new ApiError(
        403,
        "MFI_BORROWER_PORTAL_DISABLED",
        "Borrower portal access has not been enabled for this account.",
      );
    }
  }
  const clinicRoles = new Set([
    "clinic_admin",
    "doctor",
    "nurse",
    "receptionist",
    "pharmacist",
    "patient",
  ]);
  if (clinicRoles.has(row.role) && row.sector !== "clinic") {
    throw new ApiError(
      403,
      "CLINIC_SECTOR_REQUIRED",
      "This account must sign in through the Clinic sector.",
    );
  }
  if (row.sector === "clinic" && row.role !== "superadmin") {
    if (row.role === "clinic_admin") {
      const organizations = await sql`
        SELECT id
        FROM clinic_organizations
        WHERE created_by = ${row.id}
        LIMIT 1
      `;
      if (!organizations[0]) {
        throw new ApiError(
          403,
          "CLINIC_ACCESS_NOT_PROVISIONED",
          "This Clinic administrator is not linked to an organization.",
        );
      }
    } else if (row.role === "patient") {
      const patients = await sql`
        SELECT id
        FROM clinic_patients
        WHERE user_id = ${row.id}
          AND portal_enabled IS TRUE
        LIMIT 1
      `;
      if (!patients[0]) {
        throw new ApiError(
          403,
          "CLINIC_PATIENT_PORTAL_DISABLED",
          "Patient portal access has not been enabled for this account.",
        );
      }
    } else if (clinicRoles.has(row.role)) {
      const staff = await sql`
        SELECT id
        FROM clinic_staff
        WHERE user_id = ${row.id}
          AND active IS TRUE
        LIMIT 1
      `;
      if (!staff[0]) {
        throw new ApiError(
          403,
          "CLINIC_ACCESS_NOT_PROVISIONED",
          "This Clinic staff account is inactive or is not linked to an organization.",
        );
      }
    } else {
      throw new ApiError(
        403,
        "CLINIC_ACCESS_NOT_PROVISIONED",
        "Clinic accounts are created by a clinic administrator.",
      );
    }
  }
  const farmRoles = new Set(["farm_admin", "farm_manager", "farm_worker"]);
  if (farmRoles.has(row.role) && row.sector !== "farm") {
    throw new ApiError(
      403,
      "FARM_SECTOR_REQUIRED",
      "This account must sign in through the Farm sector.",
    );
  }
  if (row.sector === "farm" && row.role !== "superadmin") {
    if (row.waitlist || !farmRoles.has(row.role)) {
      throw new ApiError(
        403,
        "FARM_ACCESS_NOT_PROVISIONED",
        "Farm accounts are created by a Super Admin or farm administrator.",
      );
    }
    if (row.role === "farm_admin") {
      const organizations = await sql`
        SELECT id FROM farm_organizations
        WHERE created_by = ${row.id}
        LIMIT 1
      `;
      if (!organizations[0]) {
        throw new ApiError(
          403,
          "FARM_ACCESS_NOT_PROVISIONED",
          "This Farm administrator is not linked to an organization.",
        );
      }
    } else {
      const workers = await sql`
        SELECT id FROM farm_workers
        WHERE user_id = ${row.id}
          AND role = ${row.role}
          AND active IS TRUE
        LIMIT 1
      `;
      if (!workers[0]) {
        throw new ApiError(
          403,
          "FARM_ACCESS_NOT_PROVISIONED",
          "This Farm staff account is inactive or is not linked to an organization.",
        );
      }
    }
  }

  const updated = await sql`
    UPDATE users
    SET login_count = COALESCE(login_count, 0) + 1, last_login = NOW()
    WHERE id = ${row.id}
    RETURNING id, name, email, phone, role, sector, waitlist, school_id, education_level,
      class_level, subjects_taught, assigned_classes, lin, school_verified, address,
      profile_pic, session_version, subscription, subscription_active, subscription_date, login_count,
      last_login, detected_location, created_at
  `;
  const user = updated[0] as UserRecord;
  const issued = await createAccessToken(c.env, {
    id: user.id,
    email: user.email,
    role: user.role,
    schoolId: user.school_id,
    sector: user.sector,
    sessionVersion: user.session_version ?? 0,
  });

  return c.json({
    token: issued.token,
    user: publicUser(user as unknown as Record<string, unknown>),
  });
});

authRoutes.post("/reset", async (c) => {
  const body = await readJson(c);
  const email = requiredString(body, "email", { max: 254 }).toLowerCase();
  if (!validEmail(email)) {
    throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
  }

  const genericResponse = {
    ok: true,
    message: OTP_REQUEST_MESSAGE,
    expiresInSeconds: OTP_LIFETIME_SECONDS,
    resendAfterSeconds: OTP_RESEND_AFTER_SECONDS,
  };
  const sql = getDb(c.env);
  const users = await sql`
    SELECT id, name, email
    FROM users
    WHERE lower(email) = ${email}
    LIMIT 1
  `;
  const user = users[0] as { id: string; name: string; email: string } | undefined;
  if (!user) return c.json(genericResponse);

  const requestCounts = await sql`
    SELECT
      COUNT(*)::int AS request_count,
      COUNT(*) FILTER (
        WHERE created_at >= NOW() - INTERVAL '30 seconds'
      )::int AS recent_request_count
    FROM password_reset_otps
    WHERE user_id = ${user.id}
      AND created_at >= NOW() - INTERVAL '1 hour'
  `;
  if (
    Number(requestCounts[0]?.request_count ?? 0) >= OTP_MAX_REQUESTS_PER_HOUR ||
    Number(requestCounts[0]?.recent_request_count ?? 0) > 0
  ) {
    return c.json(genericResponse);
  }

  await sql`
    DELETE FROM password_reset_otps
    WHERE user_id = ${user.id}
      AND created_at < NOW() - INTERVAL '1 hour'
  `;
  const otp = generateOtp();
  const otpHash = await secretHashHex(`${otp}:${user.id}`, c.env.JWT_SECRET);
  await sql`
    UPDATE password_reset_otps
    SET used = TRUE,
        used_at = NOW(),
        reset_token_hash = NULL
    WHERE user_id = ${user.id}
      AND used = FALSE
  `;
  await sql`
    INSERT INTO password_reset_otps (user_id, otp_hash, expires_at)
    VALUES (
      ${user.id},
      ${otpHash},
      NOW() + (${OTP_LIFETIME_SECONDS} * INTERVAL '1 second')
    )
  `;
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: user.email,
      subject: "Your APSHULE password reset code",
      html: otpEmailTemplate(user.name, otp),
    }),
  );
  return c.json(genericResponse);
});

authRoutes.post("/verify-otp", async (c) => {
  const body = await readJson(c);
  const email = requiredString(body, "email", { max: 254 }).toLowerCase();
  const otp = requiredString(body, "otp", { min: 6, max: 6 });
  if (!validEmail(email)) {
    throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
  }
  if (!/^\d{6}$/u.test(otp)) {
    throw new ApiError(400, "VALIDATION_ERROR", "otp must be a 6-digit code.");
  }

  const sql = getDb(c.env);
  const users = await sql`
    SELECT id
    FROM users
    WHERE lower(email) = ${email}
    LIMIT 1
  `;
  const user = users[0] as { id: string } | undefined;
  if (!user) throw new ApiError(400, "INVALID_CODE", INVALID_OTP_MESSAGE);

  const rows = await sql`
    SELECT id, otp_hash, expires_at, attempts
    FROM password_reset_otps
    WHERE user_id = ${user.id}
      AND used = FALSE
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const challenge = rows[0] as
    | { id: string; otp_hash: string; expires_at: string | Date; attempts: number | string }
    | undefined;
  if (!challenge) {
    throw new ApiError(400, "INVALID_CODE", INVALID_OTP_MESSAGE);
  }
  if (Number(challenge.attempts) >= OTP_MAX_ATTEMPTS) {
    throw new ApiError(400, "INVALID_CODE", INVALID_OTP_MESSAGE);
  }
  if (Date.now() >= new Date(String(challenge.expires_at)).getTime()) {
    throw new ApiError(400, "INVALID_CODE", INVALID_OTP_MESSAGE);
  }

  const providedHash = await secretHashHex(`${otp}:${user.id}`, c.env.JWT_SECRET);
  if (!constantTimeEqual(providedHash, challenge.otp_hash)) {
    await sql`
      UPDATE password_reset_otps
      SET attempts = LEAST(attempts + 1, ${OTP_MAX_ATTEMPTS})
      WHERE id = ${challenge.id}
        AND used = FALSE
        AND attempts < ${OTP_MAX_ATTEMPTS}
        AND expires_at > NOW()
    `;
    throw new ApiError(400, "INVALID_CODE", INVALID_OTP_MESSAGE);
  }

  const resetToken = generateResetToken();
  const resetTokenHash = await secretHashHex(resetToken, c.env.JWT_SECRET);
  const claimedRows = await sql`
    UPDATE password_reset_otps
    SET used = TRUE,
        used_at = NOW(),
        reset_token_hash = ${resetTokenHash}
    WHERE id = ${challenge.id}
      AND user_id = ${user.id}
      AND used = FALSE
      AND attempts < ${OTP_MAX_ATTEMPTS}
      AND expires_at > NOW()
    RETURNING id
  `;
  if (!claimedRows.length) {
    throw new ApiError(400, "INVALID_CODE", INVALID_OTP_MESSAGE);
  }

  return c.json({ ok: true, reset_token: resetToken });
});

authRoutes.post("/reset-confirm", async (c) => {
  const body = await readJson(c);
  const email = requiredString(body, "email", { max: 254 }).toLowerCase();
  const resetToken = requiredString(body, "reset_token", { min: 32, max: 32 });
  const newPassword = requiredString(body, "new_password", { min: 6, max: 128 });
  if (!validEmail(email)) {
    throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
  }
  if (!/^[0-9a-f]{32}$/iu.test(resetToken)) {
    throw new ApiError(400, "VALIDATION_ERROR", "reset_token is invalid.");
  }

  const sql = getDb(c.env);
  const users = await sql`
    SELECT id
    FROM users
    WHERE lower(email) = ${email}
    LIMIT 1
  `;
  const user = users[0] as { id: string } | undefined;
  if (!user) throw new ApiError(400, "RESET_SESSION_EXPIRED", RESET_CONFIRM_ERROR);

  const resetTokenHash = await secretHashHex(resetToken, c.env.JWT_SECRET);
  const validTokens = await sql`
    SELECT id
    FROM password_reset_otps
    WHERE user_id = ${user.id}
      AND used = TRUE
      AND used_at > NOW() - INTERVAL '5 minutes'
      AND reset_token_hash = ${resetTokenHash}
    ORDER BY used_at DESC
    LIMIT 1
  `;
  if (!validTokens.length) {
    throw new ApiError(400, "RESET_SESSION_EXPIRED", RESET_CONFIRM_ERROR);
  }

  const passwordHash = await hashPassword(newPassword);
  const updatedUsers = await sql`
    WITH active_reset AS MATERIALIZED (
      SELECT id
      FROM password_reset_otps
      WHERE user_id = ${user.id}
        AND used = TRUE
        AND used_at > NOW() - INTERVAL '5 minutes'
        AND reset_token_hash = ${resetTokenHash}
      ORDER BY used_at DESC
      LIMIT 1
      FOR UPDATE
    ),
    updated_user AS (
      UPDATE users
      SET password_hash = ${passwordHash},
          session_version = COALESCE(session_version, 0) + 1,
          updated_at = NOW()
      WHERE id = ${user.id}
        AND EXISTS (SELECT 1 FROM active_reset)
      RETURNING id
    ),
    deleted_otps AS (
      DELETE FROM password_reset_otps
      WHERE user_id = ${user.id}
        AND EXISTS (SELECT 1 FROM updated_user)
      RETURNING id
    )
    SELECT id FROM updated_user
  `;
  if (!updatedUsers.length) {
    throw new ApiError(400, "RESET_SESSION_EXPIRED", RESET_CONFIRM_ERROR);
  }

  return c.json({ ok: true, message: "Password reset successful" });
});

authRoutes.post("/logout", authMiddleware, async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  await sql`
    INSERT INTO revoked_tokens (token_id, user_id, expires_at)
    VALUES (${user.tokenId}, ${user.id}, to_timestamp(${user.tokenExpiresAt}))
    ON CONFLICT (token_id) DO NOTHING
  `;
  return c.json({ message: "Logged out." });
});

authRoutes.get("/me", authMiddleware, async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, name, email, phone, role, school_id, education_level,
      sector, waitlist, class_level, subjects_taught, assigned_classes, lin,
      school_verified, address,
      profile_pic, subscription, subscription_active, subscription_date, login_count,
      last_login, detected_location, created_at
    FROM users
    WHERE id = ${c.get("user").id}
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(404, "USER_NOT_FOUND", "User account was not found.");
  const publicRecord = publicUser(rows[0] as Record<string, unknown>);
  const authenticated = c.get("user");
  return c.json({
    user: authenticated.impersonatedBy
      ? { ...publicRecord, role: authenticated.role, sector: authenticated.sector }
      : publicRecord,
  });
});

export default authRoutes;