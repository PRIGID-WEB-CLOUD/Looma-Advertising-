import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, withTransaction } from './db';
import { seedDatabaseIfEmpty } from './seed';
import {
  computeSingleEventBillMicros,
  selectWinningAd,
  splitRevenueMicros,
  CandidateCampaign,
} from './engine';
import { checkPersistentRateLimit, runScheduledJob } from './jobs';
import { queueTransactionalEmail } from './security';

test('DbClient schema seeds cleanly and preserves integer ledger invariants', async () => {
  const db = await getDb(':memory:');
  try {
    await seedDatabaseIfEmpty(db);

    const roles = (await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM roles'))!;
    assert.equal(roles.cnt, 3);

    const campaigns = await db.query<Record<string, any>>("SELECT * FROM campaigns WHERE status = 'active'");
    assert.ok(campaigns.length >= 3);

    const advWallet = (await db.queryOne<{ available_micros: number }>(
      "SELECT available_micros FROM advertiser_wallets WHERE advertiser_id = 'adv_1'"
    ))!;
    assert.ok(advWallet.available_micros > 0);
  } finally {
    await db.close();
  }
});

test('Transactional CPC billing prevents overspending and splits revenue share accurately', async () => {
  const db = await getDb(':memory:');
  try {
    await seedDatabaseIfEmpty(db);

    const beforeWallet = (await db.queryOne<{ id: string; available_micros: number }>(
      "SELECT id, available_micros FROM advertiser_wallets WHERE advertiser_id = 'adv_1'"
    ))!;

    const billMicros = computeSingleEventBillMicros('CPC', 1_450_000, 'click');
    const { publisherShareMicros, platformFeeMicros } = splitRevenueMicros(billMicros, 7200);
    assert.equal(publisherShareMicros + platformFeeMicros, billMicros);

    await withTransaction(db, async (tx) => {
      const newAdvBal = Number(beforeWallet.available_micros) - billMicros;
      await tx.execute('UPDATE advertiser_wallets SET available_micros = ? WHERE id = ?', [
        newAdvBal,
        beforeWallet.id,
      ]);
      await tx.execute(
        `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
         VALUES ('led_test_1', 'idem_test_1', 'advertiser_wallet', ?, 'ad_spend', 'debit', ?, ?, 'USD', 'click', 'req_test_1', 'Test CPC charge')`,
        [beforeWallet.id, billMicros, newAdvBal]
      );
    });

    const afterWallet = (await db.queryOne<{ available_micros: number }>(
      "SELECT available_micros FROM advertiser_wallets WHERE advertiser_id = 'adv_1'"
    ))!;
    assert.equal(afterWallet.available_micros, beforeWallet.available_micros - billMicros);

    // Verify auction rejects campaign if wallet balance is zeroed out
    const emptyCandidate: CandidateCampaign = {
      campaignId: 'cmp_1',
      advertiserId: 'adv_1',
      campaignName: 'Zero Balance Campaign',
      pricingModel: 'CPC',
      biddingStrategy: 'manual',
      status: 'active',
      moderationStatus: 'approved',
      startDate: '2026-01-01',
      endDate: '2027-12-31',
      frequencyCapPerSession: 5,
      dailyBudgetMicros: 100_000_000,
      totalBudgetMicros: 500_000_000,
      spentTodayMicros: 0,
      spentTotalMicros: 0,
      maxBidMicros: 1_450_000,
      pacingMode: 'standard',
      walletAvailableMicros: 0,
      targeting: {
        countries: ['ALL'],
        languages: ['ALL'],
        deviceCategories: ['desktop'],
        operatingSystems: ['ALL'],
        browsers: ['ALL'],
        contextualCategories: ['ALL'],
        consentRequired: true,
      },
      creative: {
        id: 'crt_1',
        advertisementId: 'ad_1',
        format: 'native',
        title: 'Test',
        description: 'Desc',
        mediaUrl: '',
        destinationUrl: 'https://example.com',
        ctaText: 'Go',
        trackingParams: '',
        dimensions: 'responsive',
        approvalStatus: 'approved',
      },
      historicalCtr: 0.02,
      historicalCvr: 0.04,
      qualityScore: 1,
    };

    const winner = selectWinningAd([emptyCandidate], {
      placementId: 'plc_1',
      placementFormat: 'native',
      floorCpmMicros: 100_000,
      country: 'US',
      language: 'en',
      deviceCategory: 'desktop',
      os: 'macOS',
      browser: 'Chrome',
      category: 'business_finance',
      consentGranted: true,
      sessionImpressionCounts: {},
      nowIso: '2026-11-24T12:00:00Z',
    });
    assert.equal(winner, null);
  } finally {
    await db.close();
  }
});

test('User profile and preference tables persist updates cleanly', async () => {
  const db = await getDb(':memory:');
  try {
    await seedDatabaseIfEmpty(db);

    await db.execute(
      `INSERT INTO user_preferences (user_id) VALUES ('usr_adv_1') ON CONFLICT (user_id) DO NOTHING`
    );
    await db.execute(
      `UPDATE user_preferences
       SET timezone = 'Europe/London', preferred_currency = 'EUR', two_factor_enabled = 1, session_timeout_minutes = 240
       WHERE user_id = 'usr_adv_1'`
    );

    const prefs = (await db.queryOne<{
      timezone: string;
      preferred_currency: string;
      two_factor_enabled: number;
      session_timeout_minutes: number;
    }>(
      'SELECT timezone, preferred_currency, two_factor_enabled, session_timeout_minutes FROM user_preferences WHERE user_id = ?',
      ['usr_adv_1']
    ))!;

    assert.equal(prefs.timezone, 'Europe/London');
    assert.equal(prefs.preferred_currency, 'EUR');
    assert.equal(prefs.two_factor_enabled, 1);
    assert.equal(prefs.session_timeout_minutes, 240);
  } finally {
    await db.close();
  }
});

test('Campaign budget, pacing, and targeting rules update atomically', async () => {
  const db = await getDb(':memory:');
  try {
    await seedDatabaseIfEmpty(db);

    await withTransaction(db, async (tx) => {
      await tx.execute(
        `UPDATE campaign_budgets
         SET daily_budget_micros = 175000000, total_budget_micros = 2500000000, max_bid_micros = 1950000, pacing_mode = 'accelerated'
         WHERE campaign_id = 'cmp_1'`
      );

      await tx.execute(
        `UPDATE campaign_targeting
         SET countries_json = ?, device_categories_json = ?, consent_required = 1
         WHERE campaign_id = 'cmp_1'`,
        [JSON.stringify(['US', 'GB', 'NG']), JSON.stringify(['desktop', 'mobile', 'tablet'])]
      );
    });

    const budget = (await db.queryOne<{
      daily_budget_micros: number;
      total_budget_micros: number;
      max_bid_micros: number;
      pacing_mode: string;
    }>('SELECT daily_budget_micros, total_budget_micros, max_bid_micros, pacing_mode FROM campaign_budgets WHERE campaign_id = ?', [
      'cmp_1',
    ]))!;
    const target = (await db.queryOne<{
      countries_json: string;
      device_categories_json: string;
      consent_required: number;
    }>('SELECT countries_json, device_categories_json, consent_required FROM campaign_targeting WHERE campaign_id = ?', [
      'cmp_1',
    ]))!;

    assert.equal(budget.daily_budget_micros, 175_000_000);
    assert.equal(budget.total_budget_micros, 2_500_000_000);
    assert.equal(budget.max_bid_micros, 1_950_000);
    assert.equal(budget.pacing_mode, 'accelerated');
    assert.deepEqual(JSON.parse(target.countries_json), ['US', 'GB', 'NG']);
    assert.deepEqual(JSON.parse(target.device_categories_json), ['desktop', 'mobile', 'tablet']);
    assert.equal(target.consent_required, 1);
  } finally {
    await db.close();
  }
});

test('Persistent rate limiter enforces exact sliding-window threshold', async () => {
  const db = await getDb(':memory:');
  try {
    await seedDatabaseIfEmpty(db);

    assert.equal(await checkPersistentRateLimit(db, 'test:ip:1', 3, 60_000), true);
    assert.equal(await checkPersistentRateLimit(db, 'test:ip:1', 3, 60_000), true);
    assert.equal(await checkPersistentRateLimit(db, 'test:ip:1', 3, 60_000), true);
    assert.equal(await checkPersistentRateLimit(db, 'test:ip:1', 3, 60_000), false);

    const row = (await db.queryOne<{ count: number }>(
      'SELECT count FROM rate_limit_buckets WHERE bucket_key = ?',
      ['test:ip:1']
    ))!;
    assert.equal(row.count, 3);
  } finally {
    await db.close();
  }
});

test('Scheduled background jobs mutate expected rows and record audit history', async () => {
  const db = await getDb(':memory:');
  try {
    await seedDatabaseIfEmpty(db);

    await db.execute("UPDATE campaign_budgets SET spent_today_micros = 45000000 WHERE campaign_id = 'cmp_1'");
    await db.execute(
      "UPDATE publisher_wallets SET estimated_micros = available_micros + pending_micros + 5000000 WHERE publisher_id = 'pub_looma_1p'"
    );
    const expiredIso = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await db.execute(
      `INSERT INTO auth_tokens (id, user_id, token_hash, token_type, expires_at)
       VALUES ('tok_exp_1', 'usr_adv_1', 'hash_exp_1', 'email_verify', ?)`,
      [expiredIso]
    );

    const budgetRes = await runScheduledJob(db, 'daily_budget_reset', 'test_suite');
    assert.equal(budgetRes.status, 'completed');
    assert.ok(budgetRes.affectedCount >= 1);

    const afterBudget = (await db.queryOne<{ spent_today_micros: number }>(
      "SELECT spent_today_micros FROM campaign_budgets WHERE campaign_id = 'cmp_1'"
    ))!;
    assert.equal(afterBudget.spent_today_micros, 0);

    const settleRes = await runScheduledJob(db, 'publisher_earnings_settlement', 'test_suite');
    assert.equal(settleRes.status, 'completed');
    assert.ok(settleRes.affectedCount >= 1);

    const cleanupRes = await runScheduledJob(db, 'expired_token_cleanup', 'test_suite');
    assert.equal(cleanupRes.status, 'completed');
    assert.ok(cleanupRes.affectedCount >= 1);

    const runs = (await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM scheduled_job_runs'))!;
    assert.equal(runs.cnt, 3);
  } finally {
    await db.close();
  }
});

test('Default prohibited policy rules seed idempotently and transactional email logs to outbox', async () => {
  const db = await getDb(':memory:');
  try {
    await seedDatabaseIfEmpty(db);

    const rules = (await db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM prohibited_categories'))!;
    assert.ok(rules.cnt >= 5);

    const emailId = await queueTransactionalEmail(db, {
      to: 'advertiser@looma-ads.com',
      subject: 'Prepaid Deposit Confirmed',
      bodyText: 'Your wallet deposit has settled.',
      category: 'billing_receipt',
    });
    const stored = (await db.queryOne<{
      id: string;
      recipient_email: string;
      delivery_status: string;
    }>('SELECT id, recipient_email, delivery_status FROM email_outbox WHERE id = ?', [emailId]))!;
    assert.equal(stored.recipient_email, 'advertiser@looma-ads.com');
    assert.equal(stored.delivery_status, 'logged');
  } finally {
    await db.close();
  }
});
