import { Hono } from "hono";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { readJson, requiredString } from "../http.js";
import {
  optionalBodyText,
  queryText,
  requestIp,
  routeUuid,
} from "../ncdc-helpers.js";
import type { AppEnv } from "../types.js";

const foundationRoutes = new Hono<AppEnv>();
const MARKING_LEVELS = ["Exceeds", "Meets", "Approaching", "Needs Support"] as const;

function readMarkingGrid(value: unknown): Record<(typeof MARKING_LEVELS)[number], string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "marking_grid must be a JSON object.");
  }
  const source = value as Record<string, unknown>;
  const unknownKey = Object.keys(source).find(
    (key) => !MARKING_LEVELS.includes(key as (typeof MARKING_LEVELS)[number]),
  );
  if (unknownKey) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `marking_grid contains an unsupported level: ${unknownKey}.`,
    );
  }
  const result = {} as Record<(typeof MARKING_LEVELS)[number], string>;
  for (const level of MARKING_LEVELS) {
    const text = source[level] ?? "";
    if (typeof text !== "string" || text.length > 2000) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `marking_grid.${level} must be a string of at most 2000 characters.`,
      );
    }
    result[level] = text.trim();
  }
  return result;
}

foundationRoutes.get(
  "/uneb-items",
  authMiddleware,
  requireRole("teacher", "school", "superadmin"),
  async (c) => {
    const subject = queryText(c.req.query("subject"), "subject", 120);
    const classLevel = queryText(c.req.query("class_level"), "class_level", 80);
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT id, subject, class_level, topic, scenario_text, competency,
             marking_grid, source_year, created_by, created_at
      FROM uneb_items
      WHERE (${subject === null} OR subject = ${subject})
        AND (${classLevel === null} OR class_level = ${classLevel})
      ORDER BY class_level ASC, subject ASC, topic ASC, created_at DESC
    `;
    return c.json({ items: rows });
  },
);

foundationRoutes.post(
  "/uneb-items",
  authMiddleware,
  requireRole("superadmin"),
  async (c) => {
    const body = await readJson(c);
    const subject = requiredString(body, "subject", { max: 120 });
    const classLevel = requiredString(body, "class_level", { max: 80 });
    const topic = requiredString(body, "topic", { max: 240 });
    const scenarioText = optionalBodyText(body, "scenario_text", 12000) ?? null;
    const competency = optionalBodyText(body, "competency", 2400) ?? null;
    const markingGrid = readMarkingGrid(body.marking_grid ?? {});
    const sourceYear = optionalBodyText(body, "source_year", 24) ?? null;
    const user = c.get("user");
    const metadata = JSON.stringify({ subject, class_level: classLevel, topic, source_year: sourceYear });
    const sql = getDb(c.env);
    const rows = await sql`
      WITH inserted AS (
        INSERT INTO uneb_items (
          subject, class_level, topic, scenario_text, competency,
          marking_grid, source_year, created_by
        )
        VALUES (
          ${subject}, ${classLevel}, ${topic}, ${scenarioText}, ${competency},
          ${JSON.stringify(markingGrid)}::jsonb, ${sourceYear}, ${user.id}
        )
        RETURNING id, subject, class_level, topic, scenario_text, competency,
                  marking_grid, source_year, created_by, created_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'uneb_item.create', 'uneb_items',
               inserted.id, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        FROM inserted
        RETURNING target_id
      )
      SELECT inserted.*
      FROM inserted
      INNER JOIN audit ON audit.target_id = inserted.id
    `;
    return c.json({ item: rows[0] }, 201);
  },
);

foundationRoutes.patch(
  "/uneb-items/:id",
  authMiddleware,
  requireRole("superadmin"),
  async (c) => {
    const id = routeUuid(c.req.param("id"));
    const body = await readJson(c);
    const hasSubject = "subject" in body;
    const hasClassLevel = "class_level" in body;
    const hasTopic = "topic" in body;
    const hasScenarioText = "scenario_text" in body;
    const hasCompetency = "competency" in body;
    const hasMarkingGrid = "marking_grid" in body;
    const hasSourceYear = "source_year" in body;
    if (
      !hasSubject &&
      !hasClassLevel &&
      !hasTopic &&
      !hasScenarioText &&
      !hasCompetency &&
      !hasMarkingGrid &&
      !hasSourceYear
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one UNEB item field to update.");
    }
    const subject = hasSubject ? requiredString(body, "subject", { max: 120 }) : null;
    const classLevel = hasClassLevel
      ? requiredString(body, "class_level", { max: 80 })
      : null;
    const topic = hasTopic ? requiredString(body, "topic", { max: 240 }) : null;
    const scenarioText = hasScenarioText
      ? optionalBodyText(body, "scenario_text", 12000)
      : null;
    const competency = hasCompetency ? optionalBodyText(body, "competency", 2400) : null;
    const markingGrid = hasMarkingGrid ? readMarkingGrid(body.marking_grid) : null;
    const sourceYear = hasSourceYear ? optionalBodyText(body, "source_year", 24) : null;
    const user = c.get("user");
    const changedFields = Object.keys(body).filter((field) =>
      ["subject", "class_level", "topic", "scenario_text", "competency", "marking_grid", "source_year"].includes(field),
    );
    const metadata = JSON.stringify({ changed_fields: changedFields });
    const sql = getDb(c.env);
    const rows = await sql`
      WITH updated AS (
        UPDATE uneb_items
        SET subject = CASE WHEN ${hasSubject} THEN ${subject} ELSE subject END,
            class_level = CASE WHEN ${hasClassLevel} THEN ${classLevel} ELSE class_level END,
            topic = CASE WHEN ${hasTopic} THEN ${topic} ELSE topic END,
            scenario_text = CASE WHEN ${hasScenarioText} THEN ${scenarioText} ELSE scenario_text END,
            competency = CASE WHEN ${hasCompetency} THEN ${competency} ELSE competency END,
            marking_grid = CASE WHEN ${hasMarkingGrid} THEN ${markingGrid === null ? null : JSON.stringify(markingGrid)}::jsonb ELSE marking_grid END,
            source_year = CASE WHEN ${hasSourceYear} THEN ${sourceYear} ELSE source_year END
        WHERE id = ${id}
        RETURNING id, subject, class_level, topic, scenario_text, competency,
                  marking_grid, source_year, created_by, created_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'uneb_item.update', 'uneb_items',
               updated.id, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        FROM updated
        RETURNING target_id
      )
      SELECT updated.*
      FROM updated
      INNER JOIN audit ON audit.target_id = updated.id
    `;
    if (!rows[0]) throw new ApiError(404, "UNEB_ITEM_NOT_FOUND", "UNEB item was not found.");
    return c.json({ item: rows[0] });
  },
);

foundationRoutes.delete(
  "/uneb-items/:id",
  authMiddleware,
  requireRole("superadmin"),
  async (c) => {
    const id = routeUuid(c.req.param("id"));
    const user = c.get("user");
    const sql = getDb(c.env);
    const rows = await sql`
      WITH deleted AS (
        DELETE FROM uneb_items
        WHERE id = ${id}
        RETURNING id
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'uneb_item.delete', 'uneb_items',
               deleted.id, '{}'::jsonb, ${requestIp(c.req.raw.headers)}
        FROM deleted
        RETURNING target_id
      )
      SELECT deleted.id
      FROM deleted
      INNER JOIN audit ON audit.target_id = deleted.id
    `;
    if (!rows[0]) throw new ApiError(404, "UNEB_ITEM_NOT_FOUND", "UNEB item was not found.");
    return c.json({ message: "UNEB item deleted.", id: rows[0].id });
  },
);

foundationRoutes.get(
  "/curriculum-links",
  authMiddleware,
  requireRole("teacher", "school", "superadmin"),
  async (c) => {
    const subject = queryText(c.req.query("subject"), "subject", 120);
    const classLevel = queryText(c.req.query("class_level"), "class_level", 80);
    const query = queryText(c.req.query("q"), "q", 240);
    const search = query === null ? null : `%${query}%`;
    const sql = getDb(c.env);
    const [countRows, rows] = await Promise.all([
      sql`
        SELECT COUNT(*)::int AS total
        FROM curriculum_links
        WHERE (${subject === null} OR subject = ${subject})
          AND (${classLevel === null} OR class_level = ${classLevel})
          AND (
            ${search === null}
            OR topic ILIKE ${search}
            OR summary_text ILIKE ${search}
            OR syllabus_ref ILIKE ${search}
          )
      `,
      sql`
      SELECT id, subject, class_level, topic, syllabus_ref, learner_book_page,
             teacher_guide_page, summary_text, activity_suggestion, created_at
      FROM curriculum_links
      WHERE (${subject === null} OR subject = ${subject})
        AND (${classLevel === null} OR class_level = ${classLevel})
        AND (
          ${search === null}
          OR topic ILIKE ${search}
          OR summary_text ILIKE ${search}
          OR syllabus_ref ILIKE ${search}
        )
      ORDER BY topic ASC NULLS LAST
      LIMIT 100
      `,
    ]);
    const response: {
      results: typeof rows;
      total: number;
      links?: typeof rows;
    } = {
      results: rows,
      total: Number(countRows[0]?.total ?? 0),
    };

    // Preserve the Command Center's existing unfiltered NCDC list contract.
    if (
      c.get("user").role === "superadmin" &&
      subject === null &&
      classLevel === null &&
      query === null
    ) {
      response.links = await sql`
        SELECT id, subject, class_level, topic, syllabus_ref, learner_book_page,
               teacher_guide_page, summary_text, activity_suggestion, created_at
        FROM curriculum_links
        ORDER BY class_level ASC NULLS LAST, subject ASC NULLS LAST,
                 topic ASC NULLS LAST, created_at DESC
      `;
    }

    return c.json(response);
  },
);

foundationRoutes.get(
  "/curriculum-links/subjects",
  authMiddleware,
  requireRole("teacher", "superadmin"),
  async (c) => {
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT DISTINCT subject
      FROM curriculum_links
      WHERE subject IS NOT NULL AND BTRIM(subject) <> ''
      ORDER BY subject ASC
    `;
    return c.json({ subjects: rows.map((row) => row.subject) });
  },
);

