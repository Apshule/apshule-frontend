import { Hono, type Context, type Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRealSuperAdmin } from "../auth.js";
import { readJson, requiredString } from "../http.js";
import {
  detectDocKind,
  DocumentProxyError,
  fetchDocumentStream,
  fetchWithTimeout,
  parseHttpUrl,
  validateDocumentProxyUrl,
} from "../document-kind.js";
import {
  pdfUrlExpiresAt,
  getPdfResolverSkipReason,
  resolvePdfUrl,
  type PdfResolutionStatus,
} from "../pdf-resolver.js";
import type { AppEnv } from "../types.js";

const documents = new Hono<AppEnv>();
const DOCUMENT_CACHE_SECONDS = 60 * 60;
const PUBLIC_PROXY_LINK_SECONDS = 60 * 60;
const PUBLIC_PROXY_TOKEN_AAD = "APSHULE-DOC-PROXY-V1";
const PDF_LINK_EXPIRY_SAFETY_SECONDS = 5 * 60;
const PDF_BATCH_DEFAULT_LIMIT = 20;
const PDF_BATCH_MAX_LIMIT = 50;
const PDF_PROXY_TIMEOUT_MS = 15_000;
const DOCUMENT_PROXY_TIMEOUT_MS = 20_000;
const MAX_PDF_RANGE_HEADER_LENGTH = 128;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{1,8192}$/u.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function publicProxyEncryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("APSHULE-DOC-PROXY"),
      info: new TextEncoder().encode(PUBLIC_PROXY_TOKEN_AAD),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function createPublicProxyToken(
  targetUrl: URL,
  expiresAt: number,
  secret: string,
): Promise<string> {
  const key = await publicProxyEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(PUBLIC_PROXY_TOKEN_AAD);
  const plaintext = new TextEncoder().encode(JSON.stringify({
    url: targetUrl.toString(),
    expiresAt,
    download: false,
  }));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    key,
    plaintext,
  ));
  const token = new Uint8Array(iv.byteLength + encrypted.byteLength);
  token.set(iv);
  token.set(encrypted, iv.byteLength);
  return toBase64Url(token);
}

async function readPublicProxyToken(
  token: string,
  secret: string | undefined,
): Promise<{ url: string; expiresAt: number; download: boolean } | null> {
  if (!secret) return null;
  const bytes = fromBase64Url(token);
  if (!bytes || bytes.byteLength < 12 + 16) return null;
  try {
    const key = await publicProxyEncryptionKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.slice(0, 12),
        additionalData: new TextEncoder().encode(PUBLIC_PROXY_TOKEN_AAD),
        tagLength: 128,
      },
      key,
      bytes.slice(12),
    );
    const claims = JSON.parse(new TextDecoder().decode(plaintext)) as {
      url?: unknown;
      expiresAt?: unknown;
      download?: unknown;
    };
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof claims.url !== "string" ||
      claims.url.length > 2048 ||
      !Number.isInteger(claims.expiresAt) ||
      (claims.expiresAt as number) <= now ||
      (claims.expiresAt as number) > now + PUBLIC_PROXY_LINK_SECONDS ||
      claims.download !== false
    ) {
      return null;
    }
    return {
      url: claims.url,
      expiresAt: claims.expiresAt as number,
      download: false,
    };
  } catch {
    return null;
  }
}

