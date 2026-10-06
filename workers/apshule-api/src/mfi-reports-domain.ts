export type UmraClassification =
  | "performing"
  | "watch"
  | "substandard"
  | "doubtful"
  | "loss";

export interface RiskPortfolioLoan {
  outstandingPrincipal: number | string;
  daysOverdue: number | string;
  restructured: boolean;
}

export interface RiskClassificationRow {
  classification: UmraClassification;
  account_count: number;
  outstanding_portfolio: number;
  required_provision_rate: number;
  required_provision_amount: number;
}

export interface RiskClassificationSection {
  rows: RiskClassificationRow[];
  account_count: number;
  outstanding_portfolio: number;
  required_provision_amount: number;
}

export interface UmraRiskClassification {
  portfolio_ageing: RiskClassificationSection;
  rescheduled_or_reclassified: RiskClassificationSection;
  account_count: number;
  outstanding_portfolio: number;
  required_provision_amount: number;
  provisioning_rates: Record<UmraClassification, number>;
}

export const UMRA_CLASSIFICATIONS: readonly UmraClassification[] = [
  "performing",
  "watch",
  "substandard",
  "doubtful",
  "loss",
];

export const UMRA_PROVISIONING_RATES: Readonly<Record<UmraClassification, number>> = {
  performing: 0.01,
  watch: 0.05,
  substandard: 0.25,
  doubtful: 0.5,
  loss: 1,
};

function finiteAmount(value: number | string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError("Portfolio amounts must be finite and non-negative.");
  }
  return amount;
}

function wholeUgx(value: number): number {
  return Math.round(value);
}

export function classifyUmraLoan(daysOverdue: number): UmraClassification {
  if (!Number.isInteger(daysOverdue) || daysOverdue < 0) {
    throw new RangeError("Days overdue must be a non-negative integer.");
  }
  if (daysOverdue === 0) return "performing";
  if (daysOverdue <= 30) return "watch";
  if (daysOverdue <= 90) return "substandard";
  if (daysOverdue <= 180) return "doubtful";
  return "loss";
}

function emptySection(): RiskClassificationSection {
  return {
    rows: UMRA_CLASSIFICATIONS.map((classification) => ({
      classification,
      account_count: 0,
      outstanding_portfolio: 0,
      required_provision_rate: UMRA_PROVISIONING_RATES[classification],
      required_provision_amount: 0,
    })),
    account_count: 0,
    outstanding_portfolio: 0,
    required_provision_amount: 0,
  };
}

function finishSection(section: RiskClassificationSection): RiskClassificationSection {
  for (const row of section.rows) {
    row.outstanding_portfolio = wholeUgx(row.outstanding_portfolio);
    row.required_provision_amount = wholeUgx(
      row.outstanding_portfolio * row.required_provision_rate,
    );
    section.account_count += row.account_count;
    section.outstanding_portfolio += row.outstanding_portfolio;
    section.required_provision_amount += row.required_provision_amount;
  }
  return section;
}

export function buildUmraRiskClassification(
  loans: readonly RiskPortfolioLoan[],
): UmraRiskClassification {
  const portfolioAgeing = emptySection();
  const rescheduled = emptySection();
  const rows = new Map<UmraClassification, RiskClassificationRow[]>();
  for (const section of [portfolioAgeing, rescheduled]) {
    for (const row of section.rows) {
      const grouped = rows.get(row.classification) || [];
      grouped.push(row);
      rows.set(row.classification, grouped);
    }
  }

  for (const loan of loans) {
    const balance = finiteAmount(loan.outstandingPrincipal);
    if (balance === 0) continue;
    const daysOverdue = Number(loan.daysOverdue);
    const classification = classifyUmraLoan(daysOverdue);
    const target = rows.get(classification)?.[loan.restructured ? 1 : 0];
    if (!target) throw new Error("Risk classification row was not initialized.");
    target.account_count += 1;
    target.outstanding_portfolio += balance;
  }

  finishSection(portfolioAgeing);
  finishSection(rescheduled);
  return {
    portfolio_ageing: portfolioAgeing,
    rescheduled_or_reclassified: rescheduled,
    account_count: portfolioAgeing.account_count + rescheduled.account_count,
    outstanding_portfolio:
      portfolioAgeing.outstanding_portfolio + rescheduled.outstanding_portfolio,
    required_provision_amount:
      portfolioAgeing.required_provision_amount +
      rescheduled.required_provision_amount,
    provisioning_rates: { ...UMRA_PROVISIONING_RATES },
  };
}

export function calculatePar(
  loans: readonly { outstandingBalance: number | string; daysOverdue: number | string }[],
  thresholdDays: number,
): { at_risk_amount: number; portfolio_amount: number; ratio: number } {
  if (!Number.isInteger(thresholdDays) || thresholdDays < 1) {
    throw new RangeError("PAR threshold must be a positive integer number of days.");
  }
  let atRisk = 0;
  let portfolio = 0;
  for (const loan of loans) {
    const balance = finiteAmount(loan.outstandingBalance);
    const days = Number(loan.daysOverdue);
    if (!Number.isInteger(days) || days < 0) {
      throw new RangeError("Days overdue must be a non-negative integer.");
    }
    portfolio += balance;
    if (balance > 0 && days >= thresholdDays) atRisk += balance;
  }
  const portfolioAmount = wholeUgx(portfolio);
  const atRiskAmount = wholeUgx(atRisk);
  return {
    at_risk_amount: atRiskAmount,
    portfolio_amount: portfolioAmount,
    ratio: portfolioAmount === 0 ? 0 : atRiskAmount / portfolioAmount,
  };
}

export function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvDocument(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

export function parseReportDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new RangeError("Date must use YYYY-MM-DD format.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError("Date must be a valid calendar date.");
  }
  return value;
}
