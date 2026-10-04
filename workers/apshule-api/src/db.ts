import { neon } from "@neondatabase/serverless";
import type { Env } from "./types.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getDb(env: Env) {
  if (!env.DATABASE_URL) {
    throw new ApiError(
      503,
      "DATABASE_NOT_CONFIGURED",
      "The DATABASE_URL binding is not configured.",
    );
  }

  return neon(env.DATABASE_URL);
}

export function requireEnv(
  value: string | undefined,
  key: string,
): string {
  if (!value?.trim()) {
    throw new ApiError(
      503,
      "CONFIGURATION_MISSING",
      `The ${key} binding is not configured.`,
    );
  }
  return value.trim();
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "23505" ||
    (typeof candidate.message === "string" &&
      /duplicate key|unique constraint/i.test(candidate.message))
  );
}