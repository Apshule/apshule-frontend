import { Hono } from "hono";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { readJson } from "../http.js";
import {
  assertSameSchool,
  linkedSchoolId,
  optionalBodyText,
  optionalBodyUuid,
  optionalBoolean,
  optionalInteger,
  optionalTimestamp,
  queryText,
  queryUuid,
  requestIp,
  requiredBoolean,
  requiredInteger,
  requireLearner,
  requireTeacher,
  routeUuid,
} from "../ncdc-helpers.js";
import type { AuthenticatedUser, AppEnv } from "../types.js";

const learningRoutes = new Hono<AppEnv>();

function assertRequestedSchool(
  requestedSchoolId: string | null | undefined,
  derivedSchoolId: string | null,
): void {
  if (requestedSchoolId && requestedSchoolId !== derivedSchoolId) {
    throw new ApiError(403, "FORBIDDEN", "school_id is controlled by your account.");
  }
}

async function resolveLearnerSchool(
  sql: ReturnType<typeof getDb>,
  learnerId: string | null,
  requestedSchoolId: string | null | undefined,
  user: AuthenticatedUser,
): Promise<{ learnerId: string | null; schoolId: string | null }> {
  const learner = learnerId ? await requireLearner(sql, learnerId) : null;

  if (user.role === "individual") {
    if (learnerId && learnerId !== user.id) {
      throw new ApiError(403, "FORBIDDEN", "You can only create a project for your own account.");
    }
    assertRequestedSchool(requestedSchoolId, user.schoolId);
    return { learnerId: user.id, schoolId: user.schoolId };
  }

  if (user.role === "teacher" || user.role === "school") {
    const schoolId = linkedSchoolId(user);
    assertRequestedSchool(requestedSchoolId, schoolId);
    if (learner && learner.school_id !== schoolId) {
      throw new ApiError(403, "FORBIDDEN", "The learner is not linked to your school.");
    }
    return { learnerId, schoolId };
  }

  if (
    learner &&
    requestedSchoolId &&
    learner.school_id &&
    learner.school_id !== requestedSchoolId
  ) {
    throw new ApiError(400, "SCHOOL_LEARNER_MISMATCH", "school_id does not match the learner's school.");
  }
  return {
    learnerId,
    schoolId: requestedSchoolId ?? learner?.school_id ?? null,
  };
}

async function resolveRecordTeacher(
  sql: ReturnType<typeof getDb>,
  teacherId: string | null | undefined,
  user: AuthenticatedUser,
  schoolId: string | null,
): Promise<string | null> {
  if (user.role === "teacher") {
    if (teacherId && teacherId !== user.id) {
      throw new ApiError(403, "FORBIDDEN", "You can only record work under your own teacher account.");
    }
    return user.id;
  }
  if (!teacherId) return null;
  const teacher = await requireTeacher(sql, teacherId);
  if (schoolId) assertSameSchool(teacher.school_id, schoolId, "teachers");
  return teacherId;
}

function optionalStatus(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  return optionalBodyText(body, field, 80);
}

