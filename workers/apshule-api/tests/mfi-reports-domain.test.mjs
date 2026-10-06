import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUmraRiskClassification,
  calculatePar,
  classifyUmraLoan,
  csvDocument,
  parseReportDate,
} from "../src/mfi-reports-domain.js";

test("classifies loans using the published UMRA ageing thresholds", () => {
  assert.equal(classifyUmraLoan(0), "performing");
  assert.equal(classifyUmraLoan(1), "watch");
  assert.equal(classifyUmraLoan(30), "watch");
  assert.equal(classifyUmraLoan(31), "substandard");
  assert.equal(classifyUmraLoan(90), "substandard");
  assert.equal(classifyUmraLoan(91), "doubtful");
  assert.equal(classifyUmraLoan(180), "doubtful");
  assert.equal(classifyUmraLoan(181), "loss");
  assert.throws(() => classifyUmraLoan(-1), RangeError);
});

test("builds the Schedule 3 portfolio and restructure sections with statutory provisions", () => {
  const report = buildUmraRiskClassification([
    { outstandingPrincipal: 100_000, daysOverdue: 0, restructured: false },
    { outstandingPrincipal: 40_000, daysOverdue: 15, restructured: false },
    { outstandingPrincipal: 60_000, daysOverdue: 45, restructured: true },
    { outstandingPrincipal: 20_000, daysOverdue: 200, restructured: false },
    { outstandingPrincipal: 0, daysOverdue: 30, restructured: false },
  ]);

  assert.equal(report.account_count, 4);
  assert.equal(report.outstanding_portfolio, 220_000);
  assert.equal(report.required_provision_amount, 38_000);
  assert.deepEqual(
    report.portfolio_ageing.rows.map((row) => row.required_provision_rate),
    [0.01, 0.05, 0.25, 0.5, 1],
  );
  assert.equal(report.portfolio_ageing.rows[0].account_count, 1);
  assert.equal(report.portfolio_ageing.rows[1].outstanding_portfolio, 40_000);
  assert.equal(report.portfolio_ageing.rows[4].required_provision_amount, 20_000);
  assert.equal(report.rescheduled_or_reclassified.rows[2].account_count, 1);
  assert.equal(report.rescheduled_or_reclassified.outstanding_portfolio, 60_000);
});

test("calculates PAR balances and safely handles an empty portfolio", () => {
  const loans = [
    { outstandingBalance: 100_000, daysOverdue: 0 },
    { outstandingBalance: "25000", daysOverdue: 30 },
    { outstandingBalance: "50", daysOverdue: 60 },
  ];
  assert.deepEqual(calculatePar(loans, 30), {
    at_risk_amount: 25_050,
    portfolio_amount: 125_050,
    ratio: 25_050 / 125_050,
  });
  assert.deepEqual(calculatePar([], 30), {
    at_risk_amount: 0,
    portfolio_amount: 0,
    ratio: 0,
  });
});

test("validates report dates and quotes CSV values", () => {
  assert.equal(parseReportDate("2026-10-06"), "2026-10-06");
  assert.throws(() => parseReportDate("2026-02-30"), RangeError);
  assert.equal(
    csvDocument(["name", "note"], [['Borrower, One', 'said "paid"']]),
    '"name","note"\r\n"Borrower, One","said ""paid"""',
  );
});
