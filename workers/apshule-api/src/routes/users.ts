import { Hono } from "hono";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { optionalString, publicUser, readJson, requiredString } from "../http.js";
import type { AppEnv, UserRecord } from "../types.js";

const users = new Hono<AppEnv>();

users.get("/", authMiddleware, requireRole("superadmin"), async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, name, email, phone, role, sector, school_id, education_level,
      class_level, subjects_taught, assigned_classes, lin, school_verified, address,
      profile_pic, subscription, subscription_active, subscription_date, login_count,
      last_login, detected_location, created_at
    FROM users
    ORDER BY created_at DESC
    LIMIT 500
  `;
  return c.json({ users: rows.map((row) => publicUser(row as Record<string, unknown>)) });
});

users.patch("/me", authMiddleware, async (c) => {
  const body = await readJson(c);
  const name = optionalString(body, "name", { max: 120 });
  const phone = optionalString(body, "phone", { max: 40, allowNull: true });
  const address = optionalString(body, "address", { max: 300, allowNull: true });
  const profilePic = optionalString(body, "profilePic", { max: 2000, allowNull: true });

  if (![name, phone, address, profilePic].some((value) => value !== undefined)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one profile field to update.");
  }
  const sql = getDb(c.env);
  const rows = await sql`
    UPDATE users
    SET
      name = CASE WHEN ${name !== undefined} THEN ${name ?? null} ELSE name END,
      phone = CASE WHEN ${phone !== undefined} THEN ${phone ?? null} ELSE phone END,
      address = CASE WHEN ${address !== undefined} THEN ${address ?? null} ELSE address END,
      profile_pic = CASE WHEN ${profilePic !== undefined} THEN ${profilePic ?? null} ELSE profile_pic END
    WHERE id = ${c.get("user").id}
    RETURNING id, name, email, phone, role, school_id, education_level,
      class_level, subjects_taught, assigned_classes, lin, school_verified, address,
      profile_pic, subscription, subscription_active, subscription_date, login_count,
      last_login, detected_location, created_at
  `;
  if (!rows[0]) throw new ApiError(404, "USER_NOT_FOUND", "User account was not found.");
  return c.json({ user: publicUser(rows[0] as Record<string, unknown>) });
});

users.post("/me/subscription", authMiddleware, async (c) => {
  const body = await readJson(c);
  const subscription = requiredString(body, "subscription", { max: 120 });
  const sql = getDb(c.env);
  const paid = await sql`
    SELECT id
    FROM payments
    WHERE user_id = ${c.get("user").id}
      AND plan = ${subscription}
      AND status = 'completed'
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  if (!paid[0]) {
    throw new ApiError(
      402,
      "PAYMENT_REQUIRED",
      "A verified completed payment is required to activate this subscription.",
    );
  }
  const rows = await sql`
    UPDATE users
    SET subscription = ${subscription},
        subscription_active = TRUE,
        subscription_date = COALESCE(subscription_date, NOW())
    WHERE id = ${c.get("user").id}
    RETURNING id, subscription, subscription_active, subscription_date
  `;
  if (!rows[0]) throw new ApiError(404, "USER_NOT_FOUND", "User account was not found.");
  return c.json({ subscription: rows[0] });
});

users.patch("/:id", authMiddleware, requireRole("superadmin"), async (c) => {
  const body = await readJson(c);
  const role = requiredString(body, "role", { max: 30 });
  if (!["individual", "teacher", "school", "superadmin"].includes(role)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "role must be individual, teacher, school, or superadmin.",
    );
  }
  const userId = c.req.param("id");
  const sql = getDb(c.env);

  let schoolId: string | null = null;
  if (role === "school") {
    const matchingSchool = await sql`
      SELECT id FROM schools WHERE lower(login_email) = (
        SELECT lower(email) FROM users WHERE id = ${userId}
      ) LIMIT 1
    `;
    if (!matchingSchool[0]) {
      throw new ApiError(
        400,
        "SCHOOL_ACCOUNT_REQUIRED",
        "Create a school record with this user's email before assigning the school role.",
      );
    }
    schoolId = (matchingSchool[0] as { id: string }).id;
  }

  const rows = await sql`
    UPDATE users
    SET role = ${role},
        school_id = ${schoolId}
    WHERE id = ${userId}
    RETURNING id, name, email, phone, role, school_id, education_level,
      class_level, subjects_taught, assigned_classes, lin, school_verified, address,
      profile_pic, subscription, subscription_active, subscription_date, login_count,
      last_login, detected_location, created_at
  `;
  if (!rows[0]) throw new ApiError(404, "USER_NOT_FOUND", "User account was not found.");
  return c.json({ user: publicUser(rows[0] as Record<string, unknown>) });
});

users.delete("/:id", authMiddleware, requireRole("superadmin"), async (c) => {
  const userId = c.req.param("id");
  if (userId === c.get("user").id) {
    throw new ApiError(400, "SELF_DELETE_NOT_ALLOWED", "You cannot delete your own account.");
  }
  const sql = getDb(c.env);
  const rows = await sql`DELETE FROM users WHERE id = ${userId} RETURNING id`;
  if (!rows[0]) throw new ApiError(404, "USER_NOT_FOUND", "User account was not found.");
  return c.json({ message: "User deleted.", id: (rows[0] as { id: string }).id });
});

export default users;