import crypto from 'node:crypto';

export type PricingModel = 'CPM' | 'CPC' | 'CPA' | 'CPI' | 'CPV' | 'FIXED';
export type PlacementFormat = 'banner' | 'responsive' | 'native' | 'video' | 'in_feed' | 'interstitial';
export type CreativeFormat = 'image' | 'banner' | 'native' | 'text' | 'video' | 'responsive' | 'sponsored';

export interface CandidateCampaign {
  campaignId: string;
  advertiserId: string;
  campaignName: string;
  pricingModel: PricingModel;
  biddingStrategy: string;
  status: string;
  moderationStatus: string;
  startDate: string;
  endDate: string;
  frequencyCapPerSession: number;
  dailyBudgetMicros: number;
  totalBudgetMicros: number;
  spentTodayMicros: number;
  spentTotalMicros: number;
  maxBidMicros: number;
  pacingMode: string;
  walletAvailableMicros: number;
  targeting: {
    countries: string[];
    languages: string[];
    deviceCategories: string[];
    operatingSystems: string[];
    browsers: string[];
    contextualCategories: string[];
    consentRequired: boolean;
  };
  creative: {
    id: string;
    advertisementId: string;
    format: CreativeFormat;
    title: string;
    description: string;
    mediaUrl: string;
    destinationUrl: string;
    ctaText: string;
    trackingParams: string;
    dimensions: string;
    approvalStatus: string;
  };
  historicalCtr: number;
  historicalCvr: number;
  qualityScore: number;
}

export interface AdRequestContext {
  placementId: string;
  placementFormat: PlacementFormat;
  floorCpmMicros: number;
  country: string;
  language: string;
  deviceCategory: string;
  os: string;
  browser: string;
  category: string;
  consentGranted: boolean;
  sessionImpressionCounts: Record<string, number>;
  recentDeliveryCounts?: Record<string, number>;
  nowIso: string;
}

export interface RankedAdCandidate {
  candidate: CandidateCampaign;
  effectiveCpmMicros: number;
  auctionScore: number;
  estimatedBillableMicros: number;
  rotationFactor?: number;
}

export interface TrackingTokenPayload {
  eventType: 'impression' | 'click' | 'conversion' | 'video' | 'install';
  requestId: string;
  campaignId: string;
  creativeId: string;
  placementId: string;
  publisherId: string;
  advertiserId: string;
  pricingModel: PricingModel;
  clearingPriceMicros: number;
  exp: number;
}

export const MICROS_PER_UNIT = 1_000_000;

