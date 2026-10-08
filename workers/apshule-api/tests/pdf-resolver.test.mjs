import assert from "node:assert/strict";
import test from "node:test";
import { pdfUrlExpiresAt, resolvePdfUrl } from "../src/pdf-resolver.ts";

const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49]);

test("direct HTTPS PDFs resolve without fetching a viewer page", async () => {
  let fetchCalled = false;
  const result = await resolvePdfUrl("https://files.example.com/lesson.pdf", async () => {
    fetchCalled = true;
    return new Response("unexpected");
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.directUrl, "https://files.example.com/lesson.pdf");
  assert.equal(fetchCalled, false);
});

test("PDFToLink HTML resolves and verifies the embedded direct PDF URL", async () => {
  const viewerUrl = "https://pdftolink.app/view/example-id";
  const directUrl = "https://files.example.com/lesson.pdf?X-Amz-Date=20261008T120000Z&amp;X-Amz-Expires=3600";
  const requests = [];
  const result = await resolvePdfUrl(viewerUrl, async (url, init) => {
    requests.push({ url, init });
    if (url === viewerUrl) {
      return new Response(`<html><iframe src="${directUrl}"></iframe></html>`, {
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response(pdfBytes, {
      status: 206,
      headers: { "Content-Type": "application/pdf" },
    });
  });

  assert.equal(result.status, "resolved");
  assert.equal(
    result.directUrl,
    "https://files.example.com/lesson.pdf?X-Amz-Date=20261008T120000Z&X-Amz-Expires=3600",
  );
  assert.equal(requests.length, 2);
  assert.equal(new Headers(requests[1].init.headers).get("Range"), "bytes=0-4");
  assert.equal(
    result.expiresAt,
    Math.floor(Date.UTC(2026, 9, 8, 12, 0, 0) / 1000) + 3600,
  );
});

test("viewer HTML without a verified PDF is reported as not_pdf", async () => {
  const result = await resolvePdfUrl(
    "https://pdftolink.app/view/no-pdf",
    async () => new Response("<html><p>No file</p></html>", {
      headers: { "Content-Type": "text/html" },
    }),
  );
  assert.deepEqual(result, { status: "not_pdf" });
});

test("resolver rejects an unsafe redirect and never fetches the private target", async () => {
  const viewerUrl = "https://pdftolink.app/view/unsafe";
  const requests = [];
  const result = await resolvePdfUrl(viewerUrl, async (url) => {
    requests.push(url);
    if (url === viewerUrl) {
      return new Response(
        '<html><iframe src="https://files.example.com/lesson.pdf"></iframe></html>',
        { headers: { "Content-Type": "text/html" } },
      );
    }
    return new Response(null, {
      status: 302,
      headers: { Location: "https://127.0.0.1/internal.pdf" },
    });
  });
  assert.equal(result.status, "not_pdf");
  assert.deepEqual(requests, [
    viewerUrl,
    "https://files.example.com/lesson.pdf",
  ]);
});

test("resolver requires HTTPS and reports unreachable viewer pages as failed", async () => {
  let fetchCalled = false;
  const insecure = await resolvePdfUrl("http://files.example.com/lesson.pdf", async () => {
    fetchCalled = true;
    return new Response("unexpected");
  });
  assert.equal(insecure.status, "failed");
  assert.equal(fetchCalled, false);

  const failed = await resolvePdfUrl("https://pdftolink.app/view/offline", async () => {
    throw new Error("network unavailable");
  });
  assert.deepEqual(failed, { status: "failed" });
});

test("signed PDF URL expiry is parsed without exposing or logging the URL", () => {
  const expiry = pdfUrlExpiresAt(
    "https://files.example.com/book.pdf?X-Amz-Date=20261008T120000Z&X-Amz-Expires=3600&X-Amz-Signature=example",
  );
  assert.equal(expiry, Math.floor(Date.UTC(2026, 9, 8, 12, 0, 0) / 1000) + 3600);
  assert.equal(pdfUrlExpiresAt("https://files.example.com/book.pdf"), null);
});