learningRoutes.get(
  "/ca-records",
  authMiddleware,
  requireRole("individual", "teacher", "school", "superadmin"),
  async (c) => {
    const user = c.get("user");
    const learnerId = queryUuid(c.req.query("learner_id"), "learner_id");
    const schoolId = queryUuid(c.req.query("school_id"), "school_id");
    const term = queryText(c.req.query("term"), "term", 80);
    const staffSchoolId =
      user.role === "teacher" || user.role === "school" ? linkedSchoolId(user) : null;
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT id, learner_id, school_id, subject, competency, evidence_1, evidence_2,
             evidence_3, final_level, term, teacher_id, synced_at, created_at
      FROM ca_records
      WHERE (
        ${user.role === "superadmin"}
        OR (${user.role === "teacher" || user.role === "school"} AND school_id = ${staffSchoolId})
        OR (${user.role === "individual"} AND learner_id = ${user.id})
      )
        AND (${learnerId === null} OR learner_id = ${learnerId})
        AND (${schoolId === null} OR school_id = ${schoolId})
        AND (${term === null} OR term = ${term})
      ORDER BY created_at DESC
    `;
    return c.json({ records: rows });
  },
);

learningRoutes.post(
  "/ca-records",
  authMiddleware,
  requireRole("teacher", "school", "superadmin"),
  async (c) => {
    const body = await readJson(c);
    const user = c.get("user");
    const rawLearnerId = optionalBodyUuid(body, "learner_id") ?? null;
    const rawSchoolId = optionalBodyUuid(body, "school_id") ?? null;
    const rawTeacherId = optionalBodyUuid(body, "teacher_id") ?? null;
    if (!rawLearnerId && user.role !== "superadmin") {
      throw new ApiError(400, "VALIDATION_ERROR", "learner_id is required.");
    }
    const sql = getDb(c.env);
    const learner = rawLearnerId ? await requireLearner(sql, rawLearnerId) : null;
    let schoolId = rawSchoolId ?? learner?.school_id ?? null;
    if (user.role === "teacher" || user.role === "school") {
      schoolId = linkedSchoolId(user);
      assertRequestedSchool(rawSchoolId, schoolId);
      if (!learner) throw new ApiError(400, "VALIDATION_ERROR", "learner_id is required.");
      assertSameSchool(learner.school_id, schoolId, "learner records");
    } else if (
      rawSchoolId &&
      learner?.school_id &&
      rawSchoolId !== learner.school_id
    ) {
      throw new ApiError(400, "SCHOOL_LEARNER_MISMATCH", "school_id does not match the learner's school.");
    }
    const teacherId = await resolveRecordTeacher(sql, rawTeacherId, user, schoolId);
    const subject = optionalBodyText(body, "subject", 120) ?? null;
    const competency = optionalBodyText(body, "competency", 2400) ?? null;
    const evidence1 = optionalBodyText(body, "evidence_1", 4000) ?? null;
    const evidence2 = optionalBodyText(body, "evidence_2", 4000) ?? null;
    const evidence3 = optionalBodyText(body, "evidence_3", 4000) ?? null;
    const finalLevel = optionalBodyText(body, "final_level", 80) ?? null;
    const term = optionalBodyText(body, "term", 80) ?? null;
    const syncedAt = optionalTimestamp(body, "synced_at") ?? null;
    const metadata = JSON.stringify({
      learner_id: rawLearnerId,
      school_id: schoolId,
      subject,
      term,
    });
    const rows = await sql`
      WITH inserted AS (
        INSERT INTO ca_records (
          learner_id, school_id, subject, competency, evidence_1, evidence_2,
          evidence_3, final_level, term, teacher_id, synced_at
        )
        VALUES (
          ${rawLearnerId}, ${schoolId}, ${subject}, ${competency}, ${evidence1},
          ${evidence2}, ${evidence3}, ${finalLevel}, ${term}, ${teacherId}, ${syncedAt}
        )
        RETURNING id, learner_id, school_id, subject, competency, evidence_1, evidence_2,
                  evidence_3, final_level, term, teacher_id, synced_at, created_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'ca_record.create', 'ca_records',
               inserted.id, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        FROM inserted
        RETURNING target_id
      )
      SELECT inserted.*
      FROM inserted
      INNER JOIN audit ON audit.target_id = inserted.id
    `;
    return c.json({ record: rows[0] }, 201);
  },
);

learningRoutes.patch(
  "/ca-records/:id",
  authMiddleware,
  requireRole("teacher", "school", "superadmin"),
  async (c) => {
    const id = routeUuid(c.req.param("id"));
    const body = await readJson(c);
    const fields = [
      "subject",
      "competency",
      "evidence_1",
      "evidence_2",
      "evidence_3",
      "final_level",
      "term",
      "teacher_id",
      "synced_at",
    ] as const;
    const has = Object.fromEntries(fields.map((field) => [field, field in body])) as Record<
      (typeof fields)[number],
      boolean
    >;
    if (!fields.some((field) => has[field])) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one CA record field to update.");
    }
    const user = c.get("user");
    const scopeSchoolId =
      user.role === "teacher" || user.role === "school" ? linkedSchoolId(user) : null;
    let teacherId: string | null | undefined;
    if (has.teacher_id) {
      teacherId = optionalBodyUuid(body, "teacher_id");
      if (user.role === "teacher") {
        if (teacherId !== user.id) {
          throw new ApiError(403, "FORBIDDEN", "You cannot assign a CA record to another teacher.");
        }
      } else if (teacherId) {
        const teacher = await requireTeacher(getDb(c.env), teacherId);
        if (scopeSchoolId) assertSameSchool(teacher.school_id, scopeSchoolId, "teachers");
      }
    }
    const values = {
      subject: has.subject ? optionalBodyText(body, "subject", 120) : null,
      competency: has.competency ? optionalBodyText(body, "competency", 2400) : null,
      evidence_1: has.evidence_1 ? optionalBodyText(body, "evidence_1", 4000) : null,
      evidence_2: has.evidence_2 ? optionalBodyText(body, "evidence_2", 4000) : null,
      evidence_3: has.evidence_3 ? optionalBodyText(body, "evidence_3", 4000) : null,
      final_level: has.final_level ? optionalBodyText(body, "final_level", 80) : null,
      term: has.term ? optionalBodyText(body, "term", 80) : null,
      synced_at: has.synced_at ? optionalTimestamp(body, "synced_at") : null,
    };
    const changedFields = fields.filter((field) => has[field]);
    const metadata = JSON.stringify({ changed_fields: changedFields });
    const sql = getDb(c.env);
    const rows = await sql`
      WITH updated AS (
        UPDATE ca_records
        SET subject = CASE WHEN ${has.subject} THEN ${values.subject} ELSE subject END,
            competency = CASE WHEN ${has.competency} THEN ${values.competency} ELSE competency END,
            evidence_1 = CASE WHEN ${has.evidence_1} THEN ${values.evidence_1} ELSE evidence_1 END,
            evidence_2 = CASE WHEN ${has.evidence_2} THEN ${values.evidence_2} ELSE evidence_2 END,
            evidence_3 = CASE WHEN ${has.evidence_3} THEN ${values.evidence_3} ELSE evidence_3 END,
            final_level = CASE WHEN ${has.final_level} THEN ${values.final_level} ELSE final_level END,
            term = CASE WHEN ${has.term} THEN ${values.term} ELSE term END,
            teacher_id = CASE WHEN ${has.teacher_id} THEN ${teacherId ?? null} ELSE teacher_id END,
            synced_at = CASE WHEN ${has.synced_at} THEN ${values.synced_at} ELSE synced_at END
        WHERE id = ${id}
          AND (
            ${user.role === "superadmin"}
            OR (${user.role === "teacher" || user.role === "school"} AND school_id = ${scopeSchoolId})
          )
        RETURNING id, learner_id, school_id, subject, competency, evidence_1, evidence_2,
                  evidence_3, final_level, term, teacher_id, synced_at, created_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'ca_record.update', 'ca_records',
               updated.id, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        FROM updated
        RETURNING target_id
      )
      SELECT updated.*
      FROM updated
      INNER JOIN audit ON audit.target_id = updated.id
    `;
    if (!rows[0]) throw new ApiError(404, "CA_RECORD_NOT_FOUND", "CA record was not found.");
    return c.json({ record: rows[0] });
  },
);

learningRoutes.get(
  "/projects",
  authMiddleware,
  requireRole("individual", "teacher", "school", "superadmin"),
  async (c) => {
    const user = c.get("user");
    const learnerId = queryUuid(c.req.query("learner_id"), "learner_id");
    const schoolId = queryUuid(c.req.query("school_id"), "school_id");
    const className = queryText(c.req.query("class_name"), "class_name", 120);
    const subject = queryText(c.req.query("subject"), "subject", 120);
    const staffSchoolId =
      user.role === "teacher" || user.role === "school" ? linkedSchoolId(user) : null;
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT id, learner_id, school_id, class_name, subject, title, lin, qr_code,
             milestone_1_date, milestone_1_photo, milestone_1_status,
             milestone_2_date, milestone_2_photo, milestone_2_status,
             final_date, final_photo, final_status, teacher_observed_tick,
             viva_audio_path, similarity_flag, previous_title_check, created_at
      FROM projects
      WHERE (
        ${user.role === "superadmin"}
        OR (${user.role === "teacher" || user.role === "school"} AND school_id = ${staffSchoolId})
        OR (${user.role === "individual"} AND learner_id = ${user.id})
      )
        AND (${learnerId === null} OR learner_id = ${learnerId})
        AND (${schoolId === null} OR school_id = ${schoolId})
        AND (${className === null} OR class_name = ${className})
        AND (${subject === null} OR subject = ${subject})
      ORDER BY created_at DESC
    `;
    return c.json({ projects: rows });
  },
);

