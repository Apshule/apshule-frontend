import assert from "node:assert/strict";
import test from "node:test";
import {
  isMfiDate,
  isMfiImageDataUrl,
  isMfiOfficerRole,
  MAX_MFI_PHOTO_BYTES,
} from "../src/mfi-domain.ts";

test("recognizes only supported MFI staff roles", () => {
  assert.equal(isMfiOfficerRole("loan_officer"), true);
  assert.equal(isMfiOfficerRole("loan_manager"), true);
  assert.equal(isMfiOfficerRole("loan_director"), true);
  assert.equal(isMfiOfficerRole("mfi_admin"), false);
  assert.equal(isMfiOfficerRole("superadmin"), false);
});

test("accepts real calendar dates and rejects malformed dates", () => {
  assert.equal(isMfiDate("2024-02-29"), true);
  assert.equal(isMfiDate("2025-02-29"), false);
  assert.equal(isMfiDate("2025-13-01"), false);
  assert.equal(isMfiDate("2025-1-01"), false);
});

test("validates supported base64 image data URLs against the 200 KB server cap", () => {
  assert.equal(isMfiImageDataUrl("data:image/jpeg;base64,AAAA"), true);
  assert.equal(isMfiImageDataUrl("data:image/svg+xml;base64,AAAA"), false);
  assert.equal(isMfiImageDataUrl("data:image/png;base64,ABC"), false);
  const oversized = `data:image/webp;base64,${"A".repeat(Math.ceil(MAX_MFI_PHOTO_BYTES * 4 / 3 / 4) * 4)}`;
  assert.equal(isMfiImageDataUrl(oversized), false);
});