import { Hono, type Context } from "hono";
import { authMiddleware } from "../auth.js";
import { ApiError, getDb } from "../db.js";
import { readJson, requiredString } from "../http.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";

const routes = new Hono<AppEnv>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const experimentLevels = ["primary", "o_level", "a_level"] as const;
const sessionStatuses = ["scheduled", "started", "ended"] as const;
const eventTypes = ["draw", "erase", "text", "shape"] as const;
const maxBoardEvents = 2000;
const maxBoardEventBytes = 16_000;
const maxRecordingBase64Chars = 6_000_000;
const maxRecordingSeconds = 180;

type LabLevel = (typeof experimentLevels)[number];
type SessionStatus = (typeof sessionStatuses)[number];
type EventType = (typeof eventTypes)[number];
type Sql = ReturnType<typeof getDb>;

interface LabProfile {
  id: string;
  role: AuthenticatedUser["role"];
  school_id: string | null;
  class_level: string | null;
  assigned_classes: string[] | null;
}

interface LabSession {
  id: string;
  organization_id: string | null;
  experiment_id: string | null;
  teacher_id: string | null;
  class_level: string;
  subject: string;
  title: string;
  status: SessionStatus;
  scheduled_for: string | null;
  started_at: string | null;
  ended_at: string | null;
  jitsi_room: string;
  recording_duration_seconds: number | null;
  created_at: string;
  participant_count?: number;
}

routes.use("*", authMiddleware);

function actor(c: Context<AppEnv>): AuthenticatedUser {
  return c.get("user");
}

function requireRole(
  user: AuthenticatedUser,
  roles: readonly AuthenticatedUser["role"][],
): void {
  if (!roles.includes(user.role)) {
    throw new ApiError(403, "FORBIDDEN", "You do not have permission to do this.");
  }
}

