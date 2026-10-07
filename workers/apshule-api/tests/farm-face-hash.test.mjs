import assert from "node:assert/strict";
import test from "node:test";
import jpeg from "jpeg-js";
import { computeFarmFaceHash, hammingDistance } from "../src/farm-face-hash.ts";

function jpegDataUrl(width = 32, height = 24) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = Math.round((x / Math.max(width - 1, 1)) * 255);
      data[offset + 1] = Math.round((y / Math.max(height - 1, 1)) * 255);
      data[offset + 2] = (x * 19 + y * 23) % 256;
      data[offset + 3] = 255;
    }
  }
  return `data:image/jpeg;base64,${jpeg.encode({ data, width, height }, 80).data.toString("base64")}`;
}

test("Farm face hash is a 64-bit value and identical images have zero distance", () => {
  const photo = jpegDataUrl();
  const first = computeFarmFaceHash(photo);
  const second = computeFarmFaceHash(photo);
  assert.match(first, /^[01]{64}$/u);
  assert.equal(second, first);
  assert.equal(hammingDistance(first, second), 0);
});

test("Farm face hash rejects non-JPEG, oversized, and excessive-resolution uploads", () => {
  assert.throws(() => computeFarmFaceHash("data:image/png;base64,aGVsbG8="), /JPEG/u);
  assert.throws(
    () => computeFarmFaceHash(`data:image/jpeg;base64,${"A".repeat(273_100)}`),
    /200 KB/u,
  );

  const bytes = Buffer.from(jpegDataUrl().split(",")[1], "base64");
  let frameOffset = -1;
  for (let index = 0; index < bytes.length - 9; index += 1) {
    if (bytes[index] === 0xff && [0xc0, 0xc1, 0xc2, 0xc3].includes(bytes[index + 1])) {
      frameOffset = index;
      break;
    }
  }
  assert.notEqual(frameOffset, -1, "test JPEG should contain a supported frame marker");
  bytes[frameOffset + 5] = 0x07;
  bytes[frameOffset + 6] = 0xd0;
  bytes[frameOffset + 7] = 0x07;
  bytes[frameOffset + 8] = 0xd0;
  const oversizedDimensions = `data:image/jpeg;base64,${bytes.toString("base64")}`;
  assert.throws(() => computeFarmFaceHash(oversizedDimensions), /pixels/u);
});

test("Hamming distance rejects malformed hashes and counts changed bits", () => {
  const zeros = "0".repeat(64);
  assert.equal(hammingDistance(zeros, `1${"0".repeat(63)}`), 1);
  assert.equal(hammingDistance(zeros, "1".repeat(64)), 64);
  assert.equal(hammingDistance(zeros, "not-a-hash"), 999);
});
