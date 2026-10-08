import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware } from "../auth.js";
import { ApiError, getDb, requireEnv } from "../db.js";
import { readJson } from "../http.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";

type JsonRecord = Record<string, unknown>;
type VideoProject = {
  id: string;
  organization_id: string | null;
  created_by: string;
  title: string;
  description: string | null;
  sector: string;
  language: string;
  visibility: "draft" | "published";
  duration_seconds: number;
  scenes: unknown[];
  thumbnail_base64: string | null;
  published_url: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};
type VideoLibraryItem = {
  id: string;
  organization_id: string | null;
  project_id: string | null;
  title: string;
  description: string | null;
  category: string | null;
  sector: string;
  url: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  language: string;
  tags: string[] | null;
  created_by: string | null;
  views: number;
  created_at: string;
};
type VideoScene = {
  id: string;
  title: string;
  body: string;
  background_type: "color" | "image" | "video";
  background_value: string;
  background_asset_url: string | null;
  background_page_url: string | null;
  background_user: string | null;
  background_tags: string | null;
  voiceover_text: string;
  voiceover_audio_base64: string | null;
  voiceover_audio_name: string | null;
  duration_seconds: number;
};
type Sql = ReturnType<typeof getDb>;

const routes = new Hono<AppEnv>();
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sectors = new Set(["education", "mfi", "clinic", "farm"]);
const roles = new Set(["teacher", "school"]);
const maxAudioBytes = 1 * 1024 * 1024;
const maxScenesBytes = 24 * 1024 * 1024;
const commonVoices = [
  { name: "English (United States)", lang: "en-US" },
  { name: "English (United Kingdom)", lang: "en-GB" },
  { name: "Luganda", lang: "lg-UG" },
  { name: "Runyankole", lang: "nyn-UG" },
  { name: "Ateso", lang: "teo-UG" },
  { name: "Acholi", lang: "ach-UG" },
  { name: "Swahili", lang: "sw-UG" },
];

routes.use("*", authMiddleware);

function actor(c: Context<AppEnv>): AuthenticatedUser {
  return c.get("user");
}

function ensureStudioAccess(user: AuthenticatedUser): void {
  if (user.role === "superadmin") return;
  if (!roles.has(user.role) || user.sector !== "education") {
    throw new ApiError(
      403,
      "VIDEO_STUDIO_ACCESS_REQUIRED",
      "Video Studio is available to education teachers, school admins, and Super Admins.",
    );
  }
}

