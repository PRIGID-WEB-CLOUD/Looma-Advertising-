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

test('SQLite schema seeds cleanly and preserves integer ledger invariants', () => {
  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);

  const roles = db.prepare('SELECT COUNT(*) AS cnt FROM roles').get() as { cnt: number };
  assert.equal(roles.cnt, 3);

  const campaigns = db.prepare("SELECT * FROM campaigns WHERE status = 'active'").all() as Array<Record<string, any>>;
  assert.ok(campaigns.length >= 3);

  const advWallet = db
    .prepare("SELECT available_micros FROM advertiser_wallets WHERE advertiser_id = 'adv_1'")
    .get() as { available_micros: number };
  assert.ok(advWallet.available_micros > 0);
});

test('Transactional CPC billing prevents overspending and splits revenue share accurately', () => {
  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);

  const beforeWallet = db
    .prepare("SELECT id, available_micros FROM advertiser_wallets WHERE advertiser_id = 'adv_1'")
    .get() as { id: string; available_micros: number };

  const billMicros = computeSingleEventBillMicros('CPC', 1_450_000, 'click');
  const { publisherShareMicros, platformFeeMicros } = splitRevenueMicros(billMicros, 7200);
  assert.equal(publisherShareMicros + platformFeeMicros, billMicros);

  withTransaction(db, () => {
    const newAdvBal = beforeWallet.available_micros - billMicros;
    db.prepare('UPDATE advertiser_wallets SET available_micros = ? WHERE id = ?').run(newAdvBal, beforeWallet.id);
    db.prepare(
      `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
       VALUES ('led_test_1', 'idem_test_1', 'advertiser_wallet', ?, 'ad_spend', 'debit', ?, ?, 'USD', 'click', 'req_test_1', 'Test CPC charge')`
    ).run(beforeWallet.id, billMicros, newAdvBal);
  });

  const afterWallet = db
    .prepare("SELECT available_micros FROM advertiser_wallets WHERE advertiser_id = 'adv_1'")
    .get() as { available_micros: number };
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
});

