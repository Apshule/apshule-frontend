import { ApiError, getDb } from "./db.js";
import { optionalString, requiredString } from "./http.js";
import type { AuthenticatedUser } from "./types.js";

export type FarmSql = ReturnType<typeof getDb>;
export type FarmScope = {
  organizationId: string;
  workerId: string | null;
  locationId: string | null;
};
export type JsonBody = Record<string, unknown>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}

export function pathUuid(value: string, field = "id"): string {
  if (!UUID_PATTERN.test(value)) fail(400, "VALIDATION_ERROR", `${field} must be a valid UUID.`);
  return value;
}

export function requiredText(body: JsonBody, key: string, max = 200): string {
  try {
    return requiredString(body, key, { max });
  } catch (error) {
    fail(400, "VALIDATION_ERROR", error instanceof Error ? error.message : `${key} is required.`);
  }
}

export function optionalText(
  body: JsonBody,
  key: string,
  max = 500,
): string | null | undefined {
  try {
    const value = optionalString(body, key, { max, allowNull: true });
    if (value === undefined || value === null) return value;
    return value.trim() || null;
  } catch (error) {
    fail(400, "VALIDATION_ERROR", error instanceof Error ? error.message : `${key} is invalid.`);
  }
}

export function optionalUuid(body: JsonBody, key: string): string | null | undefined {
  if (!(key in body)) return undefined;
  if (body[key] === null || body[key] === "") return null;
  if (typeof body[key] !== "string" || !UUID_PATTERN.test(body[key])) {
    fail(400, "VALIDATION_ERROR", `${key} must be a valid UUID or null.`);
  }
  return body[key];
}

export function numberValue(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; integer?: boolean; optional?: boolean } = {},
): number | null {
  if (value === undefined || value === null || value === "") {
    if (options.optional) return null;
    fail(400, "VALIDATION_ERROR", `${field} is required.`);
  }
  const number = typeof value === "number" ? value : Number(value);
  if (
    !Number.isFinite(number) ||
    (options.min !== undefined && number < options.min) ||
    (options.max !== undefined && number > options.max) ||
    (options.integer && !Number.isSafeInteger(number))
  ) {
    fail(400, "VALIDATION_ERROR", `${field} is not a valid number.`);
  }
  return number;
}

export function moneyValue(value: unknown, field: string, optional = false): number | null {
  return numberValue(value, field, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, optional });
}

export function quantityValue(value: unknown, field: string, options: { allowNegative?: boolean; min?: number } = {}): number {
  const number = numberValue(value, field, {
    min: options.allowNegative ? -1_000_000_000 : (options.min ?? Number.MIN_VALUE),
    max: 1_000_000_000,
  });
  if (number === null || Math.round(number * 1000) !== number * 1000) {
    fail(400, "VALIDATION_ERROR", `${field} must be a quantity with at most three decimal places.`);
  }
  return number;
}

export function dateValue(value: unknown, field: string, optional = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    fail(400, "VALIDATION_ERROR", `${field} must be a valid YYYY-MM-DD date.`);
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail(400, "VALIDATION_ERROR", `${field} must be a valid YYYY-MM-DD date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(400, "VALIDATION_ERROR", `${field} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

export async function farmScope(
  sql: FarmSql,
  actor: AuthenticatedUser,
): Promise<FarmScope> {
  const rows = actor.role === "farm_admin"
    ? await sql`
        SELECT id, NULL::uuid AS worker_id, NULL::uuid AS location_id
        FROM farm_organizations
        WHERE created_by = ${actor.id}
        LIMIT 1
      `
    : await sql`
        SELECT organization_id AS id, id AS worker_id, location_id
        FROM farm_workers
        WHERE user_id = ${actor.id} AND active IS TRUE
        LIMIT 1
      `;
  const row = rows[0] as { id?: string; worker_id?: string | null; location_id?: string | null } | undefined;
  if (!row?.id) fail(403, "FARM_ACCESS_NOT_PROVISIONED", "This Farm account is inactive or not linked to an organization.");
  return {
    organizationId: row.id,
    workerId: row.worker_id || null,
    locationId: row.location_id || null,
  };
}

export async function assertLocationInOrganization(
  sql: FarmSql,
  organizationId: string,
  locationId: string | null | undefined,
): Promise<void> {
  if (!locationId) return;
  const rows = await sql`
    SELECT id
    FROM farm_locations
    WHERE id = ${locationId}
      AND organization_id = ${organizationId}
      AND active IS TRUE
    LIMIT 1
  `;
  if (!rows.length) fail(404, "LOCATION_NOT_FOUND", "Location was not found in this farm.");
}

export function workerLocation(
  actor: AuthenticatedUser,
  scope: FarmScope,
  requestedLocationId?: string | null,
): string | null {
  if (actor.role !== "farm_worker") return requestedLocationId || null;
  if (!scope.locationId) {
    fail(403, "WORKER_LOCATION_REQUIRED", "Ask a farm manager to assign your work location before recording this.");
  }
  if (requestedLocationId && requestedLocationId !== scope.locationId) {
    fail(403, "WORKER_LOCATION_FORBIDDEN", "Farm workers can only record activity at their assigned location.");
  }
  return scope.locationId;
}

export function actorIp(c: { req: { header(name: string): string | undefined } }): string | null {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return c.req.header("cf-connecting-ip") || forwarded || null;
}

export async function auditMutation(
  sql: FarmSql,
  actor: AuthenticatedUser,
  organizationId: string,
  action: string,
  targetTable: string,
  targetId: string | null,
  metadata: Record<string, unknown>,
  ip: string | null,
): Promise<void> {
  const metadataJson = JSON.stringify(metadata);
  await sql`
    WITH farm_entry AS (
      INSERT INTO farm_audit
        (organization_id, actor_id, action, target_table, target_id, metadata)
      VALUES
        (${organizationId}, ${actor.id}, ${action}, ${targetTable},
         ${targetId}, ${metadataJson}::jsonb)
      RETURNING id
    )
    INSERT INTO audit_log
      (actor_id, sector, action, target_table, target_id, metadata, ip)
    VALUES
      (${actor.id}, 'farm', ${action}, ${targetTable},
       ${targetId}, ${metadataJson}::jsonb, ${ip})
  `;
}