function ensureStudioWriter(user: AuthenticatedUser): void {
  ensureStudioAccess(user);
  if (!roles.has(user.role) && user.role !== "superadmin") {
    throw new ApiError(403, "FORBIDDEN", "You do not have permission to manage videos.");
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathUuid(value: string): string {
  if (!uuidPattern.test(value)) {
    throw new ApiError(400, "INVALID_ID", "The video ID is invalid.");
  }
  return value;
}

function cleanText(value: unknown, field: string, max: number, min = 0): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be text.`);
  }
  const text = value.trim();
  if (text.length < min || text.length > max) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `${field} must be between ${min} and ${max} characters.`,
    );
  }
  return text;
}

function optionalText(
  body: JsonRecord,
  field: string,
  max: number,
  allowNull = false,
): string | null | undefined {
  if (!(field in body)) return undefined;
  if (body[field] === null && allowNull) return null;
  return cleanText(body[field], field, max);
}

function safeHttpsUrl(value: unknown, field: string, max = 2048): string {
  if (typeof value !== "string" || value.length > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid HTTPS URL.`);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname) {
      throw new Error("HTTPS required");
    }
    return url.toString();
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid HTTPS URL.`);
  }
}

function safeMediaUrl(value: unknown, field: string, max = 2048): string {
  if (typeof value !== "string" || value.length > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid HTTP or HTTPS URL.`);
  }
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname) {
      throw new Error("HTTP(S) required");
    }
    return url.toString();
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid HTTP or HTTPS URL.`);
  }
}

function safeYouTubeUrl(value: unknown, field = "published_url"): string {
  const urlText = safeHttpsUrl(value, field);
  const url = new URL(urlText);
  const host = url.hostname.toLowerCase();
  const allowed =
    host === "youtu.be" ||
    host.endsWith(".youtu.be") ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com");
  if (!allowed) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a YouTube HTTPS URL.`);
  }
  const hasVideoId =
    (host === "youtu.be" && url.pathname.length > 1) ||
    url.searchParams.has("v") ||
    /^\/(?:embed|shorts)\/[^/]+/u.test(url.pathname);
  if (!hasVideoId) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must include a YouTube video ID.`);
  }
  return urlText;
}

function base64Bytes(value: string, mimePattern: RegExp): number | null {
  const match = value.match(/^data:([^;,]+);base64,([a-z0-9+/]*={0,2})$/iu);
  if (!match || !mimePattern.test(match[1] ?? "")) return null;
  const encoded = match[2] ?? "";
  if (!encoded || encoded.length % 4 !== 0) return null;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, (encoded.length * 3) / 4 - padding);
}

function safeSceneBackgroundUrl(value: unknown, field: string): string {
  if (typeof value === "string" && value.startsWith("data:")) {
    const bytes = base64Bytes(value, /^image\/(?:png|jpeg|webp)$/iu);
    if (bytes === null || bytes > 300 * 1024) {
      throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a PNG, JPEG, or WebP image up to 300 KB.`);
    }
    return value;
  }
  return safeMediaUrl(value, field);
}

function validateThumbnail(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", "thumbnail_base64 must be an image data URL.");
  }
  const bytes = base64Bytes(value, /^image\/(?:png|jpe?g|webp)$/iu);
  if (bytes === null || bytes > 300 * 1024) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "thumbnail_base64 must be a valid PNG, JPEG, or WebP image under 300 KB.",
    );
  }
  return value;
}

function validateAudioDataUrl(value: unknown, filename = ""): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", "Voiceover audio must be an audio data URL.");
  }
  const dataUrlBytes = base64Bytes(
    value,
    /^audio\/(?:mpeg|mp3|wav|x-wav|wave|mp4|m4a|x-m4a)$/iu,
  );
  const rawBytes =
    /^[a-z0-9+/]+={0,2}$/iu.test(value) && value.length % 4 === 0
      ? Math.max(0, (value.length * 3) / 4 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0))
      : null;
  const extension = filename.split(".").pop()?.toLowerCase();
  const validRawFormat = ["mp3", "wav", "m4a"].includes(extension ?? "");
  const bytes = dataUrlBytes ?? (validRawFormat ? rawBytes : null);
  if (bytes === null || bytes > maxAudioBytes) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Each scene voiceover must be a valid MP3, WAV, or M4A file up to 1 MB.",
    );
  }
  return value;
}