function requiredUuid(value: unknown, key: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid UUID.`);
  }
  return value;
}

function optionalUuid(value: unknown, key: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredUuid(value, key);
}

function getLabLevel(classLevel: string | null | undefined): LabLevel | null {
  const normalized = String(classLevel || "").trim().toUpperCase();
  if (/^P[4-7]$/u.test(normalized)) return "primary";
  if (/^S[1-4]$/u.test(normalized)) return "o_level";
  if (/^S[5-6]$/u.test(normalized)) return "a_level";
  return null;
}

function isValidClassLevel(value: string): boolean {
  return getLabLevel(value) !== null;
}

function getAccessibleLevels(profile: LabProfile, role: AuthenticatedUser["role"]): LabLevel[] {
  if (role === "individual") {
    const level = getLabLevel(profile.class_level);
    return level ? [level] : [];
  }
  if (role === "teacher") {
    return [...new Set((profile.assigned_classes || [])
      .map((classLevel) => getLabLevel(classLevel))
      .filter((level): level is LabLevel => level !== null))];
  }
  if (role === "school" || role === "superadmin") {
    return [...experimentLevels];
  }
  return [...experimentLevels];
}

async function getProfile(sql: Sql, user: AuthenticatedUser): Promise<LabProfile> {
  const rows = await sql`
    SELECT id::text, role, school_id::text, class_level, assigned_classes
    FROM users
    WHERE id = ${user.id}
    LIMIT 1
  `;
  const profile = rows[0] as LabProfile | undefined;
  if (!profile) throw new ApiError(404, "USER_NOT_FOUND", "The signed-in account was not found.");
  return profile;
}

function publicExperiment(row: Record<string, unknown>) {
  return {
    ...row,
    config: row.config || {},
    learning_outcomes: row.learning_outcomes || [],
  };
}

async function getSession(sql: Sql, sessionId: string): Promise<LabSession> {
  const rows = await sql`
    SELECT s.id::text, s.organization_id::text, s.experiment_id::text,
      s.teacher_id::text, s.class_level, s.subject, s.title, s.status,
      s.scheduled_for, s.started_at, s.ended_at, s.jitsi_room,
      s.recording_duration_seconds, s.created_at,
      (SELECT COUNT(*)::int FROM lab_session_attendance a
        WHERE a.session_id = s.id AND a.left_at IS NULL) AS participant_count
    FROM lab_sessions s
    WHERE s.id = ${sessionId}
    LIMIT 1
  `;
  const session = rows[0] as LabSession | undefined;
  if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "The lab session was not found.");
  return session;
}

function isSameOrganization(profile: LabProfile, session: LabSession): boolean {
  return (profile.school_id || null) === (session.organization_id || null);
}

function isSessionOwner(profile: LabProfile, session: LabSession): boolean {
  return session.teacher_id === profile.id;
}

async function hasAttendance(
  sql: Sql,
  sessionId: string,
  userId: string,
  activeOnly = false,
): Promise<boolean> {
  const rows = activeOnly
    ? await sql`
        SELECT 1 FROM lab_session_attendance
        WHERE session_id = ${sessionId} AND student_id = ${userId} AND left_at IS NULL
        LIMIT 1
      `
    : await sql`
        SELECT 1 FROM lab_session_attendance
        WHERE session_id = ${sessionId} AND student_id = ${userId}
        LIMIT 1
      `;
  return rows.length > 0;
}

async function requireSessionViewer(
  sql: Sql,
  user: AuthenticatedUser,
  profile: LabProfile,
  session: LabSession,
  options: { requireAttendance?: boolean; activeAttendance?: boolean } = {},
): Promise<void> {
  if (user.role === "superadmin" || isSessionOwner(profile, session)) return;
  if (user.role === "school" && isSameOrganization(profile, session)) return;
  if (user.role === "individual" && isSameOrganization(profile, session) &&
      profile.class_level?.toUpperCase() === session.class_level.toUpperCase()) {
    if (!options.requireAttendance && session.status !== "ended") return;
    if (await hasAttendance(sql, session.id, profile.id, options.activeAttendance)) return;
  }
  throw new ApiError(404, "SESSION_NOT_FOUND", "The lab session was not found.");
}

function parseStatus(value: string | undefined): SessionStatus | null {
  if (!value) return null;
  if (!(sessionStatuses as readonly string[]).includes(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "status must be scheduled, started, or ended.");
  }
  return value as SessionStatus;
}

function parseScheduledFor(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, "VALIDATION_ERROR", "scheduled_for must be a valid date-time.");
  }
  return new Date(value).toISOString();
}

function validateEvent(value: unknown): { type: EventType; data: Record<string, unknown>; ts: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "event must be an object.");
  }
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string" || !(eventTypes as readonly string[]).includes(event.type)) {
    throw new ApiError(400, "VALIDATION_ERROR", "event.type is not supported.");
  }
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    throw new ApiError(400, "VALIDATION_ERROR", "event.data must be an object.");
  }
  const serialized = JSON.stringify(event.data);
  if (new TextEncoder().encode(serialized).byteLength > maxBoardEventBytes) {
    throw new ApiError(413, "EVENT_TOO_LARGE", "Each whiteboard event must be under 16 KB.");
  }
  const timestamp = typeof event.ts === "number" && Number.isSafeInteger(event.ts)
    ? event.ts
    : Date.now();
  return {
    type: event.type as EventType,
    data: event.data as Record<string, unknown>,
    ts: timestamp,
  };
}

function checkRecordingBody(body: Record<string, unknown>): {
  recording: string;
  duration: number;
} {
  const recording = body.recording_base64;
  if (
    typeof recording !== "string" ||
    recording.length < 16 ||
    recording.length > maxRecordingBase64Chars ||
    recording.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(recording)
  ) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "recording_base64 must be valid base64 and no longer than 6 MB.",
    );
  }
  const duration = body.duration_seconds;
  if (
    typeof duration !== "number" ||
    !Number.isInteger(duration) ||
    duration < 0 ||
    duration > maxRecordingSeconds
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", "duration_seconds must be between 0 and 180.");
  }
  return { recording, duration };
}

routes.get("/experiments", async (c) => {
  const user = actor(c);
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  const levels = getAccessibleLevels(profile, user.role);
  const levelFilter = c.req.query("level");
  const subject = c.req.query("subject")?.trim().slice(0, 80) || null;
  if (levelFilter && !(experimentLevels as readonly string[]).includes(levelFilter)) {
    throw new ApiError(400, "VALIDATION_ERROR", "level must be primary, o_level, or a_level.");
  }
  const visibleLevels = levelFilter
    ? levels.filter((level) => level === levelFilter)
    : levels;
  if (!visibleLevels.length) return c.json({ experiments: [] });
  const rows = subject
    ? await sql`
        SELECT id::text, code, title, subject, level, description, simulator_type,
          config, learning_outcomes, display_order, embed_provider, embed_url, fallback_url, embed_height
        FROM lab_experiments
        WHERE active = TRUE AND level = ANY(${visibleLevels}::text[]) AND subject ILIKE ${subject}
        ORDER BY display_order, title
      `
    : await sql`
        SELECT id::text, code, title, subject, level, description, simulator_type,
          config, learning_outcomes, display_order, embed_provider, embed_url, fallback_url, embed_height
        FROM lab_experiments
        WHERE active = TRUE AND level = ANY(${visibleLevels}::text[])
        ORDER BY display_order, title
      `;
  return c.json({ experiments: (rows as Record<string, unknown>[]).map(publicExperiment) });
});

routes.get("/experiments/:id", async (c) => {
  const user = actor(c);
  const experimentId = requiredUuid(c.req.param("id"), "id");
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  const levels = getAccessibleLevels(profile, user.role);
  if (!levels.length) throw new ApiError(404, "EXPERIMENT_NOT_FOUND", "The experiment was not found.");
  const rows = await sql`
    SELECT id::text, code, title, subject, level, description, simulator_type,
      config, learning_outcomes, display_order, embed_provider, embed_url, fallback_url, embed_height
    FROM lab_experiments
    WHERE id = ${experimentId} AND active = TRUE AND level = ANY(${levels}::text[])
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(404, "EXPERIMENT_NOT_FOUND", "The experiment was not found.");
  return c.json({ experiment: publicExperiment(rows[0] as Record<string, unknown>) });
});

