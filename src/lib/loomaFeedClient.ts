/**
 * LOOMA ADS — Fail-Open Looma Feed Integration Client
 *
 * Designed for Looma's feed rendering pipeline:
 * - Looma controls all feed layout and creative rendering.
 * - LOOMA ADS returns data-only ad decisions with signed tracking tokens.
 * - Strict latency timeout + lightweight circuit breaker guarantee that normal
 *   Looma feed rendering continues uninterrupted if the advertising service is
 *   slow or unavailable.
 */

export interface LoomaFeedSlotSpec {
  slotIndex: number;
  placementId: string;
}

export interface LoomaFeedAdPayload {
  campaignId: string;
  campaignName: string;
  creativeId: string;
  format: string;
  pricingModel: string;
  title: string;
  description: string;
  mediaUrl: string;
  destinationUrl: string;
  ctaText: string;
  dimensions: string;
  sponsoredLabel: string;
}

export interface LoomaFeedSlotDecision {
  slotIndex: number;
  placementId: string;
  filled: boolean;
  requestId: string | null;
  reason?: string;
  reservationId?: string | null;
  reservedMicros?: number;
  auction?: {
    model: string;
    effectiveCpmMicros: number;
    auctionScore: number;
    rotationFactor: number;
  };
  ad: LoomaFeedAdPayload | null;
  tracking?: {
    impressionToken: string;
    clickToken: string;
    conversionToken: string;
    videoToken: string;
    installToken: string;
  };
}

export interface LoomaFeedFetchResult {
  degraded: boolean;
  degradedReason?: string;
  contractVersion: string;
  fallbackBehavior: 'skip_slot_continue_feed';
  latencyMs: number;
  decisions: LoomaFeedSlotDecision[];
}

interface CircuitState {
  consecutiveFailures: number;
  openUntilMs: number;
}

const circuit: CircuitState = {
  consecutiveFailures: 0,
  openUntilMs: 0,
};

export function resetLoomaFeedCircuitBreaker(): void {
  circuit.consecutiveFailures = 0;
  circuit.openUntilMs = 0;
}

export async function fetchLoomaFeedAds(options: {
  endpoint?: string;
  adapterKey?: string;
  authToken?: string | null;
  slots?: LoomaFeedSlotSpec[];
  country?: string;
  language?: string;
  deviceCategory?: string;
  feedCategory?: string;
  consentGranted?: boolean;
  sessionId?: string;
  timeoutMs?: number;
  simulateOutage?: boolean;
}): Promise<LoomaFeedFetchResult> {
  const startedAt = performance.now();
  const timeoutMs = Math.max(100, Math.min(3000, options.timeoutMs ?? 600));

  // If circuit breaker is currently open, fail open immediately without waiting on network
  if (!options.simulateOutage && Date.now() < circuit.openUntilMs) {
    return {
      degraded: true,
      degradedReason: 'circuit_breaker_open_skip_ad_slots',
      contractVersion: '2026-11-v1',
      fallbackBehavior: 'skip_slot_continue_feed',
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      decisions: [],
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (options.simulateOutage) {
      throw new Error('simulated_ad_service_unavailable');
    }

    const endpoint = options.endpoint || '/api/v1/looma/feed/ads';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.adapterKey) {
      headers['x-looma-adapter-key'] = options.adapterKey;
    }
    if (options.authToken) {
      headers.Authorization = `Bearer ${options.authToken}`;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        slots: options.slots,
        country: options.country ?? 'US',
        language: options.language ?? 'en',
        deviceCategory: options.deviceCategory ?? 'mobile',
        feedCategory: options.feedCategory ?? 'business_finance',
        consentGranted: options.consentGranted !== false,
        sessionId: options.sessionId ?? '',
      }),
    });

    if (!res.ok) {
      throw new Error(`ad_service_http_${res.status}`);
    }

    const data = await res.json();
    circuit.consecutiveFailures = 0;
    circuit.openUntilMs = 0;

    return {
      degraded: false,
      contractVersion: String(data.contractVersion || '2026-11-v1'),
      fallbackBehavior: 'skip_slot_continue_feed',
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      decisions: Array.isArray(data.decisions) ? data.decisions : [],
    };
  } catch (err) {
    if (!options.simulateOutage) {
      circuit.consecutiveFailures += 1;
      if (circuit.consecutiveFailures >= 3) {
        circuit.openUntilMs = Date.now() + 15_000;
      }
    }
    return {
      degraded: true,
      degradedReason: err instanceof Error ? err.message : 'ad_service_unavailable',
      contractVersion: '2026-11-v1',
      fallbackBehavior: 'skip_slot_continue_feed',
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      decisions: [],
    };
  } finally {
    clearTimeout(timer);
  }
}