function documentFilename(targetUrl: URL): string {
  let filename = targetUrl.pathname.split("/").pop() || "";
  try {
    filename = decodeURIComponent(filename);
  } catch {
    // Use the encoded basename when it contains malformed escapes.
  }
  return filename
    .replace(/[\u0000-\u001f\u007f"\\/:;]/gu, "_")
    .replace(/\s+/gu, " ")
    .slice(0, 120)
    .trim() || "document";
}

documents.post("/detect-doc-kind", authMiddleware, async (c) => {
  const body = await readJson(c);
  const url = requiredString(body, "url", { max: 2048 });
  try {
    parseHttpUrl(url);
  } catch (error) {
    if (error instanceof DocumentProxyError) {
      throw new ApiError(error.status, "VALIDATION_ERROR", error.message);
    }
    throw error;
  }
  return c.json({ kind: detectDocKind(url) });
});

async function documentCacheKey(
  requestUrl: string,
  targetUrl: URL,
  download: boolean,
): Promise<Request> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${targetUrl.toString()}\n${download ? "download" : "inline"}`),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return new Request(`${new URL(requestUrl).origin}/__apshule_document_cache/${hash}`);
}

async function documentProxyAuth(c: Context<AppEnv>, next: Next) {
  if (c.req.query("public") === "1") return next();
  return authMiddleware(c, next);
}

type PdfCacheRow = {
  resolved_pdf_url?: string | null;
  resolve_status?: string | null;
  resolve_reason?: string | null;
  resolved_at?: string | Date | null;
};

type CachedPdfResolution = {
  status: PdfResolutionStatus;
  directUrl?: string;
  errorCode?: "TIMEOUT";
  reason?: string;
};

function isResolvedUrlFresh(value: string, nowSeconds: number): boolean {
  const expiry = pdfUrlExpiresAt(value);
  return expiry === null || expiry > nowSeconds + PDF_LINK_EXPIRY_SAFETY_SECONDS;
}

function cachedPdfResolution(row: PdfCacheRow | undefined): CachedPdfResolution | null {
  if (!row) return null;
  if (row.resolve_status === "resolved" && row.resolved_pdf_url) {
    if (isResolvedUrlFresh(row.resolved_pdf_url, Math.floor(Date.now() / 1000))) {
      return { status: "resolved", directUrl: row.resolved_pdf_url };
    }
    return null;
  }
  if (row.resolve_status === "unresolvable") {
    return { status: "unresolvable", reason: row.resolve_reason ?? "unresolvable" };
  }
  if (row.resolve_status === "not_pdf") {
    return { status: "not_pdf", reason: row.resolve_reason ?? "source_url_not_pdf" };
  }
  return null;
}

async function findCachedPdfResolution(
  sql: ReturnType<typeof getDb>,
  sourceUrl: string,
): Promise<CachedPdfResolution | null> {
  const pdfRows = await sql`
    SELECT resolved_pdf_url, resolve_status, resolve_reason, resolved_at
    FROM pdfs
    WHERE url = ${sourceUrl}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const fromPdf = cachedPdfResolution(pdfRows[0] as PdfCacheRow | undefined);
  if (fromPdf) return fromPdf;

  const curriculumRows = await sql`
    SELECT resolved_syllabus_url AS resolved_pdf_url, 'resolved'::text AS resolve_status
    FROM curriculum_links
    WHERE syllabus_url = ${sourceUrl} AND resolved_syllabus_url IS NOT NULL
    UNION ALL
    SELECT resolved_learner_book_url AS resolved_pdf_url, 'resolved'::text AS resolve_status
    FROM curriculum_links
    WHERE learner_book_url = ${sourceUrl} AND resolved_learner_book_url IS NOT NULL
    UNION ALL
    SELECT resolved_teacher_guide_url AS resolved_pdf_url, 'resolved'::text AS resolve_status
    FROM curriculum_links
    WHERE teacher_guide_url = ${sourceUrl} AND resolved_teacher_guide_url IS NOT NULL
    LIMIT 1
  `;
  return cachedPdfResolution(curriculumRows[0] as PdfCacheRow | undefined);
}

async function persistPdfResolution(
  sql: ReturnType<typeof getDb>,
  sourceUrl: string,
  status: PdfResolutionStatus,
  directUrl: string | null,
  reason: string | null = null,
): Promise<void> {
  await sql`
    UPDATE pdfs
    SET resolved_pdf_url = ${directUrl},
        resolve_status = ${status},
        resolve_reason = ${reason},
        resolved_at = NOW(),
        doc_kind = CASE WHEN ${status === "resolved"} THEN 'pdf' ELSE doc_kind END
    WHERE url = ${sourceUrl}
  `;
  await sql`
    UPDATE curriculum_links
    SET resolved_syllabus_url = CASE
          WHEN syllabus_url = ${sourceUrl} THEN ${directUrl}
          ELSE resolved_syllabus_url
        END,
        resolved_learner_book_url = CASE
          WHEN learner_book_url = ${sourceUrl} THEN ${directUrl}
          ELSE resolved_learner_book_url
        END,
        resolved_teacher_guide_url = CASE
          WHEN teacher_guide_url = ${sourceUrl} THEN ${directUrl}
          ELSE resolved_teacher_guide_url
        END
    WHERE syllabus_url = ${sourceUrl}
       OR learner_book_url = ${sourceUrl}
       OR teacher_guide_url = ${sourceUrl}
  `;
}

async function resolveAndCachePdfUrl(
  env: AppEnv["Bindings"],
  sourceUrl: string,
): Promise<CachedPdfResolution> {
  const sql = getDb(env);
  const skipReason = getPdfResolverSkipReason(sourceUrl);
  if (skipReason) {
    await persistPdfResolution(sql, sourceUrl, "unresolvable", null, skipReason);
    return { status: "unresolvable", reason: skipReason };
  }
  const cached = await findCachedPdfResolution(sql, sourceUrl);
  if (cached) return cached;

  const resolution = await resolvePdfUrl(sourceUrl);
  const directUrl = resolution.status === "resolved" ? resolution.directUrl ?? null : null;
  await persistPdfResolution(
    sql,
    sourceUrl,
    resolution.status,
    directUrl,
    resolution.reason ?? null,
  );
  return {
    status: resolution.status,
    ...(directUrl ? { directUrl } : {}),
    ...(resolution.errorCode ? { errorCode: resolution.errorCode } : {}),
    ...(resolution.reason ? { reason: resolution.reason } : {}),
  };
}

function normalizeResolveBatchLimit(value: unknown): number {
  if (value === undefined || value === null) return PDF_BATCH_DEFAULT_LIMIT;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > PDF_BATCH_MAX_LIMIT
  ) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `limit must be an integer from 1 to ${PDF_BATCH_MAX_LIMIT}.`,
    );
  }
  return value;
}