foundationRoutes.get(
  "/curriculum-links/classes",
  authMiddleware,
  requireRole("teacher", "superadmin"),
  async (c) => {
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT DISTINCT class_level
      FROM curriculum_links
      WHERE class_level IS NOT NULL AND BTRIM(class_level) <> ''
      ORDER BY class_level ASC
    `;
    return c.json({ classes: rows.map((row) => row.class_level) });
  },
);

foundationRoutes.get(
  "/curriculum-links/:id",
  authMiddleware,
  requireRole("teacher", "school", "superadmin"),
  async (c) => {
    const id = routeUuid(c.req.param("id"));
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT id, subject, class_level, topic, syllabus_ref, learner_book_page,
             teacher_guide_page, summary_text, activity_suggestion, created_at
      FROM curriculum_links
      WHERE id = ${id}
      LIMIT 1
    `;
    if (!rows[0]) {
      throw new ApiError(404, "CURRICULUM_LINK_NOT_FOUND", "Curriculum link was not found.");
    }
    return c.json({ link: rows[0] });
  },
);

foundationRoutes.post(
  "/curriculum-links/:id/favorite",
  authMiddleware,
  requireRole("teacher"),
  async (c) => {
    const id = routeUuid(c.req.param("id"));
    const user = c.get("user");
    const sql = getDb(c.env);
    const links = await sql`
      SELECT id FROM curriculum_links WHERE id = ${id} LIMIT 1
    `;
    if (!links[0]) {
      throw new ApiError(404, "CURRICULUM_LINK_NOT_FOUND", "Curriculum link was not found.");
    }
    const rows = await sql`
      WITH deleted AS (
        DELETE FROM curriculum_favorites
        WHERE teacher_id = ${user.id}
          AND curriculum_link_id = ${id}
        RETURNING id
      ),
      inserted AS (
        INSERT INTO curriculum_favorites (teacher_id, curriculum_link_id)
        SELECT ${user.id}, ${id}
        WHERE NOT EXISTS (SELECT 1 FROM deleted)
        ON CONFLICT (teacher_id, curriculum_link_id) DO NOTHING
        RETURNING id
      )
      SELECT NOT EXISTS (SELECT 1 FROM deleted) AS favorited
    `;
    return c.json({ favorited: Boolean(rows[0]?.favorited) });
  },
);

