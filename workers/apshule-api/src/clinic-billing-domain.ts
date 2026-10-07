export type ClinicInvoiceStatus =
  | "issued"
  | "partial"
  | "patient_settled"
  | "insurance_settled"
  | "paid";

export interface ClinicInvoicePortions {
  patientPortionCents: bigint;
  patientPaidCents: bigint;
  insurancePortionCents: bigint;
  insurancePaidCents: bigint;
}

export function clinicInvoiceBalanceCents(portions: ClinicInvoicePortions): bigint {
  const patientDue =
    portions.patientPortionCents > portions.patientPaidCents
      ? portions.patientPortionCents - portions.patientPaidCents
      : 0n;
  const insuranceDue =
    portions.insurancePortionCents > portions.insurancePaidCents
      ? portions.insurancePortionCents - portions.insurancePaidCents
      : 0n;
  return patientDue + insuranceDue;
}

export function clinicInvoiceStatus(portions: ClinicInvoicePortions): ClinicInvoiceStatus {
  const patientSettled = portions.patientPaidCents >= portions.patientPortionCents;
  const insuranceSettled = portions.insurancePaidCents >= portions.insurancePortionCents;

  if (patientSettled && insuranceSettled) return "paid";
  if (patientSettled) return "patient_settled";
  if (insuranceSettled) return "insurance_settled";
  if (portions.patientPaidCents > 0n || portions.insurancePaidCents > 0n) return "partial";
  return "issued";
}

export function calculateInsurancePortionCents(
  subtotalCents: bigint,
  totalCents: bigint,
  coverageBasisPoints: bigint,
): bigint {
  if (subtotalCents <= 0n || totalCents <= 0n || coverageBasisPoints <= 0n) return 0n;
  const covered = (subtotalCents * coverageBasisPoints + 5_000n) / 10_000n;
  return covered > totalCents ? totalCents : covered;
}