routes.post("/progress", async (c) => {
  const user = actor(c);
  requireRole(user, ["individual"]);
  const body = await readJson(c);
  const experimentId = requiredUuid(body.experiment_id, "experiment_id");
  const score = body.score;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
    throw new ApiError(400, "VALIDATION_ERROR", "score must be an integer from 0 to 100.");
  }
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  const level = getLabLevel(profile.class_level);
  if (!level) throw new ApiError(403, "CLASS_LEVEL_REQUIRED", "A supported class level is required.");
  const experimentRows = await sql`
    SELECT id FROM lab_experiments
    WHERE id = ${experimentId} AND active = TRUE AND level = ${level}
    LIMIT 1
  `;
  if (!experimentRows[0]) throw new ApiError(404, "EXPERIMENT_NOT_FOUND", "The experiment was not found.");
  const rows = await sql`
    INSERT INTO lab_progress
      (student_id, experiment_id, attempts, last_score, best_score, completed, completed_at, updated_at)
    VALUES (${profile.id}, ${experimentId}, 1, ${score}, ${score}, TRUE, NOW(), NOW())
    ON CONFLICT (student_id, experiment_id) DO UPDATE SET
      attempts = lab_progress.attempts + 1,
      last_score = EXCLUDED.last_score,
      best_score = GREATEST(lab_progress.best_score, EXCLUDED.best_score),
      completed = TRUE,
      completed_at = COALESCE(lab_progress.completed_at, NOW()),
      updated_at = NOW()
    RETURNING id::text, student_id::text, experiment_id::text, attempts, last_score,
      best_score, completed, completed_at, updated_at
  `;
  return c.json({ progress: rows[0] }, 201);
});

