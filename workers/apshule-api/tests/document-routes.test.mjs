import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import documentRoutes from "../src/routes/documents.ts";

const app = new Hono();
app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "Range"] }));
app.onError((error, c) =>
  c.json(
    { error: error.message, code: error.code },
    error.status ?? 500,
  ),
);
app.route("/api", documentRoutes);

const authHeaders = { authorization: "Bearer test-token" };

function createPdfResolverSql({ pdfRows = [], remaining = 0 } = {}) {
  const calls = [];
  const sql = async (strings, ...values) => {
    const query = strings.join(" ").replace(/\s+/gu, " ").trim();
    calls.push({ query, values });
    if (query.includes("SELECT id, url") && query.includes("resolve_status")) {
      return pdfRows;
    }
    if (query.includes("SELECT COUNT(*)::int AS count")) {
      return [{ count: remaining }];
    }
    return [];
  };
  return { sql, calls };
}

test("document routes require an authenticated user", async () => {
  const response = await app.request(
    "/api/detect-doc-kind",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://files.example.com/book.pdf" }) },
  );
  assert.equal(response.status, 401);

  const proxyResponse = await app.request(
    `/api/doc-proxy?url=${encodeURIComponent("https://files.example.com/book.pdf")}`,
  );
  assert.equal(proxyResponse.status, 401);
});

test("PDF prefetch is authenticated and caches direct PDF mappings", async () => {
  const database = createPdfResolverSql();
  const response = await app.request(
    "/api/pdf-prefetch",
    {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://files.example.com/lesson.pdf" }),
    },
    { __sql: database.sql },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "resolved",
    direct_url: "https://files.example.com/lesson.pdf",
    expires_at: null,
  });
  assert.equal(database.calls.filter(({ query }) => query.startsWith("UPDATE")).length, 2);
});

test("PDF batch resolution requires an unimpersonated Super Admin", async () => {
  const response = await app.request(
    "/api/admin/resolve-pdf-links",
    {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ limit: 20 }),
    },
    { __sql: createPdfResolverSql().sql },
  );
  assert.equal(response.status, 403);
});

test("Super Admin PDF batch resolves direct files and reports remaining work", async () => {
  const database = createPdfResolverSql({
    pdfRows: [{ id: "pdf-1", url: "https://files.example.com/lesson.pdf" }],
    remaining: 0,
  });
  const response = await app.request(
    "/api/admin/resolve-pdf-links",
    {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": "application/json",
        "x-test-role": "superadmin",
      },
      body: JSON.stringify({ limit: 20 }),
    },
    { __sql: database.sql },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    processed: 1,
    resolved: 1,
    failed: 0,
    not_pdf: 0,
    remaining: 0,
  });
});

test("POST detect-doc-kind returns the server classification for authenticated users", async () => {
  const response = await app.request(
    "/api/detect-doc-kind",
    {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://files.example.com/class-notes.docx" }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { kind: "document" });
});

test("doc-proxy returns a CORS-enabled, one-hour cached response and pdf-proxy is an alias", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const entries = new Map();
  let fetchCount = 0;
  const pendingBackgroundTasks = [];
  const executionContext = {
    waitUntil(promise) {
      pendingBackgroundTasks.push(promise);
    },
  };
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        async match(request) {
          return entries.get(request.url)?.clone();
        },
        async put(request, response) {
          entries.set(request.url, response.clone());
        },
      },
    },
  });
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(new Uint8Array([37, 80, 68, 70]), {
      headers: { "Content-Type": "application/octet-stream" },
    });
  };

  try {
    const url = "https://files.example.com/book.pdf";
    const path = `/api/doc-proxy?url=${encodeURIComponent(url)}`;
    const first = await app.request(path, { headers: authHeaders }, undefined, executionContext);
    await Promise.all(pendingBackgroundTasks.splice(0));
    const second = await app.request(path, { headers: authHeaders });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(first.headers.get("Cache-Control"), /max-age=3600/u);
    assert.equal(first.headers.get("Content-Type"), "application/pdf");
    assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [37, 80, 68, 70]);
    assert.equal(second.status, 200);
    assert.equal(fetchCount, 1);

    const alias = await app.request(
      `/api/pdf-proxy?url=${encodeURIComponent("https://files.example.com/legacy.pdf")}`,
      { headers: authHeaders },
      undefined,
      executionContext,
    );
    await Promise.all(pendingBackgroundTasks.splice(0));
    assert.equal(alias.status, 200);
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else delete globalThis.caches;
  }
});