learningRoutes.post(
  "/projects",
  authMiddleware,
  requireRole("individual", "teacher", "school", "superadmin"),
  async (c) => {
    const body = await readJson(c);
    const user = c.get("user");
    const rawLearnerId = optionalBodyUuid(body, "learner_id") ?? null;
    const rawSchoolId = optionalBodyUuid(body, "school_id") ?? null;
    const sql = getDb(c.env);
    const ownership = await resolveLearnerSchool(sql, rawLearnerId, rawSchoolId, user);
    const className = optionalBodyText(body, "class_name", 120) ?? null;
    const subject = optionalBodyText(body, "subject", 120) ?? null;
    const title = optionalBodyText(body, "title", 300) ?? null;
    const lin = optionalBodyText(body, "lin", 80) ?? null;
    const qrCode = optionalBodyText(body, "qr_code", 2048) ?? null;
    const milestone1Date = optionalTimestamp(body, "milestone_1_date") ?? null;
    const milestone1Photo = optionalBodyText(body, "milestone_1_photo", 2048) ?? null;
    const milestone1Status = optionalStatus(body, "milestone_1_status");
    const milestone2Date = optionalTimestamp(body, "milestone_2_date") ?? null;
    const milestone2Photo = optionalBodyText(body, "milestone_2_photo", 2048) ?? null;
    const milestone2Status = optionalStatus(body, "milestone_2_status");
    const finalDate = optionalTimestamp(body, "final_date") ?? null;
    const finalPhoto = optionalBodyText(body, "final_photo", 2048) ?? null;
    const finalStatus = optionalStatus(body, "final_status");
    const teacherObservedTick = requiredBoolean(body, "teacher_observed_tick", false);
    const vivaAudioPath = optionalBodyText(body, "viva_audio_path", 2048) ?? null;
    const similarityFlag = requiredBoolean(body, "similarity_flag", false);
    const previousTitleCheck = optionalBodyText(body, "previous_title_check", 4000) ?? null;
    const metadata = JSON.stringify({
      learner_id: ownership.learnerId,
      school_id: ownership.schoolId,
      class_name: className,
      subject,
      title,
    });
    const rows = await sql`
      WITH inserted AS (
        INSERT INTO projects (
          learner_id, school_id, class_name, subject, title, lin, qr_code,
          milestone_1_date, milestone_1_photo, milestone_1_status,
          milestone_2_date, milestone_2_photo, milestone_2_status,
          final_date, final_photo, final_status, teacher_observed_tick,
          viva_audio_path, similarity_flag, previous_title_check
        )
        VALUES (
          ${ownership.learnerId}, ${ownership.schoolId}, ${className}, ${subject},
          ${title}, ${lin}, ${qrCode}, ${milestone1Date}, ${milestone1Photo},
          ${milestone1Status === undefined ? "pending" : milestone1Status},
          ${milestone2Date}, ${milestone2Photo},
          ${milestone2Status === undefined ? "pending" : milestone2Status},
          ${finalDate}, ${finalPhoto}, ${finalStatus === undefined ? "pending" : finalStatus},
          ${teacherObservedTick}, ${vivaAudioPath}, ${similarityFlag}, ${previousTitleCheck}
        )
        RETURNING id, learner_id, school_id, class_name, subject, title, lin, qr_code,
                  milestone_1_date, milestone_1_photo, milestone_1_status,
                  milestone_2_date, milestone_2_photo, milestone_2_status,
                  final_date, final_photo, final_status, teacher_observed_tick,
                  viva_audio_path, similarity_flag, previous_title_check, created_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'project.create', 'projects',
               inserted.id, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        FROM inserted
        RETURNING target_id
      )
      SELECT inserted.*
      FROM inserted
      INNER JOIN audit ON audit.target_id = inserted.id
    `;
    return c.json({ project: rows[0] }, 201);
  },
);

