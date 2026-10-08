import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import videoStudioRoutes from "../src/routes/video-studio.ts";

const projectId = "00000000-0000-4000-8000-000000000456";
const userId = "00000000-0000-4000-8000-000000000123";

function createApp() {
  const app = new Hono();
  app.onError((error, c) =>
    c.json({ error: error.code ?? "INTERNAL_ERROR" }, error.status ?? 500),
  );
  app.route("/api/video-studio", videoStudioRoutes);
  return app;
}

function project(overrides = {}) {
  return {
    id: projectId,
    organization_id: null,
    created_by: userId,
    title: "Health lesson",
    description: null,
    sector: "education",
    language: "en",
    visibility: "draft",
    duration_seconds: 0,
    scenes: [],
    thumbnail_base64: null,
    published_url: null,
    published_at: null,
    created_at: "2026-10-08T00:00:00.000Z",
    updated_at: "2026-10-08T00:00:00.000Z",
    ...overrides,
  };
}

function harness(sql, env = {}) {
  const app = createApp();
  return {
    app,
    env: { __sql: sql, ...env },
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
  };
}

test("Video Studio routes require authentication", async () => {
  const { app, env } = harness(async () => {
    throw new Error("Database must not be queried.");
  });
  const response = await app.request("/api/video-studio/projects", {}, env);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "UNAUTHORIZED" });
});

test("only education teachers, school admins, and Super Admins can manage projects", async () => {
  for (const headers of [
    { authorization: "Bearer test-token", "x-test-role": "doctor", "x-test-sector": "clinic" },
    { authorization: "Bearer test-token", "x-test-role": "teacher", "x-test-sector": "farm" },
  ]) {
    const { app, env } = harness(async () => {
      throw new Error("Rejected roles must not query the database.");
    });
    const response = await app.request(
      "/api/video-studio/projects",
      { headers },
      env,
    );
    assert.equal(response.status, 403);
  }
});

test("a teacher can create a draft project in their own sector", async () => {
  const calls = [];
  const { app, env, headers } = harness(async (parts, ...values) => {
    const text = parts.join("?");
    calls.push({ text, values });
    assert.match(text, /INSERT INTO video_projects/u);
    return [project({ title: "Healthy gardens" })];
  });
  const response = await app.request(
    "/api/video-studio/projects",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Healthy gardens", language: "lg-UG" }),
    },
    env,
  );
  assert.equal(response.status, 201);
  assert.equal((await response.json()).project.title, "Healthy gardens");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].values.includes("education"));
});

test("project PATCH rejects an invalid audio upload before updating", async () => {
  const calls = [];
  const { app, env, headers } = harness(async (parts) => {
    const text = parts.join("?");
    calls.push(text);
    if (text.includes("SELECT * FROM video_projects")) return [project()];
    throw new Error("Invalid audio should not reach the update query.");
  });
  const response = await app.request(
    `/api/video-studio/projects/${projectId}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        scenes: [{
          id: "scene-1",
          duration_seconds: 8,
          background_type: "color",
          background_value: "#246b56",
          voiceover_audio_base64: "data:text/plain;base64,AA==",
        }],
      }),
    },
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "VALIDATION_ERROR" });
  assert.equal(calls.length, 1);
});

test("project PATCH accepts a valid scene voiceover up to 1 MB", async () => {
  const audio = Buffer.alloc(1024 * 1024, 0x61).toString("base64");
  const { app, env, headers } = harness(async (parts) => {
    const text = parts.join("?");
    if (text.includes("SELECT * FROM video_projects")) return [project()];
    if (text.includes("UPDATE video_projects")) return [project()];
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const response = await app.request(
    `/api/video-studio/projects/${projectId}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        scenes: [{
          id: "scene-1",
          duration_seconds: 8,
          background_type: "color",
          background_value: "#246b56",
          voiceover_audio_name: "narration.mp3",
          voiceover_audio_base64: audio,
        }],
      }),
    },
    env,
  );
  assert.equal(response.status, 200);
});

