import { Hono, type Context } from "hono";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, hashPassword, verifyPassword } from "../auth.js";
import { optionalString, readJson } from "../http.js";
import { emptyToNull, optionalDate, optionalImageBase64 } from "../profile-validation.js";
import type { AppEnv } from "../types.js";

const userProfile = new Hono<AppEnv>();
const classLevels = new Set([
  "Baby", "Middle", "Top",
  "P1", "P2", "P3", "P4", "P5", "P6", "P7",
  "S1", "S2", "S3", "S4", "S5", "S6",
]);
const genders = new Set(["female", "male", "other", "prefer_not_to_say"]);

function requestIp(c: Context<AppEnv>): string | null {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null
  )?.slice(0, 255) ?? null;
}

function assertNotImpersonated(user: AppEnv["Variables"]["user"]): void {
  if (user.impersonatedBy) {
    throw new ApiError(
      403,
      "IMPERSONATION_FORBIDDEN",
      "Profile changes are unavailable during an impersonation session.",
    );
  }
}

function optionalPassword(body: Record<string, unknown>, key: string, min: number): string {
  const value = body[key];
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > 128
  ) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `${key} must be between ${min} and 128 characters.`,
    );
  }
  return value;
}

userProfile.get("/me/profile", authMiddleware, async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT
      u.id, u.name, u.email, u.phone, u.role, u.sector, u.class_level, u.lin,
      u.subjects_taught, u.assigned_classes, u.avatar_base64, u.profile_pic,
      u.gender, u.bio, u.date_of_birth, u.address, u.school_id,
      s.name AS school_name
    FROM users u
    LEFT JOIN schools s ON s.id = u.school_id
    WHERE u.id = ${c.get("user").id}
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(404, "USER_NOT_FOUND", "User account was not found.");
  return c.json({ user: rows[0] });
});

userProfile.patch("/me/profile", authMiddleware, async (c) => {
  const actor = c.get("user");
  assertNotImpersonated(actor);
  const body = await readJson(c);

  const name = optionalString(body, "name", { max: 120 });
  const phone = emptyToNull(optionalString(body, "phone", { max: 40, allowNull: true }));
  const bio = emptyToNull(optionalString(body, "bio", { max: 200, allowNull: true }));
  const address = emptyToNull(optionalString(body, "address", { max: 300, allowNull: true }));
  const genderInput = optionalString(body, "gender", { max: 30, allowNull: true });
  const gender = genderInput === undefined || genderInput === null || genderInput === ""
    ? genderInput
    : genderInput.toLowerCase();
  const dateOfBirth = optionalDate(body, "date_of_birth");
  const avatarBase64 = optionalImageBase64(body, "avatar_base64", 300 * 1024);

  let classLevel: string | null | undefined;
  if ("class_level" in body) {
    if (actor.role !== "individual" || actor.sector !== "education") {
      throw new ApiError(403, "FORBIDDEN", "Only student profiles can update class level.");
    }
    const value = body.class_level;
    if (value === null || value === "") {
      classLevel = null;
    } else if (typeof value === "string" && classLevels.has(value)) {
      classLevel = value;
    } else {
      throw new ApiError(400, "VALIDATION_ERROR", "class_level must be a supported school level.");
    }
  }

  if (typeof name === "string" && !name.trim()) {
    throw new ApiError(400, "VALIDATION_ERROR", "name cannot be empty.");
  }
  if (gender !== undefined && gender !== null && !genders.has(gender)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "gender must be female, male, other, or prefer_not_to_say.",
    );
  }

  const changedFields = [
    ["name", name],
    ["phone", phone],
    ["bio", bio],
    ["address", address],
    ["gender", gender],
    ["date_of_birth", dateOfBirth],
    ["avatar_base64", avatarBase64],
    ["class_level", classLevel],
  ].filter(([, value]) => value !== undefined).map(([key]) => key);
  if (changedFields.length === 0) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one profile field to update.");
  }

  const sql = getDb(c.env);
  const rows = await sql`
    WITH updated_user AS (
      UPDATE users
      SET
        name = CASE WHEN ${name !== undefined} THEN ${name ?? null} ELSE name END,
        phone = CASE WHEN ${phone !== undefined} THEN ${phone ?? null} ELSE phone END,
        bio = CASE WHEN ${bio !== undefined} THEN ${bio ?? null} ELSE bio END,
        address = CASE WHEN ${address !== undefined} THEN ${address ?? null} ELSE address END,
        gender = CASE WHEN ${gender !== undefined} THEN ${gender ?? null} ELSE gender END,
        date_of_birth = CASE WHEN ${dateOfBirth !== undefined} THEN ${dateOfBirth ?? null} ELSE date_of_birth END,
        avatar_base64 = CASE WHEN ${avatarBase64 !== undefined} THEN ${avatarBase64 ?? null} ELSE avatar_base64 END,
        class_level = CASE WHEN ${classLevel !== undefined} THEN ${classLevel ?? null} ELSE class_level END,
        updated_at = NOW()
      WHERE id = ${actor.id}
      RETURNING
        id, name, email, phone, role, sector, class_level, lin, subjects_taught,
        assigned_classes, avatar_base64, profile_pic, gender, bio, date_of_birth,
        address, school_id
    ),
    audit_event AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT
        ${actor.id}, ${actor.sector}, 'profile_updated', 'users', u.id,
        ${JSON.stringify({ changed_fields: changedFields })}::jsonb, ${requestIp(c)}
      FROM updated_user u
      RETURNING id
    )
    SELECT u.*, s.name AS school_name
    FROM updated_user u
    LEFT JOIN schools s ON s.id = u.school_id
  `;
  if (!rows[0]) throw new ApiError(404, "USER_NOT_FOUND", "User account was not found.");
  return c.json({ user: rows[0] });
});

