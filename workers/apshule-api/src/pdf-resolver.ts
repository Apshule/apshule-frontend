import {
  detectDocKind,
  DocumentProxyError,
  fetchWithTimeout,
  parseHttpUrl,
  validateDocumentProxyUrl,
} from "./document-kind.js";

export type PdfResolutionStatus = "resolved" | "failed" | "not_pdf" | "unresolvable";

export type PdfResolution = {
  status: PdfResolutionStatus;
  directUrl?: string;
  expiresAt?: number | null;
  errorCode?: "TIMEOUT";
  reason?: string;
};

const MAX_VIEWER_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const MAX_CANDIDATES = 8;
export const PDF_VIEWER_FETCH_TIMEOUT_MS = 4_000;

function responseHeaderIsHtml(response: Response): boolean {
  const mediaType = response.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

async function readTextUpToLimit(response: Response): Promise<string | null> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VIEWER_HTML_BYTES) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      byteLength += value.byteLength;
      if (byteLength > MAX_VIEWER_HTML_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function fetchWithSafeRedirects(
  value: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ response: Response; finalUrl: URL } | null> {
  let currentUrl: URL;
  try {
    currentUrl = validateDocumentProxyUrl(value);
  } catch {
    return null;
  }

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        currentUrl.toString(),
        {
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; APSHULE-PDFResolver/1.0)",
            Accept: "text/html,application/xhtml+xml,*/*;q=0.1",
          },
          redirect: "manual",
          signal,
        },
        timeoutMs,
        fetcher,
      );
    } catch (error) {
      if (error instanceof DocumentProxyError && error.code === "TIMEOUT") {
        throw error;
      }
      return null;
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: currentUrl };
    }

    const location = response.headers.get("Location");
    await response.body?.cancel().catch(() => {});
    if (!location || redirectCount === MAX_REDIRECTS) return null;

    let nextUrl: URL;
    try {
      nextUrl = validateDocumentProxyUrl(new URL(location, currentUrl).toString());
    } catch {
      return null;
    }
    if (currentUrl.protocol === "https:" && nextUrl.protocol !== "https:") return null;
    currentUrl = nextUrl;
  }
  return null;
}

export function getPdfResolverSkipReason(value: string): string | null {
  let url: URL;
  try {
    url = parseHttpUrl(value);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  const pathname = url.pathname.toLowerCase();
  const hasPdfSuffix = pathname.endsWith(".pdf");
  const isHostOrSubdomain = (domain: string) =>
    hostname === domain || hostname.endsWith(`.${domain}`);

  if (
    !hasPdfSuffix &&
    (isHostOrSubdomain("pdftolink.com") || isHostOrSubdomain("pdftolink.app")) &&
    pathname.includes("/view/")
  ) {
    return "pdftolink_viewer_page";
  }
  if (
    (isHostOrSubdomain("docs.google.com") || isHostOrSubdomain("googleusercontent.com")) &&
    (/\/viewer(?:\/|$)/u.test(pathname) || /\/gview(?:\/|$)/u.test(pathname))
  ) {
    return "google_viewer_page";
  }
  for (const domain of ["issuu.com", "scribd.com", "slideshare.net"]) {
    if (isHostOrSubdomain(domain)) return `unsupported_viewer_${domain.replace(/\W/gu, "_")}`;
  }
  return null;
}

function stripTrackingQueryParams(url: URL): URL {
  const candidate = new URL(url.toString());
  const trackingParam =
    /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|referrer|ref|source|campaign|tracking)$/iu;
  for (const key of [...candidate.searchParams.keys()]) {
    if (trackingParam.test(key)) candidate.searchParams.delete(key);
  }
  return candidate;
}

