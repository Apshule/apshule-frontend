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
app.route("/", documentRoutes);

const authHeaders = { authorization: "Bearer test-token" };

test("document routes require an authenticated user", async () => {
  const response = await app.request(
    "/detect-doc-kind",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://files.example.com/book.pdf" }) },
  );
  assert.equal(response.status, 401);
});

test("POST detect-doc-kind returns the server classification for authenticated users", async () => {
  const response = await app.request(
    "/detect-doc-kind",
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
    const path = `/doc-proxy?url=${encodeURIComponent(url)}`;
    const first = await app.request(path, { headers: authHeaders });
    const second = await app.request(path, { headers: authHeaders });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(first.headers.get("Cache-Control"), /max-age=3600/u);
    assert.equal(first.headers.get("Content-Type"), "application/pdf");
    assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [37, 80, 68, 70]);
    assert.equal(second.status, 200);
    assert.equal(fetchCount, 1);

    const alias = await app.request(
      `/pdf-proxy?url=${encodeURIComponent("https://files.example.com/legacy.pdf")}`,
      { headers: authHeaders },
    );
    assert.equal(alias.status, 200);
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else delete globalThis.caches;
  }
});

test("doc-proxy returns the exact viewer-page error and rejects private IP URLs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>viewer</html>", {
    headers: { "Content-Type": "text/html" },
  });
  try {
    const response = await app.request(
      `/doc-proxy?url=${encodeURIComponent("https://files.example.com/view")}`,
      { headers: authHeaders },
    );
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error, "This is a viewer page, use direct file link");

    const privateUrl = await app.request(
      `/doc-proxy?url=${encodeURIComponent("https://127.0.0.1/book.pdf")}`,
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
        `/doc-proxy?url=${encodeURIComponent(url)}`,
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
