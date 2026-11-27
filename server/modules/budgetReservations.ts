import crypto from 'node:crypto';
import { type DbClient, withTransaction } from '../db/postgres';

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
export async function reserveBudgetForRequest(
  db: DbClient,
  params: {
    advertiserId: string;
    campaignId: string;
    requestId: string;
    amountMicros: number;
    ttlMinutes?: number;
  }
): Promise<ReserveBudgetResult> {
  const amount = Math.max(0, Math.round(params.amountMicros));
  if (amount <= 0) {
    return { reserved: false, reservedMicros: 0, reason: 'zero_reserve_amount' };
  }
  const ttlMinutes = Math.max(1, Math.min(120, Math.round(params.ttlMinutes ?? 30)));

  return withTransaction(db, async (tx) => {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + ttlMinutes * 60_000).toISOString();

    const existing = await tx.queryOne<{ id: string; amount_micros: number }>(
      'SELECT id, amount_micros FROM budget_reservations WHERE request_id = ?',
      [params.requestId]
    );
    if (existing) {
      return {
        reserved: true,
        reservationId: existing.id,
        reservedMicros: Number(existing.amount_micros),
      };
    }

    const wallet = await tx.queryOne<{ id: string; available_micros: number; reserved_micros: number }>(
      'SELECT id, available_micros, reserved_micros FROM advertiser_wallets WHERE advertiser_id = ?',
      [params.advertiserId]
    );

    if (!wallet || Number(wallet.available_micros) < amount) {
      return {
        reserved: false,
        reservedMicros: 0,
        availableAfterMicros: Number(wallet?.available_micros ?? 0),
        reason: 'insufficient_prepaid_balance',
      };
    }

    const budget = await tx.queryOne<{
      daily_budget_micros: number;
      total_budget_micros: number;
      spent_today_micros: number;
      spent_total_micros: number;
    }>(
      `SELECT daily_budget_micros, total_budget_micros, spent_today_micros, spent_total_micros
       FROM campaign_budgets WHERE campaign_id = ?`,
      [params.campaignId]
    );

    if (!budget) {
      return { reserved: false, reservedMicros: 0, reason: 'campaign_budget_missing' };
    }

    const activeReservedRow = await tx.queryOne<{ active_reserved: number }>(
      `SELECT COALESCE(SUM(amount_micros), 0) AS active_reserved
       FROM budget_reservations
       WHERE campaign_id = ? AND status = 'active' AND expires_at >= ?`,
      [params.campaignId, nowIso]
    );

    const activeReserved = Number(activeReservedRow?.active_reserved ?? 0);
    if (
      Number(budget.spent_today_micros) + activeReserved + amount > Number(budget.daily_budget_micros) ||
      Number(budget.spent_total_micros) + activeReserved + amount > Number(budget.total_budget_micros)
    ) {
      return {
        reserved: false,
        reservedMicros: 0,
        availableAfterMicros: Number(wallet.available_micros),
        reason: 'campaign_budget_headroom_exhausted',
      };
    }

    const reservationId = `rsv_${crypto.randomUUID().slice(0, 12)}`;

    const walletUpdate = await tx.execute(
      `UPDATE advertiser_wallets
       SET available_micros = available_micros - ?, reserved_micros = reserved_micros + ?, updated_at = ?
       WHERE id = ? AND available_micros >= ?`,
      [amount, amount, nowIso, wallet.id, amount]
    );
    if (walletUpdate.rowCount === 0) {
      const currentWallet = await tx.queryOne<{ available_micros: number }>(
        'SELECT available_micros FROM advertiser_wallets WHERE id = ?',
        [wallet.id]
      );
      return {
        reserved: false,
        reservedMicros: 0,
        availableAfterMicros: Number(currentWallet?.available_micros ?? 0),
        reason: 'insufficient_prepaid_balance',
      };
    }

    const updatedWallet = await tx.queryOne<{ available_micros: number }>(
      'SELECT available_micros FROM advertiser_wallets WHERE id = ?',
      [wallet.id]
    );
    const nextAvailable = Number(updatedWallet?.available_micros ?? 0);

    await tx.execute(
      `INSERT INTO budget_reservations
         (id, advertiser_id, wallet_id, campaign_id, request_id, amount_micros, captured_micros, released_micros, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'active', ?)`,
      [reservationId, params.advertiserId, wallet.id, params.campaignId, params.requestId, amount, expiresIso]
    );

    await tx.execute(
      `INSERT INTO financial_ledger
         (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
       VALUES (?, ?, 'advertiser_wallet', ?, 'budget_reserve', 'debit', ?, ?, 'USD', 'reservation', ?, ?)`,
      [
        `led_${crypto.randomUUID().slice(0, 12)}`,
        `rsv_hold_${params.requestId}`,
        wallet.id,
        amount,
        nextAvailable,
        reservationId,
        `Prepaid budget reservation for ad request ${params.requestId}`,
      ]
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
 */
export async function captureReservationInTx(
  db: DbClient,
  params: {
    advertiserId: string;
    campaignId: string;
    requestId: string;
    chargeMicros: number;
    eventType: 'impression' | 'click' | 'conversion' | 'video_view' | 'app_install';
    ledgerIdempotencyKey: string;
    description: string;
  }
): Promise<CaptureReservationResult | null> {
  const charge = Math.max(0, Math.round(params.chargeMicros));
  if (charge <= 0) return null;
  const nowIso = new Date().toISOString();

  const wallet = await db.queryOne<{ id: string; available_micros: number; reserved_micros: number }>(
    'SELECT id, available_micros, reserved_micros FROM advertiser_wallets WHERE advertiser_id = ?',
    [params.advertiserId]
  );
  if (!wallet) return null;

  const resv = await db.queryOne<{ id: string; amount_micros: number }>(
    `SELECT id, amount_micros
     FROM budget_reservations
     WHERE request_id = ? AND advertiser_id = ? AND status = 'active'`,
    [params.requestId, params.advertiserId]
  );

  if (resv) {
    const resvAmount = Number(resv.amount_micros);
    const fromReserve = Math.min(resvAmount, charge);
    const extraNeeded = Math.max(0, charge - fromReserve);
    const excessToRelease = Math.max(0, resvAmount - charge);

    const claimRes = await db.execute(
      `UPDATE budget_reservations
       SET status = 'captured', captured_micros = ?, released_micros = ?, settled_at = ?
       WHERE id = ? AND status = 'active'`,
      [charge, excessToRelease, nowIso, resv.id]
    );
    if (claimRes.rowCount === 0) {
      return null;
    }

    const budgetRes = await db.execute(
      `UPDATE campaign_budgets
       SET spent_today_micros = spent_today_micros + ?, spent_total_micros = spent_total_micros + ?, updated_at = ?
       WHERE campaign_id = ?
         AND spent_today_micros + ? <= daily_budget_micros
         AND spent_total_micros + ? <= total_budget_micros`,
      [charge, charge, nowIso, params.campaignId, charge, charge]
    );
    if (budgetRes.rowCount === 0) {
      await db.execute(
        `UPDATE budget_reservations
         SET status = 'active', captured_micros = 0, released_micros = 0, settled_at = NULL
         WHERE id = ?`,
        [resv.id]
      );
      return null;
    }

    const walletRes = await db.execute(
      `UPDATE advertiser_wallets
       SET available_micros = available_micros - ? + ?,
           reserved_micros = CASE WHEN reserved_micros >= ? THEN reserved_micros - ? ELSE 0 END,
           lifetime_spent_micros = lifetime_spent_micros + ?,
           updated_at = ?
       WHERE id = ? AND available_micros >= ?`,
      [extraNeeded, excessToRelease, resvAmount, resvAmount, charge, nowIso, wallet.id, extraNeeded]
    );
    if (walletRes.rowCount === 0) {
      await db.execute(
        `UPDATE campaign_budgets
         SET spent_today_micros = CASE WHEN spent_today_micros >= ? THEN spent_today_micros - ? ELSE 0 END,
             spent_total_micros = CASE WHEN spent_total_micros >= ? THEN spent_total_micros - ? ELSE 0 END,
             updated_at = ?
         WHERE campaign_id = ?`,
        [charge, charge, charge, charge, nowIso, params.campaignId]
      );
      await db.execute(
        `UPDATE budget_reservations
         SET status = 'active', captured_micros = 0, released_micros = 0, settled_at = NULL
         WHERE id = ?`,
        [resv.id]
      );
      return null;
    }

    const updatedWallet = await db.queryOne<{ available_micros: number }>(
      'SELECT available_micros FROM advertiser_wallets WHERE id = ?',
      [wallet.id]
    );
    const nextAvailable = Number(updatedWallet?.available_micros ?? 0);

    if (excessToRelease > 0) {
      await db.execute(
        `INSERT INTO financial_ledger
           (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
         VALUES (?, ?, 'advertiser_wallet', ?, 'budget_release', 'credit', ?, ?, 'USD', 'reservation', ?, ?)`,
        [
          `led_${crypto.randomUUID().slice(0, 12)}`,
          `rsv_rel_${resv.id}`,
          wallet.id,
          excessToRelease,
          nextAvailable,
          resv.id,
          `Released unused budget reservation surplus for ${params.requestId}`,
        ]
      );
    }

    await db.execute(
      `INSERT INTO financial_ledger
         (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
       VALUES (?, ?, 'advertiser_wallet', ?, 'ad_spend', 'debit', ?, ?, 'USD', ?, ?, ?)`,
      [
        `led_${crypto.randomUUID().slice(0, 12)}`,
        params.ledgerIdempotencyKey,
        wallet.id,
        charge,
        nextAvailable,
        params.eventType,
        params.requestId,
        params.description,
      ]
    );

    return {
      capturedMicros: charge,
      releasedExcessMicros: excessToRelease,
      usedReservation: true,
      reservationId: resv.id,
      advertiserBalanceAfterMicros: nextAvailable,
    };
  }

  const budgetRes = await db.execute(
    `UPDATE campaign_budgets
     SET spent_today_micros = spent_today_micros + ?, spent_total_micros = spent_total_micros + ?, updated_at = ?
     WHERE campaign_id = ?
       AND spent_today_micros + ? <= daily_budget_micros
       AND spent_total_micros + ? <= total_budget_micros`,
    [charge, charge, nowIso, params.campaignId, charge, charge]
  );
  if (budgetRes.rowCount === 0) {
    return null;
  }

  const walletRes = await db.execute(
    `UPDATE advertiser_wallets
     SET available_micros = available_micros - ?, lifetime_spent_micros = lifetime_spent_micros + ?, updated_at = ?
     WHERE id = ? AND available_micros >= ?`,
    [charge, charge, nowIso, wallet.id, charge]
  );
  if (walletRes.rowCount === 0) {
    await db.execute(
      `UPDATE campaign_budgets
       SET spent_today_micros = CASE WHEN spent_today_micros >= ? THEN spent_today_micros - ? ELSE 0 END,
           spent_total_micros = CASE WHEN spent_total_micros >= ? THEN spent_total_micros - ? ELSE 0 END,
           updated_at = ?
       WHERE campaign_id = ?`,
      [charge, charge, charge, charge, nowIso, params.campaignId]
    );
    return null;
  }

  const updatedWallet = await db.queryOne<{ available_micros: number }>(
    'SELECT available_micros FROM advertiser_wallets WHERE id = ?',
    [wallet.id]
  );
  const nextAvailable = Number(updatedWallet?.available_micros ?? 0);

  await db.execute(
    `INSERT INTO financial_ledger
       (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
     VALUES (?, ?, 'advertiser_wallet', ?, 'ad_spend', 'debit', ?, ?, 'USD', ?, ?, ?)`,
    [
      `led_${crypto.randomUUID().slice(0, 12)}`,
      params.ledgerIdempotencyKey,
      wallet.id,
      charge,
      nextAvailable,
      params.eventType,
      params.requestId,
      params.description,
    ]
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
 * Releases a single active reservation back into the advertiser's available wallet.
 */
export async function releaseReservationInTx(
  db: DbClient,
  requestId: string,
  reason = 'Released unused ad delivery reservation'
): Promise<{ released: boolean; amountMicros: number }> {
  const resv = await db.queryOne<{ id: string; wallet_id: string; amount_micros: number }>(
    `SELECT id, wallet_id, amount_micros
     FROM budget_reservations
     WHERE request_id = ? AND status = 'active'`,
    [requestId]
  );

  if (!resv) return { released: false, amountMicros: 0 };

  const nowIso = new Date().toISOString();
  const resvAmount = Number(resv.amount_micros);

  const claimRes = await db.execute(
    `UPDATE budget_reservations
     SET status = 'released', released_micros = ?, settled_at = ?
     WHERE id = ? AND status = 'active'`,
    [resvAmount, nowIso, resv.id]
  );
  if (claimRes.rowCount === 0) {
    return { released: false, amountMicros: 0 };
  }

  const walletUpdate = await db.execute(
    `UPDATE advertiser_wallets
     SET available_micros = available_micros + ?,
         reserved_micros = CASE WHEN reserved_micros >= ? THEN reserved_micros - ? ELSE 0 END,
         updated_at = ?
     WHERE id = ?`,
    [resvAmount, resvAmount, resvAmount, nowIso, resv.wallet_id]
  );
  if (walletUpdate.rowCount === 0) {
    return { released: false, amountMicros: 0 };
  }

  const updatedWallet = await db.queryOne<{ available_micros: number }>(
    'SELECT available_micros FROM advertiser_wallets WHERE id = ?',
    [resv.wallet_id]
  );
  const nextAvailable = Number(updatedWallet?.available_micros ?? 0);

  await db.execute(
    `INSERT INTO financial_ledger
       (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
     VALUES (?, ?, 'advertiser_wallet', ?, 'budget_release', 'credit', ?, ?, 'USD', 'reservation', ?, ?)`,
    [
      `led_${crypto.randomUUID().slice(0, 12)}`,
      `rsv_rel_${resv.id}`,
      resv.wallet_id,
      resvAmount,
      nextAvailable,
      resv.id,
      reason,
    ]
  );

  return { released: true, amountMicros: resvAmount };
}

/**
 * Releases all expired active reservations back to advertiser available balances.
 */
export async function releaseExpiredReservationsInTx(db: DbClient): Promise<{
  releasedCount: number;
  totalReleasedMicros: number;
}> {
  const nowIso = new Date().toISOString();
  const expiredRows = await db.query<{
    id: string;
    wallet_id: string;
    request_id: string;
    amount_micros: number;
  }>(
    `SELECT id, wallet_id, request_id, amount_micros
     FROM budget_reservations
     WHERE status = 'active' AND expires_at <= ?`,
    [nowIso]
  );

  let releasedCount = 0;
  let totalReleasedMicros = 0;

  for (const row of expiredRows) {
    const rowAmount = Number(row.amount_micros);

    const claimRes = await db.execute(
      `UPDATE budget_reservations
       SET status = 'expired', released_micros = ?, settled_at = ?
       WHERE id = ? AND status = 'active'`,
      [rowAmount, nowIso, row.id]
    );
    if (claimRes.rowCount === 0) continue;

    const walletUpdate = await db.execute(
      `UPDATE advertiser_wallets
       SET available_micros = available_micros + ?,
           reserved_micros = CASE WHEN reserved_micros >= ? THEN reserved_micros - ? ELSE 0 END,
           updated_at = ?
       WHERE id = ?`,
      [rowAmount, rowAmount, rowAmount, nowIso, row.wallet_id]
    );
    if (walletUpdate.rowCount === 0) continue;

    const updatedWallet = await db.queryOne<{ available_micros: number }>(
      'SELECT available_micros FROM advertiser_wallets WHERE id = ?',
      [row.wallet_id]
    );
    const nextAvailable = Number(updatedWallet?.available_micros ?? 0);

    await db.execute(
      `INSERT INTO financial_ledger
         (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
       VALUES (?, ?, 'advertiser_wallet', ?, 'budget_release', 'credit', ?, ?, 'USD', 'reservation_expiry', ?, ?)`,
      [
        `led_${crypto.randomUUID().slice(0, 12)}`,
        `rsv_exp_${row.id}`,
        row.wallet_id,
        rowAmount,
        nextAvailable,
        row.id,
        `Expired budget reservation released for request ${row.request_id}`,
      ]
    );

    releasedCount += 1;
    totalReleasedMicros += rowAmount;
  }

  return { releasedCount, totalReleasedMicros };
}
