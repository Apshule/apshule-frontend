import { Hono, type Context } from "hono";
import { ApiError } from "../db.js";
import { authMiddleware } from "../auth.js";
import { readJson, requiredString } from "../http.js";
import {
  detectDocKind,
  DocumentProxyError,
  fetchDocumentBytes,
  parseHttpUrl,
  validateDocumentProxyUrl,
} from "../document-kind.js";
import type { AppEnv } from "../types.js";

const documents = new Hono<AppEnv>();
const DOCUMENT_CACHE_SECONDS = 60 * 60;

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

async function documentCacheKey(requestUrl: string, targetUrl: URL): Promise<Request> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(targetUrl.toString()),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return new Request(`${new URL(requestUrl).origin}/__apshule_document_cache/${hash}`);
}

async function proxyDocument(c: Context<AppEnv>) {
  const rawUrl = c.req.query("url") ?? "";
  let targetUrl: URL;
  try {
    targetUrl = validateDocumentProxyUrl(rawUrl);
  } catch (error) {
    if (error instanceof DocumentProxyError) {
      throw new ApiError(error.status, "INVALID_DOCUMENT_URL", error.message);
    }
    throw error;
  }

  const cache = (globalThis as typeof globalThis & {
    caches?: { default?: Cache };
  }).caches?.default;
  const key = await documentCacheKey(c.req.url, targetUrl);
  if (cache) {
    try {
      const cached = await cache.match(key);
      if (cached) return cached;
    } catch {
      console.warn("[doc-proxy] cache read failed");
    }
  }

  let document: { body: Uint8Array; contentType: string };
  try {
    document = await fetchDocumentBytes(targetUrl.toString());
  } catch (error) {
    if (error instanceof DocumentProxyError) {
      throw new ApiError(error.status, "DOCUMENT_PROXY_ERROR", error.message);
    }
    throw error;
  }

  const responseBody = new ArrayBuffer(document.body.byteLength);
  new Uint8Array(responseBody).set(document.body);
  const response = new Response(responseBody, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Type",
      "Cache-Control": `public, max-age=${DOCUMENT_CACHE_SECONDS}, s-maxage=${DOCUMENT_CACHE_SECONDS}`,
      "Content-Length": String(document.body.byteLength),
      "Content-Type": document.contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });

  if (cache) {
    try {
      await cache.put(key, response.clone());
    } catch {
      console.warn("[doc-proxy] cache write failed");
    }
  }
  return response;
}

documents.get("/doc-proxy", authMiddleware, proxyDocument);
documents.get("/pdf-proxy", authMiddleware, proxyDocument);

export default documents;