test('User profile and preference tables persist updates cleanly', () => {
  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);

  db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id) VALUES ('usr_adv_1')`).run();
  db.prepare(
    `UPDATE user_preferences
     SET timezone = 'Europe/London', preferred_currency = 'EUR', two_factor_enabled = 1, session_timeout_minutes = 240
     WHERE user_id = 'usr_adv_1'`
  ).run();

  const prefs = db
    .prepare('SELECT timezone, preferred_currency, two_factor_enabled, session_timeout_minutes FROM user_preferences WHERE user_id = ?')
    .get('usr_adv_1') as { timezone: string; preferred_currency: string; two_factor_enabled: number; session_timeout_minutes: number };

  assert.equal(prefs.timezone, 'Europe/London');
  assert.equal(prefs.preferred_currency, 'EUR');
  assert.equal(prefs.two_factor_enabled, 1);
  assert.equal(prefs.session_timeout_minutes, 240);
});

test('Campaign budget, pacing, and targeting rules update atomically in SQLite', () => {
  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);

  withTransaction(db, () => {
    db.prepare(
      `UPDATE campaign_budgets
       SET daily_budget_micros = 175000000, total_budget_micros = 2500000000, max_bid_micros = 1950000, pacing_mode = 'accelerated'
       WHERE campaign_id = 'cmp_1'`
    ).run();

    db.prepare(
      `UPDATE campaign_targeting
       SET countries_json = ?, device_categories_json = ?, consent_required = 1
       WHERE campaign_id = 'cmp_1'`
    ).run(JSON.stringify(['US', 'GB', 'NG']), JSON.stringify(['desktop', 'mobile', 'tablet']));
  });

  const budget = db
    .prepare('SELECT daily_budget_micros, total_budget_micros, max_bid_micros, pacing_mode FROM campaign_budgets WHERE campaign_id = ?')
    .get('cmp_1') as { daily_budget_micros: number; total_budget_micros: number; max_bid_micros: number; pacing_mode: string };
  const target = db
    .prepare('SELECT countries_json, device_categories_json, consent_required FROM campaign_targeting WHERE campaign_id = ?')
    .get('cmp_1') as { countries_json: string; device_categories_json: string; consent_required: number };

  assert.equal(budget.daily_budget_micros, 175_000_000);
  assert.equal(budget.total_budget_micros, 2_500_000_000);
  assert.equal(budget.max_bid_micros, 1_950_000);
  assert.equal(budget.pacing_mode, 'accelerated');
  assert.deepEqual(JSON.parse(target.countries_json), ['US', 'GB', 'NG']);
  assert.deepEqual(JSON.parse(target.device_categories_json), ['desktop', 'mobile', 'tablet']);
  assert.equal(target.consent_required, 1);
});

test('Persistent SQLite rate limiter enforces exact sliding-window threshold', () => {
  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);

  assert.equal(checkPersistentRateLimit(db, 'test:ip:1', 3, 60_000), true);
  assert.equal(checkPersistentRateLimit(db, 'test:ip:1', 3, 60_000), true);
  assert.equal(checkPersistentRateLimit(db, 'test:ip:1', 3, 60_000), true);
  assert.equal(checkPersistentRateLimit(db, 'test:ip:1', 3, 60_000), false);

  const row = db.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?').get('test:ip:1') as { count: number };
  assert.equal(row.count, 3);
});

test('Scheduled background jobs mutate expected rows and record audit history', () => {
  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);

  // Set up spend today, unsettled publisher earnings, and an expired auth token
  db.prepare("UPDATE campaign_budgets SET spent_today_micros = 45000000 WHERE campaign_id = 'cmp_1'").run();
  db.prepare(
    "UPDATE publisher_wallets SET estimated_micros = available_micros + pending_micros + 5000000 WHERE publisher_id = 'pub_1'"
  ).run();
  db.prepare(
    `INSERT INTO auth_tokens (id, user_id, token_hash, token_type, expires_at)
     VALUES ('tok_exp_1', 'usr_adv_1', 'hash_exp_1', 'email_verify', datetime('now', '-2 hours'))`
  ).run();

  const budgetRes = runScheduledJob(db, 'daily_budget_reset', 'test_suite');
  assert.equal(budgetRes.status, 'completed');
  assert.ok(budgetRes.affectedCount >= 1);

  const afterBudget = db.prepare("SELECT spent_today_micros FROM campaign_budgets WHERE campaign_id = 'cmp_1'").get() as {
    spent_today_micros: number;
  };
  assert.equal(afterBudget.spent_today_micros, 0);

  const settleRes = runScheduledJob(db, 'publisher_earnings_settlement', 'test_suite');
  assert.equal(settleRes.status, 'completed');
  assert.ok(settleRes.affectedCount >= 1);

  const cleanupRes = runScheduledJob(db, 'expired_token_cleanup', 'test_suite');
  assert.equal(cleanupRes.status, 'completed');
  assert.ok(cleanupRes.affectedCount >= 1);

  const runs = db.prepare('SELECT COUNT(*) AS cnt FROM scheduled_job_runs').get() as { cnt: number };
  assert.equal(runs.cnt, 3);
});

test('Default prohibited policy rules seed idempotently and transactional email logs to outbox', () => {
  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);

  const rules = db.prepare('SELECT COUNT(*) AS cnt FROM prohibited_categories').get() as { cnt: number };
  assert.ok(rules.cnt >= 5);

  const emailId = queueTransactionalEmail(db, {
    to: 'advertiser@looma-ads.com',
    subject: 'Prepaid Deposit Confirmed',
    bodyText: 'Your wallet deposit has settled.',
    category: 'billing_receipt',
  });
  const stored = db.prepare('SELECT id, recipient_email, delivery_status FROM email_outbox WHERE id = ?').get(emailId) as {
    id: string;
    recipient_email: string;
    delivery_status: string;
  };
  assert.equal(stored.recipient_email, 'advertiser@looma-ads.com');
  assert.equal(stored.delivery_status, 'logged');
});

