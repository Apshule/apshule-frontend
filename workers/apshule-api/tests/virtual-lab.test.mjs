import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import virtualLabRoutes from "../src/routes/virtual-lab.ts";

const userId = "00000000-0000-4000-8000-000000000123";
const experimentId = "00000000-0000-4000-8000-000000000456";
const teacherId = "00000000-0000-4000-8000-000000000789";

function createApp() {
  const app = new Hono();
  app.onError((error, c) =>
    c.json({ error: error.code ?? "INTERNAL_ERROR" }, error.status ?? 500),
  );
  app.route("/api/lab", virtualLabRoutes);
  return app;
}

function harness(sql, role = "teacher") {
  return {
    app: createApp(),
    env: { __sql: sql },
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "x-test-role": role,
    },
  };
}

test("Virtual Lab routes require authentication", async () => {
  const { app, env } = harness(async () => {
    throw new Error("Unauthenticated requests must not query the database.");
  });
  const response = await app.request("/api/lab/experiments", {}, env);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "UNAUTHORIZED" });
});

test("experiment catalog exposes only the stored safe-embed metadata fields", async () => {
  let catalogQuery = "";
  const { app, env, headers } = harness(async (parts) => {
    const query = parts.join("?");
    if (query.includes("FROM users")) {
      return [{ id: userId, role: "individual", school_id: null, class_level: "P5", assigned_classes: [] }];
    }
    if (query.includes("FROM lab_experiments")) {
      catalogQuery = query;
      return [{
        id: experimentId,
        code: "OL_REFRACTION",
        title: "Bending Light",
        subject: "Physics",
        level: "primary",
        simulator_type: "phet",
        embed_provider: "phet",
        embed_url: "https://phet.colorado.edu/sims/html/bending-light/latest/bending-light_en.html",
        fallback_url: "https://phet.colorado.edu/sims/html/bending-light/latest/bending-light_en.html",
        embed_height: 600,
        config: {},
        learning_outcomes: [],
      }];
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }, "individual");
  const response = await app.request("/api/lab/experiments", { headers }, env);
  assert.equal(response.status, 200);
  assert.match(catalogQuery, /embed_provider/u);
  assert.match(catalogQuery, /embed_url/u);
  assert.match(catalogQuery, /fallback_url/u);
  assert.match(catalogQuery, /embed_height/u);
  const payload = await response.json();
  assert.equal(payload.experiments[0].embed_provider, "phet");
  assert.equal(payload.experiments[0].embed_height, 600);
});

test("only individual learners can submit experiment progress", async () => {
  const { app, env, headers } = harness(async () => {
    throw new Error("Rejected roles must not query the database.");
  });
  const response = await app.request(
    "/api/lab/progress",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ experiment_id: experimentId, score: 90 }),
    },
    env,
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "FORBIDDEN" });
});

test("school admins must assign a teacher when creating a live session", async () => {
  const { app, env, headers } = harness(async (parts) => {
    const query = parts.join("?");
    if (query.includes("FROM users")) {
      return [{ id: userId, role: "school", school_id: userId, class_level: null, assigned_classes: [] }];
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }, "school");
  const response = await app.request(
    "/api/lab/sessions",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "S2 science lesson", class_level: "S2", subject: "Physics" }),
    },
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "VALIDATION_ERROR" });
});

test("school admins can create a session for a same-school teacher assigned to the class", async () => {
  const { app, env, headers } = harness(async (parts, ...values) => {
    const query = parts.join("?");
    if (query.includes("FROM users") && query.includes("role = 'teacher'")) {
      assert.ok(values.includes(teacherId));
      assert.ok(values.includes(userId));
      assert.ok(values.includes("S2"));
      return [{ id: teacherId }];
    }
    if (query.includes("FROM users")) {
      return [{ id: userId, role: "school", school_id: userId, class_level: null, assigned_classes: [] }];
    }
    if (query.includes("INSERT INTO lab_sessions")) {
      assert.ok(values.includes(teacherId));
      return [{
        id: experimentId,
        organization_id: userId,
        teacher_id: teacherId,
        class_level: "S2",
        subject: "Physics",
        title: "S2 science lesson",
        status: "scheduled",
        jitsi_room: "lab-room",
      }];
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }, "school");
  const response = await app.request(
    "/api/lab/sessions",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "S2 science lesson",
        class_level: "S2",
        subject: "Physics",
        teacher_id: teacherId,
      }),
    },
    env,
  );
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.session.teacher_id, teacherId);
  assert.equal(payload.session.status, "scheduled");
});

test("progress rejects scores outside the 0–100 range before querying", async () => {
  const { app, env, headers } = harness(async () => {
    throw new Error("Invalid scores must be rejected before database access.");
  }, "individual");
  const response = await app.request(
    "/api/lab/progress",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ experiment_id: experimentId, score: 101 }),
    },
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "VALIDATION_ERROR" });
});

