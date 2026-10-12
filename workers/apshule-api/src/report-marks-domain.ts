export function calculateReportMark(input: {
  a1: number; a2: number; a3: number; eot: number;
}) {
  const avg = (input.a1 + input.a2 + input.a3) / 3;
  const pct20 = avg * 0.2;
  const pct80 = input.eot * 0.8;
  const pct100 = pct20 + pct80;
  return {
    avg, pct20, pct80, pct100,
    identifier: avg >= 2.5 ? 3 : avg >= 1.5 ? 2 : 1,
    grade: pct100 >= 80 ? "A" : pct100 >= 70 ? "B" : pct100 >= 60 ? "C" : pct100 >= 50 ? "D" : "E",
  };
}
