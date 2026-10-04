import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const offlineDataSource = await readFile(new URL("../offline-data.js", import.meta.url), "utf8");
const offlineDataModule = await import(
    `data:text/javascript;base64,${Buffer.from(offlineDataSource).toString("base64")}`
);
const { createOfflineDataLayer } = offlineDataModule;

const apiBase = "https://example.test";

function tokenFor(userId = "learner-1", extraClaims = {}) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return [
        encode({ alg: "none", typ: "JWT" }),
        encode({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600, ...extraClaims }),
        "signature",
    ].join(".");
}

function makeIdb(initial = []) {
    let nextId = initial.reduce((next, row) => Math.max(next, Number(row.id) + 1), 1);
    const queue = initial.map((row) => ({ ...row }));
    return {
        queue,
        async get() { return null; },
        async queueAll() { return queue.map((item) => ({ ...item })); },
        async queuePush(item) {
            const id = nextId++;
            queue.push({ ...item, id });
            return id;
        },
        async queueUpdate(id, patch) {
            const index = queue.findIndex((item) => item.id === id);
            if (index < 0) return false;
            queue[index] = { ...queue[index], ...patch, id };
            return true;
        },
        async queueClaim(id, claimId, now, leaseMs, force = false) {
            const item = queue.find((row) => row.id === id);
            if (!item || item.status !== "pending" || item.claim_until > now) return null;
            if (!force && item.next_attempt_at > now) return null;
            Object.assign(item, { claimed_by: claimId, claim_until: now + leaseMs });
            return { ...item };
        },
        async queueDelete(id) {
            const index = queue.findIndex((item) => item.id === id);
            if (index >= 0) queue.splice(index, 1);
            return true;
        },
    };
}

function makeLayer({
    online = false,
    role = "individual",
    userId = "learner-1",
    claims = {},
    idb = makeIdb(),
    fetchImpl = async () => new Response("{}", { status: 200 }),
} = {}) {
    const token = tokenFor(userId, claims);
    const network = { online };
    const layer = createOfflineDataLayer({
        apiBase,
        idb,
        getToken: () => token,
        getCurrentUser: () => ({ id: userId, role }),
        isOnline: () => network.online,
        fetchImpl,
    });
    return { layer, idb, token, setOnline: (value) => { network.online = Boolean(value); } };
}

test("queues only the five approved POST routes and scopes records to the signed-in user", async () => {
    const { layer, idb } = makeLayer({ role: "teacher" });
    const allowed = [
        ["/api/ca-records", { learner_id: "learner-2" }],
        ["/api/video-views", { lessonId: "lesson-1" }],
        ["/api/teacher/retooling/12/quiz", { answers: [1, 2, 3, 4, 0] }],
        ["/api/projects", { title: "Science project" }],
        ["/api/report-cards/card-1/marks", { subject_name: "Science", score: 80 }],
    ];

    for (const [path, body] of allowed) {
        const result = await layer.api(path, { method: "POST", body });
        assert.equal(result.queued, true, `${path} should queue`);
    }
    assert.equal(idb.queue.length, allowed.length);
    assert.ok(idb.queue.every((item) => item.user_id === "learner-1"));
    assert.deepEqual(idb.queue.map((item) => item.path), allowed.map(([path]) => path));
    assert.ok(idb.queue.every((item) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item.operation_id)
    ));
});

test("does not queue unapproved routes, methods, unauthenticated writes, or impersonation", async () => {
    const { layer, idb } = makeLayer({ role: "teacher" });
    for (const [path, options] of [
        ["/api/attendance/mark", { method: "POST", body: {} }],
        ["/api/student/projects/1/milestone", { method: "PATCH", body: {} }],
        ["/api/teacher/retooling/12/start", { method: "POST", body: {} }],
        ["/api/ca-records", { method: "PATCH", body: {} }],
        ["/api/auth/logout", { method: "POST" }],
        ["/api/projects", { method: "POST", body: {}, auth: false }],
    ]) {
        await assert.rejects(
            layer.api(path, options),
            (error) => error.code === "OFFLINE_WRITE_BLOCKED",
            `${path} should remain blocked`,
        );
    }
    assert.equal(idb.queue.length, 0);

    const impersonated = makeLayer({
        online: false,
        role: "teacher",
        claims: { impersonated_by: "admin-1" },
    });
    await assert.rejects(
        impersonated.layer.api("/api/ca-records", { method: "POST", body: {} }),
        (error) => error.code === "OFFLINE_SESSION_EXPIRED" || error.code === "OFFLINE_WRITE_BLOCKED",
    );
    assert.equal(impersonated.idb.queue.length, 0);

    const expired = makeLayer({
        role: "teacher",
        claims: { exp: Math.floor(Date.now() / 1000) - 60 },
    });
    await assert.rejects(
        expired.layer.api("/api/ca-records", { method: "POST", body: {} }),
        (error) => error.code === "OFFLINE_SESSION_EXPIRED",
    );
    assert.equal(expired.idb.queue.length, 0);
});