learningRoutes.patch(
  "/projects/:id",
  authMiddleware,
  requireRole("teacher", "school", "superadmin"),
  async (c) => {
    const id = routeUuid(c.req.param("id"));
    const body = await readJson(c);
    const fields = [
      "class_name",
      "subject",
      "title",
      "lin",
      "qr_code",
      "milestone_1_date",
      "milestone_1_photo",
      "milestone_1_status",
      "milestone_2_date",
      "milestone_2_photo",
      "milestone_2_status",
      "final_date",
      "final_photo",
      "final_status",
      "teacher_observed_tick",
      "viva_audio_path",
      "similarity_flag",
      "previous_title_check",
    ] as const;
    const has = Object.fromEntries(fields.map((field) => [field, field in body])) as Record<
      (typeof fields)[number],
      boolean
    >;
    if (!fields.some((field) => has[field])) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one project field to update.");
    }
    const user = c.get("user");
    const scopeSchoolId =
      user.role === "teacher" || user.role === "school" ? linkedSchoolId(user) : null;
    const values = {
      class_name: has.class_name ? optionalBodyText(body, "class_name", 120) : null,
      subject: has.subject ? optionalBodyText(body, "subject", 120) : null,
      title: has.title ? optionalBodyText(body, "title", 300) : null,
      lin: has.lin ? optionalBodyText(body, "lin", 80) : null,
      qr_code: has.qr_code ? optionalBodyText(body, "qr_code", 2048) : null,
      milestone_1_date: has.milestone_1_date ? optionalTimestamp(body, "milestone_1_date") : null,
      milestone_1_photo: has.milestone_1_photo
        ? optionalBodyText(body, "milestone_1_photo", 2048)
        : null,
      milestone_1_status: has.milestone_1_status
        ? optionalStatus(body, "milestone_1_status")
        : null,
      milestone_2_date: has.milestone_2_date ? optionalTimestamp(body, "milestone_2_date") : null,
      milestone_2_photo: has.milestone_2_photo
        ? optionalBodyText(body, "milestone_2_photo", 2048)
        : null,
      milestone_2_status: has.milestone_2_status
        ? optionalStatus(body, "milestone_2_status")
        : null,
      final_date: has.final_date ? optionalTimestamp(body, "final_date") : null,
      final_photo: has.final_photo ? optionalBodyText(body, "final_photo", 2048) : null,
      final_status: has.final_status ? optionalStatus(body, "final_status") : null,
      teacher_observed_tick: has.teacher_observed_tick
        ? optionalBoolean(body, "teacher_observed_tick")
        : null,
      viva_audio_path: has.viva_audio_path
        ? optionalBodyText(body, "viva_audio_path", 2048)
        : null,
      similarity_flag: has.similarity_flag ? optionalBoolean(body, "similarity_flag") : null,
      previous_title_check: has.previous_title_check
        ? optionalBodyText(body, "previous_title_check", 4000)
        : null,
    };
    const changedFields = fields.filter((field) => has[field]);
    const metadata = JSON.stringify({ changed_fields: changedFields });
    const sql = getDb(c.env);
    const rows = await sql`
      WITH updated AS (
        UPDATE projects
        SET class_name = CASE WHEN ${has.class_name} THEN ${values.class_name} ELSE class_name END,
            subject = CASE WHEN ${has.subject} THEN ${values.subject} ELSE subject END,
            title = CASE WHEN ${has.title} THEN ${values.title} ELSE title END,
            lin = CASE WHEN ${has.lin} THEN ${values.lin} ELSE lin END,
            qr_code = CASE WHEN ${has.qr_code} THEN ${values.qr_code} ELSE qr_code END,
            milestone_1_date = CASE WHEN ${has.milestone_1_date} THEN ${values.milestone_1_date} ELSE milestone_1_date END,
            milestone_1_photo = CASE WHEN ${has.milestone_1_photo} THEN ${values.milestone_1_photo} ELSE milestone_1_photo END,
            milestone_1_status = CASE WHEN ${has.milestone_1_status} THEN ${values.milestone_1_status} ELSE milestone_1_status END,
            milestone_2_date = CASE WHEN ${has.milestone_2_date} THEN ${values.milestone_2_date} ELSE milestone_2_date END,
            milestone_2_photo = CASE WHEN ${has.milestone_2_photo} THEN ${values.milestone_2_photo} ELSE milestone_2_photo END,
            milestone_2_status = CASE WHEN ${has.milestone_2_status} THEN ${values.milestone_2_status} ELSE milestone_2_status END,
            final_date = CASE WHEN ${has.final_date} THEN ${values.final_date} ELSE final_date END,
            final_photo = CASE WHEN ${has.final_photo} THEN ${values.final_photo} ELSE final_photo END,
            final_status = CASE WHEN ${has.final_status} THEN ${values.final_status} ELSE final_status END,
            teacher_observed_tick = CASE WHEN ${has.teacher_observed_tick} THEN ${values.teacher_observed_tick} ELSE teacher_observed_tick END,
            viva_audio_path = CASE WHEN ${has.viva_audio_path} THEN ${values.viva_audio_path} ELSE viva_audio_path END,
            similarity_flag = CASE WHEN ${has.similarity_flag} THEN ${values.similarity_flag} ELSE similarity_flag END,
            previous_title_check = CASE WHEN ${has.previous_title_check} THEN ${values.previous_title_check} ELSE previous_title_check END
        WHERE id = ${id}
          AND (
            ${user.role === "superadmin"}
            OR (${user.role === "teacher" || user.role === "school"} AND school_id = ${scopeSchoolId})
          )
        RETURNING id, learner_id, school_id, class_name, subject, title, lin, qr_code,
                  milestone_1_date, milestone_1_photo, milestone_1_status,
                  milestone_2_date, milestone_2_photo, milestone_2_status,
                  final_date, final_photo, final_status, teacher_observed_tick,
                  viva_audio_path, similarity_flag, previous_title_check, created_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'project.update', 'projects',
               updated.id, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        FROM updated
        RETURNING target_id
      )
      SELECT updated.*
      FROM updated
      INNER JOIN audit ON audit.target_id = updated.id
    `;
    if (!rows[0]) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found.");
    return c.json({ project: rows[0] });
  },
);

