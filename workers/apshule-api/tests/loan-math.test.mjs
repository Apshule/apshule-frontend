import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateCredit,
  allocatePayment,
  buildScheduleFlat,
  buildScheduleReducing,
  calculateLateFee,
} from "../src/mfi/loan-math.ts";

test("flat schedule uses whole UGX, applies flat interest and distributes fees", () => {
  const result = buildScheduleFlat({
    principal: 1_500_000,
    annual_rate: 22,
    term_months: 12,
    frequency: "monthly",
    start_date: "2026-01-31",
    processing_fee_percent: 2,
    insurance_fee_percent: 1,
  });

  assert.equal(result.total_interest, 330_000);
  assert.equal(result.total_fees, 45_000);
  assert.equal(result.total_repayable, 1_875_000);
  assert.equal(result.schedules.length, 12);
  assert.equal(result.schedules[0].due_date, "2026-01-31");
  assert.equal(result.schedules[1].due_date, "2026-02-28");
  assert.equal(result.schedules.at(-1).due_date, "2026-12-31");
  assert.equal(result.schedules.reduce((sum, row) => sum + row.principal_due, 0), 1_500_000);
  assert.equal(result.schedules.reduce((sum, row) => sum + row.total_due, 0), result.total_repayable);
  assert.ok(result.schedules.every((row) => Number.isInteger(row.total_due)));
});

test("reducing-balance schedule accrues interest on declining principal and closes exactly", () => {
  const result = buildScheduleReducing({
    principal: 1_500_000,
    annual_rate: 22,
    term_months: 12,
    frequency: "monthly",
    start_date: "2026-02-15",
  });

  assert.equal(result.schedules.length, 12);
  assert.equal(result.schedules[0].interest_due, 27_500);
  assert.ok(result.schedules[1].interest_due < result.schedules[0].interest_due);
  assert.equal(result.schedules.reduce((sum, row) => sum + row.principal_due, 0), 1_500_000);
  assert.equal(result.total_interest, result.schedules.reduce((sum, row) => sum + row.interest_due, 0));
  assert.equal(result.schedules.at(-1).principal_due, 1_500_000 - result.schedules
    .slice(0, -1)
    .reduce((sum, row) => sum + row.principal_due, 0));
});

test("biweekly and weekly schedules use 2x and 4x periods per term month", () => {
  const input = {
    principal: 120_000,
    annual_rate: 0,
    term_months: 3,
    start_date: "2026-01-01",
  };
  const biweekly = buildScheduleFlat({ ...input, frequency: "biweekly" });
  const weekly = buildScheduleFlat({ ...input, frequency: "weekly" });
  assert.equal(biweekly.schedules.length, 6);
  assert.equal(biweekly.schedules.at(-1).due_date, "2026-03-12");
  assert.equal(weekly.schedules.length, 12);
  assert.equal(weekly.schedules.at(-1).due_date, "2026-03-19");
  assert.equal(weekly.total_repayable, 120_000);
});

test("late fee respects grace period and rounds to whole UGX", () => {
  assert.equal(calculateLateFee(150_000, 2, 37, 7), 3_000);
  assert.equal(calculateLateFee(150_000, 2, 7, 7), 0);
});

test("payment allocation follows late fees, fees, interest, then principal", () => {
  const result = allocatePayment(17_000, [
    {
      id: "first",
      installment_number: 1,
      due_date: "2026-01-01",
      principal_due: 10_000,
      interest_due: 2_000,
      fees_due: 1_000,
      late_fee_due: 3_000,
      principal_paid: 0,
      interest_paid: 0,
      fees_paid: 0,
      late_fee_paid: 0,
    },
    {
      id: "second",
      installment_number: 2,
      due_date: "2026-02-01",
      principal_due: 20_000,
      interest_due: 2_000,
      fees_due: 1_000,
      late_fee_due: 0,
      principal_paid: 0,
      interest_paid: 0,
      fees_paid: 0,
      late_fee_paid: 0,
    },
  ]);

  assert.equal(result.applied_amount, 17_000);
  assert.equal(result.overpayment, 0);
  assert.deepEqual(result.allocations[0], {
    schedule_id: "first",
    late_fees_applied: 3_000,
    fees_applied: 1_000,
    interest_applied: 2_000,
    principal_applied: 10_000,
  });
  assert.equal(result.allocations[1].late_fees_applied, 0);
});

test("credit note skips overdue, paid, partially paid, and current installments", () => {
  const result = allocateCredit(1_000, [
    { id: "overdue", installment_number: 1, due_date: "2026-05-01", status: "overdue", principal_due: 1_000 },
    { id: "paid", installment_number: 2, due_date: "2026-06-01", status: "paid", principal_due: 1_000 },
    { id: "partial", installment_number: 3, due_date: "2026-07-01", status: "pending", principal_due: 1_000, principal_paid: 1 },
    { id: "today", installment_number: 4, due_date: "2026-08-01", status: "pending", principal_due: 1_000 },
    { id: "future", installment_number: 5, due_date: "2026-08-02", status: "pending", principal_due: 500 },
  ], "2026-08-01");

  assert.deepEqual(result, {
    allocations: [{ schedule_id: "future", principal_reduction: 500 }],
    applied_amount: 500,
  });
});

test("credit note is spread evenly across future installments and capped by eligible principal", () => {
  const result = allocateCredit(2_000, [
    { id: "one", installment_number: 1, due_date: "2026-09-01", status: "pending", principal_due: 900 },
    { id: "two", installment_number: 2, due_date: "2026-10-01", status: "pending", principal_due: 900 },
    { id: "three", installment_number: 3, due_date: "2026-11-01", status: "pending", principal_due: 100 },
  ], "2026-08-01");

  assert.deepEqual(result, {
    allocations: [
      { schedule_id: "one", principal_reduction: 900 },
      { schedule_id: "two", principal_reduction: 900 },
      { schedule_id: "three", principal_reduction: 100 },
    ],
    applied_amount: 1_900,
  });
});
