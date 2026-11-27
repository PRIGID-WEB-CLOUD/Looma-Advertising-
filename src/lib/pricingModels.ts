export interface PricingModelOption {
  code: 'CPM' | 'CPC' | 'CPA' | 'CPI' | 'CPV' | 'FIXED';
  name: string;
  unit: string;
  minUsd: number;
}

export interface PricingModelDetail extends PricingModelOption {
  summary: string;
  billingTrigger: string;
  bestFor: string;
  eventLabelPlural: string;
}

export const DEFAULT_PRICING_MODELS: PricingModelOption[] = [
  { code: 'CPM', name: 'Cost Per Mille', unit: '1,000 verified impressions', minUsd: 0.5 },
  { code: 'CPC', name: 'Cost Per Click', unit: 'Verified user click', minUsd: 0.1 },
  { code: 'CPA', name: 'Cost Per Acquisition', unit: 'Attributed conversion', minUsd: 2.0 },
  { code: 'CPI', name: 'Cost Per Install', unit: 'Verified app install', minUsd: 1.5 },
  { code: 'CPV', name: 'Cost Per View', unit: 'Completed video view', minUsd: 0.05 },
  { code: 'FIXED', name: 'Fixed Sponsorship', unit: 'Guaranteed placement share', minUsd: 500.0 },
];

const PRICING_MODEL_META: Record<
  PricingModelOption['code'],
  { summary: string; billingTrigger: string; bestFor: string; eventLabelPlural: string }
> = {
  CPM: {
    summary: 'Pay only for viewable impressions verified on Looma placements.',
    billingTrigger: 'Billed per 1,000 verified impressions',
    bestFor: 'Brand reach & product launches',
    eventLabelPlural: 'verified impressions',
  },
  CPC: {
    summary: 'Pay per fraud-filtered user click with automated bot protection.',
    billingTrigger: 'Billed per verified user click',
    bestFor: 'Website traffic & lead funnels',
    eventLabelPlural: 'verified clicks',
  },
  CPA: {
    summary: 'Pay when attributed downstream conversions fire via server postback.',
    billingTrigger: 'Billed per attributed conversion',
    bestFor: 'Signups, checkouts & revenue ROI',
    eventLabelPlural: 'attributed conversions',
  },
  CPI: {
    summary: 'Pay per verified mobile app install with attributed install tracking.',
    billingTrigger: 'Billed per verified app install',
    bestFor: 'iOS & Android user acquisition',
    eventLabelPlural: 'verified installs',
  },
  CPV: {
    summary: 'Pay only when viewers complete your MP4 or WEBM video creative.',
    billingTrigger: 'Billed per completed video view',
    bestFor: 'Storytelling & product demos',
    eventLabelPlural: 'completed video views',
  },
  FIXED: {
    summary: 'Reserve guaranteed high-priority share of voice across featured placements.',
    billingTrigger: 'Prepaid fixed sponsorship allocation',
    bestFor: 'Flagship takeovers & seasonal promos',
    eventLabelPlural: 'sponsorship package(s)',
  },
};

export function mergePricingModelDetails(
  apiModels?: Array<{ code: string; name: string; unit: string; minUsd: number }>
): PricingModelDetail[] {
  const source = apiModels && apiModels.length > 0 ? apiModels : DEFAULT_PRICING_MODELS;
  const knownCodes = new Set<string>(DEFAULT_PRICING_MODELS.map((m) => m.code));

  const merged: PricingModelDetail[] = [];
  for (const item of source) {
    if (!knownCodes.has(item.code)) continue;
    const code = item.code as PricingModelOption['code'];
    const meta = PRICING_MODEL_META[code];
    merged.push({
      code,
      name: item.name,
      unit: item.unit,
      minUsd: Number(item.minUsd),
      ...meta,
    });
  }

  return merged.length > 0
    ? merged
    : DEFAULT_PRICING_MODELS.map((m) => ({ ...m, ...PRICING_MODEL_META[m.code] }));
}

export interface PrepaidEstimate {
  effectiveBudgetUsd: number;
  estimatedUnits: number;
  unitLabel: string;
  meetsMinimum: boolean;
}

/**
 * Estimates maximum billable volume at a pricing model's minimum rate for a prepaid wallet deposit.
 */
export function estimatePrepaidDelivery(
  model: PricingModelDetail,
  budgetUsd: number
): PrepaidEstimate {
  const cleanBudget = Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : 0;
  const minUsd = model.minUsd > 0 ? model.minUsd : 0.01;
  const meetsMinimum = cleanBudget >= minUsd;

  if (!meetsMinimum) {
    return {
      effectiveBudgetUsd: cleanBudget,
      estimatedUnits: 0,
      unitLabel: model.eventLabelPlural,
      meetsMinimum: false,
    };
  }

  if (model.code === 'CPM') {
    const impressions = Math.floor((cleanBudget / minUsd) * 1000);
    return {
      effectiveBudgetUsd: cleanBudget,
      estimatedUnits: impressions,
      unitLabel: model.eventLabelPlural,
      meetsMinimum: true,
    };
  }

  const units = Math.floor(cleanBudget / minUsd);
  return {
    effectiveBudgetUsd: cleanBudget,
    estimatedUnits: units,
    unitLabel: model.eventLabelPlural,
    meetsMinimum: true,
  };
}
