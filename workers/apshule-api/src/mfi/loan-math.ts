export type LoanFrequency = "monthly" | "biweekly" | "weekly";
export type LoanInterestMethod = "flat" | "reducing_balance";

export interface ScheduleRow {
  installment_number: number;
  due_date: string;
  principal_due: number;
  interest_due: number;
  fees_due: number;
  total_due: number;
}

export interface BuiltSchedule {
  schedules: ScheduleRow[];
  total_interest: number;
  total_fees: number;
  total_repayable: number;
  maturity_date: string;
}

export interface ScheduleInput {
  principal: number;
  annual_rate: number;
  term_months: number;
  frequency: LoanFrequency;
  start_date: string;
  processing_fee_percent?: number;
  insurance_fee_percent?: number;
}

export interface PaymentScheduleInput {
  id: string;
  installment_number: number;
  due_date: string;
  principal_due: number;
  interest_due: number;
  fees_due: number;
  late_fee_due: number;
  principal_paid: number;
  interest_paid: number;
  fees_paid: number;
  late_fee_paid: number;
}

export interface PaymentAllocation {
  schedule_id: string;
  principal_applied: number;
  interest_applied: number;
  fees_applied: number;
  late_fees_applied: number;
}

export interface CreditScheduleInput {
  id: string;
  installment_number: number;
  due_date: string;
  status: string;
  principal_due: number;
  principal_paid?: number;
  interest_paid?: number;
  fees_paid?: number;
  late_fee_paid?: number;
  total_paid?: number;
}

export interface CreditAllocation {
  schedule_id: string;
  principal_reduction: number;
}

const FREQUENCIES: Record<LoanFrequency, { periodsPerMonth: number; ratePeriodsPerYear: number; days: number }> = {
  monthly: { periodsPerMonth: 1, ratePeriodsPerYear: 12, days: 0 },
  biweekly: { periodsPerMonth: 2, ratePeriodsPerYear: 26, days: 14 },
  weekly: { periodsPerMonth: 4, ratePeriodsPerYear: 52, days: 7 },
};

function wholeUgx(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("Amount must be finite.");
  return Math.round(value);
}

function assertScheduleInput(input: ScheduleInput): void {
  if (!Number.isSafeInteger(input.principal) || input.principal <= 0) {
    throw new RangeError("Principal must be a positive whole number of UGX.");
  }
  if (!Number.isFinite(input.annual_rate) || input.annual_rate < 0 || input.annual_rate > 1000) {
    throw new RangeError("Annual rate is outside the supported range.");
  }
  if (!Number.isInteger(input.term_months) || input.term_months < 1 || input.term_months > 360) {
    throw new RangeError("Term must be between 1 and 360 months.");
  }
  if (!(input.frequency in FREQUENCIES)) {
    throw new RangeError("Repayment frequency must be monthly, biweekly, or weekly.");
  }
  if (!isIsoDate(input.start_date)) throw new RangeError("First installment date must be a valid ISO date.");
  for (const value of [input.processing_fee_percent ?? 0, input.insurance_fee_percent ?? 0]) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new RangeError("Fee percentages must be between 0 and 100.");
    }
  }
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function addMonthsClamped(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const targetMonth = month - 1 + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return formatDate(new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay))));
}

function formatDate(value: Date): string {
  return `${value.getUTCFullYear().toString().padStart(4, "0")}-${(value.getUTCMonth() + 1)
    .toString().padStart(2, "0")}-${value.getUTCDate().toString().padStart(2, "0")}`;
}

function installmentDate(start: string, index: number, frequency: LoanFrequency): string {
  if (frequency === "monthly") return addMonthsClamped(start, index);
  const startDate = new Date(`${start}T00:00:00.000Z`);
  startDate.setUTCDate(startDate.getUTCDate() + FREQUENCIES[frequency].days * index);
  return formatDate(startDate);
}

