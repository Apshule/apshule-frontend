import { Hono, type Context, type Next } from "hono";
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
const PUBLIC_PROXY_LINK_SECONDS = 60 * 60;
const PUBLIC_PROXY_TOKEN_AAD = "APSHULE-DOC-PROXY-V1";

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

async function proxyDocument(c: Context<AppEnv>) {
  const isPublic = c.req.query("public") === "1";
  const download = c.req.query("download") === "1";
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
      targetUrl = validateDocumentProxyUrl(c.req.query("url") ?? "");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DocumentProxyError) {
      throw new ApiError(error.status, "INVALID_DOCUMENT_URL", error.message);
    }
    throw error;
  }

  const cache = (globalThis as typeof globalThis & {
    caches?: { default?: Cache };
  }).caches?.default;
  const key = await documentCacheKey(c.req.url, targetUrl, download);
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
  const responseHeaders = new Headers({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Disposition, Content-Length, Content-Type",
      "Cache-Control": `public, max-age=${DOCUMENT_CACHE_SECONDS}, s-maxage=${DOCUMENT_CACHE_SECONDS}`,
      "Content-Length": String(document.body.byteLength),
      "Content-Type": document.contentType,
      "X-Content-Type-Options": "nosniff",
  });
  if (download) {
    responseHeaders.set(
      "Content-Disposition",
      `attachment; filename="${documentFilename(targetUrl)}"`,
    );
  }
  const response = new Response(responseBody, { headers: responseHeaders });

  if (cache) {
    try {
      await cache.put(key, response.clone());
    } catch {
      console.warn("[doc-proxy] cache write failed");
    }
  }
  return response;
}

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

export default documents;