async function proxyDocument(c: Context<AppEnv>) {
  const isPublic = c.req.query("public") === "1";
  const download = c.req.query("download") === "1";
  const rawUrl = c.req.query("url") ?? "";
  const skipReason = !isPublic ? getPdfResolverSkipReason(rawUrl) : null;
  if (skipReason) {
    return c.json({
      error: "Cannot resolve to PDF",
      code: "UNRESOLVABLE",
      original_url: rawUrl,
    }, 422);
  }
  let targetUrl: URL;
  try {
    if (isPublic) {
      const claims = await readPublicProxyToken(
        c.req.query("token") ?? "",
        c.env.JWT_SECRET,
      );
      if (!claims || claims.download !== download) {
        throw new ApiError(401, "INVALID_PUBLIC_DOCUMENT_LINK", "This public document link is invalid or expired.");
      }
      targetUrl = validateDocumentProxyUrl(claims.url);
    } else {
      targetUrl = validateDocumentProxyUrl(rawUrl);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DocumentProxyError) {
      throw new ApiError(error.status, "INVALID_DOCUMENT_URL", error.message);
    }
    throw error;
  }

  const sourceKind = detectDocKind(targetUrl.toString());
  const hasFileExtension = /\.[a-z0-9]{1,12}$/iu.test(targetUrl.pathname);
  if (sourceKind === "viewer" || (sourceKind === "other" && !hasFileExtension)) {
    const resolution = await resolveAndCachePdfUrl(c.env, targetUrl.toString());
    if (resolution.status !== "resolved" || !resolution.directUrl) {
      return c.json({
        error: "Cannot resolve to PDF",
        code: "UNRESOLVABLE",
        original_url: targetUrl.toString(),
      }, 422);
    }
    try {
      targetUrl = validateDocumentProxyUrl(resolution.directUrl);
    } catch (error) {
      if (error instanceof DocumentProxyError) {
        throw new ApiError(502, "PDF_LINK_INVALID", "The PDF link could not be safely opened.");
      }
      throw error;
    }
  }

  const isPdf = targetUrl.pathname.toLowerCase().endsWith(".pdf");
  const rawRange = c.req.header("Range") ?? null;
  const range = isPdf ? parsePdfRange(rawRange) : { value: null, invalid: false };
  if (range.invalid) {
    return c.json({ error: "Invalid PDF byte range", code: "INVALID_RANGE" }, 416);
  }
  const cache = (globalThis as typeof globalThis & {
    caches?: { default?: Cache };
  }).caches?.default;
  const key = await documentCacheKey(c.req.url, targetUrl, download);
  if (cache && !range.value) {
    try {
      const cached = await cache.match(key);
      if (cached) return cached;
    } catch {
      console.warn("[doc-proxy] cache read failed");
    }
  }

  let document: {
    body: ReadableStream<Uint8Array>;
    contentType: string;
    contentLength: number | null;
    status: number;
    contentRange: string | null;
    acceptRanges: string | null;
  };
  try {
    document = await fetchDocumentStream(
      targetUrl.toString(),
      (input, init) => fetchWithTimeout(
        input,
        { ...init, signal: c.req.raw.signal },
        DOCUMENT_PROXY_TIMEOUT_MS,
      ),
      { range: range.value, requirePdf: isPdf },
    );
  } catch (error) {
    if (error instanceof DocumentProxyError) {
      return c.json(
        { error: error.message, code: error.code },
        error.status as ContentfulStatusCode,
      );
    }
    console.error("[doc-proxy] upstream request failed");
    return c.json({ error: "Could not load the document.", code: "UPSTREAM_ERROR" }, 502);
  }

  const responseHeaders = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Disposition, Content-Length, Content-Range, Content-Type",
    "Cache-Control": `public, max-age=${DOCUMENT_CACHE_SECONDS}, s-maxage=${DOCUMENT_CACHE_SECONDS}`,
    "Content-Type": document.contentType,
    "X-Content-Type-Options": "nosniff",
  });
  if (isPdf) responseHeaders.set("Accept-Ranges", document.acceptRanges || "bytes");
  if (document.contentLength !== null) {
    responseHeaders.set("Content-Length", String(document.contentLength));
  }
  if (document.contentRange) {
    responseHeaders.set("Content-Range", document.contentRange);
  }
  if (download) {
    responseHeaders.set(
      "Content-Disposition",
      `attachment; filename="${documentFilename(targetUrl)}"`,
    );
  }
  const response = new Response(document.body, {
    status: document.status,
    headers: responseHeaders,
  });

  if (cache && !range.value && document.status === 200) {
    try {
      c.executionCtx.waitUntil(
        cache.put(key, response.clone()).catch(() => {
          console.warn("[doc-proxy] cache write failed");
        }),
      );
    } catch {
      console.warn("[doc-proxy] cache write failed");
    }
  }
  return response;
}