foundationRoutes.get(
  "/teacher/curriculum-favorites",
  authMiddleware,
  requireRole("teacher"),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT link.id, link.subject, link.class_level, link.topic,
             link.syllabus_ref, link.learner_book_page, link.teacher_guide_page,
             link.summary_text, link.activity_suggestion, link.created_at,
             favorite.created_at AS favorited_at
      FROM curriculum_favorites AS favorite
      INNER JOIN curriculum_links AS link
        ON link.id = favorite.curriculum_link_id
      WHERE favorite.teacher_id = ${user.id}
      ORDER BY favorite.created_at DESC, link.topic ASC
    `;
    return c.json(rows);
  },
);

foundationRoutes.post(
  "/curriculum-links/:id/view",
  authMiddleware,
  requireRole("teacher"),
  async (c) => {
    const id = routeUuid(c.req.param("id"));
    const user = c.get("user");
    const sql = getDb(c.env);
    const links = await sql`
      SELECT id FROM curriculum_links WHERE id = ${id} LIMIT 1
    `;
    if (!links[0]) {
      throw new ApiError(404, "CURRICULUM_LINK_NOT_FOUND", "Curriculum link was not found.");
    }

    await sql`
      INSERT INTO curriculum_recent (teacher_id, curriculum_link_id)
      VALUES (${user.id}, ${id})
    `;
    await sql`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (ORDER BY viewed_at DESC, id DESC) AS position
        FROM curriculum_recent
        WHERE teacher_id = ${user.id}
      )
      DELETE FROM curriculum_recent
      WHERE id IN (SELECT id FROM ranked WHERE position > 50)
    `;

    const dailyRows = await sql`
      SELECT COUNT(*)::int AS view_count,
             TO_CHAR(NOW(), 'YYYY-MM-DD') AS view_date
      FROM curriculum_recent
      WHERE teacher_id = ${user.id}
        AND viewed_at >= DATE_TRUNC('day', NOW())
    `;
    const viewCount = Number(dailyRows[0]?.view_count ?? 0);
    const viewDate = String(dailyRows[0]?.view_date ?? "");
    if (viewCount >= 20) {
      await sql`
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, ${user.sector}, 'curriculum_link.view_threshold',
               'curriculum_links', ${id},
               ${JSON.stringify({ view_date: viewDate, daily_view_count: viewCount })}::jsonb,
               ${requestIp(c.req.raw.headers)}
        WHERE NOT EXISTS (
          SELECT 1
          FROM audit_log
          WHERE actor_id = ${user.id}
            AND action = 'curriculum_link.view_threshold'
            AND metadata->>'view_date' = ${viewDate}
        )
        ON CONFLICT DO NOTHING
      `;
    }

    return c.json({ ok: true });
  },
);

foundationRoutes.get(
  "/teacher/curriculum-recent",
  authMiddleware,
  requireRole("teacher"),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT link.id, link.subject, link.class_level, link.topic,
             link.syllabus_ref, link.learner_book_page, link.teacher_guide_page,
             link.summary_text, link.activity_suggestion, link.created_at,
             recent.viewed_at
      FROM curriculum_recent AS recent
      INNER JOIN curriculum_links AS link
        ON link.id = recent.curriculum_link_id
      WHERE recent.teacher_id = ${user.id}
      ORDER BY recent.viewed_at DESC, recent.id DESC
      LIMIT 20
    `;
    return c.json(rows);
  },
);

