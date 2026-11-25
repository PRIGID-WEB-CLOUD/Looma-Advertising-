import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db';

export type ReservationStatus = 'active' | 'captured' | 'released' | 'expired';

export interface BudgetReservationRecord {
  id: string;
  advertiser_id: string;
  wallet_id: string;
  campaign_id: string;
  request_id: string;
  amount_micros: number;
  captured_micros: number;
  released_micros: number;
  status: ReservationStatus;
  expires_at: string;
  settled_at: string | null;
  created_at: string;
}

export interface ReserveBudgetResult {
  reserved: boolean;
  reservationId?: string;
  reservedMicros: number;
  availableAfterMicros?: number;
  reason?: string;
}

export interface CaptureReservationResult {
  capturedMicros: number;
  releasedExcessMicros: number;
  usedReservation: boolean;
  reservationId: string | null;
  advertiserBalanceAfterMicros: number;
}

/**
 * Atomically reserves funds from an advertiser's prepaid available wallet into
 * reserved_micros for a pending ad delivery request, writing an immutable
 * 'budget_reserve' financial ledger entry. Guarantees delivery cannot overspend
 * prepaid funds even under concurrent requests.
 */
export function reserveBudgetForRequest(
  db: DatabaseSync,
  params: {
    advertiserId: string;
    campaignId: string;
    requestId: string;
    amountMicros: number;
    ttlMinutes?: number;
  }
): ReserveBudgetResult {
  const amount = Math.max(0, Math.round(params.amountMicros));
  if (amount <= 0) {
    return { reserved: false, reservedMicros: 0, reason: 'zero_reserve_amount' };
  }
  const ttlMinutes = Math.max(1, Math.min(120, Math.round(params.ttlMinutes ?? 30)));

  return withTransaction(db, () => {
    const existing = db
      .prepare('SELECT id, amount_micros FROM budget_reservations WHERE request_id = ?')
      .get(params.requestId) as { id: string; amount_micros: number } | undefined;
    if (existing) {
      return {
        reserved: true,
        reservationId: existing.id,
        reservedMicros: existing.amount_micros,
      };
    }

    const wallet = db
      .prepare('SELECT id, available_micros, reserved_micros FROM advertiser_wallets WHERE advertiser_id = ?')
      .get(params.advertiserId) as
      | { id: string; available_micros: number; reserved_micros: number }
      | undefined;

    if (!wallet || wallet.available_micros < amount) {
      return {
        reserved: false,
        reservedMicros: 0,
        availableAfterMicros: wallet?.available_micros ?? 0,
        reason: 'insufficient_prepaid_balance',
      };
    }

    const budget = db
      .prepare(
        `SELECT daily_budget_micros, total_budget_micros, spent_today_micros, spent_total_micros
         FROM campaign_budgets WHERE campaign_id = ?`
      )
      .get(params.campaignId) as
      | {
          daily_budget_micros: number;
          total_budget_micros: number;
          spent_today_micros: number;
          spent_total_micros: number;
        }
      | undefined;

    if (!budget) {
      return { reserved: false, reservedMicros: 0, reason: 'campaign_budget_missing' };
    }

    const activeReservedRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount_micros), 0) AS active_reserved
         FROM budget_reservations
         WHERE campaign_id = ? AND status = 'active' AND expires_at >= datetime('now')`
      )
      .get(params.campaignId) as { active_reserved: number };

    const activeReserved = activeReservedRow?.active_reserved ?? 0;
    if (
      budget.spent_today_micros + activeReserved + amount > budget.daily_budget_micros ||
      budget.spent_total_micros + activeReserved + amount > budget.total_budget_micros
    ) {
      return {
        reserved: false,
        reservedMicros: 0,
        availableAfterMicros: wallet.available_micros,
        reason: 'campaign_budget_headroom_exhausted',
      };
    }

    const nextAvailable = wallet.available_micros - amount;
    const nextReserved = wallet.reserved_micros + amount;
    const reservationId = `rsv_${crypto.randomUUID().slice(0, 12)}`;

    db.prepare(
      `UPDATE advertiser_wallets
       SET available_micros = ?, reserved_micros = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(nextAvailable, nextReserved, wallet.id);

    db.prepare(
      `INSERT INTO budget_reservations
         (id, advertiser_id, wallet_id, campaign_id, request_id, amount_micros, captured_micros, released_micros, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'active', datetime('now', ?))`
    ).run(reservationId, params.advertiserId, wallet.id, params.campaignId, params.requestId, amount, `+${ttlMinutes} minutes`);

    db.prepare(
      `INSERT INTO financial_ledger
         (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
       VALUES (?, ?, 'advertiser_wallet', ?, 'budget_reserve', 'debit', ?, ?, 'USD', 'reservation', ?, ?)`
    ).run(
      `led_${crypto.randomUUID().slice(0, 12)}`,
      `rsv_hold_${params.requestId}`,
      wallet.id,
      amount,
      nextAvailable,
      reservationId,
      `Prepaid budget reservation for ad request ${params.requestId}`
    );

    return {
      reserved: true,
      reservationId,
      reservedMicros: amount,
      availableAfterMicros: nextAvailable,
    };
  });
}

