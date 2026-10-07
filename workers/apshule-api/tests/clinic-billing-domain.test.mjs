import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateInsurancePortionCents,
  clinicInvoiceBalanceCents,
  clinicInvoiceStatus,
} from "../src/clinic-billing-domain.ts";

test("dual-track invoice balance includes unpaid patient and insurer portions", () => {
  const portions = {
    patientPortionCents: 460_000n,
    patientPaidCents: 200_000n,
    insurancePortionCents: 1_840_000n,
    insurancePaidCents: 1_000_000n,
  };
  assert.equal(clinicInvoiceBalanceCents(portions), 1_100_000n);
  assert.equal(clinicInvoiceStatus(portions), "partial");
});

test("paid status requires both portions to be fully paid", () => {
  assert.equal(clinicInvoiceStatus({
    patientPortionCents: 460_000n,
    patientPaidCents: 460_000n,
    insurancePortionCents: 1_840_000n,
    insurancePaidCents: 0n,
  }), "patient_settled");
  assert.equal(clinicInvoiceStatus({
    patientPortionCents: 460_000n,
    patientPaidCents: 0n,
    insurancePortionCents: 1_840_000n,
    insurancePaidCents: 1_840_000n,
  }), "insurance_settled");
  assert.equal(clinicInvoiceStatus({
    patientPortionCents: 460_000n,
    patientPaidCents: 460_000n,
    insurancePortionCents: 1_840_000n,
    insurancePaidCents: 1_840_000n,
  }), "paid");
});

test("invoice without insurance becomes paid when the patient portion is paid", () => {
  const portions = {
    patientPortionCents: 2_300_000n,
    patientPaidCents: 2_300_000n,
    insurancePortionCents: 0n,
    insurancePaidCents: 0n,
  };
  assert.equal(clinicInvoiceBalanceCents(portions), 0n);
  assert.equal(clinicInvoiceStatus(portions), "paid");
});

test("insurance coverage is rounded to cents and capped at the total", () => {
  assert.equal(calculateInsurancePortionCents(2_300_000n, 2_300_000n, 8_000n), 1_840_000n);
  assert.equal(calculateInsurancePortionCents(2_300_000n, 2_000_000n, 10_000n), 2_000_000n);
  assert.equal(calculateInsurancePortionCents(2_300_000n, 2_300_000n, 0n), 0n);
});