function extractPdfCandidates(html: string, viewerUrl: URL): URL[] {
  const normalized = html
    .replace(/\\u0026/giu, "&")
    .replace(/&(?:amp|#0*38|#x0*26);/giu, "&")
    .replace(/\\\//gu, "/")
    .replace(/&quot;|&#0*34;|&#x0*22;/giu, '"')
    .replace(/&#0*39;|&#x0*27;/giu, "'");
  const matches = normalized.match(/https?:\/\/[^"'<>\\\s]+/giu) ?? [];
  const candidates: URL[] = [];
  const seen = new Set<string>();

  for (const rawMatch of matches) {
    const raw = rawMatch.replace(/[),.;\]}]+$/gu, "");
    let candidate: URL;
    try {
      candidate = stripTrackingQueryParams(validateDocumentProxyUrl(raw));
    } catch {
      continue;
    }
    if (
      candidate.protocol !== "https:" ||
      !candidate.pathname.toLowerCase().endsWith(".pdf") ||
      candidate.hostname === viewerUrl.hostname ||
      seen.has(candidate.toString())
    ) {
      continue;
    }
    seen.add(candidate.toString());
    candidates.push(candidate);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}

export function pdfUrlExpiresAt(value: string): number | null {
  try {
    const url = new URL(value);
    const amzDate = url.searchParams.get("X-Amz-Date");
    const amzExpires = Number(url.searchParams.get("X-Amz-Expires"));
    if (amzDate && Number.isInteger(amzExpires) && amzExpires > 0) {
      const match = amzDate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u);
      if (match) {
        const issuedAt = Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        );
        return Math.floor(issuedAt / 1000) + amzExpires;
      }
    }

    const expires = Number(url.searchParams.get("Expires"));
    if (Number.isInteger(expires) && expires > 0) return expires;
    const azureExpiry = url.searchParams.get("se");
    if (azureExpiry) {
      const timestamp = Date.parse(azureExpiry);
      if (Number.isFinite(timestamp)) return Math.floor(timestamp / 1000);
    }
  } catch {
    return null;
  }
  return null;
}

export async function resolvePdfUrl(
  value: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch,
  timeouts: { viewer?: number } = {},
): Promise<PdfResolution> {
  const skipReason = getPdfResolverSkipReason(value);
  if (skipReason) {
    return { status: "unresolvable", reason: skipReason };
  }

  let sourceUrl: URL;
  try {
    sourceUrl = validateDocumentProxyUrl(value);
  } catch (error) {
    return {
      status: "unresolvable",
      reason: error instanceof DocumentProxyError ? "invalid_source_url" : "invalid_source_url",
    };
  }
  if (sourceUrl.protocol !== "https:") {
    return { status: "unresolvable", reason: "source_url_not_https" };
  }

  if (sourceUrl.pathname.toLowerCase().endsWith(".pdf")) {
    const directUrl = sourceUrl.toString();
    return {
      status: "resolved",
      directUrl,
      expiresAt: pdfUrlExpiresAt(directUrl),
    };
  }

  const kind = detectDocKind(sourceUrl.toString());
  if (kind !== "viewer" && kind !== "other") {
    return { status: "not_pdf", reason: "source_url_not_pdf" };
  }

  const viewerTimeoutMs = timeouts.viewer ?? PDF_VIEWER_FETCH_TIMEOUT_MS;
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), viewerTimeoutMs);
  try {
    const viewerResponse = await fetchWithSafeRedirects(
      sourceUrl.toString(),
      fetcher,
      viewerTimeoutMs,
      deadline.signal,
    );
    if (deadline.signal.aborted) {
      return {
        status: "unresolvable",
        errorCode: "TIMEOUT",
        reason: "viewer_fetch_timeout",
      };
    }
    if (!viewerResponse || !viewerResponse.response.ok) {
      await viewerResponse?.response.body?.cancel().catch(() => {});
      return { status: "unresolvable", reason: "viewer_page_unavailable" };
    }

    if (!responseHeaderIsHtml(viewerResponse.response)) {
      await viewerResponse.response.body?.cancel().catch(() => {});
      return { status: "unresolvable", reason: "viewer_page_not_html" };
    }

    const html = await readTextUpToLimit(viewerResponse.response);
    if (deadline.signal.aborted) {
      return {
        status: "unresolvable",
        errorCode: "TIMEOUT",
        reason: "viewer_fetch_timeout",
      };
    }
    if (html === null) {
      return { status: "unresolvable", reason: "viewer_page_too_large" };
    }
    const candidates = extractPdfCandidates(html, viewerResponse.finalUrl);
    if (!candidates.length) {
      return { status: "unresolvable", reason: "no_direct_pdf_url_found" };
    }
    const directUrl = candidates[0].toString();
    return {
      status: "resolved",
      directUrl,
      expiresAt: pdfUrlExpiresAt(directUrl),
    };
  } catch (error) {
    if (
      deadline.signal.aborted ||
      (error instanceof DocumentProxyError && error.code === "TIMEOUT")
    ) {
      return {
        status: "unresolvable",
        errorCode: "TIMEOUT",
        reason: "viewer_fetch_timeout",
      };
    }
    return { status: "unresolvable", reason: "viewer_fetch_failed" };
  } finally {
    clearTimeout(deadlineTimer);
  }
}
