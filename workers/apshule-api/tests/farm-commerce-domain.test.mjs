import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateProfitLoss,
  calculateSaleTotals,
  nextMonthlySaleNumber,
} from "../src/farm-commerce-domain.ts";

test("farm sale totals calculate item totals and discount without assuming payment", () => {
  assert.deepEqual(calculateSaleTotals([
    { quantity: 2.5, unit_price: 2000 },
    { quantity: 3, unit_price: 500 },
  ], 1000), {
    subtotal: 6500,
    discount: 1000,
    total: 5500,
  });
});

test("farm sale totals reject empty, invalid, and over-discounted sales", () => {
  assert.throws(() => calculateSaleTotals([], 0), /at least one product/u);
  assert.throws(() => calculateSaleTotals([{ quantity: 0, unit_price: 100 }], 0), /greater than zero/u);
  assert.throws(() => calculateSaleTotals([{ quantity: 1, unit_price: 100 }], 101), /cannot exceed/u);
});

test("monthly farm sale numbers are scoped to the month and have a bounded sequence", () => {
  assert.equal(nextMonthlySaleNumber("202610", 0), "SAL-202610-0001");
  assert.equal(nextMonthlySaleNumber("202610", 9998), "SAL-202610-9999");
  assert.throws(() => nextMonthlySaleNumber("202610", 9999), /limit/u);
});

test("farm profit and loss uses released revenue minus expenses", () => {
  assert.deepEqual(calculateProfitLoss(100_000, 35_000), {
    revenue: 100_000,
    expenses: 35_000,
    gross_profit: 65_000,
    margin_pct: 65,
  });
  assert.deepEqual(calculateProfitLoss(0, 5_000), {
    revenue: 0,
    expenses: 5_000,
    gross_profit: -5_000,
    margin_pct: 0,
  });
});
