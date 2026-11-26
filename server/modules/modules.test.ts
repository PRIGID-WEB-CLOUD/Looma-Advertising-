import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, withTransaction } from '../db';
import { seedDatabaseIfEmpty } from '../seed';
import {
  captureReservationInTx,
  releaseExpiredReservationsInTx,
  releaseReservationInTx,
  reserveBudgetForRequest,
} from './budgetReservations';
import { getFeatureFlags, isPublisherEligibleForDelivery } from './featureFlags';
import {
  exchangeLoomaSsoSession,
  selectLoomaFeedAds,
  signLoomaSsoAssertion,
} from './loomaAdapter';
import { computePercentile, getOperationalMonitoringSnapshot, recordAdDeliveryMetric } from './monitoring';
import { runScheduledJob } from '../jobs';

test('Initial launch feature flags keep Looma first-party exclusive and disable external third-party network features', () => {
  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);

  const flags = getFeatureFlags(db);
  assert.equal(flags.looma_first_party_only_mode, true);
  assert.equal(flags.external_publisher_registration_enabled, true);
  assert.equal(flags.third_party_sdk_distribution_enabled, false);
  assert.equal(flags.third_party_revenue_allocation_enabled, false);
  assert.equal(flags.third_party_publisher_payouts_enabled, false);
  assert.equal(flags.postpaid_advertiser_credit_enabled, false);

  assert.equal(isPublisherEligibleForDelivery(db, 'first_party', 'approved').eligible, true);
  const thirdPartyCheck = isPublisherEligibleForDelivery(db, 'third_party', 'approved');
  assert.equal(thirdPartyCheck.eligible, false);
  assert.equal(thirdPartyCheck.reason, 'external_publishers_disabled_by_feature_flag');

  // When expansion flags are enabled in platform_settings, third-party publisher becomes eligible
  db.prepare(
    `UPDATE platform_settings SET value_json = 'true' WHERE key = 'third_party_sdk_distribution_enabled'`
  ).run();
  assert.equal(isPublisherEligibleForDelivery(db, 'third_party', 'approved').eligible, true);
});