test("doc-proxy-link issues an encrypted temporary URL that works without a JWT", async () => {
  const originalFetch = globalThis.fetch;
  let fetchedUrl = null;
  globalThis.fetch = async (url) => {
    fetchedUrl = url;
    return new Response(new Uint8Array([80, 75, 3, 4]), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    });
  };
  const env = { JWT_SECRET: "test-only-preview-secret" };
  const sourceUrl = "https://files.example.com/private-course-book.docx?version=4";

  try {
    const denied = await app.request(
      "/api/doc-proxy-link",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: sourceUrl }) },
      env,
    );
    assert.equal(denied.status, 401);

    const issueResponse = await app.request(
      "/api/doc-proxy-link",
      {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
      },
      env,
    );
    assert.equal(issueResponse.status, 200);
    assert.equal(issueResponse.headers.get("Cache-Control"), "no-store");
    const issued = await issueResponse.json();
    const proxyUrl = new URL(issued.url);
    assert.equal(proxyUrl.pathname, "/api/doc-proxy");
    assert.equal(proxyUrl.searchParams.get("public"), "1");
    assert.equal(proxyUrl.searchParams.has("url"), false);
    assert.equal(proxyUrl.searchParams.has("token"), true);
    assert.equal(issued.url.includes("private-course-book.docx"), false);
    assert.equal(issued.expiresAt > Math.floor(Date.now() / 1000), true);

    const publicResponse = await app.request(proxyUrl.pathname + proxyUrl.search, {}, env);
    assert.equal(publicResponse.status, 200);
    assert.equal(publicResponse.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(publicResponse.headers.get("Cache-Control"), /max-age=3600/u);
    assert.equal(
      publicResponse.headers.get("Content-Type"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.equal(fetchedUrl, sourceUrl);
    assert.deepEqual([...new Uint8Array(await publicResponse.arrayBuffer())], [80, 75, 3, 4]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public doc-proxy rejects unsigned and tampered capabilities before fetching", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("unexpected");
  };
  const env = { JWT_SECRET: "test-only-preview-secret" };
  const sourceUrl = "https://files.example.com/lesson.docx";

  try {
    const issued = await app.request(
      "/api/doc-proxy-link",
      {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
      },
      env,
    );
    const capability = new URL((await issued.json()).url);

    const unsigned = await app.request("/api/doc-proxy?public=1", {}, env);
    assert.equal(unsigned.status, 401);

    const token = capability.searchParams.get("token");
    assert.ok(token);
    capability.searchParams.set("token", `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`);
    const tampered = await app.request(capability.pathname + capability.search, {}, env);
    assert.equal(tampered.status, 401);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("doc-proxy download mode returns a safe attachment filename", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([37, 80, 68, 70]), {
    headers: { "Content-Type": "application/pdf" },
  });
  try {
    const response = await app.request(
      `/api/doc-proxy?url=${encodeURIComponent("https://files.example.com/lesson%20notes.pdf")}&download=1`,
      { headers: authHeaders },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Disposition"), 'attachment; filename="lesson notes.pdf"');
    assert.match(response.headers.get("Access-Control-Expose-Headers"), /Content-Disposition/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("doc-proxy returns the exact viewer-page error and rejects private IP URLs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>viewer</html>", {
    headers: { "Content-Type": "text/html" },
  });
  try {
    const response = await app.request(
      `/api/doc-proxy?url=${encodeURIComponent("https://files.example.com/view")}`,
      { headers: authHeaders },
    );
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error, "This is a viewer page, use direct file link");

    const privateUrl = await app.request(
      `/api/doc-proxy?url=${encodeURIComponent("https://127.0.0.1/book.pdf")}`,
      { headers: authHeaders },
    );
    assert.equal(privateUrl.status, 400);
    assert.equal(privateUrl.headers.get("Content-Type")?.includes("application/json"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("doc-proxy rejects nested Google Docs and Microsoft Office viewers before fetching", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("unexpected");
  };
  try {
    for (const url of [
      "https://docs.google.com/gview?embedded=1&url=https%3A%2F%2Ffiles.example.com%2Flesson.docx",
      "https://view.officeapps.live.com/op/embed.aspx?src=https%3A%2F%2Ffiles.example.com%2Flesson.docx",
    ]) {
      const response = await app.request(
        `/api/doc-proxy?url=${encodeURIComponent(url)}`,
        { headers: authHeaders },
      );
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.equal(payload.error, "Nested viewers not allowed");
    }
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
