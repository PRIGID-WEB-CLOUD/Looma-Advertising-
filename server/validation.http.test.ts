import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { getDb } from './db';
import { seedDatabaseIfEmpty } from './seed';
import { hashPassword } from './auth';
import { createAdDeliveryRouter } from './routes/adDelivery';
import { createAdvertiserRouter } from './routes/advertiser';
import { createPublisherRouter } from './routes/publisher';
import { createAdminRouter } from './routes/admin';
import { createPublicAndAuthRouter } from './routes/publicAndAuth';
import { createLoomaIntegrationRouter } from './routes/loomaIntegration';

async function startValidationServer() {
  const tempUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-val-test-'));
  process.env.LOOMA_STORAGE_DIR = tempUploadDir;

  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const e = err as { type?: string; status?: number; statusCode?: number };
    if (e?.type === 'entity.too.large' || e?.status === 413 || e?.statusCode === 413) {
      res.status(413).json({ error: 'Request payload is too large. Maximum allowed size is 15 MB.' });
      return;
    }
    if (err instanceof SyntaxError && (e?.status === 400 || e?.statusCode === 400 || 'body' in (err as object))) {
      res.status(400).json({ error: 'Malformed JSON request body.' });
      return;
    }
    next(err);
  });

  app.use('/api/v1/looma', createLoomaIntegrationRouter(db));
  app.use('/api/v1/ad', createAdDeliveryRouter(db));
  app.use('/api/advertiser', createAdvertiserRouter(db));
  app.use('/api/publisher', createPublisherRouter(db));
  app.use('/api/admin', createAdminRouter(db));
  app.use('/api', createPublicAndAuthRouter(db));

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function reqJson<T = Record<string, any>>(
    urlPath: string,
    opts: { method?: string; token?: string; body?: unknown; rawBody?: string } = {}
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    let bodyStr: string | undefined;
    if (opts.rawBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = opts.rawBody;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(opts.body);
    }
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: opts.method || 'GET',
      headers,
      body: bodyStr,
    });
    const text = await res.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = text;
    }
    return { status: res.status, data: data as T };
  }

  async function authenticateActors() {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = 'usr_adv_1'").run(hashPassword('TestAdvPass!123'));
    db.prepare("UPDATE users SET password_hash = ? WHERE id = 'usr_pub_looma'").run(hashPassword('TestPubPass!123'));
    const advRow = db.prepare("SELECT email FROM users WHERE id = 'usr_adv_1'").get() as { email: string };
    const pubRow = db.prepare("SELECT email FROM users WHERE id = 'usr_pub_looma'").get() as { email: string };

    const advLogin = await reqJson('/api/auth/login', {
      method: 'POST',
      body: { email: advRow.email, password: 'TestAdvPass!123' },
    });
    const pubLogin = await reqJson('/api/auth/login', {
      method: 'POST',
      body: { email: pubRow.email, password: 'TestPubPass!123' },
    });
    const adminClaim = await reqJson('/api/auth/admin-claim', {
      method: 'POST',
      body: {
        email: 'val.admin@looma-ads.com',
        fullName: 'Validation Admin',
        password: 'AdminStrongPassword!99',
      },
    });
    assert.equal(advLogin.status, 200);
    assert.equal(pubLogin.status, 200);
    assert.equal(adminClaim.status, 201);

    return {
      advToken: advLogin.data.token as string,
      pubToken: pubLogin.data.token as string,
      adminToken: adminClaim.data.token as string,
    };
  }

  async function close() {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tempUploadDir, { recursive: true, force: true });
  }

  return { reqJson, authenticateActors, close };
}