function validateScenes(value: unknown): VideoScene[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new ApiError(400, "VALIDATION_ERROR", "scenes must be an array with at most 100 items.");
  }
  const scenes = value.map((entry, index): VideoScene => {
    if (!isRecord(entry)) {
      throw new ApiError(400, "VALIDATION_ERROR", `Scene ${index + 1} must be an object.`);
    }
    const id =
      typeof entry.id === "string" && entry.id.length <= 80
        ? entry.id
        : crypto.randomUUID();
    const backgroundType =
      entry.background_type === "image" || entry.background_type === "video"
        ? entry.background_type
        : "color";
    const backgroundValue =
      typeof entry.background_value === "string" ? entry.background_value.trim() : "#246b56";
    let assetUrl: string | null = null;
    if (backgroundType === "color") {
      if (!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/iu.test(backgroundValue)) {
        throw new ApiError(400, "VALIDATION_ERROR", `Scene ${index + 1} background color is invalid.`);
      }
    } else {
      assetUrl = safeSceneBackgroundUrl(
        entry.background_asset_url ?? entry.background_value,
        `Scene ${index + 1} background_asset_url`,
      );
    }
    const duration =
      typeof entry.duration_seconds === "number" &&
      Number.isInteger(entry.duration_seconds) &&
      entry.duration_seconds >= 3 &&
      entry.duration_seconds <= 30
        ? entry.duration_seconds
        : 8;
    const audioName =
      typeof entry.voiceover_audio_name === "string"
        ? entry.voiceover_audio_name.trim().slice(0, 255)
        : null;
    return {
      id,
      title: typeof entry.title === "string" ? entry.title.trim().slice(0, 180) : "",
      body: typeof entry.body === "string" ? entry.body.trim().slice(0, 4000) : "",
      background_type: backgroundType,
      background_value: backgroundType === "color" ? backgroundValue : "",
      background_asset_url: assetUrl,
      background_page_url:
        typeof entry.background_page_url === "string" && entry.background_page_url.length <= 2048
          ? safeHttpsUrl(entry.background_page_url, `Scene ${index + 1} attribution URL`)
          : null,
      background_user:
        typeof entry.background_user === "string" ? entry.background_user.trim().slice(0, 120) : null,
      background_tags:
        typeof entry.background_tags === "string" ? entry.background_tags.trim().slice(0, 250) : null,
      voiceover_text:
        typeof entry.voiceover_text === "string"
          ? entry.voiceover_text.trim().slice(0, 4000)
          : "",
      voiceover_audio_base64: validateAudioDataUrl(entry.voiceover_audio_base64, audioName ?? ""),
      voiceover_audio_name: audioName,
      duration_seconds: duration,
    };
  });
  if (JSON.stringify(scenes).length > maxScenesBytes) {
    throw new ApiError(
      413,
      "SCENES_TOO_LARGE",
      "Scene data exceeds 24 MB. Remove some audio files before saving.",
    );
  }
  return scenes;
}

function durationForScenes(scenes: VideoScene[]): number {
  return scenes.reduce((total, scene) => total + scene.duration_seconds, 0);
}