test("project PATCH rejects scene voiceover larger than 1 MB before updating", async () => {
  const audio = Buffer.alloc(1024 * 1024 + 1, 0x61).toString("base64");
  let updates = 0;
  const { app, env, headers } = harness(async (parts) => {
    const text = parts.join("?");
    if (text.includes("SELECT * FROM video_projects")) return [project()];
    if (text.includes("UPDATE video_projects")) updates += 1;
    return [];
  });
  const response = await app.request(
    `/api/video-studio/projects/${projectId}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        scenes: [{
          id: "scene-1",
          duration_seconds: 8,
          background_type: "color",
          background_value: "#246b56",
          voiceover_audio_name: "narration.mp3",
          voiceover_audio_base64: audio,
        }],
      }),
    },
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(updates, 0);
});

test("project PATCH accepts a local image up to 300 KB", async () => {
  const image = `data:image/png;base64,${Buffer.alloc(300 * 1024, 0x61).toString("base64")}`;
  const { app, env, headers } = harness(async (parts) => {
    const text = parts.join("?");
    if (text.includes("SELECT * FROM video_projects")) return [project()];
    if (text.includes("UPDATE video_projects")) return [project()];
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const response = await app.request(
    `/api/video-studio/projects/${projectId}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        scenes: [{
          id: "scene-1",
          duration_seconds: 8,
          background_type: "image",
          background_value: "",
          background_asset_url: image,
        }],
      }),
    },
    env,
  );
  assert.equal(response.status, 200);
});

test("project PATCH rejects a local image larger than 300 KB before updating", async () => {
  const image = `data:image/png;base64,${Buffer.alloc(300 * 1024 + 1, 0x61).toString("base64")}`;
  let updates = 0;
  const { app, env, headers } = harness(async (parts) => {
    const text = parts.join("?");
    if (text.includes("SELECT * FROM video_projects")) return [project()];
    if (text.includes("UPDATE video_projects")) updates += 1;
    return [];
  });
  const response = await app.request(
    `/api/video-studio/projects/${projectId}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        scenes: [{
          id: "scene-1",
          duration_seconds: 8,
          background_type: "image",
          background_value: "",
          background_asset_url: image,
        }],
      }),
    },
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "VALIDATION_ERROR" });
  assert.equal(updates, 0);
});

test("video library filters by category, language, and search", async () => {
  let queryValues;
  const { app, env, headers } = harness(async (parts, ...values) => {
    const text = parts.join("?");
    assert.match(text, /FROM video_library vl/u);
    queryValues = values;
    return [];
  });
  const response = await app.request(
    "/api/video-studio/library?category=lesson&language=lg-UG&search=health",
    { headers },
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).videos, []);
  assert.ok(queryValues.includes("lesson"));
  assert.ok(queryValues.includes("lg-UG"));
  assert.ok(queryValues.includes("%health%"));
});

test("publishing a project adds the YouTube link to the video library", async () => {
  const calls = [];
  const published = project({
    visibility: "published",
    published_url: "https://www.youtube.com/watch?v=abc123xyz99",
    published_at: "2026-10-08T00:00:00.000Z",
  });
  const libraryVideo = {
    id: "00000000-0000-4000-8000-000000000789",
    project_id: projectId,
    title: published.title,
    url: published.published_url,
    sector: "education",
  };
  const { app, env, headers } = harness(async (parts) => {
    const text = parts.join("?");
    calls.push(text);
    if (text.includes("SELECT * FROM video_projects")) return [project()];
    if (text.includes("UPDATE video_projects SET")) return [published];
    if (text.includes("INSERT INTO video_library")) return [libraryVideo];
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const response = await app.request(
    `/api/video-studio/projects/${projectId}/publish`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ published_url: published.published_url }),
    },
    env,
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.project.visibility, "published");
  assert.equal(result.video.url, published.published_url);
  assert.equal(calls.length, 3);
});

test("publishing rejects non-YouTube URLs", async () => {
  const { app, env, headers } = harness(async () => {
    throw new Error("Invalid URL must be rejected before database access.");
  });
  const response = await app.request(
    `/api/video-studio/projects/${projectId}/publish`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ published_url: "https://example.com/video" }),
    },
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "VALIDATION_ERROR" });
});

test("Pixabay query rejects unsupported result types", async () => {
  const { app, env, headers } = harness(async () => {
    throw new Error("Invalid type must be rejected before database access.");
  }, { PIXABAY_API_KEY: "test-key" });
  const response = await app.request(
    "/api/video-studio/pixabay/search?q=classroom&type=audio",
    { headers },
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "VALIDATION_ERROR" });
});

test("Pixabay search returns the local-media fallback when no API key is configured", async () => {
  const { app, env, headers } = harness(async () => {
    throw new Error("Missing Pixabay configuration must not query the database.");
  });
  const response = await app.request(
    "/api/video-studio/pixabay/search?q=green%20leaf&type=image",
    { headers },
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    error: "Pixabay not configured",
    fallback: true,
  });
});

test("the authenticated voice list includes locally relevant languages", async () => {
  const { app, env, headers } = harness(async () => {
    throw new Error("Voice list must not query the database.");
  });
  const response = await app.request("/api/video-studio/tts-voices", { headers }, env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.voices.some((voice) => voice.lang === "lg-UG"));
  assert.ok(result.voices.some((voice) => voice.lang === "en-US"));
});