/**
 * Captures a billable event charge inside an existing caller transaction.
 * Uses the active budget reservation for the request when present (releasing any
 * excess reserved funds back to available_micros), or falls back safely to direct
 * available wallet debit if the reservation expired or wasn't created.
 */
export function captureReservationInTx(
  db: DatabaseSync,
  params: {
    advertiserId: string;
    campaignId: string;
    requestId: string;
    chargeMicros: number;
    eventType: 'impression' | 'click' | 'conversion' | 'video_view' | 'app_install';
    ledgerIdempotencyKey: string;
    description: string;
  }
): CaptureReservationResult | null {
  const charge = Math.max(0, Math.round(params.chargeMicros));
  if (charge <= 0) return null;

  const wallet = db
    .prepare('SELECT id, available_micros, reserved_micros FROM advertiser_wallets WHERE advertiser_id = ?')
    .get(params.advertiserId) as
    | { id: string; available_micros: number; reserved_micros: number }
    | undefined;
  if (!wallet) return null;

  const budget = db
    .prepare(
      `SELECT daily_budget_micros, total_budget_micros, spent_today_micros, spent_total_micros
       FROM campaign_budgets WHERE campaign_id = ?`
    )
    .get(params.campaignId) as
    | {
        daily_budget_micros: number;
        total_budget_micros: number;
        spent_today_micros: number;
        spent_total_micros: number;
      }
    | undefined;

  if (
    !budget ||
    budget.spent_today_micros + charge > budget.daily_budget_micros ||
    budget.spent_total_micros + charge > budget.total_budget_micros
  ) {
    return null;
  }

  const resv = db
    .prepare(
      `SELECT id, amount_micros
       FROM budget_reservations
       WHERE request_id = ? AND advertiser_id = ? AND status = 'active'`
    )
    .get(params.requestId, params.advertiserId) as { id: string; amount_micros: number } | undefined;

  if (resv) {
    const fromReserve = Math.min(resv.amount_micros, charge);
    const extraNeeded = Math.max(0, charge - fromReserve);
    const excessToRelease = Math.max(0, resv.amount_micros - charge);

    if (wallet.available_micros < extraNeeded) {
      return null;
    }

    const nextReserved = Math.max(0, wallet.reserved_micros - resv.amount_micros);
    const nextAvailable = wallet.available_micros - extraNeeded + excessToRelease;

    db.prepare(
      `UPDATE advertiser_wallets
       SET available_micros = ?, reserved_micros = ?, lifetime_spent_micros = lifetime_spent_micros + ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(nextAvailable, nextReserved, charge, wallet.id);

    db.prepare(
      `UPDATE campaign_budgets
       SET spent_today_micros = spent_today_micros + ?, spent_total_micros = spent_total_micros + ?, updated_at = datetime('now')
       WHERE campaign_id = ?`
    ).run(charge, charge, params.campaignId);

    db.prepare(
      `UPDATE budget_reservations
       SET status = 'captured', captured_micros = ?, released_micros = ?, settled_at = datetime('now')
       WHERE id = ?`
    ).run(charge, excessToRelease, resv.id);

    if (excessToRelease > 0) {
      db.prepare(
        `INSERT INTO financial_ledger
           (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
         VALUES (?, ?, 'advertiser_wallet', ?, 'budget_release', 'credit', ?, ?, 'USD', 'reservation', ?, ?)`
      ).run(
        `led_${crypto.randomUUID().slice(0, 12)}`,
        `rsv_rel_${resv.id}`,
        wallet.id,
        excessToRelease,
        nextAvailable,
        resv.id,
        `Released unused budget reservation surplus for ${params.requestId}`
      );
    }

    db.prepare(
      `INSERT INTO financial_ledger
         (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
       VALUES (?, ?, 'advertiser_wallet', ?, 'ad_spend', 'debit', ?, ?, 'USD', ?, ?, ?)`
    ).run(
      `led_${crypto.randomUUID().slice(0, 12)}`,
      params.ledgerIdempotencyKey,
      wallet.id,
      charge,
      nextAvailable,
      params.eventType,
      params.requestId,
      params.description
    );

    return {
      capturedMicros: charge,
      releasedExcessMicros: excessToRelease,
      usedReservation: true,
      reservationId: resv.id,
      advertiserBalanceAfterMicros: nextAvailable,
    };
  }

  // Fallback path when no active reservation exists (e.g. direct conversion within 7-day window after expiry)
  if (wallet.available_micros < charge) {
    return null;
  }

  const nextAvailable = wallet.available_micros - charge;
  db.prepare(
    `UPDATE advertiser_wallets
     SET available_micros = ?, lifetime_spent_micros = lifetime_spent_micros + ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(nextAvailable, charge, wallet.id);

  db.prepare(
    `UPDATE campaign_budgets
     SET spent_today_micros = spent_today_micros + ?, spent_total_micros = spent_total_micros + ?, updated_at = datetime('now')
     WHERE campaign_id = ?`
  ).run(charge, charge, params.campaignId);

  db.prepare(
    `INSERT INTO financial_ledger
       (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
     VALUES (?, ?, 'advertiser_wallet', ?, 'ad_spend', 'debit', ?, ?, 'USD', ?, ?, ?)`
  ).run(
    `led_${crypto.randomUUID().slice(0, 12)}`,
    params.ledgerIdempotencyKey,
    wallet.id,
    charge,
    nextAvailable,
    params.eventType,
    params.requestId,
    params.description
  );

  return {
    capturedMicros: charge,
    releasedExcessMicros: 0,
    usedReservation: false,
    reservationId: null,
    advertiserBalanceAfterMicros: nextAvailable,
  };
}

/**
 * Releases a single active reservation back into the advertiser's available wallet
 * (for example, when a click is rejected as invalid bot traffic or manually cancelled).
 */
export function releaseReservationInTx(
  db: DatabaseSync,
  requestId: string,
  reason = 'Released unused ad delivery reservation'
): { released: boolean; amountMicros: number } {
  const resv = db
    .prepare(
      `SELECT id, wallet_id, amount_micros
       FROM budget_reservations
       WHERE request_id = ? AND status = 'active'`
    )
    .get(requestId) as { id: string; wallet_id: string; amount_micros: number } | undefined;

  if (!resv) return { released: false, amountMicros: 0 };

  const wallet = db
    .prepare('SELECT id, available_micros, reserved_micros FROM advertiser_wallets WHERE id = ?')
    .get(resv.wallet_id) as { id: string; available_micros: number; reserved_micros: number } | undefined;

  if (!wallet) return { released: false, amountMicros: 0 };

  const nextAvailable = wallet.available_micros + resv.amount_micros;
  const nextReserved = Math.max(0, wallet.reserved_micros - resv.amount_micros);

  db.prepare(
    `UPDATE advertiser_wallets
     SET available_micros = ?, reserved_micros = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(nextAvailable, nextReserved, wallet.id);

  db.prepare(
    `UPDATE budget_reservations
     SET status = 'released', released_micros = ?, settled_at = datetime('now')
     WHERE id = ?`
  ).run(resv.amount_micros, resv.id);

  db.prepare(
    `INSERT INTO financial_ledger
       (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
     VALUES (?, ?, 'advertiser_wallet', ?, 'budget_release', 'credit', ?, ?, 'USD', 'reservation', ?, ?)`
  ).run(
    `led_${crypto.randomUUID().slice(0, 12)}`,
    `rsv_rel_${resv.id}`,
    wallet.id,
    resv.amount_micros,
    nextAvailable,
    resv.id,
    reason
  );

  return { released: true, amountMicros: resv.amount_micros };
}

/**
 * Releases all expired active reservations back to advertiser available balances.
 * Invoked by the scheduled maintenance job and admin operations.
 */
export function releaseExpiredReservationsInTx(db: DatabaseSync): {
  releasedCount: number;
  totalReleasedMicros: number;
} {
  const expiredRows = db
    .prepare(
      `SELECT id, wallet_id, request_id, amount_micros
       FROM budget_reservations
       WHERE status = 'active' AND expires_at <= datetime('now')`
    )
    .all() as Array<{ id: string; wallet_id: string; request_id: string; amount_micros: number }>;

  let releasedCount = 0;
  let totalReleasedMicros = 0;

  for (const row of expiredRows) {
    const wallet = db
      .prepare('SELECT id, available_micros, reserved_micros FROM advertiser_wallets WHERE id = ?')
      .get(row.wallet_id) as { id: string; available_micros: number; reserved_micros: number } | undefined;
    if (!wallet) continue;

    const nextAvailable = wallet.available_micros + row.amount_micros;
    const nextReserved = Math.max(0, wallet.reserved_micros - row.amount_micros);

    db.prepare(
      `UPDATE advertiser_wallets
       SET available_micros = ?, reserved_micros = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(nextAvailable, nextReserved, wallet.id);

    db.prepare(
      `UPDATE budget_reservations
       SET status = 'expired', released_micros = ?, settled_at = datetime('now')
       WHERE id = ?`
    ).run(row.amount_micros, row.id);

    db.prepare(
      `INSERT INTO financial_ledger
         (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
       VALUES (?, ?, 'advertiser_wallet', ?, 'budget_release', 'credit', ?, ?, 'USD', 'reservation_expiry', ?, ?)`
    ).run(
      `led_${crypto.randomUUID().slice(0, 12)}`,
      `rsv_exp_${row.id}`,
      wallet.id,
      row.amount_micros,
      nextAvailable,
      row.id,
      `Expired budget reservation released for request ${row.request_id}`
    );

    releasedCount += 1;
    totalReleasedMicros += row.amount_micros;
  }

  return { releasedCount, totalReleasedMicros };
}