learningRoutes.get(
  "/teacher-retooling-progress/:teacher_id",
  authMiddleware,
  requireRole("teacher", "school", "superadmin"),
  async (c) => {
    const teacherId = routeUuid(c.req.param("teacher_id"), "teacher_id");
    const user = c.get("user");
    if (user.role === "teacher" && teacherId !== user.id) {
      throw new ApiError(403, "FORBIDDEN", "Teachers can only view their own progress.");
    }
    const sql = getDb(c.env);
    const teacher = await requireTeacher(sql, teacherId);
    if (user.role === "school") assertSameSchool(teacher.school_id, linkedSchoolId(user), "teacher progress");
    const rows = await sql`
      SELECT id, teacher_id, module_id, completed, quiz_score, practical_upload_path,
             certificate_issued, completed_at, updated_at
      FROM teacher_retooling_progress
      WHERE teacher_id = ${teacherId}
      ORDER BY module_id ASC
    `;
    return c.json({ progress: rows });
  },
);

learningRoutes.post(
  "/teacher-retooling-progress",
  authMiddleware,
  requireRole("teacher", "school", "superadmin"),
  async (c) => {
    const body = await readJson(c);
    const user = c.get("user");
    const requestedTeacherId = optionalBodyUuid(body, "teacher_id");
    let teacherId: string;
    if (user.role === "teacher") {
      if (requestedTeacherId && requestedTeacherId !== user.id) {
        throw new ApiError(403, "FORBIDDEN", "Teachers can only create their own progress.");
      }
      teacherId = user.id;
    } else {
      if (!requestedTeacherId) {
        throw new ApiError(400, "VALIDATION_ERROR", "teacher_id is required.");
      }
      teacherId = requestedTeacherId;
    }
    const sql = getDb(c.env);
    const teacher = await requireTeacher(sql, teacherId);
    if (user.role === "school") {
      assertSameSchool(teacher.school_id, linkedSchoolId(user), "teacher progress");
    }
    const moduleId = requiredInteger(body, "module_id", { min: 1 });
    const completed = requiredBoolean(body, "completed", false);
    const quizScore = optionalInteger(body, "quiz_score", { min: 0, allowNull: true }) ?? null;
    const practicalUploadPath = optionalBodyText(body, "practical_upload_path", 2048) ?? null;
    const certificateIssued = requiredBoolean(body, "certificate_issued", false);
    const completedAt = optionalTimestamp(body, "completed_at") ?? null;
    const metadata = JSON.stringify({
      teacher_id: teacherId,
      module_id: moduleId,
      completed,
      certificate_issued: certificateIssued,
    });
    const rows = await sql`
      WITH inserted AS (
        INSERT INTO teacher_retooling_progress (
          teacher_id, module_id, completed, quiz_score, practical_upload_path,
          certificate_issued, completed_at
        )
        VALUES (
          ${teacherId}, ${moduleId}, ${completed}, ${quizScore}, ${practicalUploadPath},
          ${certificateIssued}, ${completedAt}
        )
        RETURNING id, teacher_id, module_id, completed, quiz_score, practical_upload_path,
                  certificate_issued, completed_at, updated_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'teacher_retooling_progress.create',
               'teacher_retooling_progress', inserted.id, ${metadata}::jsonb,
               ${requestIp(c.req.raw.headers)}
        FROM inserted
        RETURNING target_id
      )
      SELECT inserted.*
      FROM inserted
      INNER JOIN audit ON audit.target_id = inserted.id
    `;
    return c.json({ progress: rows[0] }, 201);
  },
);