test("a student score is saved against the signed-in student's class-level experiment", async () => {
  const statements = [];
  const { app, env, headers } = harness(async (parts, ...values) => {
    const text = parts.join("?");
    statements.push(text);
    if (text.includes("FROM users")) {
      return [{
        id: userId,
        role: "individual",
        school_id: null,
        class_level: "S2",
        assigned_classes: [],
      }];
    }
    if (text.includes("FROM lab_experiments")) return [{ id: experimentId }];
    if (text.includes("INSERT INTO lab_progress")) {
      assert.ok(values.includes(userId));
      assert.ok(values.includes(experimentId));
      assert.ok(values.includes(85));
      return [{
        id: "progress-1",
        student_id: userId,
        experiment_id: experimentId,
        attempts: 1,
        last_score: 85,
        best_score: 85,
        completed: true,
      }];
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }, "individual");
  const response = await app.request(
    "/api/lab/progress",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ experiment_id: experimentId, score: 85 }),
    },
    env,
  );
  assert.equal(response.status, 201);
  assert.equal((await response.json()).progress.best_score, 85);
  assert.equal(statements.length, 3);
  assert.match(statements[2], /ON CONFLICT \(student_id, experiment_id\)/u);
});

test("whiteboard rejects unsupported event types before database access", async () => {
  const { app, env, headers } = harness(async () => {
    throw new Error("Invalid events must be rejected before database access.");
  });
  const response = await app.request(
    `/api/lab/sessions/${experimentId}/board-event`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ event: { type: "script", data: {}, ts: Date.now() } }),
    },
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "VALIDATION_ERROR" });
});

test("recording rejects malformed base64 before looking up a session", async () => {
  const { app, env, headers } = harness(async () => {
    throw new Error("Malformed recordings must be rejected before database access.");
  });
  const response = await app.request(
    `/api/lab/sessions/${experimentId}/recording`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ recording_base64: "not a webm payload", duration_seconds: 12 }),
    },
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "VALIDATION_ERROR" });
});

test("recording rejects payloads beyond the 6 MB base64 limit before database access", async () => {
  const { app, env, headers } = harness(async () => {
    throw new Error("Oversized recordings must be rejected before database access.");
  });
  const response = await app.request(
    `/api/lab/sessions/${experimentId}/recording`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ recording_base64: "a".repeat(6_000_004), duration_seconds: 120 }),
    },
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "VALIDATION_ERROR" });
});

test("whiteboard event cap is enforced at 2,000 events", async () => {
  let reachedUpdate = false;
  const { app, env, headers } = harness(async (parts) => {
    const query = parts.join("?");
    if (query.includes("FROM users")) {
      return [{ id: userId, role: "teacher", school_id: "school-1", class_level: "S2", assigned_classes: ["S2"] }];
    }
    if (query.includes("FROM lab_sessions s")) {
      return [{
        id: experimentId,
        organization_id: "school-1",
        teacher_id: userId,
        class_level: "S2",
        subject: "Physics",
        title: "Live lesson",
        status: "started",
        jitsi_room: "lab-room",
        participant_count: 0,
      }];
    }
    if (query.includes("UPDATE lab_sessions")) {
      reachedUpdate = true;
      return [];
    }
    if (query.includes("SELECT status")) return [{ status: "started", event_count: 2000 }];
    throw new Error(`Unexpected SQL: ${query}`);
  });
  const response = await app.request(
    `/api/lab/sessions/${experimentId}/board-event`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ event: { type: "draw", data: { points: [{ x: 1, y: 2 }] } } }),
    },
    env,
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "BOARD_EVENT_LIMIT" });
  assert.equal(reachedUpdate, true);
});

test("students cannot download recordings unless they attended the session", async () => {
  let recordingRead = false;
  const { app, env, headers } = harness(async (parts) => {
    const query = parts.join("?");
    if (query.includes("FROM users")) {
      return [{ id: userId, role: "individual", school_id: "school-1", class_level: "S2", assigned_classes: [] }];
    }
    if (query.includes("FROM lab_sessions s")) {
      return [{
        id: experimentId,
        organization_id: "school-1",
        teacher_id: "00000000-0000-4000-8000-000000000999",
        class_level: "S2",
        subject: "Physics",
        title: "Live lesson",
        status: "ended",
        jitsi_room: "lab-room",
        participant_count: 0,
      }];
    }
    if (query.includes("FROM lab_session_attendance")) return [];
    if (query.includes("recording_base64")) recordingRead = true;
    throw new Error(`Unexpected SQL: ${query}`);
  }, "individual");
  const response = await app.request(
    `/api/lab/sessions/${experimentId}/recording`,
    { headers },
    env,
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "SESSION_NOT_FOUND" });
  assert.equal(recordingRead, false);
});
