import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { authMiddleware, requireRealSuperAdmin, requireRole } from "../auth.js";
import { optionalString, readJson, requiredString } from "../http.js";
import type { AppEnv } from "../types.js";

const content = new Hono<AppEnv>();

function normalizePdfClassLevel(value: string | null | undefined): string {
  return value?.trim() || "unassigned";
}

function normalizePdfCoverColor(value: string | null | undefined): string {
  const color = value?.trim() || "#FF8C42";
  if (!/^#[0-9a-f]{6}$/iu.test(color)) {
    throw new ApiError(400, "VALIDATION_ERROR", "cover_color must be a six-digit hex color.");
  }
  return color;
}

function normalizePdfDisplayOrder(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 2147483647
  ) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "display_order must be a non-negative 32-bit integer.",
    );
  }
  return value;
}

function validatePdfUrl(url: string): string {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "url must be an absolute HTTP or HTTPS URL.");
  }
  return url;
}

content.get("/pdfs", async (c) => {
  const sql = getDb(c.env);
  const requestedClassLevel = c.req.query("class_level")?.trim();
  if (requestedClassLevel && requestedClassLevel.length > 30) {
    throw new ApiError(400, "VALIDATION_ERROR", "class_level must be no longer than 30 characters.");
  }
  const rows = requestedClassLevel
    ? await sql`
        SELECT id, title, url, class_level, cover_color, display_order, created_at
        FROM pdfs
        WHERE class_level = ${requestedClassLevel}
        ORDER BY display_order ASC, created_at DESC
      `
    : await sql`
        SELECT id, title, url, class_level, cover_color, display_order, created_at
        FROM pdfs
        ORDER BY display_order ASC, created_at DESC
      `;
  return c.json({ pdfs: rows });
});

