export const DOCUMENT_KINDS = [
  "pdf",
  "image",
  "document",
  "spreadsheet",
  "presentation",
  "video",
  "audio",
  "text",
  "viewer",
  "other",
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

const EXTENSION_KIND: Record<string, DocumentKind> = {
  pdf: "pdf",
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  doc: "document",
  docx: "document",
  odt: "document",
  rtf: "document",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  ods: "spreadsheet",
  csv: "spreadsheet",
  ppt: "presentation",
  pptx: "presentation",
  odp: "presentation",
  mp4: "video",
  webm: "video",
  mov: "video",
  avi: "video",
  mkv: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  ogg: "audio",
  txt: "text",
  md: "text",
};

const EXTENSION_MIME_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv; charset=utf-8",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odp: "application/vnd.oasis.opendocument.presentation",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};
const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
const DOCUMENT_CACHE_SECONDS = 60 * 60;

export class DocumentProxyError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, message: string, code = "DOCUMENT_PROXY_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "DocumentProxyError";
  }
}

export async function fetchWithTimeout(
  value: string,
  init: RequestInit,
  timeoutMs: number,
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  const timeoutError = () =>
    new DocumentProxyError(504, "Upstream timeout", "TIMEOUT");
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const releaseCallerSignal = () =>
    callerSignal?.removeEventListener("abort", abortFromCaller);

  let headerTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(),
    timeoutMs,
  );
  let response: Response;
  try {
    response = await fetcher(value, { ...init, signal: controller.signal });
  } catch (error) {
    releaseCallerSignal();
    if (callerSignal?.aborted) throw error;
    if (controller.signal.aborted) throw timeoutError();
    throw error;
  } finally {
    if (headerTimer !== undefined) clearTimeout(headerTimer);
    headerTimer = undefined;
  }

  if (!response.body) {
    releaseCallerSignal();
    return response;
  }

  const reader = response.body.getReader();
  let finished = false;
  const timedBody = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      if (finished) return;
      let readTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            readTimer = setTimeout(() => reject(timeoutError()), timeoutMs);
          }),
        ]);
        if (readTimer !== undefined) clearTimeout(readTimer);
        if (finished) return;
        if (result.done) {
          finished = true;
          releaseCallerSignal();
          reader.releaseLock();
          streamController.close();
          return;
        }
        streamController.enqueue(result.value);
      } catch (error) {
        if (readTimer !== undefined) clearTimeout(readTimer);
        if (finished) return;
        finished = true;
        releaseCallerSignal();
        controller.abort(error);
        await reader.cancel(error).catch(() => {});
        reader.releaseLock();
        streamController.error(error);
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      releaseCallerSignal();
      await reader.cancel(reason).catch(() => {});
      reader.releaseLock();
    },
  });

  return new Response(timedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function parseHttpUrl(value: string): URL {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    throw new DocumentProxyError(400, "url must be an HTTP or HTTPS URL no longer than 2048 characters.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new DocumentProxyError(400, "url must be a valid HTTP or HTTPS URL.");
  }

  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new DocumentProxyError(400, "url must be a public HTTP or HTTPS URL without embedded credentials.");
  }
  return parsed;
}

export function validateDocumentProxyUrl(value: string): URL {
  const parsed = parseHttpUrl(value);
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    hostname === "docs.google.com" ||
    hostname.endsWith(".docs.google.com") ||
    hostname === "view.officeapps.live.com" ||
    hostname.endsWith(".view.officeapps.live.com")
  ) {
    throw new DocumentProxyError(400, "Nested viewers not allowed");
  }
  const expectedPort = parsed.protocol === "https:" ? "443" : "80";
  const isIpLiteral = hostname.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname);
  const isLocalName =
    hostname === "localhost" ||
    /\.(?:localhost|local|internal|home|lan|test|invalid|example)$/u.test(hostname);

  if (
    isIpLiteral ||
    isLocalName ||
    !hostname.includes(".") ||
    (parsed.port && parsed.port !== expectedPort)
  ) {
    throw new DocumentProxyError(400, "url must point to a public website on the standard HTTP or HTTPS port.");
  }
  return parsed;
}