userProfile.post("/me/change-password", authMiddleware, async (c) => {
  const actor = c.get("user");
  assertNotImpersonated(actor);
  const body = await readJson(c);
  const oldPassword = optionalPassword(body, "old_password", 1);
  const newPassword = optionalPassword(body, "new_password", 6);
  if (oldPassword === newPassword) {
    throw new ApiError(400, "VALIDATION_ERROR", "Choose a new password different from the current one.");
  }

  const sql = getDb(c.env);
  const accountRows = await sql`
    SELECT password_hash
    FROM users
    WHERE id = ${actor.id}
    LIMIT 1
  `;
  const account = accountRows[0] as { password_hash: string } | undefined;
  if (!account) throw new ApiError(404, "USER_NOT_FOUND", "User account was not found.");
  if (!(await verifyPassword(oldPassword, account.password_hash))) {
    throw new ApiError(400, "CURRENT_PASSWORD_INCORRECT", "Current password is incorrect.");
  }

  const passwordHash = await hashPassword(newPassword);
  const rows = await sql`
    WITH updated_user AS (
      UPDATE users
      SET password_hash = ${passwordHash},
          session_version = COALESCE(session_version, 0) + 1,
          updated_at = NOW()
      WHERE id = ${actor.id}
        AND password_hash = ${account.password_hash}
      RETURNING id, session_version
    ),
    revoked_current_token AS (
      INSERT INTO revoked_tokens (token_id, user_id, expires_at)
      SELECT ${actor.tokenId}, u.id, to_timestamp(${actor.tokenExpiresAt})
      FROM updated_user u
      ON CONFLICT (token_id) DO NOTHING
      RETURNING token_id
    ),
    audit_event AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT
        ${actor.id}, ${actor.sector}, 'password_changed', 'users', u.id,
        '{"revoked_all_sessions":true}'::jsonb, ${requestIp(c)}
      FROM updated_user u
      RETURNING id
    )
    SELECT id, session_version FROM updated_user
  `;
  if (!rows[0]) {
    throw new ApiError(
      409,
      "PASSWORD_CHANGED_CONCURRENTLY",
      "Your password changed during this request. Log in with the current password.",
    );
  }
  return c.json({ message: "Password changed. Please log in again." });
});

export default userProfile;