content.post("/pdfs", authMiddleware, requireRole("superadmin"), async (c) => {
  const body = await readJson(c);
  const title = requiredString(body, "title", { max: 200 });
  const url = validatePdfUrl(requiredString(body, "url", { max: 2048 }));
  const classLevel = normalizePdfClassLevel(
    optionalString(body, "class_level", { max: 30, allowNull: true }),
  );
  const coverColor = normalizePdfCoverColor(
    optionalString(body, "cover_color", { max: 20, allowNull: true }),
  );
  const displayOrder = normalizePdfDisplayOrder(body.display_order);
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO pdfs (title, url, class_level, cover_color, display_order)
    VALUES (${title}, ${url}, ${classLevel}, ${coverColor}, ${displayOrder})
    RETURNING id, title, url, class_level, cover_color, display_order, created_at
  `;
  return c.json({ pdf: rows[0] }, 201);
});

content.patch("/pdfs/:id", authMiddleware, requireRole("superadmin"), async (c) => {
  const body = await readJson(c);
  const editableFields = ["title", "url", "class_level", "cover_color", "display_order"] as const;
  if (!editableFields.some((field) => field in body)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one PDF field to update.");
  }

  const hasTitle = "title" in body;
  const hasUrl = "url" in body;
  const hasClassLevel = "class_level" in body;
  const hasCoverColor = "cover_color" in body;
  const hasDisplayOrder = "display_order" in body;
  const title = hasTitle ? requiredString(body, "title", { max: 200 }) : null;
  const url = hasUrl ? validatePdfUrl(requiredString(body, "url", { max: 2048 })) : null;
  const classLevel = hasClassLevel
    ? normalizePdfClassLevel(optionalString(body, "class_level", { max: 30, allowNull: true }))
    : null;
  const coverColor = hasCoverColor
    ? normalizePdfCoverColor(optionalString(body, "cover_color", { max: 20, allowNull: true }))
    : null;
  const displayOrder = hasDisplayOrder ? normalizePdfDisplayOrder(body.display_order) : null;
  const sql = getDb(c.env);
  const rows = await sql`
    UPDATE pdfs
    SET title = CASE WHEN ${hasTitle} THEN ${title} ELSE title END,
        url = CASE WHEN ${hasUrl} THEN ${url} ELSE url END,
        class_level = CASE WHEN ${hasClassLevel} THEN ${classLevel} ELSE class_level END,
        cover_color = CASE WHEN ${hasCoverColor} THEN ${coverColor} ELSE cover_color END,
        display_order = CASE WHEN ${hasDisplayOrder} THEN ${displayOrder} ELSE display_order END
    WHERE id = ${c.req.param("id")}
    RETURNING id, title, url, class_level, cover_color, display_order, created_at
  `;
  if (!rows[0]) throw new ApiError(404, "PDF_NOT_FOUND", "PDF was not found.");
  return c.json({ pdf: rows[0] });
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

content.get(
  "/video-mappings/admin",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const sql = getDb(c.env);
    const [mappings, teachers] = await Promise.all([
      sql`
        SELECT vm.key, vm.subject, vm.class_key, vm.youtube_id, vm.teacher_id,
          teacher.name AS teacher_name
        FROM video_mappings vm
        LEFT JOIN users teacher ON teacher.id = vm.teacher_id
        ORDER BY vm.key
      `,
      sql`
        SELECT id, name, email
        FROM users
        WHERE role = 'teacher' AND sector = 'education'
        ORDER BY name, email
      `,
    ]);
    return c.json({ mappings, teachers });
  },
);

content.post("/video-mappings", authMiddleware, requireRealSuperAdmin(), async (c) => {
  const body = await readJson(c);
  const key = requiredString(body, "key", { max: 160 });
  const subject = requiredString(body, "subject", { max: 120 });
  const classKey = requiredString(body, "classKey", { max: 120 });
  const youtubeId = requiredString(body, "youtubeId", { max: 40 });
  if (!/^[A-Za-z0-9_-]{6,40}$/u.test(youtubeId)) {
    throw new ApiError(400, "VALIDATION_ERROR", "youtubeId is not a valid YouTube video identifier.");
  }
  const hasTeacherId = Object.hasOwn(body, "teacherId");
  const teacherId = hasTeacherId
    ? optionalString(body, "teacherId", { max: 36, allowNull: true }) ?? null
    : null;
  if (teacherId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(teacherId)) {
    throw new ApiError(400, "VALIDATION_ERROR", "teacherId must be a valid UUID or null.");
  }
  const sql = getDb(c.env);
  if (teacherId) {
    const teachers = await sql`
      SELECT id FROM users
      WHERE id = ${teacherId}::uuid AND role = 'teacher' AND sector = 'education'
      LIMIT 1
    `;
    if (!teachers[0]) {
      throw new ApiError(400, "INVALID_TEACHER", "teacherId must identify an Education teacher.");
    }
  }
  try {
    const rows = await sql`
      WITH saved AS (
        INSERT INTO video_mappings (key, subject, class_key, youtube_id, teacher_id)
        VALUES (${key}, ${subject}, ${classKey}, ${youtubeId}, ${teacherId}::uuid)
        ON CONFLICT (key) DO UPDATE
        SET subject = EXCLUDED.subject,
            class_key = EXCLUDED.class_key,
            youtube_id = EXCLUDED.youtube_id,
            teacher_id = CASE WHEN ${hasTeacherId}
              THEN EXCLUDED.teacher_id ELSE video_mappings.teacher_id END
        RETURNING id, key, subject, class_key, youtube_id, teacher_id, created_at
      ),
      logged AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata)
        SELECT ${c.get("user").id}, 'education', 'video_mapping.owner_updated',
          'video_mappings', saved.id,
          jsonb_build_object('lesson_key', saved.key, 'teacher_id', saved.teacher_id)
        FROM saved
      )
      SELECT saved.id, saved.key, saved.subject, saved.class_key, saved.youtube_id,
        saved.teacher_id, teacher.name AS teacher_name, saved.created_at
      FROM saved
      LEFT JOIN users teacher ON teacher.id = saved.teacher_id
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

content.get(
  "/video-views/stats",
  authMiddleware,
  requireRealSuperAdmin(),
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