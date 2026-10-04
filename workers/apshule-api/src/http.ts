import type { Context } from "hono";
import type { AppEnv } from "./types.js";
import { ApiError } from "./db.js";

export async function readJson(
  c: Context<AppEnv>,
): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "INVALID_BODY", "Expected a JSON object.");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
  options: { max?: number; min?: number } = {},
): string {
  const value = body[key];
  const text = typeof value === "string" ? value.trim() : "";
  const min = options.min ?? 1;
  const max = options.max ?? 500;
  if (text.length < min || text.length > max) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `${key} must be between ${min} and ${max} characters.`,
    );
  }
  return text;
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
  options: { max?: number; allowNull?: boolean } = {},
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null && options.allowNull) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a string.`);
  }
  const text = value.trim();
  if (text.length > (options.max ?? 500)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `${key} must be no longer than ${options.max ?? 500} characters.`,
    );
  }
  return text;
}

export function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function publicUser<T extends Record<string, unknown>>(user: T) {
  const {
    password_hash: _passwordHash,
    login_password_hash: _loginPasswordHash,
    reset_token: _resetToken,
    reset_token_expires: _resetTokenExpires,
    ...safe
  } = user;
  return safe;
}

export function parseLimit(value: string | undefined, fallback = 50): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "limit must be a positive integer.",
    );
  }
  return Math.min(parsed, 200);
}