learningRoutes.patch(
  "/teacher-retooling-progress/:id",
  authMiddleware,
  requireRole("teacher", "school", "superadmin"),
  async (c) => {
    const id = routeUuid(c.req.param("id"));
    const body = await readJson(c);
    const fields = [
      "completed",
      "quiz_score",
      "practical_upload_path",
      "certificate_issued",
      "completed_at",
    ] as const;
    const has = Object.fromEntries(fields.map((field) => [field, field in body])) as Record<
      (typeof fields)[number],
      boolean
    >;
    if (!fields.some((field) => has[field])) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Provide at least one teacher retooling progress field to update.",
      );
    }
    const user = c.get("user");
    const scopeSchoolId = user.role === "school" ? linkedSchoolId(user) : null;
    const completed = has.completed ? optionalBoolean(body, "completed") : null;
    const quizScore = has.quiz_score
      ? optionalInteger(body, "quiz_score", { min: 0, allowNull: true })
      : null;
    const practicalUploadPath = has.practical_upload_path
      ? optionalBodyText(body, "practical_upload_path", 2048)
      : null;
    const certificateIssued = has.certificate_issued
      ? optionalBoolean(body, "certificate_issued")
      : null;
    const completedAt = has.completed_at ? optionalTimestamp(body, "completed_at") : null;
    const changedFields = fields.filter((field) => has[field]);
    const metadata = JSON.stringify({ changed_fields: changedFields });
    const sql = getDb(c.env);
    const rows = await sql`
      WITH updated AS (
        UPDATE teacher_retooling_progress AS progress
        SET completed = CASE WHEN ${has.completed} THEN ${completed} ELSE completed END,
            quiz_score = CASE WHEN ${has.quiz_score} THEN ${quizScore ?? null} ELSE quiz_score END,
            practical_upload_path = CASE WHEN ${has.practical_upload_path} THEN ${practicalUploadPath} ELSE practical_upload_path END,
            certificate_issued = CASE WHEN ${has.certificate_issued} THEN ${certificateIssued} ELSE certificate_issued END,
            completed_at = CASE WHEN ${has.completed_at} THEN ${completedAt} ELSE completed_at END,
            updated_at = NOW()
        WHERE progress.id = ${id}
          AND (
            ${user.role === "superadmin"}
            OR (${user.role === "teacher"} AND progress.teacher_id = ${user.id})
            OR (
              ${user.role === "school"}
              AND EXISTS (
                SELECT 1
                FROM users teacher
                WHERE teacher.id = progress.teacher_id
                  AND teacher.role = 'teacher'
                  AND teacher.school_id = ${scopeSchoolId}
              )
            )
          )
        RETURNING progress.id, progress.teacher_id, progress.module_id, progress.completed,
                  progress.quiz_score, progress.practical_upload_path,
                  progress.certificate_issued, progress.completed_at, progress.updated_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'teacher_retooling_progress.update',
               'teacher_retooling_progress', updated.id, ${metadata}::jsonb,
               ${requestIp(c.req.raw.headers)}
        FROM updated
        RETURNING target_id
      )
      SELECT updated.*
      FROM updated
      INNER JOIN audit ON audit.target_id = updated.id
    `;
    if (!rows[0]) {
      throw new ApiError(404, "PROGRESS_NOT_FOUND", "Teacher retooling progress was not found.");
    }
    return c.json({ progress: rows[0] });
  },
);

export default learningRoutes;