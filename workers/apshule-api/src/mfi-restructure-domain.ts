import {
  buildSchedule,
  type BuiltSchedule,
  type LoanInterestMethod,
  type ScheduleInput,
} from "./mfi/loan-math.js";

export function buildRestructureSchedule(
  input: ScheduleInput,
  method: LoanInterestMethod,
  installmentAmount?: number,
): BuiltSchedule {
  const baseline = buildSchedule(input, method);
  if (installmentAmount === undefined) return baseline;
  if (!Number.isSafeInteger(installmentAmount) || installmentAmount <= 0) {
    throw new RangeError("Repayment amount must be a positive whole number of UGX.");
  }
  if (method === "flat") {
    let remainingPrincipal = input.principal;
    const schedules = baseline.schedules.map((row, index) => {
      const principal = index === baseline.schedules.length - 1
        ? remainingPrincipal
        : installmentAmount - row.interest_due;
      if (principal <= 0 || principal > remainingPrincipal) {
        if (index !== baseline.schedules.length - 1 || principal <= 0) {
          throw new RangeError("Repayment amount cannot pay down the balance within the selected term.");
        }
      }
      const principalDue = Math.min(principal, remainingPrincipal);
      remainingPrincipal -= principalDue;
      return {
        ...row,
        principal_due: principalDue,
        total_due: principalDue + row.interest_due + row.fees_due,
      };
    });
    if (remainingPrincipal !== 0) {
      throw new RangeError("Repayment amount does not repay the principal within the selected term.");
    }
    return {
      ...baseline,
      schedules,
      total_repayable: schedules.reduce((sum, row) => sum + row.total_due, 0),
    };
  }

  const periodsPerYear = input.frequency === "monthly" ? 12
    : input.frequency === "biweekly" ? 26
    : 52;
  const periodRate = input.annual_rate / 100 / periodsPerYear;
  let balance = input.principal;
  const schedules = baseline.schedules.map((row, index) => {
    const interest = Math.round(balance * periodRate);
    if (index < baseline.schedules.length - 1 && installmentAmount <= interest) {
      throw new RangeError("Repayment amount must exceed the interest due each period.");
    }
    if (index === baseline.schedules.length - 1 && installmentAmount < balance + interest) {
      throw new RangeError("Repayment amount does not repay the principal within the selected term.");
    }
    const principal = index === baseline.schedules.length - 1
      ? balance
      : Math.min(balance, installmentAmount - interest);
    if (principal <= 0) {
      throw new RangeError("Repayment amount cannot pay down the balance within the selected term.");
    }
    balance -= principal;
    return {
      ...row,
      principal_due: principal,
      interest_due: interest,
      total_due: principal + interest + row.fees_due,
    };
  });
  if (balance !== 0) {
    throw new RangeError("Repayment amount does not repay the principal within the selected term.");
  }
  const totalInterest = schedules.reduce((sum, row) => sum + row.interest_due, 0);
  const totalFees = schedules.reduce((sum, row) => sum + row.fees_due, 0);
  return {
    ...baseline,
    schedules,
    total_interest: totalInterest,
    total_fees: totalFees,
    total_repayable: schedules.reduce((sum, row) => sum + row.total_due, 0),
  };
}