routes.get("/progress/me", async (c) => {
  const user = actor(c);
  requireRole(user, ["individual"]);
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  const level = getLabLevel(profile.class_level);
  if (!level) return c.json({ progress: [] });
  const rows = await sql`
    SELECT e.id::text AS experiment_id, e.code, e.title, e.subject, e.level,
      COALESCE(p.attempts, 0) AS attempts, p.last_score, p.best_score,
      COALESCE(p.completed, FALSE) AS completed, p.completed_at, p.updated_at
    FROM lab_experiments e
    LEFT JOIN lab_progress p ON p.experiment_id = e.id AND p.student_id = ${profile.id}
    WHERE e.active = TRUE AND e.level = ${level}
    ORDER BY e.display_order, e.title
  `;
  return c.json({ progress: rows });
});

routes.get("/progress/class", async (c) => {
  const user = actor(c);
  requireRole(user, ["teacher", "school"]);
  const classLevel = c.req.query("level")?.trim() || "";
  if (!isValidClassLevel(classLevel)) {
    throw new ApiError(400, "VALIDATION_ERROR", "level must be a supported class such as P4 or S2.");
  }
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  if (!profile.school_id) {
    throw new ApiError(403, "SCHOOL_REQUIRED", "A school assignment is required to view class progress.");
  }
  if (user.role === "teacher" && !(profile.assigned_classes || []).some(
    (value) => value.toUpperCase() === classLevel.toUpperCase(),
  )) {
    throw new ApiError(403, "CLASS_ACCESS_REQUIRED", "This class is not assigned to you.");
  }
  const rows = user.role === "teacher"
    ? await sql`
        SELECT u.id::text AS student_id, u.name AS student_name, u.class_level,
          p.experiment_id::text, e.code, e.title, p.attempts, p.last_score,
          p.best_score, p.completed, p.completed_at, p.updated_at
        FROM users u
        LEFT JOIN lab_progress p ON p.student_id = u.id
        LEFT JOIN lab_experiments e ON e.id = p.experiment_id
        WHERE u.role = 'individual' AND u.school_id IS NOT DISTINCT FROM ${profile.school_id}::uuid
          AND UPPER(u.class_level) = UPPER(${classLevel})
        ORDER BY u.name, e.display_order NULLS FIRST, e.title
      `
    : await sql`
        SELECT u.id::text AS student_id, u.name AS student_name, u.class_level,
          p.experiment_id::text, e.code, e.title, p.attempts, p.last_score,
          p.best_score, p.completed, p.completed_at, p.updated_at
        FROM users u
        LEFT JOIN lab_progress p ON p.student_id = u.id
        LEFT JOIN lab_experiments e ON e.id = p.experiment_id
        WHERE u.role = 'individual' AND u.school_id = ${profile.school_id}::uuid
          AND UPPER(u.class_level) = UPPER(${classLevel})
        ORDER BY u.name, e.display_order NULLS FIRST, e.title
      `;
  return c.json({ progress: rows });
});