export function formatMicrosToUsd(micros: number): string {
  const dollars = micros / MICROS_PER_UNIT;
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function isFormatCompatible(
  placementFormat: PlacementFormat,
  creativeFormat: CreativeFormat
): boolean {
  if (creativeFormat === 'responsive' || placementFormat === 'responsive') {
    return true;
  }
  const compatibilityMap: Record<PlacementFormat, CreativeFormat[]> = {
    banner: ['banner', 'image', 'responsive'],
    responsive: ['image', 'banner', 'native', 'text', 'responsive', 'sponsored'],
    native: ['native', 'sponsored', 'text', 'image', 'responsive'],
    in_feed: ['native', 'sponsored', 'image', 'video', 'responsive'],
    video: ['video', 'responsive'],
    interstitial: ['image', 'banner', 'video', 'responsive'],
  };
  return compatibilityMap[placementFormat]?.includes(creativeFormat) ?? false;
}

function matchesFilter(allowed: string[], actual: string): boolean {
  if (!allowed || allowed.length === 0) return true;
  const normalizedAllowed = allowed.map((item) => item.toUpperCase());
  if (normalizedAllowed.includes('ALL')) return true;
  return normalizedAllowed.includes(actual.toUpperCase());
}

export function computeEffectiveCpmMicros(candidate: CandidateCampaign): number {
  const ctr = Math.max(0.002, Math.min(0.15, candidate.historicalCtr || 0.018));
  const cvr = Math.max(0.005, Math.min(0.25, candidate.historicalCvr || 0.04));

  switch (candidate.pricingModel) {
    case 'CPM':
      return candidate.maxBidMicros;
    case 'CPC':
      // eCPM = CPC * CTR * 1000
      return Math.round(candidate.maxBidMicros * ctr * 1000);
    case 'CPA':
    case 'CPI':
      // eCPM = CPA/CPI * CTR * CVR * 1000
      return Math.round(candidate.maxBidMicros * ctr * cvr * 1000);
    case 'CPV':
      // Assume ~45% view completion rate for video impressions
      return Math.round(candidate.maxBidMicros * 0.45 * 1000);
    case 'FIXED':
      // Fixed sponsorships get high priority floor-equivalent eCPM
      return Math.max(candidate.maxBidMicros, 15_000_000);
    default:
      return candidate.maxBidMicros;
  }
}

export function computeSingleEventBillMicros(
  pricingModel: PricingModel,
  bidMicros: number,
  eventType: 'impression' | 'click' | 'conversion' | 'video_complete' | 'install'
): number {
  if (pricingModel === 'CPM' && eventType === 'impression') {
    return Math.max(1, Math.round(bidMicros / 1000));
  }
  if (pricingModel === 'FIXED' && eventType === 'impression') {
    return Math.max(1, Math.round(bidMicros / 1000));
  }
  if (pricingModel === 'CPC' && eventType === 'click') {
    return Math.max(1, bidMicros);
  }
  if (pricingModel === 'CPA' && eventType === 'conversion') {
    return Math.max(1, bidMicros);
  }
  if (pricingModel === 'CPI' && (eventType === 'install' || eventType === 'conversion')) {
    return Math.max(1, bidMicros);
  }
  if (pricingModel === 'CPV' && eventType === 'video_complete') {
    return Math.max(1, bidMicros);
  }
  return 0;
}

export function splitRevenueMicros(
  grossMicros: number,
  publisherShareBps: number
): { publisherShareMicros: number; platformFeeMicros: number } {
  if (grossMicros <= 0) {
    return { publisherShareMicros: 0, platformFeeMicros: 0 };
  }
  const clampedBps = Math.max(0, Math.min(10000, Math.round(publisherShareBps)));
  const publisherShareMicros = Math.floor((grossMicros * clampedBps) / 10000);
  const platformFeeMicros = grossMicros - publisherShareMicros;
  return { publisherShareMicros, platformFeeMicros };
}

export function computeRotationFactor(recentDeliveryCount: number, sessionImpressionCount: number): number {
  const clampedRecent = Math.max(0, Math.min(10, Math.floor(recentDeliveryCount || 0)));
  const clampedSeen = Math.max(0, Math.floor(sessionImpressionCount || 0));
  return Number((1 / (1 + 0.12 * clampedRecent + 0.25 * clampedSeen)).toFixed(4));
}

export function selectWinningAds(
  candidates: CandidateCampaign[],
  context: AdRequestContext,
  maxSlots = 1
): RankedAdCandidate[] {
  const nowDate = context.nowIso.slice(0, 10);
  const ranked: RankedAdCandidate[] = [];

  for (const c of candidates) {
    if (c.status !== 'active' || c.moderationStatus !== 'approved') continue;
    if (c.creative.approvalStatus !== 'approved') continue;
    if (c.startDate > nowDate || c.endDate < nowDate) continue;

    if (!isFormatCompatible(context.placementFormat, c.creative.format)) continue;

    // Respect consent requirements
    if (c.targeting.consentRequired && !context.consentGranted) continue;

    // Check targeting compatibility
    if (!matchesFilter(c.targeting.countries, context.country)) continue;
    if (!matchesFilter(c.targeting.languages, context.language)) continue;
    if (!matchesFilter(c.targeting.deviceCategories, context.deviceCategory)) continue;
    if (!matchesFilter(c.targeting.operatingSystems, context.os)) continue;
    if (!matchesFilter(c.targeting.browsers, context.browser)) continue;

    if (
      c.targeting.contextualCategories.length > 0 &&
      !c.targeting.contextualCategories.includes('ALL') &&
      !c.targeting.contextualCategories
        .map((x) => x.toLowerCase())
        .includes(context.category.toLowerCase())
    ) {
      continue;
    }

    // Frequency cap check
    const seenCount = context.sessionImpressionCounts[c.campaignId] ?? 0;
    if (seenCount >= c.frequencyCapPerSession) continue;

    // Budget & wallet guardrails (prevent overspending)
    const remainingDaily = c.dailyBudgetMicros - c.spentTodayMicros;
    const remainingTotal = c.totalBudgetMicros - c.spentTotalMicros;
    const minRequiredReserve =
      c.pricingModel === 'CPM' || c.pricingModel === 'FIXED'
        ? Math.max(1, Math.round(c.maxBidMicros / 1000))
        : c.maxBidMicros;

    if (remainingDaily < minRequiredReserve) continue;
    if (remainingTotal < minRequiredReserve) continue;
    if (c.walletAvailableMicros < minRequiredReserve) continue;

    // Standard pacing check: if standard pacing and >98% of daily budget spent early, throttle lightly
    if (c.pacingMode === 'standard' && remainingDaily <= c.dailyBudgetMicros * 0.02) {
      continue;
    }

    const effectiveCpmMicros = computeEffectiveCpmMicros(c);
    if (effectiveCpmMicros < context.floorCpmMicros) continue;

    // Controlled ranking & rotation: combine first-price eCPM with quality & delivery rotation damping
    const qualityMultiplier = Math.max(0.5, Math.min(1.5, c.qualityScore || 1.0));
    const recentCount = context.recentDeliveryCounts?.[c.campaignId] ?? 0;
    const rotationFactor = computeRotationFactor(recentCount, seenCount);
    const auctionScore = Math.round(effectiveCpmMicros * qualityMultiplier * rotationFactor);

    ranked.push({
      candidate: c,
      effectiveCpmMicros,
      auctionScore,
      estimatedBillableMicros: minRequiredReserve,
      rotationFactor,
    });
  }

  if (ranked.length === 0) return [];

  ranked.sort((a, b) => b.auctionScore - a.auctionScore);

  const selected: RankedAdCandidate[] = [];
  const usedCampaignIds = new Set<string>();
  const targetSlots = Math.max(1, Math.min(10, maxSlots));

  for (const item of ranked) {
    if (usedCampaignIds.has(item.candidate.campaignId)) continue;
    selected.push(item);
    usedCampaignIds.add(item.candidate.campaignId);
    if (selected.length >= targetSlots) break;
  }

  return selected;
}

export function selectWinningAd(
  candidates: CandidateCampaign[],
  context: AdRequestContext
): RankedAdCandidate | null {
  return selectWinningAds(candidates, context, 1)[0] ?? null;
}

export function signTrackingToken(payload: TrackingTokenPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyTrackingToken(
  token: string,
  secret: string,
  nowMs = Date.now()
): { valid: true; payload: TrackingTokenPayload } | { valid: false; reason: string } {
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed_token' };
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TrackingTokenPayload;
    if (!parsed.exp || nowMs > parsed.exp) {
      return { valid: false, reason: 'token_expired' };
    }
    return { valid: true, payload: parsed };
  } catch {
    return { valid: false, reason: 'invalid_payload' };
  }
}

export interface FraudEvaluationInput {
  userAgent: string;
  recentClicksSameIpCount: number;
  recentImpressionsSameSessionCount: number;
  alreadyClickedImpression: boolean;
  publisherCtr: number;
}

export interface FraudEvaluationResult {
  isValid: boolean;
  reason: string | null;
  shouldRaiseAlert: boolean;
  severity: 'low' | 'medium' | 'high';
  signalType: string | null;
}

const BOT_UA_PATTERNS = [/bot/i, /crawler/i, /spider/i, /headless/i, /curl/i, /python-requests/i];

export function evaluateTrafficQuality(input: FraudEvaluationInput): FraudEvaluationResult {
  if (input.alreadyClickedImpression) {
    return {
      isValid: false,
      reason: 'duplicate_impression_click',
      shouldRaiseAlert: false,
      severity: 'low',
      signalType: 'duplicate_click',
    };
  }

  if (BOT_UA_PATTERNS.some((re) => re.test(input.userAgent))) {
    return {
      isValid: false,
      reason: 'automated_bot_user_agent',
      shouldRaiseAlert: true,
      severity: 'high',
      signalType: 'bot_traffic',
    };
  }

  if (input.recentClicksSameIpCount >= 3) {
    return {
      isValid: false,
      reason: 'repeated_click_velocity',
      shouldRaiseAlert: true,
      severity: 'high',
      signalType: 'repeated_clicks',
    };
  }

  if (input.recentImpressionsSameSessionCount >= 20) {
    return {
      isValid: false,
      reason: 'session_impression_flood',
      shouldRaiseAlert: true,
      severity: 'medium',
      signalType: 'repeated_impressions',
    };
  }

  if (input.publisherCtr > 0.25) {
    return {
      isValid: true, // Do not auto-reject valid single click solely on CTR alert; flag for review
      reason: null,
      shouldRaiseAlert: true,
      severity: 'medium',
      signalType: 'abnormal_ctr_spike',
    };
  }

  return {
    isValid: true,
    reason: null,
    shouldRaiseAlert: false,
    severity: 'low',
    signalType: null,
  };
}
