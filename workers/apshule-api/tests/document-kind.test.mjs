import assert from "node:assert/strict";
import test from "node:test";
import {
  detectDocKind,
  DocumentProxyError,
  fetchDocumentBytes,
  fetchDocumentStream,
  fetchWithTimeout,
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
    ["https://docs.google.com/viewer?url=https%3A%2F%2Ffiles.example.com%2Flesson.pdf", "viewer"],
    ["https://view.officeapps.live.com/op/embed.aspx?src=https%3A%2F%2Ffiles.example.com%2Flesson.docx", "viewer"],
    ["https://pdftolink.app/view/2ae694af-f2c8-410c-8432-880a9cb34c03", "viewer"],
    ["https://www.pdftolink.com/view/lesson", "viewer"],
    ["https://issuu.com/school/docs/lesson", "viewer"],
    ["https://scribd.com/document/123/lesson", "viewer"],
    ["https://slideshare.net/school/lesson", "viewer"],
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
  assert.deepEqual(requests[1].init.cf, { cacheTtl: 3600, cacheEverything: true });
  assert.match(requests[1].init.headers["User-Agent"], /APSHULE-ELibrary/u);
  assert.equal(result.contentType, "application/pdf");
  assert.deepEqual([...result.body], [37, 80, 68, 70]);
});

test("proxy stream returns the initial bytes without buffering the rest of the document", async () => {
  let releaseRemainder;
  let pullCount = 0;
  const upstreamBody = new ReadableStream({
    pull(controller) {
      pullCount += 1;
      if (pullCount === 1) {
        controller.enqueue(new Uint8Array(512).fill(37));
      } else if (pullCount === 2) {
        return new Promise((resolve) => {
          releaseRemainder = () => {
            controller.enqueue(new Uint8Array(512).fill(80));
            controller.close();
            resolve();
          };
        });
      }
    },
  }, { highWaterMark: 0 });

  const result = await fetchDocumentStream(
    "https://files.example.com/book.pdf",
    async () => new Response(upstreamBody, {
      headers: {
        "Content-Length": "1024",
        "Content-Type": "application/pdf",
      },
    }),
  );
  assert.equal(result.contentType, "application/pdf");
  assert.equal(result.contentLength, 1024);
  assert.equal(pullCount, 1);

  const reader = result.body.getReader();
  const first = await reader.read();
  assert.equal(first.value.byteLength, 512);
  assert.equal(first.value[0], 37);
  assert.equal(pullCount, 1);

  const secondPending = reader.read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseRemainder, "function");
  releaseRemainder();
  const second = await secondPending;
  assert.equal(second.value.byteLength, 512);
  assert.equal(second.value[0], 80);
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
});

test("PDF proxy streams single byte ranges and preserves partial-response metadata", async () => {
  let requestedRange = null;
  const result = await fetchDocumentStream(
    "https://files.example.com/book.pdf",
    async (_url, init) => {
      requestedRange = init.headers.Range;
      return new Response(new TextEncoder().encode("%PDF-1.7"), {
        status: 206,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": "8",
          "Content-Range": "bytes 0-7/2048",
          "Content-Type": "application/pdf",
        },
      });
    },
    { range: "bytes=0-7", requirePdf: true },
  );

  assert.equal(requestedRange, "bytes=0-7");
  assert.equal(result.status, 206);
  assert.equal(result.contentRange, "bytes 0-7/2048");
  assert.equal(result.acceptRanges, "bytes");
  assert.deepEqual([...new Uint8Array(await new Response(result.body).arrayBuffer())], [...new TextEncoder().encode("%PDF-1.7")]);
});

test("direct PDF proxy rejects a non-PDF content type", async () => {
  await assert.rejects(
    fetchDocumentStream(
      "https://files.example.com/book.pdf",
      async () => new Response("<html>not a PDF</html>", {
        headers: { "Content-Type": "text/html" },
      }),
      { requirePdf: true },
    ),
    (error) => error instanceof DocumentProxyError &&
      error.status === 415 &&
      error.code === "NOT_PDF",
  );
});

test("fetchWithTimeout aborts stalled upstream headers and stalled body reads", async () => {
  await assert.rejects(
    fetchWithTimeout(
      "https://files.example.com/book.pdf",
      {},
      20,
      async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ),
    (error) => error instanceof DocumentProxyError &&
      error.status === 504 &&
      error.code === "TIMEOUT",
  );

  const stalledBody = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
  }, { highWaterMark: 0 });
  const response = await fetchWithTimeout(
    "https://files.example.com/book.pdf",
    {},
    20,
    async () => new Response(stalledBody, {
      headers: { "Content-Type": "application/pdf" },
    }),
  );
  const reader = response.body.getReader();
  await assert.rejects(
    reader.read(),
    (error) => error instanceof DocumentProxyError &&
      error.status === 504 &&
      error.code === "TIMEOUT",
  );
  reader.releaseLock();
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