test('HTTP Validation: Malformed JSON, Auth, Public Contact & Privacy return structured 400 fieldErrors', async () => {
  const { reqJson, close } = await startValidationServer();
  try {
    // Malformed JSON -> 400
    const badJson = await reqJson('/api/auth/login', { method: 'POST', rawBody: '{"email": "broken' });
    assert.equal(badJson.status, 400);
    assert.match(String(badJson.data.error), /Malformed JSON/i);

    // Invalid login
    const badLogin = await reqJson('/api/auth/login', { method: 'POST', body: { email: 'not-email', password: '' } });
    assert.equal(badLogin.status, 400);
    assert.ok(badLogin.data.fieldErrors?.email);
    assert.ok(badLogin.data.fieldErrors?.password);

    // Invalid register
    const badReg = await reqJson('/api/auth/register', {
      method: 'POST',
      body: { email: 'nope', fullName: 'A', password: '123', role: 'admin', organizationName: 'X', country: 'USA' },
    });
    assert.equal(badReg.status, 400);
    assert.ok(badReg.data.fieldErrors?.email);
    assert.ok(badReg.data.fieldErrors?.fullName);
    assert.ok(badReg.data.fieldErrors?.password);
    assert.ok(badReg.data.fieldErrors?.role);
    assert.ok(badReg.data.fieldErrors?.organizationName);
    assert.ok(badReg.data.fieldErrors?.country);

    // Invalid forgot/reset password
    const badForgot = await reqJson('/api/auth/forgot-password', { method: 'POST', body: { email: 'invalid' } });
    assert.equal(badForgot.status, 400);
    assert.ok(badForgot.data.fieldErrors?.email);

    const badReset = await reqJson('/api/auth/reset-password', {
      method: 'POST',
      body: { email: 'bad', token: '!!', newPassword: 'short' },
    });
    assert.equal(badReset.status, 400);
    assert.ok(badReset.data.fieldErrors?.email);
    assert.ok(badReset.data.fieldErrors?.token);
    assert.ok(badReset.data.fieldErrors?.newPassword);

    // Invalid contact form
    const badContact = await reqJson('/api/public/contact', {
      method: 'POST',
      body: { name: 'A', email: 'bad', interest: 'unknown', message: 'short' },
    });
    assert.equal(badContact.status, 400);
    assert.ok(badContact.data.fieldErrors?.name);
    assert.ok(badContact.data.fieldErrors?.email);
    assert.ok(badContact.data.fieldErrors?.interest);
    assert.ok(badContact.data.fieldErrors?.message);

    // Invalid privacy request
    const badPrivacy = await reqJson('/api/public/privacy-request', {
      method: 'POST',
      body: { email: 'bad', requestType: 'other', jurisdiction: 'INVALID' },
    });
    assert.equal(badPrivacy.status, 400);
    assert.ok(badPrivacy.data.fieldErrors?.email);
    assert.ok(badPrivacy.data.fieldErrors?.requestType);
    assert.ok(badPrivacy.data.fieldErrors?.jurisdiction);
  } finally {
    await close();
  }
});

test('HTTP Validation: Advertiser routes reject unsafe URLs, cross-field budget/date mismatches, invalid deposits, refunds, appeals', async () => {
  const { reqJson, authenticateActors, close } = await startValidationServer();
  try {
    const { advToken } = await authenticateActors();

    // Unsafe URL + totalBudget < dailyBudget + maxBid > dailyBudget + endDate < startDate
    const badCamp = await reqJson('/api/advertiser/campaigns', {
      method: 'POST',
      token: advToken,
      body: {
        name: 'Bad Campaign',
        pricingModel: 'CPC',
        format: 'banner',
        title: 'Promo Headline',
        description: 'Promo description copy',
        destinationUrl: 'http://169.254.169.254/latest/meta-data/',
        dailyBudgetUsd: 100,
        totalBudgetUsd: 50,
        maxBidUsd: 200,
        startDate: '2026-09-10',
        endDate: '2026-09-01',
      },
    });
    assert.equal(badCamp.status, 400);
    assert.ok(badCamp.data.fieldErrors?.destinationUrl);
    assert.ok(badCamp.data.fieldErrors?.totalBudgetUsd);
    assert.ok(badCamp.data.fieldErrors?.maxBidUsd);
    assert.ok(badCamp.data.fieldErrors?.endDate);

    // Invalid campaign PATCH (unsafe URL + invalid targeting)
    const badPatch = await reqJson('/api/advertiser/campaigns/cmp_1', {
      method: 'PATCH',
      token: advToken,
      body: {
        destinationUrl: 'javascript:alert(1)',
        targeting: { countries: ['INVALID'] },
      },
    });
    assert.equal(badPatch.status, 400);
    assert.ok(badPatch.data.fieldErrors?.destinationUrl);
    assert.ok(badPatch.data.fieldErrors?.countries);

    // Invalid deposit (< $10 and bad provider)
    const badDep = await reqJson('/api/advertiser/deposit', {
      method: 'POST',
      token: advToken,
      body: { amountUsd: 5, provider: 'bitcoin' },
    });
    assert.equal(badDep.status, 400);
    assert.ok(badDep.data.fieldErrors?.amountUsd);
    assert.ok(badDep.data.fieldErrors?.provider);

    // Invalid refund (< $5)
    const badRefund = await reqJson('/api/advertiser/refund', {
      method: 'POST',
      token: advToken,
      body: { amountUsd: 1 },
    });
    assert.equal(badRefund.status, 400);
    assert.ok(badRefund.data.fieldErrors?.amountUsd);

    // Invalid appeal (too short)
    const badAppeal = await reqJson('/api/advertiser/campaigns/cmp_1/appeal', {
      method: 'POST',
      token: advToken,
      body: { reason: 'short' },
    });
    assert.equal(badAppeal.status, 400);
    assert.ok(badAppeal.data.fieldErrors?.reason);

    // Invalid profile & security settings
    const badProfile = await reqJson('/api/auth/profile', {
      method: 'PATCH',
      token: advToken,
      body: { fullName: 'A', country: 'ZZZ' },
    });
    assert.equal(badProfile.status, 400);
    assert.ok(badProfile.data.fieldErrors?.fullName);
    assert.ok(badProfile.data.fieldErrors?.country);

    const badSec = await reqJson('/api/auth/settings', {
      method: 'PATCH',
      token: advToken,
      body: { sessionTimeoutMinutes: 5, currentPassword: 'TestAdvPass!123', newPassword: 'TestAdvPass!123' },
    });
    assert.equal(badSec.status, 400);
    assert.ok(badSec.data.fieldErrors?.sessionTimeoutMinutes);
    assert.ok(badSec.data.fieldErrors?.newPassword);
  } finally {
    await close();
  }
});

