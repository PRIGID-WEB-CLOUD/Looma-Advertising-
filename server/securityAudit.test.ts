import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { getDb } from './db';
import { seedDatabaseIfEmpty } from './seed';
import { hashPassword, revokeSessionToken } from './auth';
import { createAdDeliveryRouter, getPublisherSdkScript } from './routes/adDelivery';
import { createAdvertiserRouter } from './routes/advertiser';
import { createPublisherRouter } from './routes/publisher';
import { createAdminRouter } from './routes/admin';
import { createPublicAndAuthRouter } from './routes/publicAndAuth';
import { releaseReservationInTx, reserveBudgetForRequest } from './modules/budgetReservations';
import { runScheduledJob } from './jobs';

async function startAuditTestServer() {
  const db = await getDb(':memory:');
  await seedDatabaseIfEmpty(db);

  // Provision an admin account for moderation/withdrawal/fraud tests
  const adminRole = (await db.queryOne<{ id: string }>("SELECT id FROM roles WHERE name = 'admin'"))!;
  const adminId = 'usr_audit_admin';
  await db.execute(
    `INSERT INTO users (id, email, password_hash, full_name, role_id, status, email_verified)
     VALUES (?, 'audit-admin@looma.test', ?, 'Audit Admin', ?, 'active', 1)`,
    [adminId, hashPassword('AuditAdminPass!2026'), adminRole.id]
  );

  // Enable third-party publisher registration for test signup
  await db.execute(
    `UPDATE platform_settings SET value_json = 'true' WHERE key IN ('third_party_publishers_enabled', 'third_party_publisher_payouts_enabled')`
  );

  const app = express();
  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
  app.use('/api/v1/ad', createAdDeliveryRouter(db));
  app.use('/api/advertiser', createAdvertiserRouter(db));
  app.use('/api/publisher', createPublisherRouter(db));
  app.use('/api/admin', createAdminRouter(db));
  app.use('/api', createPublicAndAuthRouter(db));

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function reqJson<T = any>(
    method: string,
    route: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string> }
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
    if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const data = (await res.json()) as T;
    return { status: res.status, data };
  }

  return {
    db,
    baseUrl,
    reqJson,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

test('Production deposit gating prevents instant free credits via bank_transfer or unconfigured gateways', async () => {
  const srv = await startAuditTestServer();
  const prevNodeEnv = process.env.NODE_ENV;
  const prevAllowSandbox = process.env.ALLOW_SANDBOX_DEPOSITS;
  const prevPs = process.env.PAYSTACK_SECRET_KEY;

  try {
    const reg = await srv.reqJson<{ token: string; user: { id: string } }>('POST', '/api/auth/register', {
      body: {
        email: 'billing-audit@brand.test',
        password: 'StrongPassword!2026',
        fullName: 'Billing Audit',
        role: 'advertiser',
        organizationName: 'Billing Audit Co',
      },
    });
    assert.equal(reg.status, 201);
    const token = reg.data.token;

    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_SANDBOX_DEPOSITS;
    process.env.PAYSTACK_SECRET_KEY = 'sk_demo_placeholder';

    // Bank transfer in production must remain pending and NOT credit the wallet
    const bankRes = await srv.reqJson<{ status: string; mode: string; depositId: string }>(
      'POST',
      '/api/advertiser/deposit',
      {
        token,
        body: { amountUsd: 5000, provider: 'bank_transfer', idempotencyKey: 'bank_prod_test_1' },
      }
    );
    assert.equal(bankRes.status, 201);
    assert.equal(bankRes.data.status, 'pending');

    // Unconfigured Paystack in production must return 503 instead of minting sandbox balance
    const psRes = await srv.reqJson<{ error: string }>('POST', '/api/advertiser/deposit', {
      token,
      body: { amountUsd: 5000, provider: 'paystack', idempotencyKey: 'ps_prod_test_1' },
    });
    assert.equal(psRes.status, 503);

    const billing = await srv.reqJson<{ wallet: { available_micros: number } }>('GET', '/api/advertiser/billing', {
      token,
    });
    assert.equal(Number(billing.data.wallet.available_micros), 0);
  } finally {
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
    else delete process.env.NODE_ENV;
    if (prevAllowSandbox !== undefined) process.env.ALLOW_SANDBOX_DEPOSITS = prevAllowSandbox;
    else delete process.env.ALLOW_SANDBOX_DEPOSITS;
    if (prevPs !== undefined) process.env.PAYSTACK_SECRET_KEY = prevPs;
    else delete process.env.PAYSTACK_SECRET_KEY;
    await srv.close();
  }
});

test('Payment webhook ignores non-settled event types such as charge.failed and refund.processed', async () => {
  const srv = await startAuditTestServer();
  const prevSecret = process.env.PAYSTACK_WEBHOOK_SECRET;
  const secret = 'whsec_audit_test_secret_123';
  process.env.PAYSTACK_WEBHOOK_SECRET = secret;

  try {
    const reg = await srv.reqJson<{ token: string; user: { id: string } }>('POST', '/api/auth/register', {
      body: {
        email: 'webhook-audit@brand.test',
        password: 'StrongPassword!2026',
        fullName: 'Webhook Audit',
        role: 'advertiser',
        organizationName: 'Webhook Audit Co',
      },
    });
    const advRow = (await srv.db.queryOne<{ id: string }>(
      'SELECT id FROM advertiser_accounts WHERE user_id = ?',
      [reg.data.user.id]
    ))!;

    const failedPayload = JSON.stringify({
      eventId: 'evt_failed_001',
      advertiserId: advRow.id,
      amountUsd: 1000,
      eventType: 'charge.failed',
    });
    const failedSig = crypto.createHmac('sha512', secret).update(failedPayload).digest('hex');

    const failedRes = await fetch(`${srv.baseUrl}/api/webhooks/payments/paystack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': failedSig },
      body: failedPayload,
    });
    assert.equal(failedRes.status, 200);
    const failedJson = (await failedRes.json()) as { processed: boolean; ignored: boolean };
    assert.equal(failedJson.processed, false);
    assert.equal(failedJson.ignored, true);

    const walAfterFailed = (await srv.db.queryOne<{ available_micros: number }>(
      'SELECT available_micros FROM advertiser_wallets WHERE advertiser_id = ?',
      [advRow.id]
    ))!;
    assert.equal(Number(walAfterFailed.available_micros), 0);

    // Valid charge.success event still credits properly
    const okPayload = JSON.stringify({
      eventId: 'evt_success_001',
      advertiserId: advRow.id,
      amountUsd: 250,
      eventType: 'charge.success',
    });
    const okSig = crypto.createHmac('sha512', secret).update(okPayload).digest('hex');
    const okRes = await fetch(`${srv.baseUrl}/api/webhooks/payments/paystack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': okSig },
      body: okPayload,
    });
    assert.equal(okRes.status, 200);
    const walAfterOk = (await srv.db.queryOne<{ available_micros: number }>(
      'SELECT available_micros FROM advertiser_wallets WHERE advertiser_id = ?',
      [advRow.id]
    ))!;
    assert.equal(Number(walAfterOk.available_micros), 250_000_000);
  } finally {
    if (prevSecret !== undefined) process.env.PAYSTACK_WEBHOOK_SECRET = prevSecret;
    else delete process.env.PAYSTACK_WEBHOOK_SECRET;
    await srv.close();
  }
});