function parsePdfRange(value: string | null): { value: string | null; invalid: boolean } {
  if (!value) return { value: null, invalid: false };
  if (value.length > MAX_PDF_RANGE_HEADER_LENGTH) {
    return { value: null, invalid: true };
  }
  const match = value.match(/^bytes=(\d+)-(\d*)$/u);
  if (!match) return { value: null, invalid: true };
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  if (
    !Number.isSafeInteger(start) ||
    (end !== null && (!Number.isSafeInteger(end) || end < start))
  ) {
    return { value: null, invalid: true };
  }
  return { value, invalid: false };
}

async function proxyDirectPdf(c: Context<AppEnv>) {
  const rawUrl = c.req.query("url") ?? "";
  if (!rawUrl || rawUrl.length > 2048) {
    return c.json({ error: "A PDF URL is required.", code: "INVALID_PDF_URL" }, 400);
  }
  let targetUrl: URL;
  try {
    targetUrl = validateDocumentProxyUrl(rawUrl);
  } catch (error) {
    const message = error instanceof DocumentProxyError
      ? error.message
      : "The PDF URL is invalid.";
    return c.json({ error: message, code: "INVALID_PDF_URL" }, 400);
  }
  if (
    targetUrl.protocol !== "https:" ||
    !targetUrl.pathname.toLowerCase().endsWith(".pdf")
  ) {
    return c.json({ error: "Not a PDF", code: "NOT_PDF" }, 415);
  }

  const range = parsePdfRange(c.req.header("Range") ?? null);
  if (range.invalid) {
    return c.json({ error: "Invalid PDF byte range", code: "INVALID_RANGE" }, 416);
  }

  let document: Awaited<ReturnType<typeof fetchDocumentStream>>;
  try {
    document = await fetchDocumentStream(
      targetUrl.toString(),
      (input, init) => fetchWithTimeout(
        input,
        { ...init, signal: c.req.raw.signal },
        PDF_PROXY_TIMEOUT_MS,
      ),
      { range: range.value, requirePdf: true },
    );
  } catch (error) {
    if (error instanceof DocumentProxyError) {
      return c.json(
        { error: error.message, code: error.code },
        error.status as ContentfulStatusCode,
      );
    }
    console.error("[doc-proxy-direct] upstream request failed");
    return c.json({ error: "Could not load the PDF.", code: "UPSTREAM_ERROR" }, 502);
  }

  const responseHeaders = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Disposition, Content-Length, Content-Range, Content-Type",
    "Cache-Control": `public, max-age=${DOCUMENT_CACHE_SECONDS}, s-maxage=${DOCUMENT_CACHE_SECONDS}`,
    "Content-Type": "application/pdf",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": document.acceptRanges || "bytes",
  });
  if (document.contentLength !== null) {
    responseHeaders.set("Content-Length", String(document.contentLength));
  }
  if (document.contentRange) {
    responseHeaders.set("Content-Range", document.contentRange);
  }
  if (c.req.query("download") === "1") {
    responseHeaders.set(
      "Content-Disposition",
      `attachment; filename="${documentFilename(targetUrl)}"`,
    );
  }
  return new Response(document.body, {
    status: document.status,
    headers: responseHeaders,
  });
}

