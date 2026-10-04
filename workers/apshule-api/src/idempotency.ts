import { ApiError, type getDb } from "./db.js";

type Database = ReturnType<typeof getDb>;

export type IdempotencyContext = {
  key: string | null;
  userId: string;
  route: string;
};

export type IdempotencyResolution = {
  body: Record<string, unknown>;
  status: 200 | 201;
  replayed: boolean;
};

type StoredIdempotencyRow = {
  user_id: string;
  route: string;
  response_body: unknown;
};

type ResponseRow = {
  response_body?: unknown;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertKeyOwner(
  row: StoredIdempotencyRow,
  context: IdempotencyContext,
): void {
  if (row.user_id !== context.userId || row.route !== context.route) {
    throw new ApiError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used for a different account or route.",
    );
  }
}

function requireStoredBody(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) {
    throw new ApiError(
      503,
      "IDEMPOTENCY_RESPONSE_PENDING",
      "The saved response is not available yet. Retry this request.",
    );
  }
  return value;
}

export function readIdempotencyKey(value: string | null): string | null {
  if (value === null) return null;
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new ApiError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be 1 to 128 letters, numbers, dots, underscores, colons, or hyphens.",
    );
  }
  return value;
}

export async function findIdempotencyReplay(
  sql: Database,
  context: IdempotencyContext,
): Promise<Record<string, unknown> | null> {
  if (!context.key) return null;
  const rows = await sql`
    SELECT user_id, route, response_body
    FROM idempotency_keys
    WHERE key = ${context.key}
    LIMIT 1
  `;
  const row = rows[0] as StoredIdempotencyRow | undefined;
  if (!row) return null;
  assertKeyOwner(row, context);
  return requireStoredBody(row.response_body);
}

export function idempotencyClaimQuery(
  sql: Database,
  context: IdempotencyContext,
) {
  if (!context.key) {
    throw new ApiError(500, "IDEMPOTENCY_KEY_MISSING", "An idempotency key is required for this transaction.");
  }
  return sql`
    INSERT INTO idempotency_keys (key, user_id, route, response_body)
    VALUES (${context.key}, ${context.userId}, ${context.route}, NULL)
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `;
}

export function idempotencyLookupQuery(
  sql: Database,
  context: IdempotencyContext,
) {
  if (!context.key) {
    throw new ApiError(500, "IDEMPOTENCY_KEY_MISSING", "An idempotency key is required for this transaction.");
  }
  return sql`
    SELECT user_id, route, response_body
    FROM idempotency_keys
    WHERE key = ${context.key}
    LIMIT 1
  `;
}

export function resolveIdempotencyTransaction(
  context: IdempotencyContext,
  claimedRows: unknown[],
  operationRows: unknown[],
  storedRows: unknown[],
  firstStatus: 200 | 201,
): IdempotencyResolution {
  const operationRow = operationRows[0] as ResponseRow | undefined;

  if (!context.key) {
    return {
      body: requireStoredBody(operationRow?.response_body),
      status: firstStatus,
      replayed: false,
    };
  }

  const stored = storedRows[0] as StoredIdempotencyRow | undefined;
  if (!stored) {
    throw new ApiError(
      500,
      "IDEMPOTENCY_RESULT_MISSING",
      "The idempotency result could not be loaded.",
    );
  }
  assertKeyOwner(stored, context);

  if (claimedRows.length === 0) {
    return {
      body: requireStoredBody(stored.response_body),
      status: 200,
      replayed: true,
    };
  }

  return {
    body: requireStoredBody(stored.response_body ?? operationRow?.response_body),
    status: firstStatus,
    replayed: false,
  };
}

type WaitUntilContext = {
  executionCtx: {
    waitUntil(promise: Promise<unknown>): void;
  };
};

export function scheduleIdempotencyCleanup(
  context: WaitUntilContext,
  sql: Database,
): void {
  try {
    const cleanup = sql`
      DELETE FROM idempotency_keys
      WHERE created_at < NOW() - INTERVAL '7 days'
    `;
    context.executionCtx.waitUntil(
      cleanup.then(() => undefined).catch(() => {
        console.warn("[apshule-api] Idempotency-key cleanup failed.");
      }),
    );
  } catch {
    console.warn("[apshule-api] Idempotency-key cleanup could not be scheduled.");
  }
}