function parseLanguage(value: unknown, field = "language"): string {
  const language = cleanText(value, field, 30, 2);
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/iu.test(language)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a language code such as en or lg-UG.`);
  }
  return language;
}

function routeSector(user: AuthenticatedUser, value?: unknown): string {
  const sector = value === undefined ? user.sector : value;
  if (typeof sector !== "string" || !sectors.has(sector)) {
    throw new ApiError(400, "VALIDATION_ERROR", "sector must be education, mfi, clinic, or farm.");
  }
  if (user.role !== "superadmin" && sector !== user.sector) {
    throw new ApiError(403, "FORBIDDEN", "You cannot create a video for another sector.");
  }
  return sector;
}

async function findProject(
  sql: Sql,
  user: AuthenticatedUser,
  id: string,
): Promise<VideoProject | null> {
  let rows;
  if (user.role === "superadmin") {
    rows = await sql`SELECT * FROM video_projects WHERE id = ${id} LIMIT 1`;
  } else if (user.role === "school" && user.schoolId) {
    rows = await sql`
      SELECT * FROM video_projects
      WHERE id = ${id} AND organization_id = ${user.schoolId}
      LIMIT 1
    `;
  } else {
    rows = await sql`
      SELECT * FROM video_projects
      WHERE id = ${id} AND created_by = ${user.id}
      LIMIT 1
    `;
  }
  return (rows[0] as VideoProject | undefined) ?? null;
}

async function updateProject(
  sql: Sql,
  user: AuthenticatedUser,
  id: string,
  values: {
    title: string | undefined;
    description: string | null | undefined;
    language: string | undefined;
    scenes: VideoScene[] | undefined;
    thumbnail: string | null | undefined;
    visibility: "draft" | "published";
    publishedUrl: string | null;
  },
  current: VideoProject,
): Promise<VideoProject | null> {
  const scenesJson = values.scenes === undefined ? null : JSON.stringify(values.scenes);
  const totalDuration = values.scenes ? durationForScenes(values.scenes) : current.duration_seconds;
  let rows;
  if (user.role === "superadmin") {
    rows = await sql`
      UPDATE video_projects SET
        title = CASE WHEN ${values.title !== undefined} THEN ${values.title ?? ""} ELSE title END,
        description = CASE WHEN ${values.description !== undefined} THEN ${values.description} ELSE description END,
        language = CASE WHEN ${values.language !== undefined} THEN ${values.language ?? ""} ELSE language END,
        scenes = CASE WHEN ${values.scenes !== undefined} THEN ${scenesJson}::jsonb ELSE scenes END,
        duration_seconds = CASE WHEN ${values.scenes !== undefined} THEN ${totalDuration} ELSE duration_seconds END,
        thumbnail_base64 = CASE WHEN ${values.thumbnail !== undefined} THEN ${values.thumbnail} ELSE thumbnail_base64 END,
        visibility = ${values.visibility},
        published_url = ${values.publishedUrl},
        published_at = CASE
          WHEN ${values.visibility === "published"} THEN COALESCE(published_at, NOW())
          ELSE NULL
        END,
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
  } else if (user.role === "school" && user.schoolId) {
    rows = await sql`
      UPDATE video_projects SET
        title = CASE WHEN ${values.title !== undefined} THEN ${values.title ?? ""} ELSE title END,
        description = CASE WHEN ${values.description !== undefined} THEN ${values.description} ELSE description END,
        language = CASE WHEN ${values.language !== undefined} THEN ${values.language ?? ""} ELSE language END,
        scenes = CASE WHEN ${values.scenes !== undefined} THEN ${scenesJson}::jsonb ELSE scenes END,
        duration_seconds = CASE WHEN ${values.scenes !== undefined} THEN ${totalDuration} ELSE duration_seconds END,
        thumbnail_base64 = CASE WHEN ${values.thumbnail !== undefined} THEN ${values.thumbnail} ELSE thumbnail_base64 END,
        visibility = ${values.visibility},
        published_url = ${values.publishedUrl},
        published_at = CASE
          WHEN ${values.visibility === "published"} THEN COALESCE(published_at, NOW())
          ELSE NULL
        END,
        updated_at = NOW()
      WHERE id = ${id} AND organization_id = ${user.schoolId}
      RETURNING *
    `;
  } else {
    rows = await sql`
      UPDATE video_projects SET
        title = CASE WHEN ${values.title !== undefined} THEN ${values.title ?? ""} ELSE title END,
        description = CASE WHEN ${values.description !== undefined} THEN ${values.description} ELSE description END,
        language = CASE WHEN ${values.language !== undefined} THEN ${values.language ?? ""} ELSE language END,
        scenes = CASE WHEN ${values.scenes !== undefined} THEN ${scenesJson}::jsonb ELSE scenes END,
        duration_seconds = CASE WHEN ${values.scenes !== undefined} THEN ${totalDuration} ELSE duration_seconds END,
        thumbnail_base64 = CASE WHEN ${values.thumbnail !== undefined} THEN ${values.thumbnail} ELSE thumbnail_base64 END,
        visibility = ${values.visibility},
        published_url = ${values.publishedUrl},
        published_at = CASE
          WHEN ${values.visibility === "published"} THEN COALESCE(published_at, NOW())
          ELSE NULL
        END,
        updated_at = NOW()
      WHERE id = ${id} AND created_by = ${user.id}
      RETURNING *
    `;
  }
  return (rows[0] as VideoProject | undefined) ?? null;
}

