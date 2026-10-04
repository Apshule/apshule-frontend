import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { optionalString, readJson, requiredString } from "../http.js";
import type { AppEnv } from "../types.js";

const content = new Hono<AppEnv>();

content.get("/pdfs", async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, title, url, created_at
    FROM pdfs
    ORDER BY created_at DESC
  `;
  return c.json({ pdfs: rows });
});

content.post("/pdfs", authMiddleware, requireRole("superadmin"), async (c) => {
  const body = await readJson(c);
  const title = requiredString(body, "title", { max: 200 });
  const url = requiredString(body, "url", { max: 2048 });
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "url must be an absolute HTTP or HTTPS URL.");
  }
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO pdfs (title, url)
    VALUES (${title}, ${url})
    RETURNING id, title, url, created_at
  `;
  return c.json({ pdf: rows[0] }, 201);
});

content.delete("/pdfs/:id", authMiddleware, requireRole("superadmin"), async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`DELETE FROM pdfs WHERE id = ${c.req.param("id")} RETURNING id`;
  if (!rows[0]) throw new ApiError(404, "PDF_NOT_FOUND", "PDF was not found.");
  return c.json({ message: "PDF deleted.", id: (rows[0] as { id: string }).id });
});

content.get("/video-mappings", async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`SELECT key, youtube_id FROM video_mappings ORDER BY key`;
  const mappings: Record<string, string> = {};
  for (const row of rows as Array<{ key: string; youtube_id: string }>) {
    mappings[row.key] = row.youtube_id;
  }
  return c.json(mappings);
});

content.post("/video-mappings", authMiddleware, requireRole("superadmin"), async (c) => {
  const body = await readJson(c);
  const key = requiredString(body, "key", { max: 160 });
  const subject = requiredString(body, "subject", { max: 120 });
  const classKey = requiredString(body, "classKey", { max: 120 });
  const youtubeId = requiredString(body, "youtubeId", { max: 40 });
  if (!/^[A-Za-z0-9_-]{6,40}$/u.test(youtubeId)) {
    throw new ApiError(400, "VALIDATION_ERROR", "youtubeId is not a valid YouTube video identifier.");
  }
  const sql = getDb(c.env);
  try {
    const rows = await sql`
      INSERT INTO video_mappings (key, subject, class_key, youtube_id)
      VALUES (${key}, ${subject}, ${classKey}, ${youtubeId})
      ON CONFLICT (key) DO UPDATE
      SET subject = EXCLUDED.subject,
          class_key = EXCLUDED.class_key,
          youtube_id = EXCLUDED.youtube_id
      RETURNING id, key, subject, class_key, youtube_id, created_at
    `;
    return c.json({ mapping: rows[0] }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "MAPPING_CONFLICT", "A mapping already exists for this key.");
    }
    throw error;
  }
});

content.get("/subjects", async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`SELECT level, list FROM subjects ORDER BY level`;
  const result: { nursery: string[]; primary: string[]; secondary: string[] } = {
    nursery: [],
    primary: [],
    secondary: [],
  };
  for (const row of rows as Array<{ level: string; list: string[] }>) {
    if (row.level === "nursery" || row.level === "primary" || row.level === "secondary") {
      result[row.level] = row.list;
    }
  }
  return c.json(result);
});

content.put(
  "/subjects/:level",
  authMiddleware,
  requireRole("superadmin"),
  async (c) => {
    const level = c.req.param("level");
    if (level !== "nursery" && level !== "primary" && level !== "secondary") {
      throw new ApiError(400, "VALIDATION_ERROR", "level must be nursery, primary, or secondary.");
    }
    const body = await readJson(c);
    const subjects = body.subjects;
    if (
      !Array.isArray(subjects) ||
      subjects.length > 100 ||
      subjects.some(
        (subject) =>
          typeof subject !== "string" ||
          !subject.trim() ||
          subject.trim().length > 120,
      )
    ) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "subjects must be an array of up to 100 non-empty strings.",
      );
    }
    const uniqueSubjects = [...new Set(subjects.map((subject) => (subject as string).trim()))];
    const sql = getDb(c.env);
    const rows = await sql`
      INSERT INTO subjects (level, list)
      VALUES (${level}, ${uniqueSubjects})
      ON CONFLICT (level) DO UPDATE SET list = EXCLUDED.list
      RETURNING level, list
    `;
    return c.json({ [level]: (rows[0] as { list: string[] }).list });
  },
);

content.get("/feedbacks", authMiddleware, requireRole("superadmin"), async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ApiError(400, "VALIDATION_ERROR", "limit must be a positive integer.");
  }
  const boundedLimit = Math.min(limit, 200);
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, lesson, rating, comment, user_name, user_email, timestamp
    FROM feedbacks
    ORDER BY timestamp DESC
    LIMIT ${boundedLimit}
  `;
  return c.json({ feedbacks: rows });
});

content.post("/feedbacks", async (c) => {
  const body = await readJson(c);
  const lesson = optionalString(body, "lesson", { max: 200 }) ?? null;
  const comment = optionalString(body, "comment", { max: 4000 }) ?? null;
  const userName = optionalString(body, "userName", { max: 120 }) ?? null;
  const userEmail = optionalString(body, "userEmail", { max: 254 })?.toLowerCase() ?? null;
  let rating: number | null = null;
  if (body.rating !== undefined && body.rating !== null) {
    if (!Number.isInteger(body.rating) || Number(body.rating) < 1 || Number(body.rating) > 5) {
      throw new ApiError(400, "VALIDATION_ERROR", "rating must be an integer from 1 to 5.");
    }
    rating = Number(body.rating);
  }
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO feedbacks (lesson, rating, comment, user_name, user_email)
    VALUES (${lesson}, ${rating}, ${comment}, ${userName}, ${userEmail})
    RETURNING id, lesson, rating, comment, user_name, user_email, timestamp
  `;
  return c.json({ feedback: rows[0] }, 201);
});

content.post("/video-views", async (c) => {
  const body = await readJson(c);
  const subject = optionalString(body, "subject", { max: 120 }) ?? null;
  const classId = optionalString(body, "classId", { max: 120 }) ?? null;
  const className = optionalString(body, "className", { max: 120 }) ?? null;
  const userId = optionalString(body, "userId", { max: 80 }) ?? null;
  const userName = optionalString(body, "userName", { max: 120 }) ?? null;
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO video_views (subject, class_id, class_name, user_id, user_name)
    VALUES (${subject}, ${classId}, ${className}, ${userId}, ${userName})
    RETURNING id, subject, class_id, class_name, user_id, user_name, timestamp
  `;
  return c.json({ view: rows[0] }, 201);
});

content.get(
  "/video-views/stats",
  authMiddleware,
  requireRole("superadmin"),
  async (c) => {
    const sql = getDb(c.env);
    const [totals, bySubject, byClass] = await Promise.all([
      sql`SELECT COUNT(*)::int AS total FROM video_views`,
      sql`
        SELECT subject, COUNT(*)::int AS views
        FROM video_views
        GROUP BY subject
        ORDER BY views DESC, subject ASC
      `,
      sql`
        SELECT class_id, class_name, COUNT(*)::int AS views
        FROM video_views
        GROUP BY class_id, class_name
        ORDER BY views DESC, class_name ASC
      `,
    ]);
    return c.json({
      total: (totals[0] as { total: number } | undefined)?.total ?? 0,
      bySubject,
      byClass,
    });
  },
);

export default content;