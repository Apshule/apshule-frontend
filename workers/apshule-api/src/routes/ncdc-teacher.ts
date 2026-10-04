import { Hono } from "hono";
import { getDb } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { queryText } from "../ncdc-helpers.js";
import type { AppEnv } from "../types.js";

const teacherRoutes = new Hono<AppEnv>();

function currentAcademicTerm(): string {
  const month = new Date().getUTCMonth() + 1;
  if (month <= 4) return "Term One";
  if (month <= 8) return "Term Two";
  return "Term Three";
}

teacherRoutes.get(
  "/teacher/me/stats",
  authMiddleware,
  requireRole("teacher"),
  async (c) => {
    const user = c.get("user");
    const currentTerm = currentAcademicTerm();
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT
        (
          SELECT COUNT(DISTINCT assigned.class_level)::int
          FROM unnest(
            COALESCE(teacher.assigned_classes, ARRAY[]::text[])
          ) AS assigned(class_level)
        ) AS classes_count,
        (
          SELECT COUNT(*)::int
          FROM users learner
          WHERE learner.role = 'individual'
            AND learner.class_level = ANY(
              COALESCE(teacher.assigned_classes, ARRAY[]::text[])
            )
            AND (teacher.school_id IS NULL OR learner.school_id = teacher.school_id)
        ) AS students_count,
        (
          SELECT COUNT(*)::int
          FROM ca_records record
          INNER JOIN users learner ON learner.id = record.learner_id
          WHERE record.teacher_id = teacher.id
            AND record.term = ${currentTerm}
            AND learner.class_level = ANY(
              COALESCE(teacher.assigned_classes, ARRAY[]::text[])
            )
            AND (
              teacher.school_id IS NULL
              OR (
                learner.school_id = teacher.school_id
                AND record.school_id = teacher.school_id
              )
            )
        ) AS ca_records_count,
        (
          SELECT COUNT(*)::int
          FROM projects project
          LEFT JOIN users learner ON learner.id = project.learner_id
          WHERE COALESCE(project.final_status, 'pending') = 'pending'
            AND COALESCE(learner.class_level, project.class_name) = ANY(
              COALESCE(teacher.assigned_classes, ARRAY[]::text[])
            )
            AND (
              teacher.school_id IS NULL
              OR (
                COALESCE(learner.school_id, project.school_id) = teacher.school_id
                AND (project.school_id IS NULL OR project.school_id = teacher.school_id)
              )
            )
        ) AS pending_projects_count,
        (
          SELECT COUNT(*)::int
          FROM teacher_retooling_progress progress
          WHERE progress.teacher_id = teacher.id
            AND progress.module_id BETWEEN 1 AND 10
            AND progress.completed IS TRUE
        ) AS modules_completed
      FROM users teacher
      WHERE teacher.id = ${user.id}
        AND teacher.role = 'teacher'
      LIMIT 1
    `;

    if (!rows[0]) {
      return c.json({ error: "Teacher account was not found." }, 404);
    }
    return c.json(rows[0]);
  },
);

teacherRoutes.get(
  "/teacher/students",
  authMiddleware,
  requireRole("teacher"),
  async (c) => {
    const user = c.get("user");
    const classLevel = queryText(c.req.query("class_level"), "class_level", 20);
    const sql = getDb(c.env);
    const teacherRows = await sql`
      SELECT assigned_classes
      FROM users
      WHERE id = ${user.id}
        AND role = 'teacher'
      LIMIT 1
    `;
    const assignedClasses = (teacherRows[0]?.assigned_classes as string[] | null) ?? [];
    if (classLevel && !assignedClasses.includes(classLevel)) {
      return c.json({ error: "You can only view learners in your assigned classes." }, 403);
    }

    const rows = await sql`
      SELECT learner.id, learner.name, learner.email, learner.class_level, learner.lin
      FROM users learner
      INNER JOIN users teacher ON teacher.id = ${user.id}
      WHERE learner.role = 'individual'
        AND teacher.role = 'teacher'
        AND learner.class_level = ANY(
          COALESCE(teacher.assigned_classes, ARRAY[]::text[])
        )
        AND (teacher.school_id IS NULL OR learner.school_id = teacher.school_id)
        AND (${classLevel === null} OR learner.class_level = ${classLevel})
      ORDER BY learner.class_level ASC, learner.name ASC
    `;
    return c.json(rows);
  },
);

export default teacherRoutes;