foundationRoutes.post(
  "/curriculum-links",
  authMiddleware,
  requireRole("superadmin"),
  async (c) => {
    const body = await readJson(c);
    const subject = optionalBodyText(body, "subject", 120) ?? null;
    const classLevel = optionalBodyText(body, "class_level", 80) ?? null;
    const topic = optionalBodyText(body, "topic", 240) ?? null;
    const syllabusRef = optionalBodyText(body, "syllabus_ref", 300) ?? null;
    const learnerBookPage = optionalBodyText(body, "learner_book_page", 120) ?? null;
    const teacherGuidePage = optionalBodyText(body, "teacher_guide_page", 120) ?? null;
    const summaryText = optionalBodyText(body, "summary_text", 6000) ?? null;
    const activitySuggestion = optionalBodyText(body, "activity_suggestion", 6000) ?? null;
    const user = c.get("user");
    const metadata = JSON.stringify({ subject, class_level: classLevel, topic });
    const sql = getDb(c.env);
    const rows = await sql`
      WITH inserted AS (
        INSERT INTO curriculum_links (
          subject, class_level, topic, syllabus_ref, learner_book_page,
          teacher_guide_page, summary_text, activity_suggestion
        )
        VALUES (
          ${subject}, ${classLevel}, ${topic}, ${syllabusRef}, ${learnerBookPage},
          ${teacherGuidePage}, ${summaryText}, ${activitySuggestion}
        )
        RETURNING id, subject, class_level, topic, syllabus_ref, learner_book_page,
                  teacher_guide_page, summary_text, activity_suggestion, created_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'curriculum_link.create', 'curriculum_links',
               inserted.id, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        FROM inserted
        RETURNING target_id
      )
      SELECT inserted.*
      FROM inserted
      INNER JOIN audit ON audit.target_id = inserted.id
    `;
    return c.json({ link: rows[0] }, 201);
  },
);

