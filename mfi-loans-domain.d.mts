export type LoanInterestMethod = "flat" | "reducing_balance";

export interface LoanPaymentEstimate {
  monthlyPayment: number;
  totalRepayment: number;
  interestAmount: number;
  method: LoanInterestMethod;
}

export function estimateMonthlyPayment(
  amount: number | string,
  annualRate: number | string,
  termMonths: number | string,
  method?: LoanInterestMethod,
): LoanPaymentEstimate;

export function calculateDebtToIncome(
  monthlyPayment: number | string,
  monthlyIncome: number | string | null | undefined,
): number | null;
