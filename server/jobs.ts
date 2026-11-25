import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from './db';
import { releaseExpiredReservationsInTx } from './modules/budgetReservations';

/**
 * Persistent SQLite-backed sliding-window rate limiter so request limits survive
 * process restarts and stay consistent without volatile in-memory Maps.
 */
export function checkPersistentRateLimit(
  db: DatabaseSync,
  key: string,
  maxRequests = 180,
  windowMs = 60_000
): boolean {
  const now = Date.now();
  return withTransaction(db, () => {
    const existing = db
      .prepare('SELECT count, reset_at_ms FROM rate_limit_buckets WHERE bucket_key = ?')
      .get(key) as { count: number; reset_at_ms: number } | undefined;

    if (!existing || now >= existing.reset_at_ms) {
      db.prepare(
        `INSERT INTO rate_limit_buckets (bucket_key, count, reset_at_ms)
         VALUES (?, 1, ?)
         ON CONFLICT(bucket_key) DO UPDATE SET count = 1, reset_at_ms = excluded.reset_at_ms`
      ).run(key, now + windowMs);
      return true;
    }

    if (existing.count >= maxRequests) {
      return false;
    }

    db.prepare('UPDATE rate_limit_buckets SET count = count + 1 WHERE bucket_key = ?').run(key);
    return true;
  });
}

export type ScheduledJobName =
  | 'daily_budget_reset'
  | 'publisher_earnings_settlement'
  | 'expired_token_cleanup'
  | 'release_expired_reservations';

export interface JobRunResult {
  runId: string;
  jobName: ScheduledJobName;
  status: 'completed' | 'failed';
  summary: string;
  affectedCount: number;
}

export function runScheduledJob(
  db: DatabaseSync,
  jobName: ScheduledJobName,
  triggeredBy = 'scheduler'
): JobRunResult {
  const runId = `job_${crypto.randomUUID().slice(0, 10)}`;
  let summary = '';
  let affectedCount = 0;

  try {
    withTransaction(db, () => {
      if (jobName === 'daily_budget_reset') {
        const res = db
          .prepare("UPDATE campaign_budgets SET spent_today_micros = 0, updated_at = datetime('now') WHERE spent_today_micros > 0")
          .run();
        affectedCount = Number(res.changes || 0);
        summary = `Reset daily spend counters for ${affectedCount} active campaign budget(s).`;
      } else if (jobName === 'publisher_earnings_settlement') {
        // Move unadjusted estimated_micros delta into finalized available_micros after IVT checks
        const wallets = db
          .prepare('SELECT id, publisher_id, estimated_micros, available_micros, pending_micros FROM publisher_wallets WHERE estimated_micros > 0')
          .all() as Array<{
          id: string;
          publisher_id: string;
          estimated_micros: number;
          available_micros: number;
          pending_micros: number;
        }>;

        for (const w of wallets) {
          // Only settle positive pending/unfinalized delta if estimated exceeds already-settled available + pending
          const unsettled = Math.max(0, w.estimated_micros - (w.available_micros + w.pending_micros));
          if (unsettled > 0) {
            const newAvailable = w.available_micros + unsettled;
            db.prepare(
              `UPDATE publisher_wallets
               SET available_micros = ?, lifetime_earned_micros = lifetime_earned_micros + ?, updated_at = datetime('now')
               WHERE id = ?`
            ).run(newAvailable, unsettled, w.id);

            db.prepare(
              `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
               VALUES (?, ?, 'publisher_wallet', ?, 'publisher_earning', 'credit', ?, ?, 'USD', 'settlement', ?, ?)`
            ).run(
              `led_${crypto.randomUUID().slice(0, 12)}`,
              `settle_${runId}_${w.id}`,
              w.id,
              unsettled,
              newAvailable,
              runId,
              'Scheduled earnings finalization settlement'
            );
            affectedCount += 1;
          }
        }
        summary = `Finalized publisher earnings for ${affectedCount} wallet(s).`;
      } else if (jobName === 'expired_token_cleanup') {
        const tokRes = db
          .prepare("DELETE FROM auth_tokens WHERE expires_at < datetime('now') OR consumed_at IS NOT NULL")
          .run();
        const rlRes = db
          .prepare('DELETE FROM rate_limit_buckets WHERE reset_at_ms < ?')
          .run(Date.now());
        const ssoRes = db
          .prepare("DELETE FROM looma_sso_nonces WHERE expires_at < datetime('now')")
          .run();
        affectedCount = Number(tokRes.changes || 0) + Number(rlRes.changes || 0) + Number(ssoRes.changes || 0);
        summary = `Purged ${affectedCount} expired auth tokens, SSO nonces, and stale rate-limit buckets.`;
      } else if (jobName === 'release_expired_reservations') {
        const rel = releaseExpiredReservationsInTx(db);
        affectedCount = rel.releasedCount;
        const dollars = (rel.totalReleasedMicros / 1_000_000).toFixed(2);
        summary = `Released ${rel.releasedCount} expired budget reservation(s) totaling $${dollars} back to advertiser prepaid wallets.`;
      }

      db.prepare(
        `INSERT INTO scheduled_job_runs (id, job_name, status, summary, affected_count, triggered_by)
         VALUES (?, ?, 'completed', ?, ?, ?)`
      ).run(runId, jobName, summary, affectedCount, triggeredBy);
    });

    return { runId, jobName, status: 'completed', summary, affectedCount };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Job execution error';
    db.prepare(
      `INSERT INTO scheduled_job_runs (id, job_name, status, summary, affected_count, triggered_by)
       VALUES (?, ?, 'failed', ?, 0, ?)`
    ).run(runId, jobName, errMsg, triggeredBy);
    return { runId, jobName, status: 'failed', summary: errMsg, affectedCount: 0 };
  }
}

export function startBackgroundScheduler(db: DatabaseSync): void {
  // Periodic token, rate-limit, and expired reservation maintenance every 5 minutes
  const cleanupTimer = setInterval(() => {
    try {
      runScheduledJob(db, 'release_expired_reservations', 'scheduler');
      runScheduledJob(db, 'expired_token_cleanup', 'scheduler');
    } catch (err) {
      console.error('Background maintenance job failed:', err);
    }
  }, 5 * 60 * 1000);
  cleanupTimer.unref();

  // Check every hour whether UTC midnight rollover occurred for daily budget reset
  let lastResetDate = new Date().toISOString().slice(0, 10);
  const dailyTimer = setInterval(() => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastResetDate) {
      lastResetDate = today;
      try {
        runScheduledJob(db, 'daily_budget_reset', 'scheduler');
        runScheduledJob(db, 'publisher_earnings_settlement', 'scheduler');
      } catch (err) {
        console.error('Background daily job failed:', err);
      }
    }
  }, 60 * 60 * 1000);
  dailyTimer.unref();
}