test('Atomic prepaid budget reservations prevent overspending, settle verified charges, and release surplus or expired holds', () => {
  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);

  // Set advertiser wallet to exactly $2.00 (2_000_000 micros)
  db.prepare("UPDATE advertiser_wallets SET available_micros = 2000000, reserved_micros = 0 WHERE advertiser_id = 'adv_1'").run();

  // First reservation of $1.45 succeeds
  const r1 = reserveBudgetForRequest(db, {
    advertiserId: 'adv_1',
    campaignId: 'cmp_1',
    requestId: 'req_rsv_1',
    amountMicros: 1_450_000,
  });
  assert.equal(r1.reserved, true);
  assert.equal(r1.availableAfterMicros, 550_000);

  // Second concurrent reservation of $1.45 fails because only $0.55 remains available (prevents overspend)
  const r2 = reserveBudgetForRequest(db, {
    advertiserId: 'adv_1',
    campaignId: 'cmp_1',
    requestId: 'req_rsv_2',
    amountMicros: 1_450_000,
  });
  assert.equal(r2.reserved, false);
  assert.equal(r2.reason, 'insufficient_prepaid_balance');

  // Partial capture of $1.00 releases $0.45 surplus back to available_micros
  const cap = withTransaction(db, () =>
    captureReservationInTx(db, {
      advertiserId: 'adv_1',
      campaignId: 'cmp_1',
      requestId: 'req_rsv_1',
      chargeMicros: 1_000_000,
      eventType: 'click',
      ledgerIdempotencyKey: 'clk_test_rsv_1',
      description: 'Test partial capture',
    })
  );
  assert.ok(cap);
  assert.equal(cap.usedReservation, true);
  assert.equal(cap.capturedMicros, 1_000_000);
  assert.equal(cap.releasedExcessMicros, 450_000);
  assert.equal(cap.advertiserBalanceAfterMicros, 1_000_000); // $2.00 - $1.00 = $1.00

  // Reserve $0.50 and explicitly release (e.g. bot click blocked)
  const r3 = reserveBudgetForRequest(db, {
    advertiserId: 'adv_1',
    campaignId: 'cmp_1',
    requestId: 'req_rsv_3',
    amountMicros: 500_000,
  });
  assert.equal(r3.reserved, true);

  const rel = withTransaction(db, () => releaseReservationInTx(db, 'req_rsv_3', 'Bot traffic blocked'));
  assert.equal(rel.released, true);
  assert.equal(rel.amountMicros, 500_000);

  // Reserve $0.25, force expire it, and run release_expired_reservations scheduled job
  const r4 = reserveBudgetForRequest(db, {
    advertiserId: 'adv_1',
    campaignId: 'cmp_1',
    requestId: 'req_rsv_exp',
    amountMicros: 250_000,
  });
  assert.equal(r4.reserved, true);
  db.prepare("UPDATE budget_reservations SET expires_at = datetime('now', '-5 minutes') WHERE request_id = 'req_rsv_exp'").run();

  const jobOutcome = runScheduledJob(db, 'release_expired_reservations', 'test_suite');
  assert.equal(jobOutcome.status, 'completed');
  assert.equal(jobOutcome.affectedCount, 1);

  const walletAfter = db
    .prepare("SELECT available_micros, reserved_micros FROM advertiser_wallets WHERE advertiser_id = 'adv_1'")
    .get() as { available_micros: number; reserved_micros: number };
  assert.equal(walletAfter.available_micros, 1_000_000);
  assert.equal(walletAfter.reserved_micros, 0);

  // Also test direct expired cleanup helper returns 0 when nothing remains
  const secondSweep = withTransaction(db, () => releaseExpiredReservationsInTx(db));
  assert.equal(secondSweep.releasedCount, 0);
});

test('Looma SSO assertion exchange verifies signatures, business membership, prevents replay, and avoids profile duplication', () => {
  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);
  const secret = 'test-looma-sso-shared-secret';

  const validAssertion = signLoomaSsoAssertion(
    {
      loomaUserId: 'looma_u_100',
      email: 'maya.lin@atlascommerce.io',
      fullName: 'Maya Lin',
      businessId: 'looma_biz_100',
      businessName: 'Atlas Commerce Global',
      membershipRole: 'owner',
      verifiedMembership: true,
    },
    secret
  );

  // First exchange succeeds and links to existing advertiser account without duplicating users
  const userCountBefore = (db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number }).cnt;
  const first = exchangeLoomaSsoSession(db, validAssertion, secret);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.identityLink.advertiserId, 'adv_1');
  }
  const userCountAfter = (db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number }).cnt;
  assert.equal(userCountAfter, userCountBefore);

  // Replaying the same jti assertion is rejected
  const replay = exchangeLoomaSsoSession(db, validAssertion, secret);
  assert.equal(replay.ok, false);
  if (!replay.ok) {
    assert.equal(replay.status, 401);
    assert.equal(replay.error, 'sso_assertion_replayed');
  }

  // Tampered signature rejected
  const tampered = `${validAssertion.slice(0, -3)}xxx`;
  const badSig = exchangeLoomaSsoSession(db, tampered, secret);
  assert.equal(badSig.ok, false);
  if (!badSig.ok) assert.equal(badSig.status, 401);

  // Unverified business membership rejected with 403
  const unverified = signLoomaSsoAssertion(
    {
      loomaUserId: 'looma_u_101',
      email: 'newbiz@example.com',
      fullName: 'Unverified Member',
      businessId: 'looma_biz_101',
      businessName: 'Unverified Co',
      membershipRole: 'admin',
      verifiedMembership: false,
    },
    secret
  );
  const unvRes = exchangeLoomaSsoSession(db, unverified, secret);
  assert.equal(unvRes.ok, false);
  if (!unvRes.ok) assert.equal(unvRes.status, 403);

  // Insufficient role (viewer) rejected with 403
  const viewer = signLoomaSsoAssertion(
    {
      loomaUserId: 'looma_u_102',
      email: 'viewer@example.com',
      fullName: 'Viewer Only',
      businessId: 'looma_biz_102',
      businessName: 'Viewer Co',
      membershipRole: 'viewer',
      verifiedMembership: true,
    },
    secret
  );
  const viewRes = exchangeLoomaSsoSession(db, viewer, secret);
  assert.equal(viewRes.ok, false);
  if (!viewRes.ok) assert.equal(viewRes.status, 403);

  // Admin account linking via SSO must always be blocked with 403
  const adminUser = db
    .prepare("SELECT email FROM users WHERE id = 'usr_admin_1'")
    .get() as { email: string };
  const adminSso = signLoomaSsoAssertion(
    {
      loomaUserId: 'looma_u_admin_hijack',
      email: adminUser.email,
      fullName: 'Attempted Admin SSO',
      businessId: 'looma_biz_evil',
      businessName: 'Evil Corp',
      membershipRole: 'owner',
      verifiedMembership: true,
    },
    secret
  );
  const adminRes = exchangeLoomaSsoSession(db, adminSso, secret);
  assert.equal(adminRes.ok, false);
  if (!adminRes.ok) {
    assert.equal(adminRes.status, 403);
    assert.equal(adminRes.error, 'admin_sso_not_allowed');
  }
});