async function removeProject(
  sql: Sql,
  user: AuthenticatedUser,
  id: string,
): Promise<boolean> {
  let rows;
  if (user.role === "superadmin") {
    rows = await sql`DELETE FROM video_projects WHERE id = ${id} RETURNING id`;
  } else if (user.role === "school" && user.schoolId) {
    rows = await sql`
      DELETE FROM video_projects
      WHERE id = ${id} AND organization_id = ${user.schoolId}
      RETURNING id
    `;
  } else {
    rows = await sql`
      DELETE FROM video_projects
      WHERE id = ${id} AND created_by = ${user.id}
      RETURNING id
    `;
  }
  return rows.length > 0;
}

async function syncPublishedVideo(
  sql: Sql,
  project: VideoProject,
): Promise<VideoLibraryItem | null> {
  if (project.visibility !== "published" || !project.published_url) return null;
  const rows = await sql`
    INSERT INTO video_library (
      organization_id, project_id, title, description, category, sector, url,
      duration_seconds, language, tags, created_by
    )
    VALUES (
      ${project.organization_id}, ${project.id}, ${project.title}, ${project.description},
      'lesson', ${project.sector}, ${project.published_url}, ${project.duration_seconds},
      ${project.language}, ARRAY['lesson']::text[], ${project.created_by}
    )
    ON CONFLICT (project_id) DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      sector = EXCLUDED.sector,
      url = EXCLUDED.url,
      duration_seconds = EXCLUDED.duration_seconds,
      language = EXCLUDED.language
    RETURNING *
  `;
  return (rows[0] as VideoLibraryItem | undefined) ?? null;
}

routes.get("/projects", async (c) => {
  const user = actor(c);
  ensureStudioAccess(user);
  const sql = getDb(c.env);
  let rows;
  if (user.role === "superadmin") {
    rows = await sql`
      SELECT * FROM video_projects
      ORDER BY updated_at DESC
      LIMIT 100
    `;
  } else if (user.role === "school" && user.schoolId) {
    rows = await sql`
      SELECT * FROM video_projects
      WHERE organization_id = ${user.schoolId}
      ORDER BY updated_at DESC
      LIMIT 100
    `;
  } else {
    rows = await sql`
      SELECT * FROM video_projects
      WHERE created_by = ${user.id}
      ORDER BY updated_at DESC
      LIMIT 100
    `;
  }
  return c.json({ projects: rows });
});