test("video-view events are deduplicated for the same user and lesson", async () => {
    const { layer, idb } = makeLayer({ role: "individual" });
    const first = await layer.api("/api/video-views", {
        method: "POST",
        body: { lessonId: "lesson-1", subject: "Math" },
    });
    const duplicate = await layer.api("/api/video-views", {
        method: "POST",
        body: { lessonId: "lesson-1", subject: "Math" },
    });
    assert.equal(first.queueId, duplicate.queueId);
    assert.equal(idb.queue.length, 1);
});

test("syncs pending mutations in order and records 409 conflicts without replay", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/api/projects")) {
            return new Response(JSON.stringify({ error: "Project already exists" }), { status: 409 });
        }
        return new Response(JSON.stringify({ record: { id: "saved" } }), { status: 201 });
    };
    const { layer, idb, setOnline } = makeLayer({ online: false, role: "teacher", fetchImpl });
    await layer.api("/api/ca-records", { method: "POST", body: { learner_id: "learner-2" } });
    await layer.api("/api/projects", { method: "POST", body: { title: "Science" } });
    const queuedOperationIds = new Map(
        idb.queue.map((item) => [item.path, item.operation_id])
    );

    setOnline(true);
    await layer.syncQueuedChanges();
    assert.deepEqual(calls.map((call) => call.url), [
        `${apiBase}/api/ca-records`,
        `${apiBase}/api/projects`,
    ]);
    assert.ok(calls.every((call) =>
        call.options.headers["Idempotency-Key"] === queuedOperationIds.get(new URL(call.url).pathname)
    ));
    assert.equal(idb.queue.find((item) => item.path === "/api/ca-records"), undefined);
    const conflict = idb.queue.find((item) => item.path === "/api/projects");
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.conflict_status, 409);
    assert.equal((await layer.getQueueStatus()).conflicts, 1);
});

test("holds queued writes until the offline session has been revalidated", async () => {
    const calls = [];
    const { layer, idb, setOnline } = makeLayer({
        online: false,
        role: "teacher",
        fetchImpl: async (url) => {
            calls.push(url);
            return new Response("{}", { status: 201 });
        },
    });
    await layer.api("/api/ca-records", { method: "POST", body: { learner_id: "learner-2" } });
    setOnline(true);
    layer.setOfflineSession(true);
    const blocked = await layer.syncQueuedChanges({ force: true });
    assert.equal(blocked.skipped, true);
    assert.equal(calls.length, 0);
    assert.equal(idb.queue.length, 1);

    layer.setOfflineSession(false);
    const synced = await layer.syncQueuedChanges();
    assert.equal(synced.synced, 1);
    assert.equal(calls.length, 1);
    assert.equal(idb.queue.length, 0);
});

test("backs off exponentially after transient server failures", async () => {
    const { layer, idb, setOnline } = makeLayer({
        online: false,
        role: "teacher",
        fetchImpl: async () => new Response(JSON.stringify({ error: "Temporarily unavailable" }), { status: 503 }),
    });
    await layer.api("/api/ca-records", { method: "POST", body: { learner_id: "learner-2" } });
    const before = Date.now();
    setOnline(true);
    await layer.syncQueuedChanges();
    const item = idb.queue[0];
    assert.equal(item.status, "pending");
    assert.equal(item.attempts, 1);
    assert.ok(item.next_attempt_at >= before + 900);
    assert.ok(item.next_attempt_at <= Date.now() + 1_500);
});
