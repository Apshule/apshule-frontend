import { createMiddleware } from "hono/factory";
import { ApiError, getDb } from "./db.js";
import type { AuthenticatedUser, AppEnv } from "./types.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface MfiOrganization {
  id: string;
  name: string;
  license_number: string | null;
  registration_number: string | null;
  tin: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  created_by: string | null;
}

export const requireMfiSector = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "superadmin" && user.sector !== "mfi") {
    throw new ApiError(403, "MFI_SECTOR_REQUIRED", "This endpoint is for MFI accounts.");
  }
  await next();
});

export async function resolveMfiOrganization(
  sql: ReturnType<typeof getDb>,
  user: AuthenticatedUser,
  requestedId?: string | null,
): Promise<MfiOrganization> {
  if (requestedId && !UUID_PATTERN.test(requestedId)) {
    throw new ApiError(400, "VALIDATION_ERROR", "organization_id must be a valid UUID.");
  }
  if (user.role === "superadmin") {
    if (!requestedId) {
      throw new ApiError(
        400,
        "MFI_ORGANIZATION_REQUIRED",
        "Choose an MFI organization before requesting this report.",
      );
    }
    const rows = await sql`
      SELECT id, name, license_number, registration_number, tin, address, email, phone, created_by
      FROM mfi_organizations
      WHERE id = ${requestedId}
      LIMIT 1
    `;
    const organization = rows[0] as MfiOrganization | undefined;
    if (!organization) {
      throw new ApiError(404, "MFI_ORGANIZATION_NOT_FOUND", "The MFI organization was not found.");
    }
    return organization;
  }

  const rows = user.role === "mfi_admin"
    ? await sql`
        SELECT id, name, license_number, registration_number, tin, address, email, phone, created_by
        FROM mfi_organizations
        WHERE created_by = ${user.id}
        ORDER BY created_at
        LIMIT 1
      `
    : await sql`
        SELECT organization.id, organization.name, organization.license_number,
          organization.registration_number, organization.tin, organization.address,
          organization.email, organization.phone, organization.created_by
        FROM mfi_officers officer
        JOIN mfi_organizations organization ON organization.id = officer.organization_id
        WHERE officer.user_id = ${user.id}
          AND officer.active IS TRUE
        ORDER BY officer.created_at
        LIMIT 1
      `;
  const organization = rows[0] as MfiOrganization | undefined;
  if (!organization) {
    throw new ApiError(
      403,
      "MFI_ORGANIZATION_REQUIRED",
      "Your account is not linked to an active MFI organization.",
    );
  }
  if (requestedId && organization.id !== requestedId) {
    throw new ApiError(403, "MFI_ORGANIZATION_FORBIDDEN", "You cannot access another MFI organization.");
  }
  return organization;
}

export function pathUuid(value: string, field = "id"): string {
  if (!UUID_PATTERN.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid UUID.`);
  }
  return value;
}
