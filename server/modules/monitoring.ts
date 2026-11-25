import type { DatabaseSync } from 'node:sqlite';

interface MonitoringCounters {
  startedAtIso: string;
  adRequestsTotal: number;
  adRequestsFilled: number;
  loomaFeedRequestsTotal: number;
  ssoExchangesTotal: number;
  ssoExchangesRejected: number;
  webhooksVerifiedTotal: number;
  webhooksRejectedTotal: number;
  fraudEventsBlockedTotal: number;
  recentLatenciesMs: number[];
}

const MAX_LATENCY_SAMPLES = 200;

const state: MonitoringCounters = {
  startedAtIso: new Date().toISOString(),
  adRequestsTotal: 0,
  adRequestsFilled: 0,
  loomaFeedRequestsTotal: 0,
  ssoExchangesTotal: 0,
  ssoExchangesRejected: 0,
  webhooksVerifiedTotal: 0,
  webhooksRejectedTotal: 0,
  fraudEventsBlockedTotal: 0,
  recentLatenciesMs: [],
};

export function recordAdDeliveryMetric(filled: boolean, latencyMs: number, isLoomaFeed = false): void {
  state.adRequestsTotal += 1;
  if (filled) state.adRequestsFilled += 1;
  if (isLoomaFeed) state.loomaFeedRequestsTotal += 1;
  state.recentLatenciesMs.push(Math.max(0, Math.round(latencyMs * 100) / 100));
  if (state.recentLatenciesMs.length > MAX_LATENCY_SAMPLES) {
    state.recentLatenciesMs.shift();
  }
}

export function recordSsoMetric(accepted: boolean): void {
  state.ssoExchangesTotal += 1;
  if (!accepted) state.ssoExchangesRejected += 1;
}

export function recordWebhookMetric(verified: boolean): void {
  if (verified) state.webhooksVerifiedTotal += 1;
  else state.webhooksRejectedTotal += 1;
}

export function recordFraudBlockedMetric(): void {
  state.fraudEventsBlockedTotal += 1;
}

export function computePercentile(samples: number[], percentile: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function getOperationalMonitoringSnapshot(db: DatabaseSync) {
  const dbCounts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM budget_reservations WHERE status = 'active') AS active_reservations,
         (SELECT COALESCE(SUM(amount_micros), 0) FROM budget_reservations WHERE status = 'active') AS active_reserved_micros,
         (SELECT COUNT(*) FROM budget_reservations WHERE status = 'captured') AS captured_reservations,
         (SELECT COUNT(*) FROM budget_reservations WHERE status IN ('released', 'expired')) AS released_reservations,
         (SELECT COUNT(*) FROM looma_identity_links) AS linked_looma_identities,
         (SELECT COUNT(*) FROM financial_ledger) AS total_ledger_entries,
         (SELECT COUNT(*) FROM fraud_alerts WHERE status IN ('open', 'investigating')) AS open_fraud_alerts`
    )
    .get() as Record<string, number>;

  return {
    service: 'looma-ads',
    status: 'healthy',
    startedAt: state.startedAtIso,
    uptimeSeconds: Math.round(process.uptime()),
    delivery: {
      adRequestsTotal: state.adRequestsTotal,
      adRequestsFilled: state.adRequestsFilled,
      loomaFeedRequestsTotal: state.loomaFeedRequestsTotal,
      runtimeFillRate: state.adRequestsTotal > 0 ? state.adRequestsFilled / state.adRequestsTotal : 1,
      p50LatencyMs: computePercentile(state.recentLatenciesMs, 50),
      p95LatencyMs: computePercentile(state.recentLatenciesMs, 95),
    },
    security: {
      ssoExchangesTotal: state.ssoExchangesTotal,
      ssoExchangesRejected: state.ssoExchangesRejected,
      webhooksVerifiedTotal: state.webhooksVerifiedTotal,
      webhooksRejectedTotal: state.webhooksRejectedTotal,
      fraudEventsBlockedTotal: state.fraudEventsBlockedTotal,
    },
    ledgerAndReservations: dbCounts,
  };
}
