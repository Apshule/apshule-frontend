import assert from "node:assert/strict";
import test from "node:test";
import {
  detectDocKind,
  DocumentProxyError,
  fetchDocumentBytes,
  validateDocumentProxyUrl,
} from "../src/document-kind.ts";

test("detectDocKind classifies supported file extensions and viewer pages", () => {
  const cases = [
    ["https://files.example.com/lesson.PDF?download=1", "pdf"],
    ["https://files.example.com/lesson.png#page=2", "image"],
    ["https://files.example.com/lesson.odt", "document"],
    ["https://files.example.com/lesson.csv", "spreadsheet"],
    ["https://files.example.com/lesson.pptx", "presentation"],
    ["https://files.example.com/lesson.webm", "video"],
    ["https://files.example.com/lesson.m4a", "audio"],
    ["https://files.example.com/lesson.md", "text"],
    ["https://elearn.ncdc.go.ug/viewer/agriculture-s5", "viewer"],
    ["https://docs.google.com/gview?url=https%3A%2F%2Ffiles.example.com%2Flesson.docx", "viewer"],
    ["https://view.officeapps.live.com/op/embed.aspx?src=https%3A%2F%2Ffiles.example.com%2Flesson.docx", "viewer"],
    ["https://files.example.com/share/lesson", "other"],
  ];

  for (const [url, expected] of cases) {
    assert.equal(detectDocKind(url), expected, url);
  }
  assert.equal(detectDocKind(null), null);
});

test("document proxy URL validation rejects local, credentialed, and nonstandard-port URLs", () => {
  assert.equal(
    validateDocumentProxyUrl("https://cdn.example.com/book.pdf").hostname,
    "cdn.example.com",
  );
  for (const url of [
    "https://127.0.0.1/book.pdf",
    "http://localhost/book.pdf",
    "https://host.local/book.pdf",
    "https://user:password@cdn.example.com/book.pdf",
    "https://cdn.example.com:8443/book.pdf",
    "file:///book.pdf",
  ]) {
    assert.throws(() => validateDocumentProxyUrl(url), DocumentProxyError, url);
  }
});

test("document proxy URL validation blocks Google and Microsoft viewer hosts", () => {
  for (const url of [
    "https://docs.google.com/gview?embedded=1&url=https%3A%2F%2Ffiles.example.com%2Flesson.docx",
    "https://view.officeapps.live.com/op/embed.aspx?src=https%3A%2F%2Ffiles.example.com%2Flesson.docx",
  ]) {
    assert.throws(
      () => validateDocumentProxyUrl(url),
      (error) => error instanceof DocumentProxyError &&
        error.status === 400 &&
        error.message === "Nested viewers not allowed",
      url,
    );
  }
});

test("proxy fetch follows safe HTTPS redirects and maps generic PDF MIME types", async () => {
  const requests = [];
  const result = await fetchDocumentBytes(
    "https://files.example.com/book.pdf",
    async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://cdn.example.com/book.pdf" },
        });
      }
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    },
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "https://cdn.example.com/book.pdf");
  assert.equal(requests[1].init.redirect, "manual");
  assert.match(requests[1].init.headers["User-Agent"], /APSHULE-ELibrary/u);
  assert.equal(result.contentType, "application/pdf");
  assert.deepEqual([...result.body], [37, 80, 68, 70]);
});

test("proxy rejects viewer HTML with the required direct-file message", async () => {
  await assert.rejects(
    fetchDocumentBytes(
      "https://files.example.com/view",
      async () => new Response("<html><body>viewer</body></html>", {
        headers: { "Content-Type": "text/html" },
      }),
    ),
    (error) => error instanceof DocumentProxyError &&
      error.status === 415 &&
      error.message === "This is a viewer page, use direct file link",
  );

  await assert.rejects(
    fetchDocumentBytes(
      "https://files.example.com/view",
      async () => new Response("<html><body>viewer</body></html>", {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    ),
    (error) => error instanceof DocumentProxyError && error.status === 415,
  );
});

test("proxy refuses oversized files and insecure redirect downgrades", async () => {
  await assert.rejects(
    fetchDocumentBytes(
      "https://files.example.com/book.pdf",
      async () => new Response(null, {
        headers: { "Content-Length": String(20 * 1024 * 1024 + 1) },
      }),
    ),
    (error) => error instanceof DocumentProxyError && error.status === 413,
  );
  await assert.rejects(
    fetchDocumentBytes(
      "https://files.example.com/book.pdf",
      async () => new Response(null, {
        status: 302,
        headers: { Location: "http://cdn.example.com/book.pdf" },
      }),
    ),
    (error) => error instanceof DocumentProxyError && error.status === 502,
  );
});