test('Publisher sandboxOverride domain verification is forbidden in production for non-admins', async () => {
  const srv = await startAuditTestServer();
  const prevNodeEnv = process.env.NODE_ENV;
  const prevAllowVer = process.env.ALLOW_SANDBOX_VERIFICATION;

  try {
    const pubReg = await srv.reqJson<{ token: string; user: { id: string } }>('POST', '/api/auth/register', {
      body: {
        email: 'pub-audit@site.test',
        password: 'StrongPassword!2026',
        fullName: 'Pub Audit',
        role: 'publisher',
        organizationName: 'Pub Audit Media',
      },
    });
    assert.equal(pubReg.status, 201);
    const pubToken = pubReg.data.token;

    const pubAcc = (await srv.db.queryOne<{ id: string }>(
      'SELECT id FROM publisher_accounts WHERE user_id = ?',
      [pubReg.data.user.id]
    ))!;

    const propRes = await srv.reqJson<{ propertyId: string }>('POST', '/api/publisher/properties', {
      token: pubToken,
      body: {
        propertyType: 'website',
        name: 'Unowned Target',
        domainOrBundle: 'example.org',
        category: 'technology',
        language: 'en',
        monthlyPageviews: 10000,
        verificationMethod: 'dns_txt',
      },
    });
    assert.equal(propRes.status, 201);

    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_SANDBOX_VERIFICATION;

    // Publisher cannot self-verify via sandboxOverride in production
    const pubVerify = await srv.reqJson<{ error: string }>(
      'POST',
      `/api/publisher/properties/${propRes.data.propertyId}/verify`,
      {
        token: pubToken,
        body: { sandboxOverride: true },
      }
    );
    assert.equal(pubVerify.status, 403);

    const adminLogin = await srv.reqJson<{ token: string }>('POST', '/api/auth/login', {
      body: { email: 'audit-admin@looma.test', password: 'AuditAdminPass!2026' },
    });
    assert.equal(adminLogin.status, 200);

    // Admin can still explicitly override verification when needed
    const adminVerify = await srv.reqJson<{ verified: boolean }>(
      'POST',
      `/api/publisher/properties/${propRes.data.propertyId}/verify?publisherId=${encodeURIComponent(pubAcc.id)}`,
      {
        token: adminLogin.data.token,
        body: { sandboxOverride: true },
      }
    );
    assert.equal(adminVerify.status, 200);
    assert.equal(adminVerify.data.verified, true);
  } finally {
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
    else delete process.env.NODE_ENV;
    if (prevAllowVer !== undefined) process.env.ALLOW_SANDBOX_VERIFICATION = prevAllowVer;
    else delete process.env.ALLOW_SANDBOX_VERIFICATION;
    await srv.close();
  }
});

