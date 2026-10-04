import { ApiError } from "./db.js";

export function optionalDate(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid date.`);
  }
  return value;
}

export function optionalImageBase64(
  body: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a base64 image.`);
  }
  const dataUrl = value.trim();
  if (!dataUrl) return null;
  const encodedLimit = Math.ceil(maxBytes / 3) * 4 + 100;
  if (dataUrl.length > encodedLimit) {
    throw new ApiError(413, "IMAGE_TOO_LARGE", `${key} must be no larger than ${Math.ceil(maxBytes / 1024)}KB.`);
  }
  const match = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/iu);
  if (!match) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a PNG, JPEG, or WebP data URL.`);
  }
  const mime = match[1]!.toLowerCase();
  const encoded = match[2]!;
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} contains invalid base64 data.`);
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const byteLength = (encoded.length / 4) * 3 - padding;
  if (byteLength < 12) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} is not a supported image.`);
  }
  if (byteLength > maxBytes) {
    throw new ApiError(413, "IMAGE_TOO_LARGE", `${key} must be no larger than ${Math.ceil(maxBytes / 1024)}KB.`);
  }

  const prefix = Uint8Array.from(
    atob(encoded.slice(0, 16)),
    (character) => character.charCodeAt(0),
  );
  const isPng =
    mime === "image/png" &&
    prefix[0] === 0x89 &&
    prefix[1] === 0x50 &&
    prefix[2] === 0x4e &&
    prefix[3] === 0x47 &&
    prefix[4] === 0x0d &&
    prefix[5] === 0x0a &&
    prefix[6] === 0x1a &&
    prefix[7] === 0x0a;
  const isJpeg =
    mime === "image/jpeg" &&
    prefix[0] === 0xff &&
    prefix[1] === 0xd8 &&
    prefix[2] === 0xff;
  const isWebp =
    mime === "image/webp" &&
    String.fromCharCode(...prefix.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...prefix.slice(8, 12)) === "WEBP";
  if (!isPng && !isJpeg && !isWebp) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} content does not match its image type.`);
  }
  return dataUrl;
}

export function emptyToNull(value: string | null | undefined): string | null | undefined {
  return value === "" ? null : value;
}