foundationRoutes.patch(
  "/curriculum-links/:id",
  authMiddleware,
  requireRole("superadmin"),
  async (c) => {
    const id = routeUuid(c.req.param("id"));
    const body = await readJson(c);
    const fields = [
      "subject",
      "class_level",
      "topic",
      "syllabus_ref",
      "learner_book_page",
      "teacher_guide_page",
      "summary_text",
      "activity_suggestion",
    ] as const;
    const has = Object.fromEntries(fields.map((field) => [field, field in body])) as Record<
      (typeof fields)[number],
      boolean
    >;
    if (!fields.some((field) => has[field])) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one curriculum link field to update.");
    }
    const values = {
      subject: has.subject ? optionalBodyText(body, "subject", 120) : null,
      class_level: has.class_level ? optionalBodyText(body, "class_level", 80) : null,
      topic: has.topic ? optionalBodyText(body, "topic", 240) : null,
      syllabus_ref: has.syllabus_ref ? optionalBodyText(body, "syllabus_ref", 300) : null,
      learner_book_page: has.learner_book_page
        ? optionalBodyText(body, "learner_book_page", 120)
        : null,
      teacher_guide_page: has.teacher_guide_page
        ? optionalBodyText(body, "teacher_guide_page", 120)
        : null,
      summary_text: has.summary_text ? optionalBodyText(body, "summary_text", 6000) : null,
      activity_suggestion: has.activity_suggestion
        ? optionalBodyText(body, "activity_suggestion", 6000)
        : null,
    };
    const changedFields = fields.filter((field) => has[field]);
    const user = c.get("user");
    const sql = getDb(c.env);
    const rows = await sql`
      WITH updated AS (
        UPDATE curriculum_links
        SET subject = CASE WHEN ${has.subject} THEN ${values.subject} ELSE subject END,
            class_level = CASE WHEN ${has.class_level} THEN ${values.class_level} ELSE class_level END,
            topic = CASE WHEN ${has.topic} THEN ${values.topic} ELSE topic END,
            syllabus_ref = CASE WHEN ${has.syllabus_ref} THEN ${values.syllabus_ref} ELSE syllabus_ref END,
            learner_book_page = CASE WHEN ${has.learner_book_page} THEN ${values.learner_book_page} ELSE learner_book_page END,
            teacher_guide_page = CASE WHEN ${has.teacher_guide_page} THEN ${values.teacher_guide_page} ELSE teacher_guide_page END,
            summary_text = CASE WHEN ${has.summary_text} THEN ${values.summary_text} ELSE summary_text END,
            activity_suggestion = CASE WHEN ${has.activity_suggestion} THEN ${values.activity_suggestion} ELSE activity_suggestion END
        WHERE id = ${id}
        RETURNING id, subject, class_level, topic, syllabus_ref, learner_book_page,
                  teacher_guide_page, summary_text, activity_suggestion, created_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'curriculum_link.update', 'curriculum_links',
               updated.id, ${JSON.stringify({ changed_fields: changedFields })}::jsonb,
               ${requestIp(c.req.raw.headers)}
        FROM updated
        RETURNING target_id
      )
      SELECT updated.*
      FROM updated
      INNER JOIN audit ON audit.target_id = updated.id
    `;
    if (!rows[0]) throw new ApiError(404, "CURRICULUM_LINK_NOT_FOUND", "Curriculum link was not found.");
    return c.json({ link: rows[0] });
  },
);

foundationRoutes.delete(
  "/curriculum-links/:id",
  authMiddleware,
  requireRole("superadmin"),
  async (c) => {
    const id = routeUuid(c.req.param("id"));
    const user = c.get("user");
    const sql = getDb(c.env);
    const rows = await sql`
      WITH deleted AS (
        DELETE FROM curriculum_links
        WHERE id = ${id}
        RETURNING id
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'curriculum_link.delete', 'curriculum_links',
               deleted.id, '{}'::jsonb, ${requestIp(c.req.raw.headers)}
        FROM deleted
        RETURNING target_id
      )
      SELECT deleted.id
      FROM deleted
      INNER JOIN audit ON audit.target_id = deleted.id
    `;
    if (!rows[0]) {
      throw new ApiError(404, "CURRICULUM_LINK_NOT_FOUND", "Curriculum link was not found.");
    }
    return c.json({ message: "Curriculum link deleted.", id: rows[0].id });
  },
);

foundationRoutes.get(
  "/ncdc/stats",
  authMiddleware,
  requireRole("superadmin"),
  async (c) => {
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM uneb_items) AS uneb_items_count,
        (SELECT COUNT(*)::int FROM curriculum_links) AS curriculum_links_count,
        (SELECT COUNT(*)::int FROM projects) AS projects_count,
        (SELECT COUNT(*)::int FROM ca_records) AS ca_records_count
    `;
    return c.json(rows[0]);
  },
);

export default foundationRoutes;