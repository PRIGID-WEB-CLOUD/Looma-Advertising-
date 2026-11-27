import crypto from 'node:crypto';
import { type DbClient, withTransaction } from './db/postgres';
import { releaseExpiredReservationsInTx } from './modules/budgetReservations';

/**
 * Persistent DB-backed sliding-window rate limiter so request limits survive
 * process restarts and stay consistent across instances.
 */
export async function checkPersistentRateLimit(
  db: DbClient,
  key: string,
  maxRequests = 180,
  windowMs = 60_000
): Promise<boolean> {
  const now = Date.now();
  return withTransaction(db, async (tx) => {
    const existing = await tx.queryOne<{ count: number; reset_at_ms: number }>(
      'SELECT count, reset_at_ms FROM rate_limit_buckets WHERE bucket_key = ?',
      [key]
    );

    if (!existing || now >= Number(existing.reset_at_ms)) {
      await tx.execute(
        `INSERT INTO rate_limit_buckets (bucket_key, count, reset_at_ms)
         VALUES (?, 1, ?)
         ON CONFLICT(bucket_key) DO UPDATE SET count = 1, reset_at_ms = excluded.reset_at_ms`,
        [key, now + windowMs]
      );
      return true;
    }

    if (Number(existing.count) >= maxRequests) {
      return false;
    }

    await tx.execute('UPDATE rate_limit_buckets SET count = count + 1 WHERE bucket_key = ?', [key]);
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

export async function runScheduledJob(
  db: DbClient,
  jobName: ScheduledJobName,
  triggeredBy = 'scheduler'
): Promise<JobRunResult> {
  const runId = `job_${crypto.randomUUID().slice(0, 10)}`;
  let summary = '';
  let affectedCount = 0;

  try {
    await withTransaction(db, async (tx) => {
      const nowIso = new Date().toISOString();

      if (jobName === 'daily_budget_reset') {
        const res = await tx.execute(
          'UPDATE campaign_budgets SET spent_today_micros = 0, updated_at = ? WHERE spent_today_micros > 0',
          [nowIso]
        );
        affectedCount = res.rowCount;
        summary = `Reset daily spend counters for ${affectedCount} active campaign budget(s).`;
      } else if (jobName === 'publisher_earnings_settlement') {
        const wallets = await tx.query<{
          id: string;
          publisher_id: string;
          estimated_micros: number;
          available_micros: number;
          pending_micros: number;
        }>(
          'SELECT id, publisher_id, estimated_micros, available_micros, pending_micros FROM publisher_wallets WHERE estimated_micros > 0'
        );

        for (const w of wallets) {
          const unsettled = Math.max(0, Number(w.estimated_micros) - (Number(w.available_micros) + Number(w.pending_micros)));
          if (unsettled > 0) {
            await tx.execute(
              `UPDATE publisher_wallets
               SET available_micros = available_micros + ?, lifetime_earned_micros = lifetime_earned_micros + ?, updated_at = ?
               WHERE id = ?`,
              [unsettled, unsettled, nowIso, w.id]
            );

            const updatedWallet = (await tx.queryOne<{ available_micros: number }>(
              'SELECT available_micros FROM publisher_wallets WHERE id = ?',
              [w.id]
            ))!;
            const newAvailable = Number(updatedWallet.available_micros);

            await tx.execute(
              `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
               VALUES (?, ?, 'publisher_wallet', ?, 'publisher_earning', 'credit', ?, ?, 'USD', 'settlement', ?, ?)`,
              [
                `led_${crypto.randomUUID().slice(0, 12)}`,
                `settle_${runId}_${w.id}`,
                w.id,
                unsettled,
                newAvailable,
                runId,
                'Scheduled earnings finalization settlement',
              ]
            );
            affectedCount += 1;
          }
        }
        summary = `Finalized publisher earnings for ${affectedCount} wallet(s).`;
      } else if (jobName === 'expired_token_cleanup') {
        const tokRes = await tx.execute(
          'DELETE FROM auth_tokens WHERE expires_at < ? OR consumed_at IS NOT NULL',
          [nowIso]
        );
        const revRes = await tx.execute(
          'DELETE FROM revoked_tokens WHERE expires_at < ?',
          [nowIso]
        );
        const rlRes = await tx.execute(
          'DELETE FROM rate_limit_buckets WHERE reset_at_ms < ?',
          [Date.now()]
        );
        const ssoRes = await tx.execute(
          'DELETE FROM looma_sso_nonces WHERE expires_at < ?',
          [nowIso]
        );
        affectedCount = tokRes.rowCount + revRes.rowCount + rlRes.rowCount + ssoRes.rowCount;
        summary = `Purged ${affectedCount} expired auth/revoked tokens, SSO nonces, and stale rate-limit buckets.`;
      } else if (jobName === 'release_expired_reservations') {
        const rel = await releaseExpiredReservationsInTx(tx);
        affectedCount = rel.releasedCount;
        const dollars = (rel.totalReleasedMicros / 1_000_000).toFixed(2);
        summary = `Released ${rel.releasedCount} expired budget reservation(s) totaling $${dollars} back to advertiser prepaid wallets.`;
      }

      await tx.execute(
        `INSERT INTO scheduled_job_runs (id, job_name, status, summary, affected_count, triggered_by)
         VALUES (?, ?, 'completed', ?, ?, ?)`,
        [runId, jobName, summary, affectedCount, triggeredBy]
      );
    });

    return { runId, jobName, status: 'completed', summary, affectedCount };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Job execution error';
    await db
      .execute(
        `INSERT INTO scheduled_job_runs (id, job_name, status, summary, affected_count, triggered_by)
         VALUES (?, ?, 'failed', ?, 0, ?)`,
        [runId, jobName, errMsg, triggeredBy]
      )
      .catch(() => {});
    return { runId, jobName, status: 'failed', summary: errMsg, affectedCount: 0 };
  }
}

export function startBackgroundScheduler(db: DbClient): void {
  const cleanupTimer = setInterval(() => {
    void (async () => {
      try {
        await runScheduledJob(db, 'release_expired_reservations', 'scheduler');
        await runScheduledJob(db, 'expired_token_cleanup', 'scheduler');
      } catch (err) {
        console.error('Background maintenance job failed:', err);
      }
    })();
  }, 5 * 60 * 1000);
  cleanupTimer.unref();

  let lastResetDate = new Date().toISOString().slice(0, 10);
  const dailyTimer = setInterval(() => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastResetDate) {
      lastResetDate = today;
      void (async () => {
        try {
          await runScheduledJob(db, 'daily_budget_reset', 'scheduler');
          await runScheduledJob(db, 'publisher_earnings_settlement', 'scheduler');
        } catch (err) {
          console.error('Background daily job failed:', err);
        }
      })();
    }
  }, 60 * 60 * 1000);
  dailyTimer.unref();
}
