import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateMfiCollateralScore,
  collateralValueTier,
  isMfiCollateralPhoto,
  MAX_MFI_COLLATERAL_PHOTO_BYTES,
  MFI_COLLATERAL_DEFAULTS,
} from "../src/mfi-collateral-domain.ts";

test("provides the ten scoped default collateral types with unique codes", () => {
  assert.equal(MFI_COLLATERAL_DEFAULTS.length, 10);
  assert.equal(new Set(MFI_COLLATERAL_DEFAULTS.map((type) => type.code)).size, 10);
  assert.ok(MFI_COLLATERAL_DEFAULTS.every((type) => type.base_score >= 0 && type.base_score <= 100));
});

test("scores collateral using the documented 40/30/20/10 weighted components", () => {
  const result = calculateMfiCollateralScore({
    typeBaseScore: 80,
    estimatedValue: 750_000,
    condition: "good",
    documentCount: 2,
  });

  assert.deepEqual(
    [result.type.weight, result.value.weight, result.condition.weight, result.documents.weight],
    [0.4, 0.3, 0.2, 0.1],
  );
  assert.equal(result.type.weighted, 32);
  assert.equal(result.value.weighted, 18);
  assert.equal(result.condition.weighted, 16);
  assert.equal(result.documents.weighted, 6);
  assert.equal(result.total, 72);
});

test("keeps collateral value tier thresholds stable", () => {
  assert.equal(collateralValueTier(499_999), 40);
  assert.equal(collateralValueTier(500_000), 60);
  assert.equal(collateralValueTier(1_999_999), 60);
  assert.equal(collateralValueTier(2_000_000), 80);
  assert.equal(collateralValueTier(10_000_000), 80);
  assert.equal(collateralValueTier(10_000_001), 100);
});

test("scores document evidence as none, partial, or complete", () => {
  const score = (documentCount) => calculateMfiCollateralScore({
    typeBaseScore: 50,
    estimatedValue: 2_000_000,
    condition: "fair",
    documentCount,
  }).documents;
  assert.deepEqual([score(0).score, score(1).score, score(3).score], [20, 60, 100]);
});

test("accepts collateral photo data URLs up to 200 KB and rejects larger or unsupported data", () => {
  const image = (bytes, mime = "image/jpeg") =>
    `data:${mime};base64,${Buffer.alloc(bytes).toString("base64")}`;
  assert.equal(isMfiCollateralPhoto(image(MAX_MFI_COLLATERAL_PHOTO_BYTES)), true);
  assert.equal(isMfiCollateralPhoto(image(MAX_MFI_COLLATERAL_PHOTO_BYTES + 1)), false);
  assert.equal(isMfiCollateralPhoto(image(8, "image/svg+xml")), false);
  assert.equal(isMfiCollateralPhoto("data:image/png;base64,ABC"), false);
});