test('HTTP Validation: Publisher, Admin, Ad Delivery & Looma Integration routes return 400 on invalid payloads', async () => {
  const { reqJson, authenticateActors, close } = await startValidationServer();
  try {
    const { pubToken, adminToken } = await authenticateActors();

    // Publisher invalid property
    const badProp = await reqJson('/api/publisher/properties', {
      method: 'POST',
      token: pubToken,
      body: { propertyType: 'website', name: 'X', domainOrBundle: 'http://localhost/bad', monthlyPageviews: -1 },
    });
    assert.equal(badProp.status, 400);
    assert.ok(badProp.data.fieldErrors?.name);
    assert.ok(badProp.data.fieldErrors?.domainOrBundle);
    assert.ok(badProp.data.fieldErrors?.monthlyPageviews);

    // Publisher invalid placement
    const badPlc = await reqJson('/api/publisher/placements', {
      method: 'POST',
      token: pubToken,
      body: { propertyId: '', name: 'A', format: 'invalid', dimensions: 'bad dim', floorCpmUsd: 0.01 },
    });
    assert.equal(badPlc.status, 400);
    assert.ok(badPlc.data.fieldErrors?.propertyId);
    assert.ok(badPlc.data.fieldErrors?.name);
    assert.ok(badPlc.data.fieldErrors?.format);
    assert.ok(badPlc.data.fieldErrors?.dimensions);
    assert.ok(badPlc.data.fieldErrors?.floorCpmUsd);

    // Publisher invalid payout method & withdrawal
    const badPayout = await reqJson('/api/publisher/payout-method', {
      method: 'PATCH',
      token: pubToken,
      body: { payoutMethodType: 'crypto', payoutDestination: '123' },
    });
    assert.equal(badPayout.status, 400);
    assert.ok(badPayout.data.fieldErrors?.payoutMethodType);
    assert.ok(badPayout.data.fieldErrors?.payoutDestination);

    const badWdr = await reqJson('/api/publisher/withdraw', {
      method: 'POST',
      token: pubToken,
      body: { amountUsd: 10 },
    });
    assert.equal(badWdr.status, 400);
    assert.ok(badWdr.data.fieldErrors?.amountUsd);

    // Admin invalid prohibited category & settings
    const badCat = await reqJson('/api/admin/prohibited-categories', {
      method: 'POST',
      token: adminToken,
      body: { name: 'A', keywords: [], severity: 'destroy' },
    });
    assert.equal(badCat.status, 400);
    assert.ok(badCat.data.fieldErrors?.name);
    assert.ok(badCat.data.fieldErrors?.keywords);
    assert.ok(badCat.data.fieldErrors?.severity);

    const badSettings = await reqJson('/api/admin/settings', {
      method: 'PUT',
      token: adminToken,
      body: { settings: { default_publisher_share_bps: 100, gdpr_consent_enforcement: 'invalid' } },
    });
    assert.equal(badSettings.status, 400);
    assert.ok(badSettings.data.fieldErrors?.default_publisher_share_bps);
    assert.ok(badSettings.data.fieldErrors?.gdpr_consent_enforcement);

    // Ad delivery invalid request
    const badAdReq = await reqJson('/api/v1/ad/request', {
      method: 'POST',
      body: { placementId: '', country: 'INVALID', deviceCategory: 'toaster' },
    });
    assert.equal(badAdReq.status, 400);
    assert.ok(badAdReq.data.fieldErrors?.placementId);

    // Looma integration invalid feed/ads payload (authenticated as publisher)
    const badFeed = await reqJson('/api/v1/looma/feed/ads', {
      method: 'POST',
      token: pubToken,
      body: { slots: [], country: 'INVALID' },
    });
    assert.equal(badFeed.status, 400);
    assert.ok(badFeed.data.fieldErrors?.slots);
  } finally {
    await close();
  }
});
