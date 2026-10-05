const ROUNDING_FACTOR = 100;

/**
 * Estimates a monthly principal-and-interest payment. Interest rates are
 * annual percentages; flat interest is charged against the original principal.
 */
export function estimateMonthlyPayment(amount, annualRate, termMonths, method = "reducing_balance") {
  const principal = Number(amount);
  const rate = Number(annualRate);
  const months = Number(termMonths);
  if (!Number.isFinite(principal) || principal <= 0) {
    throw new RangeError("Loan amount must be greater than zero.");
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 1000) {
    throw new RangeError("Interest rate must be between 0 and 1000 percent.");
  }
  if (!Number.isInteger(months) || months < 1 || months > 360) {
    throw new RangeError("Term must be between 1 and 360 months.");
  }
  if (method !== "flat" && method !== "reducing_balance") {
    throw new RangeError("Interest method must be flat or reducing_balance.");
  }

  const monthlyRate = rate / 100 / 12;
  const monthlyPayment = method === "flat"
    ? principal / months + principal * monthlyRate
    : monthlyRate === 0
      ? principal / months
      : principal * monthlyRate / (1 - (1 + monthlyRate) ** -months);
  const roundedPayment = Math.round(monthlyPayment * ROUNDING_FACTOR) / ROUNDING_FACTOR;
  const totalRepayment = Math.round(roundedPayment * months * ROUNDING_FACTOR) / ROUNDING_FACTOR;

  return {
    monthlyPayment: roundedPayment,
    totalRepayment,
    interestAmount: Math.round((totalRepayment - principal) * ROUNDING_FACTOR) / ROUNDING_FACTOR,
    method,
  };
}

export function calculateDebtToIncome(monthlyPayment, monthlyIncome) {
  const payment = Number(monthlyPayment);
  const income = Number(monthlyIncome);
  if (!Number.isFinite(payment) || payment < 0 || !Number.isFinite(income) || income <= 0) {
    return null;
  }
  return Math.round((payment / income) * 100 * ROUNDING_FACTOR) / ROUNDING_FACTOR;
}