routes.post("/sessions", async (c) => {
  const user = actor(c);
  requireRole(user, ["teacher", "school", "superadmin"]);
  const body = await readJson(c);
  const title = requiredString(body, "title", { min: 2, max: 200 });
  const classLevel = requiredString(body, "class_level", { min: 2, max: 8 }).toUpperCase();
  if (!isValidClassLevel(classLevel)) {
    throw new ApiError(400, "VALIDATION_ERROR", "class_level must be P4-P7 or S1-S6.");
  }
  const subject = requiredString(body, "subject", { max: 80 });
  const scheduledFor = parseScheduledFor(body.scheduled_for);
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  if (user.role === "teacher" && !(profile.assigned_classes || []).some(
    (value) => value.toUpperCase() === classLevel,
  )) {
    throw new ApiError(403, "CLASS_ACCESS_REQUIRED", "This class is not assigned to you.");
  }
  const experimentId = optionalUuid(body.experiment_id, "experiment_id");
  if (experimentId) {
    const experiment = await sql`
      SELECT level FROM lab_experiments
      WHERE id = ${experimentId} AND active = TRUE
      LIMIT 1
    `;
    if (!experiment[0] || experiment[0].level !== getLabLevel(classLevel)) {
      throw new ApiError(400, "EXPERIMENT_LEVEL_MISMATCH", "The experiment does not match this class level.");
    }
  }
  let organizationId = profile.school_id;
  if (user.role === "superadmin") {
    organizationId = optionalUuid(body.organization_id, "organization_id");
  }
  let teacherId = profile.id;
  if (user.role !== "teacher") {
    if (!organizationId) {
      throw new ApiError(400, "ORGANIZATION_REQUIRED", "An organization is required when staff create a session.");
    }
    const requestedTeacherId = requiredUuid(body.teacher_id, "teacher_id");
    const teacherRows = await sql`
      SELECT id::text
      FROM users
      WHERE id = ${requestedTeacherId}::uuid
        AND role = 'teacher'
        AND school_id = ${organizationId}::uuid
        AND ${classLevel} = ANY(COALESCE(assigned_classes, ARRAY[]::text[]))
      LIMIT 1
    `;
    if (!teacherRows[0]) {
      throw new ApiError(404, "TEACHER_NOT_ASSIGNED", "The selected teacher is not assigned to this class and organization.");
    }
    teacherId = String(teacherRows[0].id);
  }
  const sessionId = crypto.randomUUID();
  const roomSuffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const room = `lab-${sessionId.replaceAll("-", "").slice(0, 18)}-${roomSuffix}`;
  const rows = await sql`
    INSERT INTO lab_sessions
      (id, organization_id, experiment_id, teacher_id, class_level, subject, title,
        status, scheduled_for, jitsi_room)
    VALUES (${sessionId}, ${organizationId}::uuid, ${experimentId}::uuid, ${teacherId}::uuid,
      ${classLevel}, ${subject}, ${title}, 'scheduled', ${scheduledFor}::timestamptz, ${room})
    RETURNING id::text, organization_id::text, experiment_id::text, teacher_id::text,
      class_level, subject, title, status, scheduled_for, started_at, ended_at,
      jitsi_room, recording_duration_seconds, created_at
  `;
  return c.json({ session: rows[0] }, 201);
});

