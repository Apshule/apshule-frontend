import assert from "node:assert/strict";
import test from "node:test";
import {
  getPdfResolverSkipReason,
  pdfUrlExpiresAt,
  PDF_VIEWER_FETCH_TIMEOUT_MS,
  resolvePdfUrl,
} from "../src/pdf-resolver.ts";

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

test("supported viewer HTML extracts only a strict direct PDF URL and removes tracking parameters", async () => {
  const viewerUrl = "https://elearn.ncdc.go.ug/viewer/example-id";
  const directUrl = "https://files.example.com/lesson.pdf?X-Amz-Date=20261008T120000Z&amp;X-Amz-Expires=3600&amp;utm_source=reader&amp;token=keep";
  const requests = [];
  const result = await resolvePdfUrl(viewerUrl, async (url, init) => {
    requests.push({ url, init });
    return new Response(`<html><iframe src="${directUrl}"></iframe></html>`, {
      headers: { "Content-Type": "text/html" },
    });
  });

  assert.equal(result.status, "resolved");
  assert.equal(
    result.directUrl,
    "https://files.example.com/lesson.pdf?X-Amz-Date=20261008T120000Z&X-Amz-Expires=3600&token=keep",
  );
  assert.equal(requests.length, 1);
  assert.equal(
    result.expiresAt,
    Math.floor(Date.UTC(2026, 9, 8, 12, 0, 0) / 1000) + 3600,
  );
});

test("viewer HTML without a strict .pdf URL is marked unresolvable", async () => {
  const result = await resolvePdfUrl(
    "https://elearn.ncdc.go.ug/viewer/no-pdf",
    async () => new Response('<html><a href="https://files.example.com/download?id=lesson.pdf">No direct file</a></html>', {
      headers: { "Content-Type": "text/html" },
    }),
  );
  assert.deepEqual(result, {
    status: "unresolvable",
    reason: "no_direct_pdf_url_found",
  });
});

test("resolver extracts a direct URL without probing it or following its redirects", async () => {
  const viewerUrl = "https://elearn.ncdc.go.ug/viewer/no-probe";
  const requests = [];
  const result = await resolvePdfUrl(viewerUrl, async url => {
    requests.push(url);
    return new Response(
      '<html><iframe src="https://files.example.com/lesson.pdf"></iframe></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.directUrl, "https://files.example.com/lesson.pdf");
  assert.deepEqual(requests, [viewerUrl]);
});

test("blocklisted viewer URLs skip network fetches and are marked unresolvable", async () => {
  const blocklisted = [
    ["https://pdftolink.com/view/lesson", "pdftolink_viewer_page"],
    ["https://pdftolink.app/view/lesson", "pdftolink_viewer_page"],
    ["https://docs.google.com/viewer?url=https%3A%2F%2Ffiles.example.com%2Flesson.pdf", "google_viewer_page"],
    ["https://issuu.com/school/docs/lesson", "unsupported_viewer_issuu_com"],
    ["https://scribd.com/document/123/lesson", "unsupported_viewer_scribd_com"],
    ["https://slideshare.net/school/lesson", "unsupported_viewer_slideshare_net"],
  ];
  for (const [url, reason] of blocklisted) {
    let fetchCalled = false;
    assert.equal(getPdfResolverSkipReason(url), reason);
    assert.deepEqual(await resolvePdfUrl(url, async () => {
      fetchCalled = true;
      throw new Error("Must not fetch blocklisted viewer pages.");
    }), { status: "unresolvable", reason });
    assert.equal(fetchCalled, false);
  }
});

test("resolver requires HTTPS and reports unreachable viewer pages as unresolvable", async () => {
  let fetchCalled = false;
  const insecure = await resolvePdfUrl("http://files.example.com/lesson.pdf", async () => {
    fetchCalled = true;
    return new Response("unexpected");
  });
  assert.equal(insecure.status, "unresolvable");
  assert.equal(fetchCalled, false);

  const failed = await resolvePdfUrl("https://elearn.ncdc.go.ug/viewer/offline", async () => {
    throw new Error("network unavailable");
  });
  assert.deepEqual(failed, { status: "unresolvable", reason: "viewer_page_unavailable" });
});

test("resolver reports a structured timeout for a stalled viewer fetch", async () => {
  const result = await resolvePdfUrl(
    "https://elearn.ncdc.go.ug/viewer/slow",
    async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    { viewer: 20 },
  );

  assert.deepEqual(result, {
    status: "unresolvable",
    errorCode: "TIMEOUT",
    reason: "viewer_fetch_timeout",
  });
  assert.equal(PDF_VIEWER_FETCH_TIMEOUT_MS, 4000);
});

test("signed PDF URL expiry is parsed without exposing or logging the URL", () => {
  const expiry = pdfUrlExpiresAt(
    "https://files.example.com/book.pdf?X-Amz-Date=20261008T120000Z&X-Amz-Expires=3600&X-Amz-Signature=example",
  );
  assert.equal(expiry, Math.floor(Date.UTC(2026, 9, 8, 12, 0, 0) / 1000) + 3600);
  assert.equal(pdfUrlExpiresAt("https://files.example.com/book.pdf"), null);
});