test('Approved campaigns require re-moderation on creative/destination edits while preserving approval on budget-only edits', async () => {
  const srv = await startAuditTestServer();
  try {
    const advReg = await srv.reqJson<{ token: string }>('POST', '/api/auth/register', {
      body: {
        email: 'remod-audit@brand.test',
        password: 'StrongPassword!2026',
        fullName: 'Remod Brand',
        role: 'advertiser',
        organizationName: 'Remod Co',
      },
    });
    const advToken = advReg.data.token;

    const createCamp = await srv.reqJson<{ campaignId: string }>('POST', '/api/advertiser/campaigns', {
      token: advToken,
      body: {
        name: 'Clean Launch Campaign',
        objective: 'website_traffic',
        pricingModel: 'CPC',
        startDate: '2025-01-01',
        endDate: '2029-12-31',
        dailyBudgetUsd: 100,
        totalBudgetUsd: 500,
        maxBidUsd: 1.5,
        format: 'native',
        title: 'Trusted Cloud Hosting',
        description: 'Fast developer infrastructure with transparent billing.',
        destinationUrl: 'https://trusted-brand.example.com/launch',
        ctaText: 'Start Free',
        targeting: { countries: ['US'], languages: ['en'], deviceCategories: ['desktop'] },
      },
    });
    assert.equal(createCamp.status, 201);
    const campaignId = createCamp.data.campaignId;

    const adminLogin = await srv.reqJson<{ token: string }>('POST', '/api/auth/login', {
      body: { email: 'audit-admin@looma.test', password: 'AuditAdminPass!2026' },
    });
    const approveRes = await srv.reqJson('POST', '/api/admin/moderation/decision', {
      token: adminLogin.data.token,
      body: { campaignId, decision: 'approved', reason: 'Verified clean creative' },
    });
    assert.equal(approveRes.status, 200);

    // Budget-only edit should NOT revoke approval
    const budgetEdit = await srv.reqJson<{ updated: boolean; remoderationRequired: boolean }>(
      'PATCH',
      `/api/advertiser/campaigns/${campaignId}`,
      {
        token: advToken,
        body: { dailyBudgetUsd: 150 },
      }
    );
    assert.equal(budgetEdit.status, 200);
    assert.equal(budgetEdit.data.remoderationRequired, false);

    let campRow = (await srv.db.queryOne<{ status: string; moderation_status: string }>(
      'SELECT status, moderation_status FROM campaigns WHERE id = ?',
      [campaignId]
    ))!;
    assert.equal(campRow.moderation_status, 'approved');
    assert.equal(campRow.status, 'active');

    // Swapping destinationUrl on an approved campaign MUST trigger re-moderation
    const swapDest = await srv.reqJson<{ updated: boolean; remoderationRequired: boolean }>(
      'PATCH',
      `/api/advertiser/campaigns/${campaignId}`,
      {
        token: advToken,
        body: { destinationUrl: 'https://different-landing.example.net/offer' },
      }
    );
    assert.equal(swapDest.status, 200);
    assert.equal(swapDest.data.remoderationRequired, true);

    campRow = (await srv.db.queryOne<{ status: string; moderation_status: string }>(
      'SELECT status, moderation_status FROM campaigns WHERE id = ?',
      [campaignId]
    ))!;
    assert.equal(campRow.moderation_status, 'pending');
    assert.equal(campRow.status, 'pending_review');
  } finally {
    await srv.close();
  }
});