documents.post("/pdf-prefetch", authMiddleware, async (c) => {
  const body = await readJson(c);
  const rawUrl = requiredString(body, "url", { max: 2048 });
  const skipReason = getPdfResolverSkipReason(rawUrl);
  if (skipReason) {
    const originalUrl = parseHttpUrl(rawUrl).toString();
    await resolveAndCachePdfUrl(c.env, originalUrl);
    c.header("Cache-Control", "no-store");
    return c.json({
      error: "Cannot resolve to PDF",
      code: "UNRESOLVABLE",
      original_url: originalUrl,
    }, 422);
  }
  let sourceUrl: URL;
  try {
    sourceUrl = validateDocumentProxyUrl(rawUrl);
  } catch (error) {
    if (error instanceof DocumentProxyError) {
      throw new ApiError(error.status, "INVALID_DOCUMENT_URL", error.message);
    }
    throw error;
  }
  if (sourceUrl.protocol !== "https:") {
    throw new ApiError(400, "INVALID_DOCUMENT_URL", "PDF links must use HTTPS.");
  }

  const resolution = await resolveAndCachePdfUrl(c.env, sourceUrl.toString());
  c.header("Cache-Control", "no-store");
  if (resolution.status !== "resolved" || !resolution.directUrl) {
    return c.json({
      error: "Cannot resolve to PDF",
      code: "UNRESOLVABLE",
      original_url: sourceUrl.toString(),
    }, 422);
  }
  const expiresAt = resolution.directUrl ? pdfUrlExpiresAt(resolution.directUrl) : null;
  return c.json({
    status: resolution.status,
    direct_url: resolution.directUrl ?? null,
    expires_at: expiresAt,
    ...(resolution.errorCode ? { error_code: resolution.errorCode } : {}),
  });
});

