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
import type { AppEnv, UserRecord, UserRole } from "../types.js";

const authRoutes = new Hono<AppEnv>();

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

authRoutes.post("/reset", async () => {
  throw new ApiError(
    503,
    "PASSWORD_RESET_NOT_CONFIGURED",
    "Password reset is unavailable until a secure email delivery provider is configured.",
  );
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