export function detectDocKind(value: string | null | undefined): DocumentKind | null {
  if (typeof value !== "string" || !value.trim()) return null;

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "other";
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  const pathname = parsed.pathname.toLowerCase();
  const isDomain = (domain: string) =>
    hostname === domain || hostname.endsWith(`.${domain}`);
  if (
    isDomain("elearn.ncdc.go.ug") &&
    /\/viewer(?:\/|$)/u.test(pathname)
  ) {
    return "viewer";
  }
  if (
    (isDomain("pdftolink.app") || isDomain("pdftolink.com")) &&
    pathname.includes("/view/") &&
    !pathname.endsWith(".pdf")
  ) {
    return "viewer";
  }
  if (
    isDomain("docs.google.com") ||
    isDomain("view.officeapps.live.com") ||
    isDomain("issuu.com") ||
    isDomain("scribd.com") ||
    isDomain("slideshare.net")
  ) {
    return "viewer";
  }

  let decodedPathname = pathname;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    // A malformed escape does not prevent safe extension matching.
  }
  const extension = decodedPathname.match(/\.([a-z0-9]+)$/u)?.[1];
  return extension ? EXTENSION_KIND[extension] ?? "other" : "other";
}

function isHtmlContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function isHtmlDocumentPrefix(prefix: string): boolean {
  const normalized = prefix.replace(/^\uFEFF/u, "").trimStart().toLowerCase();
  return /^(?:<!doctype\s+html\b|<html\b|<head\b|<script\b)/u.test(normalized);
}

function fileExtension(url: URL): string | null {
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep the URL parser's encoded path and fall back to the declared MIME type.
  }
  return pathname.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1] ?? null;
}