test('Looma first-party feed adapter fills multi-slot feeds with unique campaigns, creates reservations, and blocks third-party placements at launch', () => {
  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);

  const feedRes = selectLoomaFeedAds(db, {
    slots: [
      { slotIndex: 2, placementId: 'plc_looma_feed_native' },
      { slotIndex: 6, placementId: 'plc_looma_feed_infeed' },
      { slotIndex: 10, placementId: 'plc_meridian_native' }, // Third-party placement disabled at launch
    ],
    country: 'US',
    language: 'en',
    deviceCategory: 'desktop',
    os: 'macOS',
    browser: 'Chrome',
    feedCategory: 'business_finance',
    consentGranted: true,
    sessionId: 'sess_looma_feed_1',
    clientIp: '203.0.113.10',
    userAgent: 'LoomaApp/2.1',
  });

  assert.equal(feedRes.publisherMode, 'first_party_adapter');
  assert.equal(feedRes.fallbackBehavior, 'skip_slot_continue_feed');
  assert.equal(feedRes.decisions.length, 3);

  // First-party Looma native slot fills and reserves prepaid budget
  assert.equal(feedRes.decisions[0].filled, true);
  assert.ok(feedRes.decisions[0].reservationId);
  assert.ok((feedRes.decisions[0].reservedMicros ?? 0) > 0);
  assert.ok(feedRes.decisions[0].tracking?.impressionToken);

  // If second slot also fills, it must not duplicate the first slot's campaign
  if (feedRes.decisions[1].filled) {
    assert.notEqual(
      feedRes.decisions[1].ad?.campaignId,
      feedRes.decisions[0].ad?.campaignId
    );
  }

  // Third-party placement is cleanly skipped while looma_first_party_only_mode is active
  assert.equal(feedRes.decisions[2].filled, false);
  assert.equal(feedRes.decisions[2].reason, 'external_publishers_disabled_by_feature_flag');
});

test('Operational monitoring computes accurate latency percentiles and database health counts', () => {
  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);

  assert.equal(computePercentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 50), 50);
  assert.equal(computePercentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95), 100);
  assert.equal(computePercentile([], 95), 0);

  recordAdDeliveryMetric(true, 12.5, true);
  const snap = getOperationalMonitoringSnapshot(db);
  assert.equal(snap.status, 'healthy');
  assert.ok(snap.delivery.adRequestsTotal >= 1);
  assert.ok(snap.ledgerAndReservations.total_ledger_entries >= 1);
});
