export const CLINIC_STAFF_ROLES = [
  "doctor",
  "nurse",
  "receptionist",
  "pharmacist",
] as const;

export type ClinicStaffRole = (typeof CLINIC_STAFF_ROLES)[number];

export function isClinicStaffRole(value: string): value is ClinicStaffRole {
  return CLINIC_STAFF_ROLES.some((role) => role === value);
}

export function isClinicDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isClinicImageDataUrl(
  value: string,
  maxBytes = 200 * 1024,
): boolean {
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/iu.exec(value);
  if (!match) return false;
  const encoded = match[1]!;
  if (encoded.length % 4 !== 0) return false;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedBytes = (encoded.length / 4) * 3 - padding;
  return decodedBytes > 0 && decodedBytes <= maxBytes;
}

export function formatClinicPatientNumber(yyyymm: string, sequence: number): string {
  if (!/^\d{6}$/u.test(yyyymm)) {
    throw new RangeError("yyyymm must be a six-digit year-month value.");
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 9999) {
    throw new RangeError("sequence must be an integer from 1 to 9999.");
  }
  return `PAT-${yyyymm}-${String(sequence).padStart(4, "0")}`;
}