routes.post("/projects", async (c) => {
  const user = actor(c);
  ensureStudioWriter(user);
  const body = await readJson(c);
  const title = cleanText(body.title, "title", 200, 1);
  const description = optionalText(body, "description", 5000, true) ?? null;
  const language = body.language === undefined ? "en" : parseLanguage(body.language);
  const sector = routeSector(user, user.role === "superadmin" ? body.sector : undefined);
  const organizationId = user.schoolId;
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO video_projects (
      organization_id, created_by, title, description, sector, language
    )
    VALUES (
      ${organizationId}, ${user.id}, ${title}, ${description}, ${sector}, ${language}
    )
    RETURNING *
  `;
  return c.json({ project: rows[0] }, 201);
});

routes.get("/projects/:id", async (c) => {
  const user = actor(c);
  ensureStudioAccess(user);
  const id = pathUuid(c.req.param("id"));
  const project = await findProject(getDb(c.env), user, id);
  if (!project) throw new ApiError(404, "NOT_FOUND", "Video project not found.");
  return c.json({ project });
});

routes.patch("/projects/:id", async (c) => {
  const user = actor(c);
  ensureStudioWriter(user);
  const id = pathUuid(c.req.param("id"));
  const body = await readJson(c);
  const allowedKeys = new Set([
    "title",
    "description",
    "language",
    "scenes",
    "visibility",
    "thumbnail_base64",
    "published_url",
  ]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new ApiError(400, "INVALID_FIELDS", "The request contains unsupported project fields.");
  }
  if (Object.keys(body).length === 0) {
    throw new ApiError(400, "INVALID_BODY", "Provide at least one project field to update.");
  }
  const current = await findProject(getDb(c.env), user, id);
  if (!current) throw new ApiError(404, "NOT_FOUND", "Video project not found.");
  const title = body.title === undefined ? undefined : cleanText(body.title, "title", 200, 1);
  const description = optionalText(body, "description", 5000, true);
  const language = body.language === undefined ? undefined : parseLanguage(body.language);
  const scenes = body.scenes === undefined ? undefined : validateScenes(body.scenes);
  const thumbnail = body.thumbnail_base64 === undefined
    ? undefined
    : validateThumbnail(body.thumbnail_base64);
  let visibility = current.visibility;
  if (body.visibility !== undefined) {
    if (body.visibility !== "draft" && body.visibility !== "published") {
      throw new ApiError(400, "VALIDATION_ERROR", "visibility must be draft or published.");
    }
    visibility = body.visibility;
  }
  let publishedUrl = current.published_url;
  if (body.published_url !== undefined) {
    if (body.published_url === null || body.published_url === "") {
      publishedUrl = null;
    } else {
      publishedUrl = safeYouTubeUrl(body.published_url);
    }
    if (body.visibility === undefined) {
      visibility = publishedUrl ? "published" : "draft";
    }
  }
  if (visibility === "draft") publishedUrl = null;
  if (visibility === "published" && !publishedUrl) {
    throw new ApiError(
      400,
      "PUBLISHED_URL_REQUIRED",
      "A YouTube URL is required before publishing this project.",
    );
  }
  const sql = getDb(c.env);
  const updated = await updateProject(
    sql,
    user,
    id,
    { title, description, language, scenes, thumbnail, visibility, publishedUrl },
    current,
  );
  if (!updated) throw new ApiError(404, "NOT_FOUND", "Video project not found.");
  if (updated.visibility === "published") {
    await syncPublishedVideo(sql, updated);
  } else if (current.visibility === "published") {
    await sql`DELETE FROM video_library WHERE project_id = ${updated.id}`;
  }
  return c.json({ project: updated });
});

routes.delete("/projects/:id", async (c) => {
  const user = actor(c);
  ensureStudioWriter(user);
  const id = pathUuid(c.req.param("id"));
  const deleted = await removeProject(getDb(c.env), user, id);
  if (!deleted) throw new ApiError(404, "NOT_FOUND", "Video project not found.");
  return c.json({ deleted: true });
});

routes.post("/projects/:id/publish", async (c) => {
  const user = actor(c);
  ensureStudioWriter(user);
  const id = pathUuid(c.req.param("id"));
  const body = await readJson(c);
  const publishedUrl = safeYouTubeUrl(body.published_url);
  const sql = getDb(c.env);
  const current = await findProject(sql, user, id);
  if (!current) throw new ApiError(404, "NOT_FOUND", "Video project not found.");
  const project = await updateProject(
    sql,
    user,
    id,
    {
      title: undefined,
      description: undefined,
      language: undefined,
      scenes: undefined,
      thumbnail: undefined,
      visibility: "published",
      publishedUrl,
    },
    current,
  );
  if (!project) throw new ApiError(404, "NOT_FOUND", "Video project not found.");
  const video = await syncPublishedVideo(sql, project);
  if (!video) {
    throw new ApiError(500, "PUBLISH_FAILED", "The video could not be added to the library.");
  }
  return c.json({ project, video });
});

routes.get("/library", async (c) => {
  const user = actor(c);
  const category = c.req.query("category")?.trim().slice(0, 80) || null;
  const language = c.req.query("language")?.trim().slice(0, 30) || null;
  const search = c.req.query("search")?.trim().slice(0, 120) || null;
  const sector = c.req.query("sector")?.trim() || null;
  if (sector && user.role !== "superadmin") {
    throw new ApiError(403, "FORBIDDEN", "Only Super Admins can filter videos by sector.");
  }
  if (sector && !sectors.has(sector)) {
    throw new ApiError(400, "VALIDATION_ERROR", "sector must be education, mfi, clinic, or farm.");
  }
  const searchPattern = search ? `%${search}%` : null;
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT
      vl.id, vl.organization_id, vl.project_id, vl.title, vl.description,
      vl.category, vl.sector, vl.url,
      COALESCE(vl.thumbnail_url, vp.thumbnail_base64) AS thumbnail_url,
      vl.duration_seconds, vl.language, vl.tags, vl.views, vl.created_at,
      COUNT(*) OVER()::int AS total
    FROM video_library vl
    LEFT JOIN video_projects vp ON vp.id = vl.project_id
    WHERE (${category === null} OR vl.category = ${category})
      AND (${language === null} OR vl.language = ${language})
      AND (${sector === null} OR vl.sector = ${sector})
      AND (
        ${searchPattern === null}
        OR vl.title ILIKE ${searchPattern}
        OR COALESCE(vl.description, '') ILIKE ${searchPattern}
        OR COALESCE(array_to_string(vl.tags, ' '), '') ILIKE ${searchPattern}
      )
    ORDER BY vl.created_at DESC
    LIMIT 200
  `;
  const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? 0);
  let sectorCounts: Array<{ sector: string; count: number }> = [];
  if (user.role === "superadmin") {
    const countRows = await sql`
      SELECT sector, COUNT(*)::int AS count
      FROM video_library
      GROUP BY sector
      ORDER BY sector
    `;
    sectorCounts = countRows.map((row) => ({
      sector: String(row.sector),
      count: Number(row.count),
    }));
  }
  return c.json({ videos: rows, total, sector_counts: sectorCounts });
});

