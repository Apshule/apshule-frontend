import {
  detectDocKind,
  DocumentProxyError,
  validateDocumentProxyUrl,
} from "./document-kind.js";

export type PdfResolutionStatus = "resolved" | "failed" | "not_pdf";

export type PdfResolution = {
  status: PdfResolutionStatus;
  directUrl?: string;
  expiresAt?: number | null;
};

const MAX_VIEWER_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const MAX_CANDIDATES = 8;
const PDF_SIGNATURE = "%PDF-";

function responseHeaderIsHtml(response: Response): boolean {
  const mediaType = response.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

async function readPrefix(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  try {
    const first = await reader.read();
    return first.value?.slice(0, 5) ?? new Uint8Array();
  } finally {
    await reader.cancel().catch(() => {});
  }
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
  rangeRequest = false,
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
      response = await fetcher(
        currentUrl.toString(),
        {
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; APSHULE-PDFResolver/1.0)",
            Accept: rangeRequest ? "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1" : "text/html,application/xhtml+xml",
            ...(rangeRequest ? { Range: "bytes=0-4" } : {}),
          },
          redirect: "manual",
        } as RequestInit,
      );
    } catch {
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
      candidate = validateDocumentProxyUrl(raw);
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
): Promise<PdfResolution> {
  let sourceUrl: URL;
  try {
    sourceUrl = validateDocumentProxyUrl(value);
  } catch (error) {
    if (error instanceof DocumentProxyError) return { status: "failed" };
    return { status: "failed" };
  }
  if (sourceUrl.protocol !== "https:") return { status: "failed" };

  if (sourceUrl.pathname.toLowerCase().endsWith(".pdf")) {
    const directUrl = sourceUrl.toString();
    return {
      status: "resolved",
      directUrl,
      expiresAt: pdfUrlExpiresAt(directUrl),
    };
  }

  if (detectDocKind(sourceUrl.toString()) !== "viewer") {
    return { status: "not_pdf" };
  }

  const viewerResponse = await fetchWithSafeRedirects(sourceUrl.toString(), fetcher);
  if (!viewerResponse || !viewerResponse.response.ok) {
    await viewerResponse?.response.body?.cancel().catch(() => {});
    return { status: "failed" };
  }

  if (!responseHeaderIsHtml(viewerResponse.response)) {
    const prefix = await readPrefix(viewerResponse.response);
    if (new TextDecoder().decode(prefix) === PDF_SIGNATURE) {
      const directUrl = viewerResponse.finalUrl.toString();
      return {
        status: "resolved",
        directUrl,
        expiresAt: pdfUrlExpiresAt(directUrl),
      };
    }
    return { status: "not_pdf" };
  }

  const html = await readTextUpToLimit(viewerResponse.response);
  if (html === null) return { status: "failed" };
  const candidates = extractPdfCandidates(html, viewerResponse.finalUrl);
  if (!candidates.length) return { status: "not_pdf" };

  for (const candidate of candidates) {
    const probe = await fetchWithSafeRedirects(candidate.toString(), fetcher, true);
    if (!probe) continue;
    if (![200, 206].includes(probe.response.status)) {
      await probe.response.body?.cancel().catch(() => {});
      continue;
    }
    const prefix = await readPrefix(probe.response);
    if (new TextDecoder().decode(prefix) !== PDF_SIGNATURE) continue;
    const directUrl = probe.finalUrl.toString();
    return {
      status: "resolved",
      directUrl,
      expiresAt: pdfUrlExpiresAt(directUrl),
    };
  }
  return { status: "not_pdf" };
}