function splitWholeAmount(amount: number, count: number): number[] {
  const base = Math.floor(amount / count);
  const remainder = amount - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function makeScheduleRows(
  input: ScheduleInput,
  principalParts: number[],
  interestParts: number[],
  totalFees: number,
): BuiltSchedule {
  const feeParts = splitWholeAmount(totalFees, principalParts.length);
  const schedules = principalParts.map((principal_due, index) => {
    const interest_due = interestParts[index];
    const fees_due = feeParts[index];
    return {
      installment_number: index + 1,
      due_date: installmentDate(input.start_date, index, input.frequency),
      principal_due,
      interest_due,
      fees_due,
      total_due: principal_due + interest_due + fees_due,
    };
  });
  const total_interest = interestParts.reduce((sum, value) => sum + value, 0);
  return {
    schedules,
    total_interest,
    total_fees: totalFees,
    total_repayable: input.principal + total_interest + totalFees,
    maturity_date: schedules[schedules.length - 1].due_date,
  };
}

export function buildScheduleFlat(input: ScheduleInput): BuiltSchedule {
  assertScheduleInput(input);
  const periods = input.term_months * FREQUENCIES[input.frequency].periodsPerMonth;
  const totalInterest = wholeUgx(input.principal * (input.annual_rate / 100) * (input.term_months / 12));
  const totalFees = wholeUgx(
    input.principal * ((input.processing_fee_percent ?? 0) + (input.insurance_fee_percent ?? 0)) / 100,
  );
  return makeScheduleRows(
    input,
    splitWholeAmount(input.principal, periods),
    splitWholeAmount(totalInterest, periods),
    totalFees,
  );
}

export function buildScheduleReducing(input: ScheduleInput): BuiltSchedule {
  assertScheduleInput(input);
  const periodsPerYear = FREQUENCIES[input.frequency].ratePeriodsPerYear;
  const periods = input.term_months * FREQUENCIES[input.frequency].periodsPerMonth;
  const periodRate = input.annual_rate / 100 / periodsPerYear;
  const scheduledPayment = periodRate === 0
    ? input.principal / periods
    : input.principal * periodRate / (1 - Math.pow(1 + periodRate, -periods));
  const principalParts: number[] = [];
  const interestParts: number[] = [];
  let balance = input.principal;

  for (let index = 0; index < periods; index += 1) {
    const interest = wholeUgx(balance * periodRate);
    const principal = index === periods - 1
      ? balance
      : Math.min(balance, Math.max(0, wholeUgx(scheduledPayment - interest)));
    principalParts.push(principal);
    interestParts.push(interest);
    balance -= principal;
  }

  if (balance !== 0) {
    principalParts[principalParts.length - 1] += balance;
  }
  const totalFees = wholeUgx(
    input.principal * ((input.processing_fee_percent ?? 0) + (input.insurance_fee_percent ?? 0)) / 100,
  );
  return makeScheduleRows(input, principalParts, interestParts, totalFees);
}

export function buildSchedule(input: ScheduleInput, method: LoanInterestMethod): BuiltSchedule {
  if (method === "flat") return buildScheduleFlat(input);
  if (method === "reducing_balance") return buildScheduleReducing(input);
  throw new RangeError("Interest method must be flat or reducing_balance.");
}

export function calculateLateFee(
  totalDue: number,
  lateFeePercent: number,
  daysLate: number,
  gracePeriodDays: number,
): number {
  if (![totalDue, lateFeePercent, daysLate, gracePeriodDays].every(Number.isFinite)) {
    throw new RangeError("Late fee inputs must be finite.");
  }
  const billableDays = Math.max(0, Math.floor(daysLate) - Math.max(0, Math.floor(gracePeriodDays)));
  return wholeUgx(Math.max(0, totalDue) * Math.max(0, lateFeePercent) / 100 * billableDays / 30);
}

export function allocatePayment(
  amount: number,
  schedules: PaymentScheduleInput[],
): { allocations: PaymentAllocation[]; applied_amount: number; overpayment: number } {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError("Payment must be a positive whole number of UGX.");
  }
  const allocations = new Map<string, PaymentAllocation>();
  for (const schedule of schedules) {
    allocations.set(schedule.id, {
      schedule_id: schedule.id,
      principal_applied: 0,
      interest_applied: 0,
      fees_applied: 0,
      late_fees_applied: 0,
    });
  }
  let remaining = amount;
  const components = [
    ["late_fee_due", "late_fee_paid", "late_fees_applied"],
    ["fees_due", "fees_paid", "fees_applied"],
    ["interest_due", "interest_paid", "interest_applied"],
    ["principal_due", "principal_paid", "principal_applied"],
  ] as const;
  const ordered = [...schedules].sort((left, right) =>
    left.due_date.localeCompare(right.due_date) ||
    left.installment_number - right.installment_number,
  );

  for (const schedule of ordered) {
    for (const [dueKey, paidKey, appliedKey] of components) {
      if (remaining <= 0) break;
      const due = Math.max(0, Math.round(Number(schedule[dueKey]) - Number(schedule[paidKey])));
      const applied = Math.min(remaining, due);
      if (applied > 0) {
        const allocation = allocations.get(schedule.id)!;
        allocation[appliedKey] = applied;
        remaining -= applied;
      }
    }
    if (remaining <= 0) break;
  }

  const results = [...allocations.values()];
  const applied_amount = amount - remaining;
  return { allocations: results, applied_amount, overpayment: remaining };
}

