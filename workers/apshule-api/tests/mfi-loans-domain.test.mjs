import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateDebtToIncome,
  estimateMonthlyPayment,
} from "../../../mfi-loans-domain.mjs";

test("loan estimates calculate reducing-balance and flat monthly payments", () => {
  const reducing = estimateMonthlyPayment(1_500_000, 22, 12, "reducing_balance");
  const flat = estimateMonthlyPayment(1_500_000, 22, 12, "flat");

  assert.equal(reducing.monthlyPayment, 140_391.57);
  assert.equal(flat.monthlyPayment, 152_500);
  assert.ok(reducing.monthlyPayment < flat.monthlyPayment);
  assert.equal(flat.totalRepayment, 1_830_000);
});

test("loan estimates support zero interest and reject invalid inputs", () => {
  assert.deepEqual(
    estimateMonthlyPayment(600_000, 0, 6),
    {
      monthlyPayment: 100_000,
      totalRepayment: 600_000,
      interestAmount: 0,
      method: "reducing_balance",
    },
  );
  assert.throws(() => estimateMonthlyPayment(0, 22, 12), RangeError);
  assert.throws(() => estimateMonthlyPayment(100_000, 22, 0), RangeError);
  assert.throws(() => estimateMonthlyPayment(100_000, 22, 12, "unknown"), RangeError);
});

test("debt-to-income uses the estimated monthly payment and handles missing income", () => {
  assert.equal(calculateDebtToIncome(140_570.82, 1_000_000), 14.06);
  assert.equal(calculateDebtToIncome(140_570.82, 0), null);
  assert.equal(calculateDebtToIncome(140_570.82, null), null);
});