documents.post(
  "/admin/resolve-pdf-links",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const body = await readJson(c);
    const limit = normalizeResolveBatchLimit(body.limit);
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT id, url
      FROM pdfs
      WHERE COALESCE(resolve_status, 'unresolved') = 'unresolved'
         OR (resolve_status = 'not_pdf' AND doc_kind = 'viewer')
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}
    ` as Array<{ id: string; url: string }>;

    const runBatch = async (reportProgress?: (event: Record<string, unknown>) => void) => {
      let resolved = 0;
      let failed = 0;
      let notPdf = 0;
      let unresolvable = 0;
      const processedResults: Array<{
        id: string;
        status: PdfResolutionStatus;
        reason: string | null;
      }> = [];

      for (const [index, row] of rows.entries()) {
        reportProgress?.({
          type: "processing",
          current: index + 1,
          total: rows.length,
          done: index,
        });
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, 200));

        let result: Awaited<ReturnType<typeof resolveAndCachePdfUrl>>;
        try {
          result = await resolveAndCachePdfUrl(c.env, row.url);
        } catch {
          result = { status: "unresolvable", reason: "resolver_exception" };
          await persistPdfResolution(sql, row.url, "unresolvable", null, "resolver_exception");
        }

        if (result.status === "resolved") resolved += 1;
        else if (result.status === "not_pdf") notPdf += 1;
        else if (result.status === "unresolvable") unresolvable += 1;
        else failed += 1;

        const processedResult = {
          id: row.id,
          status: result.status,
          reason: result.reason ?? null,
        };
        processedResults.push(processedResult);
        reportProgress?.({
          type: "item",
          current: index + 1,
          total: rows.length,
          result: processedResult,
        });
      }

      const remainingRows = await sql`
        SELECT COUNT(*)::int AS count
        FROM pdfs
        WHERE COALESCE(resolve_status, 'unresolved') = 'unresolved'
           OR (resolve_status = 'not_pdf' AND doc_kind = 'viewer')
      `;
      return {
        processed: rows.length,
        resolved,
        failed,
        not_pdf: notPdf,
        unresolvable,
        remaining: Number((remainingRows[0] as { count?: number } | undefined)?.count ?? 0),
        processed_ids: processedResults.map((result) => result.id),
        processed_results: processedResults,
      };
    };

    if (c.req.header("accept")?.includes("text/event-stream")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (event: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          };
          send({ type: "start", total: rows.length });
          void runBatch(send)
            .then((result) => {
              send({ type: "complete", result });
              controller.close();
            })
            .catch(() => {
              send({ type: "error", message: "Could not complete the PDF resolver batch." });
              controller.close();
            });
        },
      });
      return c.body(stream, 200, {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      });
    }

    return c.json(await runBatch());
  },
);

documents.post("/doc-proxy-link", authMiddleware, async (c) => {
  const body = await readJson(c);
  const rawUrl = requiredString(body, "url", { max: 2048 });
  let targetUrl: URL;
  try {
    targetUrl = validateDocumentProxyUrl(rawUrl);
  } catch (error) {
    if (error instanceof DocumentProxyError) {
      throw new ApiError(error.status, "INVALID_DOCUMENT_URL", error.message);
    }
    throw error;
  }
  const kind = detectDocKind(targetUrl.toString());
  if (kind !== "document" && kind !== "spreadsheet" && kind !== "presentation") {
    throw new ApiError(415, "UNSUPPORTED_DOCUMENT_PREVIEW", "This link is not a supported Office document.");
  }
  const secret = c.env.JWT_SECRET;
  if (!secret) {
    throw new ApiError(503, "DOCUMENT_PREVIEW_UNAVAILABLE", "Document preview is temporarily unavailable.");
  }
  const expiresAt = Math.floor(Date.now() / 1000) + PUBLIC_PROXY_LINK_SECONDS;
  const token = await createPublicProxyToken(targetUrl, expiresAt, secret);
  const proxyUrl = new URL("/api/doc-proxy", c.req.url);
  proxyUrl.searchParams.set("public", "1");
  proxyUrl.searchParams.set("token", token);
  c.header("Cache-Control", "no-store");
  return c.json({ url: proxyUrl.toString(), expiresAt });
});

documents.get("/doc-proxy", documentProxyAuth, proxyDocument);
documents.get("/pdf-proxy", authMiddleware, proxyDocument);
documents.get("/doc-proxy-direct", authMiddleware, proxyDirectPdf);

export default documents;
