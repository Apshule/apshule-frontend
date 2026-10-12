import test from "node:test";
import assert from "node:assert/strict";
import { calculateReportMark } from "../src/report-marks-domain.ts";

test("computes average, 20/80 split, total, identifier and grade from Phase 10C example", () => {
  const result = calculateReportMark({ a1: 2.5, a2: 2, a3: 3, eot: 78 });
  assert.equal(result.avg, 2.5);
  assert.equal(result.pct20, 0.5);
  assert.equal(result.pct80, 62.400000000000006);
  assert.equal(Number(result.pct100.toFixed(1)), 62.9);
  assert.equal(result.identifier, 3);
  assert.equal(result.grade, "C");
});

test("grade boundaries are applied to final weighted score", () => {
  assert.equal(calculateReportMark({a1:0,a2:0,a3:0,eot:75}).grade, "C");
  assert.equal(calculateReportMark({a1:0,a2:0,a3:0,eot:62}).grade, "E");
});