export async function fetchDocumentStream(
  value: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch,
  options: { range?: string | null; requirePdf?: boolean } = {},
): Promise<{
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength: number | null;
  status: number;
  contentRange: string | null;
  acceptRanges: string | null;
}> {
  let currentUrl = validateDocumentProxyUrl(value);
  let upstream: Response | null = null;

  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    upstream = await fetcher(currentUrl.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; APSHULE-ELibrary/1.0)",
        Accept: "*/*",
        ...(options.range ? { Range: options.range } : {}),
      },
      redirect: "manual",
      ...(!options.range
        ? { cf: { cacheTtl: DOCUMENT_CACHE_SECONDS, cacheEverything: true } }
        : {}),
    } as RequestInit);

    if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
    const location = upstream.headers.get("Location");
    await upstream.body?.cancel();
    if (!location || redirectCount === 3) {
      throw new DocumentProxyError(502, "The document host redirected too many times.");
    }

    const nextUrl = validateDocumentProxyUrl(new URL(location, currentUrl).toString());
    if (currentUrl.protocol === "https:" && nextUrl.protocol !== "https:") {
      throw new DocumentProxyError(502, "The document host redirected to an insecure URL.");
    }
    currentUrl = nextUrl;
  }

  if (!upstream) {
    throw new DocumentProxyError(502, "The document host did not return a response.");
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw new DocumentProxyError(502, `The document host returned HTTP ${upstream.status}.`);
  }

  const upstreamType = upstream.headers.get("Content-Type");
  if (isHtmlContentType(upstreamType)) {
    await upstream.body?.cancel();
    if (options.requirePdf) {
      throw new DocumentProxyError(415, "Not a PDF", "NOT_PDF");
    }
    throw new DocumentProxyError(415, "This is a viewer page, use direct file link");
  }

  const contentLengthHeader = upstream.headers.get("Content-Length");
  const declaredLength = contentLengthHeader === null ? NaN : Number(contentLengthHeader);
  if (Number.isFinite(declaredLength) && declaredLength > DOCUMENT_MAX_BYTES) {
    await upstream.body?.cancel();
    throw new DocumentProxyError(413, "Files larger than 20 MB cannot be opened here.");
  }
  if (!upstream.body) {
    throw new DocumentProxyError(502, "The document host returned an empty response.");
  }

  const reader = upstream.body.getReader();
  const initialChunks: Uint8Array[] = [];
  let prefixLength = 0;
  let totalBytes = 0;

  try {
    while (prefixLength < 512) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > DOCUMENT_MAX_BYTES) {
        await reader.cancel();
        throw new DocumentProxyError(413, "Files larger than 20 MB cannot be opened here.");
      }
      initialChunks.push(value);
      prefixLength += value.byteLength;
    }
    const prefix = new Uint8Array(Math.min(prefixLength, 512));
    let prefixOffset = 0;
    for (const chunk of initialChunks) {
      const copyLength = Math.min(chunk.byteLength, prefix.byteLength - prefixOffset);
      if (copyLength <= 0) break;
      prefix.set(chunk.subarray(0, copyLength), prefixOffset);
      prefixOffset += copyLength;
    }
    if (isHtmlDocumentPrefix(new TextDecoder().decode(prefix))) {
      await reader.cancel();
      if (options.requirePdf) {
        throw new DocumentProxyError(415, "Not a PDF", "NOT_PDF");
      }
      throw new DocumentProxyError(415, "This is a viewer page, use direct file link");
    }
    if (options.requirePdf) {
      const mediaType = upstreamType?.split(";", 1)[0]?.trim().toLowerCase();
      const supportedPdfType =
        !mediaType ||
        mediaType === "application/pdf" ||
        mediaType === "application/x-pdf" ||
        mediaType === "application/octet-stream" ||
        mediaType === "binary/octet-stream";
      const rangeStartsAtBeginning =
        !options.range || /^bytes=0-/u.test(options.range);
      if (
        !supportedPdfType ||
        (rangeStartsAtBeginning &&
          new TextDecoder().decode(prefix.subarray(0, 5)) !== "%PDF-")
      ) {
        await reader.cancel();
        throw new DocumentProxyError(415, "Not a PDF", "NOT_PDF");
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    if (error instanceof DocumentProxyError) throw error;
    throw new DocumentProxyError(502, "The document could not be read from its host.");
  }

  const extension = fileExtension(currentUrl);
  const declaredType = upstreamType?.trim();
  const isGenericType =
    !declaredType ||
    /^(?:application|binary)\/octet-stream(?:\s*;|$)/iu.test(declaredType);
  let initialIndex = 0;
  let streamedBytes = totalBytes;
  let finished = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (initialIndex < initialChunks.length) {
        controller.enqueue(initialChunks[initialIndex]);
        initialIndex += 1;
        return;
      }
      if (finished) return;
      try {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          reader.releaseLock();
          controller.close();
          return;
        }
        streamedBytes += value.byteLength;
        if (streamedBytes > DOCUMENT_MAX_BYTES) {
          finished = true;
          await reader.cancel();
          reader.releaseLock();
          controller.error(new DocumentProxyError(413, "Files larger than 20 MB cannot be opened here."));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finished = true;
        reader.releaseLock();
        controller.error(
          error instanceof DocumentProxyError
            ? error
            : new DocumentProxyError(502, "The document could not be read from its host."),
        );
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      await reader.cancel(reason).catch(() => {});
      reader.releaseLock();
    },
  });

  return {
    body,
    contentType: isGenericType
      ? EXTENSION_MIME_TYPE[extension ?? ""] ?? "application/octet-stream"
      : declaredType,
    contentLength: Number.isFinite(declaredLength) ? declaredLength : null,
    status: upstream.status,
    contentRange: upstream.headers.get("Content-Range"),
    acceptRanges: upstream.headers.get("Accept-Ranges"),
  };
}

export async function fetchDocumentBytes(
  value: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<{ body: Uint8Array; contentType: string }> {
  const document = await fetchDocumentStream(value, fetcher);
  const reader = document.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, contentType: document.contentType };
}