routes.get("/sessions", async (c) => {
  const user = actor(c);
  const status = parseStatus(c.req.query("status"));
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  let rows: unknown[];
  if (user.role === "teacher") {
    rows = await sql`
      SELECT s.id::text, s.organization_id::text, s.experiment_id::text,
        s.teacher_id::text, s.class_level, s.subject, s.title, s.status,
        s.scheduled_for, s.started_at, s.ended_at, s.jitsi_room,
        s.recording_duration_seconds, s.created_at,
        (SELECT COUNT(*)::int FROM lab_session_attendance a
          WHERE a.session_id = s.id AND a.left_at IS NULL) AS participant_count
      FROM lab_sessions s
      WHERE s.teacher_id = ${profile.id} AND (${status}::text IS NULL OR s.status = ${status})
      ORDER BY COALESCE(s.scheduled_for, s.created_at) DESC
      LIMIT 200
    `;
  } else if (user.role === "school") {
    rows = await sql`
      SELECT s.id::text, s.organization_id::text, s.experiment_id::text,
        s.teacher_id::text, s.class_level, s.subject, s.title, s.status,
        s.scheduled_for, s.started_at, s.ended_at, s.jitsi_room,
        s.recording_duration_seconds, s.created_at,
        (SELECT COUNT(*)::int FROM lab_session_attendance a
          WHERE a.session_id = s.id AND a.left_at IS NULL) AS participant_count
      FROM lab_sessions s
      WHERE s.organization_id = ${profile.school_id}::uuid
        AND (${status}::text IS NULL OR s.status = ${status})
      ORDER BY COALESCE(s.scheduled_for, s.created_at) DESC
      LIMIT 200
    `;
  } else if (user.role === "superadmin") {
    rows = await sql`
      SELECT s.id::text, s.organization_id::text, s.experiment_id::text,
        s.teacher_id::text, s.class_level, s.subject, s.title, s.status,
        s.scheduled_for, s.started_at, s.ended_at, s.jitsi_room,
        s.recording_duration_seconds, s.created_at,
        (SELECT COUNT(*)::int FROM lab_session_attendance a
          WHERE a.session_id = s.id AND a.left_at IS NULL) AS participant_count
      FROM lab_sessions s
      WHERE (${status}::text IS NULL OR s.status = ${status})
      ORDER BY COALESCE(s.scheduled_for, s.created_at) DESC
      LIMIT 200
    `;
  } else if (user.role === "individual") {
    rows = await sql`
      SELECT s.id::text, s.organization_id::text, s.experiment_id::text,
        s.teacher_id::text, s.class_level, s.subject, s.title, s.status,
        s.scheduled_for, s.started_at, s.ended_at, s.jitsi_room,
        s.recording_duration_seconds, s.created_at,
        (SELECT COUNT(*)::int FROM lab_session_attendance a
          WHERE a.session_id = s.id AND a.left_at IS NULL) AS participant_count
      FROM lab_sessions s
      WHERE UPPER(s.class_level) = UPPER(${profile.class_level})
        AND s.organization_id IS NOT DISTINCT FROM ${profile.school_id}::uuid
        AND (s.status <> 'ended' OR EXISTS (
          SELECT 1 FROM lab_session_attendance mine
          WHERE mine.session_id = s.id AND mine.student_id = ${profile.id}
        ))
        AND (${status}::text IS NULL OR s.status = ${status})
      ORDER BY COALESCE(s.scheduled_for, s.created_at) DESC
      LIMIT 200
    `;
  } else {
    rows = [];
  }
  return c.json({ sessions: rows });
});

routes.get("/sessions/:id", async (c) => {
  const user = actor(c);
  const sessionId = requiredUuid(c.req.param("id"), "id");
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  const session = await getSession(sql, sessionId);
  await requireSessionViewer(sql, user, profile, session);
  const attendanceRows = user.role === "individual"
    ? await sql`
        SELECT joined_at, left_at, duration_seconds
        FROM lab_session_attendance
        WHERE session_id = ${sessionId} AND student_id = ${profile.id}
        LIMIT 1
      `
    : [];
  return c.json({
    session,
    attendance: attendanceRows[0] || null,
    participant_count: session.participant_count || 0,
  });
});

routes.post("/sessions/:id/start", async (c) => {
  const user = actor(c);
  requireRole(user, ["teacher"]);
  const sessionId = requiredUuid(c.req.param("id"), "id");
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  const rows = await sql`
    UPDATE lab_sessions
    SET status = 'started', started_at = NOW()
    WHERE id = ${sessionId} AND teacher_id = ${profile.id} AND status = 'scheduled'
    RETURNING id::text, organization_id::text, experiment_id::text, teacher_id::text,
      class_level, subject, title, status, scheduled_for, started_at, ended_at,
      jitsi_room, recording_duration_seconds, created_at
  `;
  if (!rows[0]) throw new ApiError(404, "SESSION_NOT_STARTABLE", "The session was not found or is not scheduled.");
  const session = rows[0] as LabSession;
  return c.json({
    session,
    jitsi_url: `https://meet.jit.si/${encodeURIComponent(session.jitsi_room)}`,
  });
});

