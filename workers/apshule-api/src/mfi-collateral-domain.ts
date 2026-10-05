export const MAX_MFI_COLLATERAL_PHOTO_BYTES = 200 * 1024;

export const MFI_COLLATERAL_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "awaiting_valuation",
  "valued",
  "awaiting_legal",
  "legal_cleared",
  "legal_issue",
] as const;

export type MfiCollateralCondition = "excellent" | "good" | "fair" | "poor";

export const MFI_COLLATERAL_DEFAULTS = [
  { code: "LAND", name: "Land", category: "Immovable", base_score: 80, requires_valuation: true, requires_legal: true },
  { code: "BUILDING", name: "Building", category: "Immovable", base_score: 85, requires_valuation: true, requires_legal: true },
  { code: "VEHICLE", name: "Vehicle", category: "Movable", base_score: 65, requires_valuation: true, requires_legal: true },
  { code: "MOTORCYCLE", name: "Motorcycle/Boda", category: "Movable", base_score: 60, requires_valuation: true, requires_legal: false },
  { code: "LIVESTOCK", name: "Livestock", category: "Livestock", base_score: 55, requires_valuation: true, requires_legal: false },
  { code: "CROPS", name: "Crops", category: "Agriculture", base_score: 45, requires_valuation: true, requires_legal: false },
  { code: "HOUSEHOLD", name: "Household Items", category: "Movable", base_score: 35, requires_valuation: false, requires_legal: false },
  { code: "SALARY", name: "Salary Assignment", category: "Income", base_score: 70, requires_valuation: false, requires_legal: true },
  { code: "SAVINGS", name: "Savings/Shares", category: "Financial", base_score: 75, requires_valuation: false, requires_legal: false },
  { code: "GUARANTOR", name: "Personal Guarantee", category: "Person", base_score: 50, requires_valuation: false, requires_legal: true },
] as const;

const CONDITION_SCORE: Record<MfiCollateralCondition, number> = {
  excellent: 100,
  good: 80,
  fair: 60,
  poor: 40,
};

export interface MfiCollateralScoreBreakdown {
  type: { score: number; weight: 0.4; weighted: number };
  value: { score: number; weight: 0.3; weighted: number };
  condition: { score: number; weight: 0.2; weighted: number };
  documents: { count: number; score: number; weight: 0.1; weighted: number };
  total: number;
}

export function collateralValueTier(value: number): number {
  if (value < 500_000) return 40;
  if (value < 2_000_000) return 60;
  if (value <= 10_000_000) return 80;
  return 100;
}

export function calculateMfiCollateralScore(input: {
  typeBaseScore: number;
  estimatedValue: number;
  condition: MfiCollateralCondition;
  documentCount: number;
}): MfiCollateralScoreBreakdown {
  const typeWeighted = input.typeBaseScore * 0.4;
  const valueScore = collateralValueTier(input.estimatedValue);
  const valueWeighted = valueScore * 0.3;
  const conditionScore = CONDITION_SCORE[input.condition];
  const conditionWeighted = conditionScore * 0.2;
  const documentScore = input.documentCount >= 3
    ? 100
    : input.documentCount > 0
      ? 60
      : 20;
  const documentsWeighted = documentScore * 0.1;
  const total = Math.round(typeWeighted + valueWeighted + conditionWeighted + documentsWeighted);

  return {
    type: { score: input.typeBaseScore, weight: 0.4, weighted: typeWeighted },
    value: { score: valueScore, weight: 0.3, weighted: valueWeighted },
    condition: { score: conditionScore, weight: 0.2, weighted: conditionWeighted },
    documents: {
      count: input.documentCount,
      score: documentScore,
      weight: 0.1,
      weighted: documentsWeighted,
    },
    total,
  };
}

export function isMfiCollateralPhoto(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]*={0,2})$/iu.exec(value);
  if (!match) return false;
  const encoded = match[1]!;
  if (!encoded || encoded.length % 4 !== 0) return false;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const bytes = (encoded.length / 4) * 3 - padding;
  return bytes > 0 && bytes <= MAX_MFI_COLLATERAL_PHOTO_BYTES;
}
