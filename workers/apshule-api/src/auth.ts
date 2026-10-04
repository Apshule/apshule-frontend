import { jwtVerify, SignJWT } from "jose";
import { createMiddleware } from "hono/factory";
import { ApiError, getDb, requireEnv } from "./db.js";
import type { AppEnv, AuthenticatedUser } from "./types.js";

const encoder = new TextEncoder();
// Cloudflare Workers Web Crypto rejects PBKDF2 iteration counts above 100,000.
const PBKDF2_ITERATIONS = 100_000;
const PASSWORD_HASH_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function derivePasswordHash(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations, hash: "SHA-256" },
    key,
    PASSWORD_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [algorithm, iterationText, saltText, hashText] = storedHash.split("$");
  if (
    algorithm !== "pbkdf2-sha256" ||
    !iterationText ||
    !saltText ||
    !hashText
  ) {
    return false;
  }
  const iterations = Number(iterationText);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) {
    return false;
  }
  try {
    const expected = fromBase64Url(hashText);
    const actual = await derivePasswordHash(
      password,
      fromBase64Url(saltText),
      iterations,
    );
    if (expected.length !== actual.length) return false;
    let mismatch = 0;
    for (let index = 0; index < expected.length; index += 1) {
      mismatch |= expected[index]! ^ actual[index]!;
    }
    return mismatch === 0;
  } catch {
    return false;
  }
}

export async function createAccessToken(
  env: AppEnv["Bindings"],
  user: {
    id: string;
    email: string;
    role: AuthenticatedUser["role"];
    schoolId: string | null;
    sector: string;
  },
  options: {
    expiresInSeconds?: number;
    impersonatedBy?: string;
  } = {},
): Promise<{ token: string; tokenId: string; expiresAt: number }> {
  const secret = encoder.encode(requireEnv(env.JWT_SECRET, "JWT_SECRET"));
  if (secret.byteLength < 32) {
    throw new ApiError(
      503,
      "INVALID_CONFIGURATION",
      "JWT_SECRET must contain at least 32 bytes.",
    );
  }
  const tokenId = crypto.randomUUID();
  const expiresInSeconds = options.expiresInSeconds ?? 30 * 24 * 60 * 60;
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1) {
    throw new ApiError(500, "INVALID_TOKEN_LIFETIME", "Token lifetime must be a positive integer.");
  }
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const claims: Record<string, unknown> = {
    email: user.email,
    role: user.role,
    schoolId: user.schoolId,
    sector: user.sector,
  };
  if (options.impersonatedBy) claims.impersonated_by = options.impersonatedBy;
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setJti(tokenId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secret);
  return { token, tokenId, expiresAt };
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const authorization = c.req.header("Authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/iu);
  if (!match?.[1]) {
    throw new ApiError(401, "UNAUTHORIZED", "A Bearer token is required.");
  }

  const secret = encoder.encode(requireEnv(c.env.JWT_SECRET, "JWT_SECRET"));
  if (secret.byteLength < 32) {
    throw new ApiError(
      503,
      "INVALID_CONFIGURATION",
      "JWT_SECRET must contain at least 32 bytes.",
    );
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(match[1], secret, {
      algorithms: ["HS256"],
    }));
  } catch {
    throw new ApiError(401, "INVALID_TOKEN", "The bearer token is invalid or expired.");
  }

  if (!payload.sub || !payload.jti || !payload.exp) {
    throw new ApiError(401, "INVALID_TOKEN", "The bearer token is incomplete.");
  }

  const impersonatedByClaim = payload.impersonated_by;
  const isImpersonationToken = impersonatedByClaim !== undefined;
  const impersonatedRoles = new Set(["individual", "teacher", "school"]);
  if (
    isImpersonationToken &&
    (
      typeof impersonatedByClaim !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(impersonatedByClaim) ||
      typeof payload.role !== "string" ||
      !impersonatedRoles.has(payload.role) ||
      typeof payload.sector !== "string" ||
      !payload.sector.trim()
    )
  ) {
    throw new ApiError(401, "INVALID_TOKEN", "The impersonation token is incomplete.");
  }

  const sql = getDb(c.env);
  const rows = await sql`
    SELECT u.id, u.name, u.email, u.role, u.school_id, u.sector
    FROM users u
    WHERE u.id = ${payload.sub}
      AND NOT EXISTS (
        SELECT 1 FROM revoked_tokens r WHERE r.token_id = ${payload.jti}
      )
    LIMIT 1
  `;
  const row = rows[0] as
    | {
        id: string;
        name: string;
        email: string;
        role: AuthenticatedUser["role"];
        school_id: string | null;
        sector: string | null;
      }
    | undefined;

  if (!row) {
    throw new ApiError(401, "INVALID_TOKEN", "The account or session is no longer active.");
  }

  c.set("user", {
    id: row.id,
    name: row.name,
    email: row.email,
    role: isImpersonationToken
      ? payload.role as AuthenticatedUser["role"]
      : row.role,
    schoolId: row.school_id,
    sector: isImpersonationToken
      ? payload.sector as string
      : row.sector ?? "education",
    tokenId: payload.jti,
    tokenExpiresAt: payload.exp,
    ...(isImpersonationToken ? { impersonatedBy: impersonatedByClaim as string } : {}),
  });
  await next();
});

export function requireRole(...roles: AuthenticatedUser["role"][]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get("user");
    if (!roles.includes(user.role)) {
      throw new ApiError(403, "FORBIDDEN", "You do not have permission to do this.");
    }
    await next();
  });
}

export function requireRealSuperAdmin() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get("user");
    if (user.role !== "superadmin" || user.impersonatedBy) {
      throw new ApiError(403, "FORBIDDEN", "A Super Admin session is required.");
    }
    await next();
  });
}

export function requireImpersonationSession() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!c.get("user").impersonatedBy) {
      throw new ApiError(403, "FORBIDDEN", "An active impersonation session is required.");
    }
    await next();
  });
}