test('Unauthenticated click sandboxMode cannot bypass HeadlessChrome bot detection', async () => {
  const srv = await startAuditTestServer();
  try {
    const advReg = await srv.reqJson<{ token: string }>('POST', '/api/auth/register', {
      body: {
        email: 'click-adv@brand.test',
        password: 'StrongPassword!2026',
        fullName: 'Click Adv',
        role: 'advertiser',
        organizationName: 'Click Adv Co',
      },
    });
    const advToken = advReg.data.token;
    await srv.reqJson('POST', '/api/advertiser/deposit', {
      token: advToken,
      body: { amountUsd: 500, provider: 'paystack', idempotencyKey: 'dep_click_bot_1' },
    });

    const camp = await srv.reqJson<{ campaignId: string }>('POST', '/api/advertiser/campaigns', {
      token: advToken,
      body: {
        name: 'Bot Check CPC',
        objective: 'website_traffic',
        pricingModel: 'CPC',
        startDate: '2025-01-01',
        endDate: '2029-12-31',
        dailyBudgetUsd: 100,
        totalBudgetUsd: 400,
        maxBidUsd: 2,
        format: 'native',
        title: 'Bot Check Ad',
        description: 'Testing click fraud enforcement.',
        destinationUrl: 'https://botcheck.example.com',
        ctaText: 'Visit',
        targeting: { countries: ['US'], languages: ['en'], deviceCategories: ['desktop'] },
      },
    });
    assert.equal(camp.status, 201);
    const adminLogin = await srv.reqJson<{ token: string }>('POST', '/api/auth/login', {
      body: { email: 'audit-admin@looma.test', password: 'AuditAdminPass!2026' },
    });
    const modApprove = await srv.reqJson('POST', '/api/admin/moderation/decision', {
      token: adminLogin.data.token,
      body: {
        campaignId: camp.data.campaignId,
        decision: 'approved',
        reason: 'Approved for click test',
      },
    });
    assert.equal(modApprove.status, 200);

    const plc = (await srv.db.queryOne<{ id: string }>(
      "SELECT id FROM ad_placements WHERE status = 'active' LIMIT 1"
    ))!;

    const adReq = await srv.reqJson<{
      filled: boolean;
      tracking: { impressionToken: string; clickToken: string };
    }>('POST', '/api/v1/ad/request', {
      body: { placementId: plc.id, country: 'US', deviceCategory: 'desktop', language: 'en' },
    });
    assert.equal(adReq.status, 200);
    assert.equal(adReq.data.filled, true);

    await srv.reqJson('POST', '/api/v1/ad/impression', {
      body: { impressionToken: adReq.data.tracking.impressionToken, viewable: true },
    });

    // Unauthenticated headless bot trying to pass sandboxMode: true MUST still be blocked
    const botClick = await srv.reqJson<{ valid: boolean; invalidReason: string; billedMicros: number }>(
      'POST',
      '/api/v1/ad/click',
      {
        headers: { 'User-Agent': 'Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36' },
        body: { clickToken: adReq.data.tracking.clickToken, sandboxMode: true },
      }
    );
    assert.equal(botClick.status, 200);
    assert.equal(botClick.data.valid, false);
    assert.equal(botClick.data.invalidReason, 'automated_bot_user_agent');
    assert.equal(botClick.data.billedMicros, 0);
  } finally {
    await srv.close();
  }
});