export function allocateCredit(
  amount: number,
  schedules: CreditScheduleInput[],
  asOfDate: string,
): { allocations: CreditAllocation[]; applied_amount: number } {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError("Credit note must be a positive whole number of UGX.");
  }
  if (!isIsoDate(asOfDate)) throw new RangeError("Credit note date must be a valid ISO date.");
  const eligible = schedules
    .filter((schedule) =>
      schedule.status === "pending" &&
      schedule.due_date > asOfDate &&
      Number(schedule.principal_due) > Number(schedule.principal_paid ?? 0) &&
      Number(schedule.principal_paid ?? 0) === 0 &&
      Number(schedule.interest_paid ?? 0) === 0 &&
      Number(schedule.fees_paid ?? 0) === 0 &&
      Number(schedule.late_fee_paid ?? 0) === 0 &&
      Number(schedule.total_paid ?? 0) === 0,
    )
    .sort((left, right) =>
      left.due_date.localeCompare(right.due_date) ||
      left.installment_number - right.installment_number,
    );
  const allocations = eligible.map((schedule) => ({
    schedule_id: schedule.id,
    principal_reduction: 0,
  }));
  let remaining = Math.min(
    amount,
    eligible.reduce((sum, schedule) => sum + Math.max(0, Math.floor(Number(schedule.principal_due))), 0),
  );

  while (remaining > 0) {
    const active = eligible
      .map((schedule, index) => ({
        schedule,
        allocation: allocations[index],
        capacity: Math.max(
          0,
          Math.floor(Number(schedule.principal_due)) - allocations[index].principal_reduction,
        ),
      }))
      .filter((item) => item.capacity > 0);
    if (!active.length) break;
    const baseShare = Math.floor(remaining / active.length);
    const extraUnits = remaining % active.length;
    let distributed = 0;
    active.forEach((item, index) => {
      const desired = baseShare + (index < extraUnits ? 1 : 0);
      const applied = Math.min(item.capacity, desired);
      item.allocation.principal_reduction += applied;
      distributed += applied;
    });
    if (distributed === 0) break;
    remaining -= distributed;
  }

  return {
    allocations: allocations.filter((item) => item.principal_reduction > 0),
    applied_amount: allocations.reduce((sum, item) => sum + item.principal_reduction, 0),
  };
}
