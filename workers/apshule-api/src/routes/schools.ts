import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { authMiddleware, hashPassword, requireRole } from "../auth.js";
import { optionalString, readJson, requiredString, validEmail } from "../http.js";
import type { AppEnv } from "../types.js";

const schools = new Hono<AppEnv>();

schools.get("/", async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, name, contact, location, logo, login_email, login_count, created_at
    FROM schools
    ORDER BY created_at DESC
  `;
  return c.json({ schools: rows });
});

schools.post("/", authMiddleware, requireRole("superadmin"), async (c) => {
  const body = await readJson(c);
  const name = requiredString(body, "name", { max: 160 });
  const loginEmail = requiredString(body, "loginEmail", { max: 254 }).toLowerCase();
  const loginPassword = requiredString(body, "loginPassword", { min: 8, max: 128 });
  if (!validEmail(loginEmail)) {
    throw new ApiError(400, "VALIDATION_ERROR", "loginEmail must be a valid email address.");
  }
  const contact = optionalString(body, "contact", { max: 160 }) ?? null;
  const location = optionalString(body, "location", { max: 300 }) ?? null;
  const logo = optionalString(body, "logo", { max: 2000 }) ?? null;
  const phone = optionalString(body, "phone", { max: 40 }) ?? null;
  const passwordHash = await hashPassword(loginPassword);
  const sql = getDb(c.env);

  let school: { id: string; name: string; login_email: string };
  try {
    const createdSchools = await sql`
      INSERT INTO schools (name, contact, location, logo, login_email, login_password_hash)
      VALUES (${name}, ${contact}, ${location}, ${logo}, ${loginEmail}, ${passwordHash})
      RETURNING id, name, login_email
    `;
    school = createdSchools[0] as typeof school;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "EMAIL_IN_USE", "A school or user already uses this email.");
    }
    throw error;
  }

  try {
    await sql`
      INSERT INTO users (name, email, phone, password_hash, role, school_id)
      VALUES (${name}, ${loginEmail}, ${phone}, ${passwordHash}, 'school', ${school.id})
    `;
  } catch (error) {
    await sql`DELETE FROM schools WHERE id = ${school.id}`;
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "EMAIL_IN_USE", "A school or user already uses this email.");
    }
    throw error;
  }
  return c.json({ school }, 201);
});

schools.patch("/:id", authMiddleware, requireRole("superadmin"), async (c) => {
  const body = await readJson(c);
  const name = optionalString(body, "name", { max: 160 });
  const contact = optionalString(body, "contact", { max: 160, allowNull: true });
  const location = optionalString(body, "location", { max: 300, allowNull: true });
  const logo = optionalString(body, "logo", { max: 2000, allowNull: true });
  if (![name, contact, location, logo].some((value) => value !== undefined)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one school field to update.");
  }
  const sql = getDb(c.env);
  const rows = await sql`
    UPDATE schools
    SET
      name = CASE WHEN ${name !== undefined} THEN ${name ?? null} ELSE name END,
      contact = CASE WHEN ${contact !== undefined} THEN ${contact ?? null} ELSE contact END,
      location = CASE WHEN ${location !== undefined} THEN ${location ?? null} ELSE location END,
      logo = CASE WHEN ${logo !== undefined} THEN ${logo ?? null} ELSE logo END
    WHERE id = ${c.req.param("id")}
    RETURNING id, name, contact, location, logo, login_email, login_count, created_at
  `;
  if (!rows[0]) throw new ApiError(404, "SCHOOL_NOT_FOUND", "School was not found.");
  return c.json({ school: rows[0] });
});

schools.delete("/:id", authMiddleware, requireRole("superadmin"), async (c) => {
  const schoolId = c.req.param("id");
  const sql = getDb(c.env);
  const linkedUsers = await sql`DELETE FROM users WHERE school_id = ${schoolId} RETURNING id`;
  const rows = await sql`DELETE FROM schools WHERE id = ${schoolId} RETURNING id`;
  if (!rows[0]) throw new ApiError(404, "SCHOOL_NOT_FOUND", "School was not found.");
  return c.json({
    message: "School deleted.",
    id: (rows[0] as { id: string }).id,
    deletedUsers: linkedUsers.length,
  });
});

export default schools;