test('Atomic wallet operations prevent refund overdraw, duplicate withdrawal payouts, duplicate IVT clawbacks, and double reservation release', async () => {
  const srv = await startAuditTestServer();
  try {
    const advReg = await srv.reqJson<{ token: string; user: { id: string } }>('POST', '/api/auth/register', {
      body: {
        email: 'atomic-adv@brand.test',
        password: 'StrongPassword!2026',
        fullName: 'Atomic Adv',
        role: 'advertiser',
        organizationName: 'Atomic Co',
      },
    });
    const advToken = advReg.data.token;
    const advAcc = (await srv.db.queryOne<{ id: string }>(
      'SELECT id FROM advertiser_accounts WHERE user_id = ?',
      [advReg.data.user.id]
    ))!;

    await srv.reqJson('POST', '/api/advertiser/deposit', {
      token: advToken,
      body: { amountUsd: 100, provider: 'paystack', idempotencyKey: 'dep_atomic_1' },
    });

    // Two concurrent $80 refunds against a $100 wallet: only one may succeed
    const [r1, r2] = await Promise.all([
      srv.reqJson('POST', '/api/advertiser/refund', { token: advToken, body: { amountUsd: 80, reason: 'Refund A' } }),
      srv.reqJson('POST', '/api/advertiser/refund', { token: advToken, body: { amountUsd: 80, reason: 'Refund B' } }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [201, 400]);

    const advWal = (await srv.db.queryOne<{ available_micros: number }>(
      'SELECT available_micros FROM advertiser_wallets WHERE advertiser_id = ?',
      [advAcc.id]
    ))!;
    assert.equal(Number(advWal.available_micros), 20_000_000);

    // Double reservation release only credits wallet once
    const camp = await srv.reqJson<{ campaignId: string }>('POST', '/api/advertiser/campaigns', {
      token: advToken,
      body: {
        name: 'Reserve Test',
        objective: 'website_traffic',
        pricingModel: 'CPC',
        startDate: '2025-01-01',
        endDate: '2029-12-31',
        dailyBudgetUsd: 50,
        totalBudgetUsd: 100,
        maxBidUsd: 1,
        format: 'text',
        title: 'Reserve Headline',
        description: 'Testing double release guard.',
        destinationUrl: 'https://reserve.example.com',
        ctaText: 'Go',
      },
    });
    assert.equal(camp.status, 201);
    const rsv = await reserveBudgetForRequest(srv.db, {
      advertiserId: advAcc.id,
      campaignId: camp.data.campaignId,
      requestId: 'req_double_release_1',
      amountMicros: 5_000_000,
    });
    assert.equal(rsv.reserved, true);

    const rel1 = await releaseReservationInTx(srv.db, 'req_double_release_1');
    const rel2 = await releaseReservationInTx(srv.db, 'req_double_release_1');
    assert.equal(rel1.released, true);
    assert.equal(rel2.released, false);

    const advWalAfterRel = (await srv.db.queryOne<{ available_micros: number }>(
      'SELECT available_micros FROM advertiser_wallets WHERE advertiser_id = ?',
      [advAcc.id]
    ))!;
    assert.equal(Number(advWalAfterRel.available_micros), 20_000_000);

    // Duplicate withdrawal settlement & duplicate fraud IVT resolution guards
    const pubReg = await srv.reqJson<{ token: string; user: { id: string } }>('POST', '/api/auth/register', {
      body: {
        email: 'atomic-pub@site.test',
        password: 'StrongPassword!2026',
        fullName: 'Atomic Pub',
        role: 'publisher',
        organizationName: 'Atomic Pub Co',
      },
    });
    const pubToken = pubReg.data.token;
    const pubAcc = (await srv.db.queryOne<{ id: string }>(
      'SELECT id FROM publisher_accounts WHERE user_id = ?',
      [pubReg.data.user.id]
    ))!;
    await srv.db.execute(
      'UPDATE publisher_wallets SET available_micros = 200000000 WHERE publisher_id = ?',
      [pubAcc.id]
    );
    await srv.reqJson('PATCH', '/api/publisher/payout-method', {
      token: pubToken,
      body: { payoutMethodType: 'bank_transfer', payoutDestination: 'ACCT-99887766' },
    });

    const wdr = await srv.reqJson<{ withdrawalId: string }>('POST', '/api/publisher/withdraw', {
      token: pubToken,
      body: { amountUsd: 100 },
    });
    assert.equal(wdr.status, 201);

    const adminLogin = await srv.reqJson<{ token: string }>('POST', '/api/auth/login', {
      body: { email: 'audit-admin@looma.test', password: 'AuditAdminPass!2026' },
    });
    const adminToken = adminLogin.data.token;

    const pay1 = await srv.reqJson('POST', `/api/admin/withdrawals/${wdr.data.withdrawalId}/decision`, {
      token: adminToken,
      body: { decision: 'paid', notes: 'First settlement' },
    });
    assert.equal(pay1.status, 200);
    const pay2 = await srv.reqJson('POST', `/api/admin/withdrawals/${wdr.data.withdrawalId}/decision`, {
      token: adminToken,
      body: { decision: 'paid', notes: 'Duplicate attempt' },
    });
    assert.ok(pay2.status === 400 || pay2.status === 409);

    // Fraud alert double resolution blocked
    await srv.db.execute(
      `INSERT INTO fraud_alerts (id, publisher_id, signal_type, severity, description, evidence_json, status)
       VALUES ('frd_audit_1', ?, 'bot_ua', 'high', 'Audit IVT test', '{}', 'open')`,
      [pubAcc.id]
    );
    const frd1 = await srv.reqJson('POST', '/api/admin/fraud/frd_audit_1/resolve', {
      token: adminToken,
      body: { status: 'confirmed_ivt', resolutionNotes: 'Confirmed', deductMicros: 25_000_000 },
    });
    assert.equal(frd1.status, 200);
    const frd2 = await srv.reqJson('POST', '/api/admin/fraud/frd_audit_1/resolve', {
      token: adminToken,
      body: { status: 'confirmed_ivt', resolutionNotes: 'Second attempt', deductMicros: 25_000_000 },
    });
    assert.equal(frd2.status, 409);

    const pubWalAfter = (await srv.db.queryOne<{ available_micros: number; invalid_deducted_micros: number }>(
      'SELECT available_micros, invalid_deducted_micros FROM publisher_wallets WHERE publisher_id = ?',
      [pubAcc.id]
    ))!;
    assert.equal(Number(pubWalAfter.available_micros), 75_000_000);
    assert.equal(Number(pubWalAfter.invalid_deducted_micros), 25_000_000);

    // Expired revoked_tokens cleanup verification
    await revokeSessionToken(srv.db, 'expired.fake.token', Date.now() - 60_000);
    await srv.db.execute(
      `UPDATE revoked_tokens SET expires_at = ?`,
      [new Date(Date.now() - 120_000).toISOString()]
    );
    await runScheduledJob(srv.db, 'expired_token_cleanup', 'audit-test');
    const rem = await srv.db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM revoked_tokens');
    assert.equal(Number(rem?.cnt ?? 0), 0);
  } finally {
    await srv.close();
  }
});

test('Publisher SDK parses cleanly and guards destinationUrl scheme', async () => {
  const sdk = getPublisherSdkScript();
  // Verify generated browser SDK parses cleanly as valid JavaScript
  assert.doesNotThrow(() => new Function(sdk));
  assert.match(sdk, /\^https\?:\\\/\\\//i);
  assert.match(sdk, /ev\.preventDefault\(\)/);
});
