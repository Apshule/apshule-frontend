import assert from "node:assert/strict";
import test from "node:test";
import { buildRestructureSchedule } from "../src/mfi-restructure-domain.js";

const base = {
  principal: 100_000,
  annual_rate: 12,
  term_months: 4,
  frequency: "monthly",
  start_date: "2026-11-01",
};

test("builds a remaining-balance restructure using the existing loan method", () => {
  const result = buildRestructureSchedule(base, "reducing_balance");
  assert.equal(result.schedules.length, 4);
  assert.equal(result.schedules.reduce((sum, row) => sum + row.principal_due, 0), 100_000);
  assert.equal(result.maturity_date, "2027-02-01");
});

test("supports a repayment target and adjusts the final payment without leaving principal", () => {
  const result = buildRestructureSchedule(base, "reducing_balance", 27_000);
  assert.equal(result.schedules.length, 4);
  assert.equal(result.schedules.reduce((sum, row) => sum + row.principal_due, 0), 100_000);
  assert.ok(result.schedules.slice(0, -1).every((row) => row.total_due <= 27_000));
});

test("rejects repayment targets that cannot amortize the balance within the term", () => {
  assert.throws(
    () => buildRestructureSchedule(base, "reducing_balance", 10_000),
    /does not repay|must exceed/u,
  );
  assert.throws(
    () => buildRestructureSchedule(base, "flat", 1),
    /cannot pay down/u,
  );
});