routes.post("/library", async (c) => {
  const user = actor(c);
  ensureStudioWriter(user);
  const body = await readJson(c);
  const title = cleanText(body.title, "title", 200, 1);
  const description = optionalText(body, "description", 5000, true) ?? null;
  const category = optionalText(body, "category", 80, true) ?? null;
  const url = safeMediaUrl(body.url ?? body.published_url, "url");
  const thumbnailUrl =
    body.thumbnail_url === undefined || body.thumbnail_url === null || body.thumbnail_url === ""
      ? null
      : safeHttpsUrl(body.thumbnail_url, "thumbnail_url");
  const duration = body.duration_seconds;
  if (
    duration !== undefined &&
    duration !== null &&
    (!Number.isInteger(duration) || Number(duration) < 0 || Number(duration) > 24 * 60 * 60)
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", "duration_seconds must be between 0 and 86400.");
  }
  const language = body.language === undefined ? "en" : parseLanguage(body.language);
  let tags: string[] | null = null;
  if (body.tags !== undefined && body.tags !== null) {
    if (
      !Array.isArray(body.tags) ||
      body.tags.length > 20 ||
      body.tags.some((tag) => typeof tag !== "string" || tag.length > 60)
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", "tags must contain up to 20 text labels.");
    }
    tags = body.tags.map((tag) => String(tag).trim()).filter(Boolean);
  }
  const sector = routeSector(user);
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO video_library (
      organization_id, title, description, category, sector, url, thumbnail_url,
      duration_seconds, language, tags, created_by
    )
    VALUES (
      ${user.schoolId}, ${title}, ${description}, ${category}, ${sector}, ${url},
      ${thumbnailUrl}, ${duration ?? null}, ${language}, ${tags}, ${user.id}
    )
    RETURNING *
  `;
  return c.json({ video: rows[0] }, 201);
});

routes.post("/library/:id/view", async (c) => {
  const id = pathUuid(c.req.param("id"));
  const rows = await getDb(c.env)`
    UPDATE video_library
    SET views = views + 1
    WHERE id = ${id}
    RETURNING views
  `;
  if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "Video not found in the library.");
  return c.json({ views: Number((rows[0] as { views: number }).views) });
});

routes.get("/pixabay/search", async (c) => {
  const user = actor(c);
  ensureStudioAccess(user);
  if (user.role !== "superadmin" && !roles.has(user.role)) {
    throw new ApiError(403, "FORBIDDEN", "You do not have permission to search Pixabay.");
  }
  const query = c.req.query("q")?.trim();
  const type = c.req.query("type") ?? "image";
  if (!query || query.length > 120) {
    throw new ApiError(400, "VALIDATION_ERROR", "q must contain between 1 and 120 characters.");
  }
  if (type !== "image" && type !== "video") {
    throw new ApiError(400, "VALIDATION_ERROR", "type must be image or video.");
  }
  const apiKey = String(c.env.PIXABAY_API_KEY ?? "").trim();
  if (!apiKey) {
    return c.json(
      { error: "Pixabay not configured", fallback: true },
      200,
      { "Cache-Control": "no-store" },
    );
  }
  const cache =
    typeof caches === "undefined"
      ? null
      : (caches as unknown as { default?: Cache }).default ?? null;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }
  const upstreamUrl = new URL(type === "video" ? "https://pixabay.com/api/videos/" : "https://pixabay.com/api/");
  upstreamUrl.searchParams.set("key", apiKey);
  upstreamUrl.searchParams.set("q", query);
  upstreamUrl.searchParams.set("per_page", "20");
  upstreamUrl.searchParams.set("safesearch", "true");
  if (type === "image") upstreamUrl.searchParams.set("image_type", "photo");
  try {
    const upstream = await fetch(upstreamUrl.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!upstream.ok) {
      throw new ApiError(502, "PIXABAY_UNAVAILABLE", "Pixabay search is temporarily unavailable.");
    }
    const payload: unknown = await upstream.json();
    if (!isRecord(payload) || !Array.isArray(payload.hits)) {
      throw new ApiError(502, "PIXABAY_INVALID_RESPONSE", "Pixabay returned an unexpected response.");
    }
    const hits = payload.hits.flatMap((raw): Array<Record<string, unknown>> => {
      if (!isRecord(raw)) return [];
      const pageUrl = (() => {
        try {
          return safeHttpsUrl(raw.pageURL, "Pixabay page URL");
        } catch {
          return "";
        }
      })();
      const source = isRecord(raw.videos) ? raw.videos : null;
      const medium = source && isRecord(source.medium) ? source.medium : null;
      const tiny = source && isRecord(source.tiny) ? source.tiny : null;
      const assetUrl = type === "video"
        ? (medium?.url ?? tiny?.url)
        : raw.largeImageURL ?? raw.webformatURL;
      const previewUrl = type === "video"
        ? (medium?.thumbnail ?? tiny?.thumbnail ?? tiny?.url)
        : raw.previewURL ?? raw.webformatURL;
      let safeAsset: string;
      let safePreview: string;
      try {
        safeAsset = safeHttpsUrl(assetUrl, "Pixabay asset URL");
        safePreview = safeHttpsUrl(previewUrl, "Pixabay preview URL");
      } catch {
        return [];
      }
      return [{
        id: String(raw.id ?? ""),
        type,
        preview_url: safePreview,
        asset_url: safeAsset,
        page_url: pageUrl,
        user: typeof raw.user === "string" ? raw.user.slice(0, 120) : "",
        tags: typeof raw.tags === "string" ? raw.tags.slice(0, 250) : "",
        duration_seconds:
          typeof raw.duration === "number" && Number.isFinite(raw.duration)
            ? Math.max(0, Math.trunc(raw.duration))
            : null,
      }];
    });
    const response = c.json({
      hits: hits.slice(0, 20),
      total: typeof payload.totalHits === "number" ? payload.totalHits : hits.length,
    });
    response.headers.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
    if (cache) await cache.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "PIXABAY_UNAVAILABLE", "Pixabay search is temporarily unavailable.");
  }
});

routes.get("/tts-voices", async (c) => {
  actor(c);
  return c.json({ voices: commonVoices });
});

export default routes;
