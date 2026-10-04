export const MAX_MFI_PHOTO_BYTES = 200 * 1024;
export const MAX_MFI_CLIENT_PHOTO_BYTES = 150 * 1024;

const MFI_OFFICER_ROLES = new Set([
  "loan_officer",
  "loan_manager",
  "loan_director",
]);

export function isMfiOfficerRole(value: unknown): value is
  | "loan_officer"
  | "loan_manager"
  | "loan_director" {
  return typeof value === "string" && MFI_OFFICER_ROLES.has(value);
}

export function isMfiDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}

export function isMfiImageDataUrl(
  value: unknown,
  maxBytes = MAX_MFI_PHOTO_BYTES,
): value is string {
  if (typeof value !== "string") return false;
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]*={0,2})$/iu.exec(value);
  if (!match) return false;
  const encoded = match[1]!;
  if (!encoded || encoded.length % 4 !== 0) return false;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const byteLength = (encoded.length / 4) * 3 - padding;
  return byteLength > 0 && byteLength <= maxBytes;
}