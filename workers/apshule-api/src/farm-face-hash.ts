import jpeg from "jpeg-js";

const PHOTO_LIMIT_BYTES = 200 * 1024;
const MAX_IMAGE_PIXELS = 2_000_000;
const JPEG_DATA_URL = /^data:image\/jpeg;base64,([a-z0-9+/]+={0,2})$/iu;

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const frameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (frameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
}

function decodeJpegDataUrl(photo: string): Uint8Array {
  if (typeof photo !== "string") throw new Error("A JPEG face image is required.");
  const match = photo.match(JPEG_DATA_URL);
  if (!match) throw new Error("The face image must be a JPEG data URL.");
  const encoded = match[1];
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const byteLength = Math.floor((encoded.length * 3) / 4) - padding;
  if (byteLength > PHOTO_LIMIT_BYTES) throw new Error("Face images must be no larger than 200 KB.");
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Computes the same 8x8 RGB-average perceptual hash used by Education.
 * The submitted image is decoded and discarded; callers should persist only
 * the returned 64-bit hash, never the source photo.
 */
export function computeFarmFaceHash(photo: string): string {
  const bytes = decodeJpegDataUrl(photo);
  const dimensions = jpegDimensions(bytes);
  if (
    !dimensions ||
    dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
  ) {
    throw new Error("The JPEG is invalid or has too many pixels.");
  }

  const decoded = jpeg.decode(bytes, {
    useTArray: true,
    maxResolutionInMP: MAX_IMAGE_PIXELS / 1_000_000,
    maxMemoryUsageInMB: 32,
  });
  if (
    decoded.width !== dimensions.width ||
    decoded.height !== dimensions.height ||
    decoded.data.length !== decoded.width * decoded.height * 4
  ) {
    throw new Error("The JPEG could not be decoded.");
  }

  const samples: number[] = [];
  let total = 0;
  for (let y = 0; y < 8; y += 1) {
    const sourceY = Math.min(decoded.height - 1, Math.max(0, (y + 0.5) * decoded.height / 8 - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(decoded.height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < 8; x += 1) {
      const sourceX = Math.min(decoded.width - 1, Math.max(0, (x + 0.5) * decoded.width / 8 - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(decoded.width - 1, x0 + 1);
      const fx = sourceX - x0;
      const luminanceAt = (pixelX: number, pixelY: number) => {
        const offset = (pixelY * decoded.width + pixelX) * 4;
        const rgba = decoded.data;
        return (rgba[offset] + rgba[offset + 1] + rgba[offset + 2]) / 3;
      };
      const top = luminanceAt(x0, y0) * (1 - fx) + luminanceAt(x1, y0) * fx;
      const bottom = luminanceAt(x0, y1) * (1 - fx) + luminanceAt(x1, y1) * fx;
      const sample = top * (1 - fy) + bottom * fy;
      samples.push(sample);
      total += sample;
    }
  }

  const average = total / 64;
  return samples.map((value) => value >= average ? "1" : "0").join("");
}

export function hammingDistance(left: string, right: string): number {
  if (!/^[01]{64}$/u.test(left) || !/^[01]{64}$/u.test(right)) return 999;
  let distance = 0;
  for (let index = 0; index < 64; index += 1) {
    if (left[index] !== right[index]) distance += 1;
  }
  return distance;
}
