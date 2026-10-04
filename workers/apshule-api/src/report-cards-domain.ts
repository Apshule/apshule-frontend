export type ReportTemplateLevel = "nursery" | "primary" | "o_level" | "a_level";

export interface CalculatedMark {
  avg: number | null;
  pct_20: number | null;
  pct_80: number | null;
  pct_100: number;
  identifier: number;
  grade: string;
}

function normalizeClassName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/gu, "");
}

export function templateLevelForClass(className: string): ReportTemplateLevel | null {
  const value = normalizeClassName(className);
  if (["baby", "babyclass", "middle", "middleclass", "top", "topclass"].includes(value)) {
    return "nursery";
  }
  if (/^(?:p|primary)(?:[1-7])$/u.test(value)) return "primary";
  if (/^(?:s|senior|secondary)(?:[1-6])$/u.test(value)) {
    const level = Number(value.match(/\d+$/u)?.[0]);
    return level >= 5 ? "a_level" : "o_level";
  }
  return null;
}

export function calculateReportMark(
  templateLevel: ReportTemplateLevel,
  a1: number | null,
  a2: number | null,
  a3: number | null,
  eot: number,
): CalculatedMark {
  const avg =
    templateLevel === "nursery"
      ? null
      : Math.round((((a1 ?? 0) + (a2 ?? 0) + (a3 ?? 0)) / 3) * 100) / 100;
  const pct20 = avg === null ? null : Math.round(avg * 0.2 * 100) / 100;
  const pct80 = Math.round(eot * 0.8 * 100) / 100;
  const pct100 =
    templateLevel === "nursery"
      ? Math.round(eot * 100) / 100
      : Math.round(((pct20 ?? 0) + pct80) * 100) / 100;

  const identifier = pct100 >= 75 ? 3 : pct100 >= 65 ? 2 : 1;
  const grade =
    pct100 >= 80
      ? "A"
      : pct100 >= 70
        ? "B"
        : pct100 >= 60
          ? "C"
          : pct100 >= 50
            ? "D"
            : "E";
  return { avg, pct_20: pct20, pct_80: pct80, pct_100: pct100, identifier, grade };
}