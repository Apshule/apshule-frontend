export type SaleLineInput = {
  quantity: number;
  unit_price: number;
};

export type SaleTotals = {
  subtotal: number;
  discount: number;
  total: number;
};

function wholeNonNegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a whole amount in UGX.`);
  }
  return value;
}

export function calculateSaleTotals(
  lines: SaleLineInput[],
  discount: number,
): SaleTotals {
  if (!lines.length) throw new Error("Add at least one product to the sale.");
  let subtotal = 0;
  for (const line of lines) {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw new Error("Sale quantities must be greater than zero.");
    }
    wholeNonNegative(line.unit_price, "unit_price");
    const lineTotal = Math.round(line.quantity * line.unit_price);
    if (!Number.isSafeInteger(lineTotal)) throw new Error("A sale line total is too large.");
    subtotal += lineTotal;
    if (!Number.isSafeInteger(subtotal)) throw new Error("The sale total is too large.");
  }
  wholeNonNegative(discount, "discount");
  if (discount > subtotal) throw new Error("Discount cannot exceed the sale subtotal.");
  const total = subtotal - discount;
  return { subtotal, discount, total };
}

export function calculateProfitLoss(revenue: number, expenses: number) {
  const grossProfit = revenue - expenses;
  return {
    revenue,
    expenses,
    gross_profit: grossProfit,
    margin_pct: revenue > 0 ? Number(((grossProfit / revenue) * 100).toFixed(2)) : 0,
  };
}

export function nextMonthlySaleNumber(
  yearMonth: string,
  lastSequence: number,
): string {
  if (!/^\d{6}$/u.test(yearMonth)) throw new Error("Sale month must be YYYYMM.");
  if (!Number.isInteger(lastSequence) || lastSequence < 0 || lastSequence >= 9999) {
    throw new Error("The monthly sale-number limit has been reached.");
  }
  return `SAL-${yearMonth}-${String(lastSequence + 1).padStart(4, "0")}`;
}