routes.post("/sessions/:id/end", async (c) => {
  const user = actor(c);
  requireRole(user, ["teacher"]);
  const sessionId = requiredUuid(c.req.param("id"), "id");
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  const rows = await sql`
    UPDATE lab_sessions
    SET status = 'ended', ended_at = NOW()
    WHERE id = ${sessionId} AND teacher_id = ${profile.id} AND status = 'started'
    RETURNING id::text, organization_id::text, experiment_id::text, teacher_id::text,
      class_level, subject, title, status, scheduled_for, started_at, ended_at,
      jitsi_room, recording_duration_seconds, created_at
  `;
  if (!rows[0]) throw new ApiError(404, "SESSION_NOT_ENDABLE", "The session was not found or is not active.");
  await sql`
    UPDATE lab_session_attendance
    SET left_at = NOW(),
      duration_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - joined_at)))::int)
    WHERE session_id = ${sessionId} AND left_at IS NULL
  `;
  return c.json({ session: rows[0] });
});

routes.post("/sessions/:id/board-event", async (c) => {
  const user = actor(c);
  requireRole(user, ["teacher", "individual"]);
  const sessionId = requiredUuid(c.req.param("id"), "id");
  const body = await readJson(c);
  const event = validateEvent(body.event);
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  const session = await getSession(sql, sessionId);
  if (user.role === "individual") {
    await requireSessionViewer(sql, user, profile, session, { requireAttendance: true, activeAttendance: true });
  } else if (!isSessionOwner(profile, session)) {
    throw new ApiError(404, "SESSION_NOT_FOUND", "The lab session was not found.");
  }
  const eventJson = JSON.stringify(event);
  const rows = await sql`
    UPDATE lab_sessions
    SET board_events = COALESCE(board_events, '[]'::jsonb) ||
      jsonb_build_array(jsonb_set(
        ${eventJson}::jsonb,
        '{seq}',
        to_jsonb(jsonb_array_length(COALESCE(board_events, '[]'::jsonb)) + 1),
        TRUE
      ))
    WHERE id = ${sessionId} AND status = 'started'
      AND jsonb_array_length(COALESCE(board_events, '[]'::jsonb)) < ${maxBoardEvents}
    RETURNING jsonb_array_length(board_events) AS event_count, board_events->-1 AS event
  `;
  if (!rows[0]) {
    const state = await sql`
      SELECT status, jsonb_array_length(COALESCE(board_events, '[]'::jsonb)) AS event_count
      FROM lab_sessions WHERE id = ${sessionId} LIMIT 1
    `;
    if (state[0]?.status !== "started") {
      throw new ApiError(409, "SESSION_NOT_STARTED", "The whiteboard is available while the session is active.");
    }
    throw new ApiError(409, "BOARD_EVENT_LIMIT", "This session has reached its 2,000-event limit.");
  }
  return c.json({ event_count: rows[0].event_count, event: rows[0].event }, 201);
});

routes.get("/sessions/:id/board-events", async (c) => {
  const user = actor(c);
  const sessionId = requiredUuid(c.req.param("id"), "id");
  const sinceText = c.req.query("since") || "0";
  const since = Number(sinceText);
  if (!Number.isInteger(since) || since < 0 || since > maxBoardEvents) {
    throw new ApiError(400, "VALIDATION_ERROR", "since must be a whiteboard event cursor from 0 to 2000.");
  }
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  const session = await getSession(sql, sessionId);
  if (user.role === "individual") {
    await requireSessionViewer(sql, user, profile, session, { requireAttendance: true });
  } else if (user.role !== "superadmin" && !isSessionOwner(profile, session)) {
    throw new ApiError(404, "SESSION_NOT_FOUND", "The lab session was not found.");
  }
  const rows = await sql`
    SELECT
      COALESCE((
        SELECT jsonb_agg(item.event ORDER BY item.ordinality)
        FROM jsonb_array_elements(COALESCE(s.board_events, '[]'::jsonb))
          WITH ORDINALITY AS item(event, ordinality)
        WHERE item.ordinality > ${since}
      ), '[]'::jsonb) AS events,
      jsonb_array_length(COALESCE(s.board_events, '[]'::jsonb)) AS event_count
    FROM lab_sessions s
    WHERE s.id = ${sessionId}
    LIMIT 1
  `;
  return c.json({ events: rows[0]?.events || [], event_count: rows[0]?.event_count || 0 });
});

