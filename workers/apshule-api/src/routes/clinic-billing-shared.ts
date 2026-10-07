import { ApiError } from "../db.js";

export type BillingItemType = "consultation" | "prescription" | "service";

export interface BillingItemInput {
  item_type: BillingItemType;
  description: string;
  reference_id: string | null;
  quantity: number;
  unit_price: string;
  total: string;
}

export const BILLING_STATUSES = new Set([
  "draft",
  "issued",
  "partial",
  "patient_settled",
  "insurance_settled",
  "paid",
  "cancelled",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_CENTS = 99_999_999_999_999n;

export function pathUuid(value: string, field = "id"): string {
  if (!UUID_PATTERN.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid UUID.`);
  }
  return value;
}

export function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a UUID.`);
  }
  return pathUuid(value.trim(), field);
}

export function requiredText(value: unknown, field: string, max = 300): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} is required.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must contain 1-${max} characters.`);
  }
  return normalized;
}

export function optionalText(
  value: unknown,
  field: string,
  max = 1000,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be text of at most ${max} characters.`);
  }
  return value.trim() || null;
}

export function assertAllowedKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(body).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new ApiError(400, "VALIDATION_ERROR", `Unsupported field: ${unexpected}.`);
  }
}

export function moneyCents(value: unknown, field: string, allowZero = true): bigint {
  const normalized = typeof value === "number"
    ? (Number.isFinite(value) ? value.toFixed(2) : "")
    : typeof value === "string"
      ? value.trim()
      : "";
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/u.exec(normalized);
  if (!match) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a non-negative amount with up to two decimals.`);
  }
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const cents = BigInt(match[1]!) * 100n + BigInt(fraction || "0");
  if (cents > MAX_CENTS || (!allowZero && cents === 0n)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} is outside the allowed amount range.`);
  }
  return cents;
}

export function centsDecimal(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

export function coverageBasisPoints(value: unknown): bigint {
  const normalized = typeof value === "number"
    ? (Number.isFinite(value) ? value.toFixed(2) : "")
    : typeof value === "string"
      ? value.trim()
      : "";
  const match = /^(100(?:\.00?)?|(?:\d{1,2})(?:\.\d{1,2})?)$/u.exec(normalized);
  if (!match) {
    throw new ApiError(400, "VALIDATION_ERROR", "coverage_percent must be between 0 and 100.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const basisPoints = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (basisPoints > 10_000n) {
    throw new ApiError(400, "VALIDATION_ERROR", "coverage_percent must be between 0 and 100.");
  }
  return basisPoints;
}

export function quantityValue(value: unknown, field: string): number {
  const normalized = typeof value === "number"
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!/^\d{1,6}(?:\.\d{1,3})?$/u.test(normalized)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a positive quantity with up to three decimals.`);
  }
  const quantity = Number(normalized);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100_000) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} is outside the allowed quantity range.`);
  }
  return quantity;
}

export function lineTotalCents(unitPriceCents: bigint, quantity: number): bigint {
  const quantityThousandths = BigInt(Math.round(quantity * 1000));
  return (unitPriceCents * quantityThousandths + 500n) / 1000n;
}

export function dateValue(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a date in YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid calendar date.`);
  }
  return value;
}

export function parseInvoiceItems(value: unknown): {
  items: BillingItemInput[];
  subtotalCents: bigint;
} {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new ApiError(400, "VALIDATION_ERROR", "items must contain between 1 and 100 line items.");
  }
  let subtotalCents = 0n;
  const items = value.map((raw, index) => {
    const field = `items[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(400, "VALIDATION_ERROR", `${field} must be an object.`);
    }
    const item = raw as Record<string, unknown>;
    assertAllowedKeys(item, [
      "item_type",
      "description",
      "reference_id",
      "quantity",
      "unit_price",
    ]);
    const itemType = item.item_type;
    if (
      itemType !== "consultation" &&
      itemType !== "prescription" &&
      itemType !== "service"
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", `${field}.item_type is invalid.`);
    }
    const description = requiredText(item.description, `${field}.description`, 300);
    const referenceId = optionalUuid(item.reference_id, `${field}.reference_id`);
    const quantity = quantityValue(item.quantity ?? 1, `${field}.quantity`);
    const priceCents = moneyCents(item.unit_price, `${field}.unit_price`);
    const totalCents = lineTotalCents(priceCents, quantity);
    subtotalCents += totalCents;
    const parsedItem: BillingItemInput = {
      item_type: itemType,
      description,
      reference_id: referenceId,
      quantity,
      unit_price: centsDecimal(priceCents),
      total: centsDecimal(totalCents),
    };
    return parsedItem;
  });
  if (subtotalCents > MAX_CENTS) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invoice subtotal is outside the allowed amount range.");
  }
  return { items, subtotalCents };
}

export function parsePercentValue(value: unknown, field: string): string {
  const basisPoints = coverageBasisPoints(value);
  return centsDecimal(basisPoints);
}