routes.post("/sessions/:id/attendance/join", async (c) => {
  const user = actor(c);
  requireRole(user, ["individual"]);
  const sessionId = requiredUuid(c.req.param("id"), "id");
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  const session = await getSession(sql, sessionId);
  if (
    session.status !== "started" ||
    !isSameOrganization(profile, session) ||
    profile.class_level?.toUpperCase() !== session.class_level.toUpperCase()
  ) {
    throw new ApiError(404, "SESSION_NOT_AVAILABLE", "This live session is not available to your class.");
  }
  const rows = await sql`
    INSERT INTO lab_session_attendance (session_id, student_id, joined_at, left_at, duration_seconds)
    VALUES (${sessionId}, ${profile.id}, NOW(), NULL, NULL)
    ON CONFLICT (session_id, student_id) DO UPDATE SET
      joined_at = CASE
        WHEN lab_session_attendance.left_at IS NOT NULL THEN NOW()
        ELSE lab_session_attendance.joined_at
      END,
      left_at = NULL,
      duration_seconds = CASE
        WHEN lab_session_attendance.left_at IS NOT NULL THEN NULL
        ELSE lab_session_attendance.duration_seconds
      END
    RETURNING joined_at, left_at, duration_seconds
  `;
  return c.json({ attendance: rows[0] }, 201);
});

routes.post("/sessions/:id/attendance/leave", async (c) => {
  const user = actor(c);
  requireRole(user, ["individual"]);
  const sessionId = requiredUuid(c.req.param("id"), "id");
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  const rows = await sql`
    UPDATE lab_session_attendance
    SET left_at = NOW(),
      duration_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - joined_at)))::int)
    WHERE session_id = ${sessionId} AND student_id = ${profile.id} AND left_at IS NULL
    RETURNING joined_at, left_at, duration_seconds
  `;
  if (!rows[0]) throw new ApiError(404, "ATTENDANCE_NOT_FOUND", "No active attendance record was found.");
  return c.json({ attendance: rows[0] });
});

routes.post("/sessions/:id/recording", async (c) => {
  const user = actor(c);
  requireRole(user, ["teacher"]);
  const sessionId = requiredUuid(c.req.param("id"), "id");
  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > 8_000_000) {
    throw new ApiError(413, "RECORDING_TOO_LARGE", "The recording request exceeds the upload limit.");
  }
  const body = await readJson(c);
  const { recording, duration } = checkRecordingBody(body);
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  const rows = await sql`
    UPDATE lab_sessions
    SET recording_base64 = ${recording}, recording_duration_seconds = ${duration}
    WHERE id = ${sessionId} AND teacher_id = ${profile.id} AND status IN ('started', 'ended')
    RETURNING id::text, status, recording_duration_seconds
  `;
  if (!rows[0]) throw new ApiError(404, "SESSION_NOT_RECORDABLE", "The session was not found or has not started.");
  return c.json({ session: rows[0] }, 201);
});

routes.get("/sessions/:id/recording", async (c) => {
  const user = actor(c);
  const sessionId = requiredUuid(c.req.param("id"), "id");
  const sql = getDb(c.env);
  const profile = await getProfile(sql, user);
  const session = await getSession(sql, sessionId);
  if (
    user.role !== "superadmin" &&
    !isSessionOwner(profile, session) &&
    !(user.role === "individual" && await hasAttendance(sql, sessionId, profile.id))
  ) {
    throw new ApiError(404, "SESSION_NOT_FOUND", "The lab session was not found.");
  }
  const rows = await sql`
    SELECT recording_base64, recording_duration_seconds
    FROM lab_sessions
    WHERE id = ${sessionId} AND recording_base64 IS NOT NULL
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(404, "RECORDING_NOT_FOUND", "No recording is available for this session.");
  c.header("Cache-Control", "no-store");
  return c.json({
    recording_base64: rows[0].recording_base64,
    duration_seconds: rows[0].recording_duration_seconds,
    mime_type: "video/webm",
  });
});

export default routes;
