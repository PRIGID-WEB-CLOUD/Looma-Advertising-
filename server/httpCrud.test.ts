import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cors from 'cors';
import { getDb } from './db';
import { seedDatabaseIfEmpty } from './seed';
import { hashPassword } from './auth';
import { createAdDeliveryRouter, getPublisherSdkScript } from './routes/adDelivery';
import { createAdvertiserRouter } from './routes/advertiser';
import { createPublisherRouter } from './routes/publisher';
import { createAdminRouter } from './routes/admin';
import { createPublicAndAuthRouter } from './routes/publicAndAuth';
import { createLoomaIntegrationRouter } from './routes/loomaIntegration';
import { generateTotpCode } from './security';

const MEDIA_EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

async function startTestServer() {
  const tempUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-ads-uploads-'));
  process.env.LOOMA_STORAGE_DIR = tempUploadDir;

  const db = getDb(':memory:');
  seedDatabaseIfEmpty(db);

  const app = express();
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use(
    express.json({
      limit: '15mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  app.get('/api/media/:filename', (req, res) => {
    const rawName = String(req.params.filename || '');
    if (!/^[a-zA-Z0-9._-]+$/.test(rawName)) {
      res.status(400).json({ error: 'Invalid media filename' });
      return;
    }
    const ext = path.extname(rawName).toLowerCase();
    const mimeType = MEDIA_EXT_TO_MIME[ext];
    if (!mimeType) {
      res.status(404).json({ error: 'Unsupported media file' });
      return;
    }
    const uploadDir = path.resolve(process.cwd(), process.env.LOOMA_STORAGE_DIR || 'data/uploads');
    const resolvedPath = path.resolve(uploadDir, rawName);
    if (!resolvedPath.startsWith(uploadDir + path.sep) || !fs.existsSync(resolvedPath)) {
      res.status(404).json({ error: 'Media asset not found' });
      return;
    }
    res.setHeader('Content-Type', mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(resolvedPath);
  });

  app.use('/api/v1/looma', cors({ origin: '*' }), createLoomaIntegrationRouter(db));
  app.use('/api/v1/ad', cors({ origin: '*' }), createAdDeliveryRouter(db));
  app.get('/sdk/looma-ads.js', cors({ origin: '*' }), (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.send(getPublisherSdkScript());
  });

  const adminCors = cors({
    origin: (origin, cb) => {
      if (!origin || ['http://localhost:3001', 'http://127.0.0.1:3001'].includes(origin)) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
    credentials: true,
  });

  const noStoreMiddleware: express.RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  app.use('/api/advertiser', noStoreMiddleware, createAdvertiserRouter(db));
  app.use('/api/publisher', noStoreMiddleware, createPublisherRouter(db));
  app.use('/api/admin', noStoreMiddleware, adminCors, createAdminRouter(db));
  app.use('/api/auth', noStoreMiddleware);
  app.use('/api', adminCors, createPublicAndAuthRouter(db));
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'looma-advertising',
    });
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function reqJson<T = Record<string, any>>(
    urlPath: string,
    opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const headers: Record<string, string> = {
      ...(opts.headers || {}),
    };
    if (opts.token) {
      headers.Authorization = `Bearer ${opts.token}`;
    }
    let bodyStr: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
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
    return { status: res.status, data: data as T, headers: res.headers };
  }

  async function authenticateTestActors() {
    // Provision test-only passwords in the isolated in-memory test DB and sign in through real endpoints
    db.prepare("UPDATE users SET password_hash = ? WHERE id = 'usr_adv_1'").run(hashPassword('TestAdvPass!123'));
    db.prepare("UPDATE users SET password_hash = ? WHERE id = 'usr_pub_looma'").run(hashPassword('TestPubPass!123'));

    const advRow = db.prepare("SELECT email FROM users WHERE id = 'usr_adv_1'").get() as { email: string };
    const pubRow = db.prepare("SELECT email FROM users WHERE id = 'usr_pub_looma'").get() as { email: string };

    const advLogin = await reqJson('/api/auth/login', {
      method: 'POST',
      body: { email: advRow.email, password: 'TestAdvPass!123' },
    });
    assert.equal(advLogin.status, 200);

    const pubLogin = await reqJson('/api/auth/login', {
      method: 'POST',
      body: { email: pubRow.email, password: 'TestPubPass!123' },
    });
    assert.equal(pubLogin.status, 200);

    const adminClaim = await reqJson('/api/auth/admin-claim', {
      method: 'POST',
      body: {
        email: 'operator.test@looma-ads.com',
        fullName: 'Test Operator',
        password: 'AdminStrongPassword!99',
      },
    });
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

  return { baseUrl, db, reqJson, authenticateTestActors, close };
}

test('HTTP E2E: Public, Minimized Health, Security Headers, SDK, CORS Preflight, and 404 JSON fallback', async () => {
  const { baseUrl, reqJson, close } = await startTestServer();
  try {
    const health = await reqJson('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);
    assert.equal(health.data.monitoring, undefined);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');

    const overview = await reqJson('/api/public/overview');
    assert.equal(overview.status, 200);
    assert.ok(Array.isArray(overview.data.pricingModels));
    assert.ok(overview.data.pricingModels.length >= 6);

    const fx = await reqJson('/api/public/fx-rates');
    assert.equal(fx.status, 200);
    assert.equal(fx.data.baseCurrency, 'USD');

    const sdkRes = await fetch(`${baseUrl}/sdk/looma-ads.js`);
    assert.equal(sdkRes.status, 200);
    const sdkBody = await sdkRes.text();
    assert.ok(sdkBody.includes('LoomaAds'));

    const contactBad = await reqJson('/api/public/contact', { method: 'POST', body: { name: 'A' } });
    assert.equal(contactBad.status, 400);

    const contactOk = await reqJson('/api/public/contact', {
      method: 'POST',
      body: { name: 'Jane Ops', email: 'jane@looma.io', company: 'Looma', message: 'Testing contact endpoint' },
    });
    assert.equal(contactOk.status, 201);
    assert.equal(contactOk.data.received, true);

    const privacyOk = await reqJson('/api/public/privacy-request', {
      method: 'POST',
      body: { email: 'user@example.com', requestType: 'data_export', jurisdiction: 'GDPR', details: 'Export please' },
    });
    assert.equal(privacyOk.status, 201);
    assert.equal(privacyOk.data.submitted, true);

    const notFound = await reqJson('/api/does-not-exist');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.data.error, 'API endpoint not found');

    const corsAllowed = await fetch(`${baseUrl}/api/admin/overview`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3001', 'Access-Control-Request-Method': 'PATCH' },
    });
    assert.equal(corsAllowed.headers.get('access-control-allow-origin'), 'http://localhost:3001');

    const corsBlocked = await fetch(`${baseUrl}/api/admin/overview`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'PATCH' },
    });
    assert.equal(corsBlocked.headers.get('access-control-allow-origin'), null);
  } finally {
    await close();
  }
});

test('HTTP E2E: Security Hardening — Auth, Demo Bypass Blocked, One-Time Admin Claim, Session Revocation, Password Reset Privacy & RBAC', async () => {
  const { db, reqJson, close } = await startTestServer();
  const prevPasscode = process.env.ADMIN_PASSCODE;
  delete process.env.ADMIN_PASSCODE;
  try {
    // Unauthenticated demo-session bypass must always be rejected with 403
    for (const role of ['admin', 'advertiser', 'publisher']) {
      const bypass = await reqJson('/api/auth/demo-session', { method: 'POST', body: { role } });
      assert.equal(bypass.status, 403);
      assert.equal(bypass.data.token, undefined);
    }

    // One-time admin claim succeeds once, then permanently locks itself
    const setupBefore = await reqJson('/api/auth/admin-setup-status');
    assert.equal(setupBefore.status, 200);
    assert.equal(setupBefore.data.adminClaimed, false);

    const claim1 = await reqJson('/api/auth/admin-claim', {
      method: 'POST',
      body: { email: 'chief.admin@looma-ads.com', fullName: 'Chief Admin', password: 'StrongAdminPassword!1' },
    });
    assert.equal(claim1.status, 201);
    assert.ok(claim1.data.token);

    const claim2 = await reqJson('/api/auth/admin-claim', {
      method: 'POST',
      body: { email: 'attacker@evil.example', fullName: 'Attacker', password: 'AttackerPassword!99' },
    });
    assert.equal(claim2.status, 403);

    // ADMIN_PASSCODE env override takes precedence over DB password for admin logins
    process.env.ADMIN_PASSCODE = 'EnvOverridePasscode#2026';
    const wrongAdminLogin = await reqJson('/api/auth/login', {
      method: 'POST',
      body: { email: 'chief.admin@looma-ads.com', password: 'StrongAdminPassword!1' },
    });
    assert.equal(wrongAdminLogin.status, 401);
    const envAdminLogin = await reqJson('/api/auth/login', {
      method: 'POST',
      body: { email: 'chief.admin@looma-ads.com', password: 'EnvOverridePasscode#2026' },
    });
    assert.equal(envAdminLogin.status, 200);
    assert.ok(envAdminLogin.data.token);
    delete process.env.ADMIN_PASSCODE;

    // External publisher self-registration blocked at launch
    const pubBlock = await reqJson('/api/auth/register', {
      method: 'POST',
      body: {
        email: 'extpub@example.com',
        fullName: 'Ext Pub',
        password: 'Password123!',
        role: 'publisher',
        organizationName: 'External News',
      },
    });
    assert.equal(pubBlock.status, 403);

    // Register advertiser
    const reg = await reqJson('/api/auth/register', {
      method: 'POST',
      body: {
        email: 'crud.adv@example.com',
        fullName: 'CRUD Advertiser',
        password: 'Password123!',
        role: 'advertiser',
        organizationName: 'CRUD Media LLC',
        country: 'US',
      },
    });
    assert.equal(reg.status, 201);
    let token = reg.data.token as string;
    assert.ok(token);
    assert.equal(reg.headers.get('cache-control'), 'no-store');

    // Duplicate email rejected
    const dupReg = await reqJson('/api/auth/register', {
      method: 'POST',
      body: {
        email: 'crud.adv@example.com',
        fullName: 'Dup',
        password: 'Password123!',
        role: 'advertiser',
        organizationName: 'Dup Co',
      },
    });
    assert.equal(dupReg.status, 409);

    // GET /api/auth/me & unauth 401
    assert.equal((await reqJson('/api/auth/me')).status, 401);
    const me = await reqJson('/api/auth/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, 'crud.adv@example.com');

    // RBAC checks (cross-role access denied with 403)
    assert.equal((await reqJson('/api/admin/overview', { token })).status, 403);
    assert.equal((await reqJson('/api/publisher/overview', { token })).status, 403);

    // PATCH profile, preferences, settings (password change invalidates old token and returns refreshed token)
    assert.equal(
      (
        await reqJson('/api/auth/profile', {
          method: 'PATCH',
          token,
          body: { fullName: 'Updated CRUD Adv', organizationName: 'CRUD Media Global', country: 'GB' },
        })
      ).status,
      200
    );
    assert.equal(
      (
        await reqJson('/api/auth/preferences', {
          method: 'PATCH',
          token,
          body: { timezone: 'Europe/London', preferredCurrency: 'GBP', compactDensity: true, emailAlerts: true },
        })
      ).status,
      200
    );
    const oldTokenBeforePwChange = token;
    const settingsRes = await reqJson('/api/auth/settings', {
      method: 'PATCH',
      token,
      body: {
        twoFactorEnabled: false,
        sessionTimeoutMinutes: 120,
        currentPassword: 'Password123!',
        newPassword: 'NewPassword456!',
      },
    });
    assert.equal(settingsRes.status, 200);
    assert.ok(settingsRes.data.token);
    // Old token must be rejected after password rotation
    assert.equal((await reqJson('/api/auth/me', { token: oldTokenBeforePwChange })).status, 401);
    token = settingsRes.data.token as string;
    assert.equal((await reqJson('/api/auth/me', { token })).status, 200);

    // Email verification flow — must NOT leak previewCode in HTTP response
    const reqVerify = await reqJson('/api/auth/request-email-verification', { method: 'POST', token });
    assert.equal(reqVerify.status, 200);
    assert.equal(reqVerify.data.previewCode, undefined);

    const verifyEmailRow = db
      .prepare(
        "SELECT body_text FROM email_outbox WHERE recipient_email = 'crud.adv@example.com' AND subject LIKE '%Verify%' ORDER BY created_at DESC LIMIT 1"
      )
      .get() as { body_text: string };
    const verifyCodeMatch = verifyEmailRow.body_text.match(/\b(\d{6})\b/);
    assert.ok(verifyCodeMatch);

    const verifyEmail = await reqJson('/api/auth/verify-email', {
      method: 'POST',
      token,
      body: { code: verifyCodeMatch[1] },
    });
    assert.equal(verifyEmail.status, 200);
    assert.equal(verifyEmail.data.verified, true);

    // TOTP 2FA setup -> verify -> login challenge -> login success -> disable
    const setup2fa = await reqJson('/api/auth/2fa/setup', { method: 'POST', token });
    assert.equal(setup2fa.status, 200);
    const totpCode = generateTotpCode(setup2fa.data.secretBase32);
    const verify2fa = await reqJson('/api/auth/2fa/verify', { method: 'POST', token, body: { code: totpCode } });
    assert.equal(verify2fa.status, 200);

    const loginNeeds2fa = await reqJson('/api/auth/login', {
      method: 'POST',
      body: { email: 'crud.adv@example.com', password: 'NewPassword456!' },
    });
    assert.equal(loginNeeds2fa.status, 200);
    assert.equal(loginNeeds2fa.data.requiresTwoFactor, true);

    const loginWith2fa = await reqJson('/api/auth/login', {
      method: 'POST',
      body: { email: 'crud.adv@example.com', password: 'NewPassword456!', totpCode },
    });
    assert.equal(loginWith2fa.status, 200);
    assert.ok(loginWith2fa.data.token);

    assert.equal((await reqJson('/api/auth/2fa/disable', { method: 'POST', token })).status, 200);

    // Forgot password -> must NOT leak previewResetCode in public response -> Reset password invalidates existing tokens
    const forgot = await reqJson('/api/auth/forgot-password', {
      method: 'POST',
      body: { email: 'crud.adv@example.com' },
    });
    assert.equal(forgot.status, 200);
    assert.equal(forgot.data.previewResetCode, undefined);

    const resetEmailRow = db
      .prepare(
        "SELECT body_text FROM email_outbox WHERE recipient_email = 'crud.adv@example.com' AND subject LIKE '%Reset%' ORDER BY created_at DESC LIMIT 1"
      )
      .get() as { body_text: string };
    const resetCodeMatch = resetEmailRow.body_text.match(/reset code ([A-F0-9]{8})/i);
    assert.ok(resetCodeMatch);

    const reset = await reqJson('/api/auth/reset-password', {
      method: 'POST',
      body: { email: 'crud.adv@example.com', token: resetCodeMatch[1], newPassword: 'ResetPassword789!' },
    });
    assert.equal(reset.status, 200);

    // Prior token must be invalidated after password reset
    assert.equal((await reqJson('/api/auth/me', { token })).status, 401);

    const loginReset = await reqJson('/api/auth/login', {
      method: 'POST',
      body: { email: 'crud.adv@example.com', password: 'ResetPassword789!' },
    });
    assert.equal(loginReset.status, 200);
    const freshToken = loginReset.data.token as string;

    const account = await reqJson('/api/auth/account', { token: freshToken });
    assert.equal(account.status, 200);
    assert.equal(account.data.profile.fullName, 'Updated CRUD Adv');
    assert.equal(account.data.profile.emailVerified, true);
    assert.equal(account.data.preferences.preferredCurrency, 'GBP');

    // Explicit logout immediately revokes the Bearer token server-side
    const logoutRes = await reqJson('/api/auth/logout', { method: 'POST', token: freshToken });
    assert.equal(logoutRes.status, 200);
    assert.equal(logoutRes.data.loggedOut, true);
    assert.equal((await reqJson('/api/auth/me', { token: freshToken })).status, 401);
  } finally {
    if (prevPasscode !== undefined) process.env.ADMIN_PASSCODE = prevPasscode;
    else delete process.env.ADMIN_PASSCODE;
    await close();
  }
});

test('HTTP E2E: Advertiser Full CRUD (GET/POST/PUT/PATCH/DELETE), Media Upload/Delete, Billing, CSV & Policy Scanner', async () => {
  const { baseUrl, reqJson, authenticateTestActors, close } = await startTestServer();
  try {
    const { advToken, adminToken } = await authenticateTestActors();

    assert.equal((await reqJson('/api/advertiser/overview', { token: advToken })).status, 200);
    assert.equal((await reqJson('/api/advertiser/campaigns', { token: advToken })).status, 200);

    // Invalid enum returns 400 (not 500)
    const badEnum = await reqJson('/api/advertiser/campaigns', {
      method: 'POST',
      token: advToken,
      body: {
        name: 'Bad Pricing',
        pricingModel: 'INVALID_MODEL',
        title: 'Title',
        description: 'Desc',
        destinationUrl: 'https://example.com',
      },
    });
    assert.equal(badEnum.status, 400);

    // Add a review-severity policy rule and verify review-flagged campaign inserts cleanly into moderation_reviews
    const revRule = await reqJson('/api/admin/prohibited-categories', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Health Claims Review Test', keywords: ['miracle-supplement-test'], severity: 'review' },
    });
    assert.equal(revRule.status, 201);

    const flaggedCamp = await reqJson('/api/advertiser/campaigns', {
      method: 'POST',
      token: advToken,
      body: {
        name: 'Flagged Campaign',
        pricingModel: 'CPC',
        title: 'Try miracle-supplement-test today',
        description: 'Clean test copy',
        destinationUrl: 'https://example.com/flagged',
      },
    });
    assert.equal(flaggedCamp.status, 201);
    assert.ok(flaggedCamp.data.reviewFlags.length >= 1);

    // Create clean campaign
    const created = await reqJson('/api/advertiser/campaigns', {
      method: 'POST',
      token: advToken,
      body: {
        name: 'Launch Campaign CRUD',
        pricingModel: 'CPC',
        dailyBudgetUsd: 60,
        totalBudgetUsd: 600,
        maxBidUsd: 1.4,
        title: 'Build Faster',
        description: 'Zero-latency tools',
        destinationUrl: 'https://example.com/build',
      },
    });
    assert.equal(created.status, 201);
    const cmpId = created.data.campaignId as string;
    const unapprovedCreativeId = created.data.creativeId as string;

    // Unapproved pending creative must NOT be exposed publicly on /api/v1/ad/creative/:id
    const pendingCrtRes = await reqJson(`/api/v1/ad/creative/${unapprovedCreativeId}`);
    assert.equal(pendingCrtRes.status, 404);

    // GET single campaign
    const fetched = await reqJson(`/api/advertiser/campaigns/${cmpId}`, { token: advToken });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.data.campaign.name, 'Launch Campaign CRUD');

    // PATCH update (budget + creative + targeting)
    const patched = await reqJson(`/api/advertiser/campaigns/${cmpId}`, {
      method: 'PATCH',
      token: advToken,
      body: {
        name: 'Launch Campaign Patched',
        dailyBudgetUsd: 90,
        title: 'Build Even Faster',
        targeting: { countries: ['US', 'CA'], deviceCategories: ['desktop', 'mobile'] },
      },
    });
    assert.equal(patched.status, 200);

    // PUT update
    const putRes = await reqJson(`/api/advertiser/campaigns/${cmpId}`, {
      method: 'PUT',
      token: advToken,
      body: {
        name: 'Launch Campaign PUT',
        totalBudgetUsd: 900,
        maxBidUsd: 1.75,
        ctaText: 'Start Free',
      },
    });
    assert.equal(putRes.status, 200);

    const afterPut = await reqJson(`/api/advertiser/campaigns/${cmpId}`, { token: advToken });
    assert.equal(afterPut.data.campaign.name, 'Launch Campaign PUT');
    assert.equal(afterPut.data.campaign.cta_text, 'Start Free');

    // Duplicate campaign
    const dup = await reqJson(`/api/advertiser/campaigns/${cmpId}/duplicate`, { method: 'POST', token: advToken });
    assert.equal(dup.status, 201);
    const dupId = dup.data.campaignId as string;

    // DELETE unused duplicated campaign (hard delete)
    const delUnused = await reqJson(`/api/advertiser/campaigns/${dupId}`, { method: 'DELETE', token: advToken });
    assert.equal(delUnused.status, 200);
    assert.equal(delUnused.data.deleted, true);
    assert.equal((await reqJson(`/api/advertiser/campaigns/${dupId}`, { token: advToken })).status, 404);

    // DELETE delivered seeded campaign cmp_1 (archives safely instead of breaking FK/ledger history)
    const delUsed = await reqJson('/api/advertiser/campaigns/cmp_1', { method: 'DELETE', token: advToken });
    assert.equal(delUsed.status, 200);
    assert.equal(delUsed.data.archived, true);

    // Media upload (PNG magic bytes) -> list -> GET binary -> DELETE -> 404 binary
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    const uploadOk = await reqJson('/api/advertiser/media', {
      method: 'POST',
      token: advToken,
      body: { filename: 'banner.png', mimeType: 'image/png', dataBase64: pngHeader.toString('base64') },
    });
    assert.equal(uploadOk.status, 201);

    const mediaList = await reqJson('/api/advertiser/media', { token: advToken });
    assert.equal(mediaList.status, 200);
    assert.ok(mediaList.data.assets.some((a: any) => a.id === uploadOk.data.assetId));

    const binFetch = await fetch(`${baseUrl}${uploadOk.data.url}`);
    assert.equal(binFetch.status, 200);
    assert.equal(binFetch.headers.get('content-type'), 'image/png');

    const delMedia = await reqJson(`/api/advertiser/media/${uploadOk.data.assetId}`, { method: 'DELETE', token: advToken });
    assert.equal(delMedia.status, 200);
    assert.equal((await fetch(`${baseUrl}${uploadOk.data.url}`)).status, 404);

    // Reporting JSON & CSV
    const rep = await reqJson('/api/advertiser/reporting?days=30', { token: advToken });
    assert.equal(rep.status, 200);
    assert.ok(Array.isArray(rep.data.dailySeries));

    const csvRes = await fetch(`${baseUrl}/api/advertiser/reporting/csv`, {
      headers: { Authorization: `Bearer ${advToken}` },
    });
    assert.equal(csvRes.status, 200);
    assert.ok((await csvRes.text()).includes('Campaign ID,Campaign Name'));

    // Billing: deposit + idempotency + refund
    const dep1 = await reqJson('/api/advertiser/deposit', {
      method: 'POST',
      token: advToken,
      body: { amountUsd: 150, provider: 'paystack', idempotencyKey: 'idem_http_test_1' },
    });
    assert.equal(dep1.status, 201);
    const depReplay = await reqJson('/api/advertiser/deposit', {
      method: 'POST',
      token: advToken,
      body: { amountUsd: 150, provider: 'paystack', idempotencyKey: 'idem_http_test_1' },
    });
    assert.equal(depReplay.status, 200);
    assert.equal(depReplay.data.duplicate, true);

    const refund = await reqJson('/api/advertiser/refund', {
      method: 'POST',
      token: advToken,
      body: { amountUsd: 25, reason: 'Test partial refund' },
    });
    assert.equal(refund.status, 201);

    const billing = await reqJson('/api/advertiser/billing', { token: advToken });
    assert.equal(billing.status, 200);
    assert.ok(billing.data.deposits.length >= 1);
  } finally {
    await close();
  }
});

test('HTTP E2E: Publisher CRUD, Admin Operations, Appeals, Withdrawals, Hardened Looma Adapter, Ad Delivery & Fail-Closed Webhooks', async () => {
  const { reqJson, authenticateTestActors, close } = await startTestServer();
  const prevAdapterKey = process.env.LOOMA_ADAPTER_KEY;
  const prevPaystackSecret = process.env.PAYSTACK_WEBHOOK_SECRET;
  const prevFlwHash = process.env.FLUTTERWAVE_WEBHOOK_HASH;
  const prevStripeSecret = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.LOOMA_ADAPTER_KEY;
  delete process.env.PAYSTACK_WEBHOOK_SECRET;
  delete process.env.FLUTTERWAVE_WEBHOOK_HASH;
  delete process.env.STRIPE_WEBHOOK_SECRET;

  try {
    const { advToken, pubToken, adminToken } = await authenticateTestActors();

    // Publisher overview & property CRUD
    assert.equal((await reqJson('/api/publisher/overview', { token: pubToken })).status, 200);
    const propCreate = await reqJson('/api/publisher/properties', {
      method: 'POST',
      token: pubToken,
      body: {
        propertyType: 'website',
        name: 'Looma Test Feed',
        domainOrBundle: 'feed.looma.test',
        category: 'business_finance',
        verificationMethod: 'dns_txt',
      },
    });
    assert.equal(propCreate.status, 201);
    const propId = propCreate.data.propertyId as string;

    assert.equal(
      (
        await reqJson(`/api/publisher/properties/${propId}`, {
          method: 'PATCH',
          token: pubToken,
          body: { name: 'Looma Test Feed Renamed', monthlyPageviews: 120000 },
        })
      ).status,
      200
    );

    const verifyProp = await reqJson(`/api/publisher/properties/${propId}/verify`, {
      method: 'POST',
      token: pubToken,
      body: { sandboxOverride: true },
    });
    assert.equal(verifyProp.status, 200);
    assert.equal(verifyProp.data.verified, true);

    // Placement CRUD + property delete guard
    const plcCreate = await reqJson('/api/publisher/placements', {
      method: 'POST',
      token: pubToken,
      body: { propertyId: propId, name: 'Test Slot', format: 'native', dimensions: 'responsive', floorCpmUsd: 1.2 },
    });
    assert.equal(plcCreate.status, 201);
    const plcId = plcCreate.data.placementId as string;

    assert.equal(
      (
        await reqJson(`/api/publisher/placements/${plcId}`, {
          method: 'PATCH',
          token: pubToken,
          body: { status: 'paused', name: 'Test Slot Updated', floorCpmUsd: 1.5 },
        })
      ).status,
      200
    );

    // Cannot delete property while placement exists
    assert.equal((await reqJson(`/api/publisher/properties/${propId}`, { method: 'DELETE', token: pubToken })).status, 409);

    // Delete unused placement then delete property
    const delPlc = await reqJson(`/api/publisher/placements/${plcId}`, { method: 'DELETE', token: pubToken });
    assert.equal(delPlc.status, 200);
    assert.equal(delPlc.data.deleted, true);

    const delProp = await reqJson(`/api/publisher/properties/${propId}`, { method: 'DELETE', token: pubToken });
    assert.equal(delProp.status, 200);
    assert.equal(delProp.data.deleted, true);

    // Publisher earnings, payout method, withdrawal + admin decision
    assert.equal((await reqJson('/api/publisher/earnings', { token: pubToken })).status, 200);
    assert.equal(
      (
        await reqJson('/api/publisher/payout-method', {
          method: 'PATCH',
          token: pubToken,
          body: { payoutMethodType: 'bank_transfer', payoutDestination: 'US-ACH-9910' },
        })
      ).status,
      200
    );
    const wdr = await reqJson('/api/publisher/withdraw', {
      method: 'POST',
      token: pubToken,
      body: { amountUsd: 60 },
    });
    assert.equal(wdr.status, 201);

    const wdrDec = await reqJson(`/api/admin/withdrawals/${wdr.data.withdrawalId}/decision`, {
      method: 'POST',
      token: adminToken,
      body: { decision: 'paid', notes: 'Settled in E2E test' },
    });
    assert.equal(wdrDec.status, 200);
    assert.equal(wdrDec.data.decision, 'paid');

    // Admin overview, advertisers, publishers, moderation, appeals, policy rules CRUD, settings, jobs, monitoring
    assert.equal((await reqJson('/api/admin/overview', { token: adminToken })).status, 200);
    assert.equal((await reqJson('/api/admin/advertisers', { token: adminToken })).status, 200);
    assert.equal(
      (
        await reqJson('/api/admin/advertisers/adv_1', {
          method: 'PATCH',
          token: adminToken,
          body: { verificationStatus: 'verified', accountStatus: 'active' },
        })
      ).status,
      200
    );
    assert.equal((await reqJson('/api/admin/publishers', { token: adminToken })).status, 200);
    assert.equal(
      (
        await reqJson('/api/admin/publishers/pub_looma_1p', {
          method: 'PATCH',
          token: adminToken,
          body: { approvalStatus: 'approved', customRevenueShareBps: 7500 },
        })
      ).status,
      200
    );

    // Create campaign -> admin rejects -> advertiser appeals -> admin approves -> second appeal decision rejected 400
    const appealCamp = await reqJson('/api/advertiser/campaigns', {
      method: 'POST',
      token: advToken,
      body: {
        name: 'Appeal Lifecycle Test',
        pricingModel: 'CPC',
        title: 'Clean Ad',
        description: 'Compliant copy',
        destinationUrl: 'https://example.com/clean',
      },
    });
    assert.equal(appealCamp.status, 201);
    const appealCampId = appealCamp.data.campaignId as string;

    assert.equal(
      (
        await reqJson('/api/admin/moderation/decision', {
          method: 'POST',
          token: adminToken,
          body: { campaignId: appealCampId, decision: 'rejected', reason: 'Needs verification' },
        })
      ).status,
      200
    );

    const appealSub = await reqJson(`/api/advertiser/campaigns/${appealCampId}/appeal`, {
      method: 'POST',
      token: advToken,
      body: { reason: 'We have updated our landing page disclosures and comply fully with policy.' },
    });
    assert.equal(appealSub.status, 201);
    assert.equal((await reqJson('/api/advertiser/appeals', { token: advToken })).status, 200);

    assert.equal(
      (
        await reqJson(`/api/admin/appeals/${appealSub.data.appealId}/decision`, {
          method: 'POST',
          token: adminToken,
          body: { decision: 'approved', adminResponse: 'Verified disclosures' },
        })
      ).status,
      200
    );
    assert.equal(
      (
        await reqJson(`/api/admin/appeals/${appealSub.data.appealId}/decision`, {
          method: 'POST',
          token: adminToken,
          body: { decision: 'rejected', adminResponse: 'Double decision must fail' },
        })
      ).status,
      400
    );

    // Prohibited categories CRUD (POST -> 409 dup -> PATCH -> DELETE -> 404)
    const pol = await reqJson('/api/admin/prohibited-categories', {
      method: 'POST',
      token: adminToken,
      body: { name: 'E2E Policy Rule', keywords: ['badword1', 'badword2'], severity: 'block' },
    });
    assert.equal(pol.status, 201);
    assert.equal(
      (
        await reqJson('/api/admin/prohibited-categories', {
          method: 'POST',
          token: adminToken,
          body: { name: 'e2e policy rule', keywords: ['dup'], severity: 'block' },
        })
      ).status,
      409
    );
    const polPatch = await reqJson(`/api/admin/prohibited-categories/${pol.data.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: { severity: 'review', active: false, keywords: ['updatedword'] },
    });
    assert.equal(polPatch.status, 200);
    assert.equal(polPatch.data.severity, 'review');
    assert.equal(polPatch.data.active, false);
    assert.equal((await reqJson(`/api/admin/prohibited-categories/${pol.data.id}`, { method: 'DELETE', token: adminToken })).status, 200);
    assert.equal((await reqJson(`/api/admin/prohibited-categories/${pol.data.id}`, { method: 'DELETE', token: adminToken })).status, 404);

    // Settings GET/PUT, Monitoring, Jobs, Finance
    const settingsGet = await reqJson('/api/admin/settings', { token: adminToken });
    assert.equal(settingsGet.status, 200);
    assert.equal(
      (
        await reqJson('/api/admin/settings', {
          method: 'PUT',
          token: adminToken,
          body: { settings: { default_publisher_share_bps: 7200 } },
        })
      ).status,
      200
    );
    assert.equal((await reqJson('/api/admin/monitoring', { token: adminToken })).status, 200);
    assert.equal((await reqJson('/api/admin/finance', { token: adminToken })).status, 200);
    assert.equal((await reqJson('/api/admin/jobs', { token: adminToken })).status, 200);
    assert.equal(
      (
        await reqJson('/api/admin/jobs/run', {
          method: 'POST',
          token: adminToken,
          body: { jobName: 'release_expired_reservations' },
        })
      ).status,
      200
    );

    // Looma Contract, Hardened SSO Assertion Minting & Exchange + Replay Block, and Authenticated Feed Adapter
    const contract = await reqJson('/api/v1/looma/contract');
    assert.equal(contract.status, 200);
    assert.equal(contract.data.contractVersion, '2026-11-v1');
    const firstPlacementId = contract.data.placements[0].id as string;

    // Without LOOMA_ADAPTER_KEY configured, demo-assertion must fail closed (403) and anonymous feed/ads must fail (401)
    assert.equal((await reqJson('/api/v1/looma/sso/demo-assertion', { method: 'POST', body: {} })).status, 403);
    assert.equal(
      (
        await reqJson('/api/v1/looma/feed/ads', {
          method: 'POST',
          body: { slots: [{ slotIndex: 2, placementId: firstPlacementId }], country: 'US', deviceCategory: 'mobile' },
        })
      ).status,
      401
    );

    // Advertiser token cannot call feed/ads (401), publisher token succeeds (200)
    assert.equal(
      (
        await reqJson('/api/v1/looma/feed/ads', {
          method: 'POST',
          token: advToken,
          body: { slots: [{ slotIndex: 2, placementId: firstPlacementId }], country: 'US', deviceCategory: 'mobile' },
        })
      ).status,
      401
    );
    const feedAdsPub = await reqJson('/api/v1/looma/feed/ads', {
      method: 'POST',
      token: pubToken,
      body: { slots: [{ slotIndex: 2, placementId: firstPlacementId }], country: 'US', deviceCategory: 'mobile' },
    });
    assert.equal(feedAdsPub.status, 200);
    assert.ok(Array.isArray(feedAdsPub.data.decisions));

    // Configure LOOMA_ADAPTER_KEY -> wrong key fails 401, valid key succeeds 200
    process.env.LOOMA_ADAPTER_KEY = 'test-adapter-secret-key-2026';
    assert.equal(
      (
        await reqJson('/api/v1/looma/sso/demo-assertion', {
          method: 'POST',
          headers: { 'x-looma-adapter-key': 'wrong-key' },
          body: {},
        })
      ).status,
      401
    );

    const demoAssertion = await reqJson('/api/v1/looma/sso/demo-assertion', {
      method: 'POST',
      headers: { 'x-looma-adapter-key': 'test-adapter-secret-key-2026' },
      body: {},
    });
    assert.equal(demoAssertion.status, 200);
    const ssoEx = await reqJson('/api/v1/looma/sso/exchange', {
      method: 'POST',
      body: { assertion: demoAssertion.data.assertion },
    });
    assert.equal(ssoEx.status, 200);
    assert.ok(ssoEx.data.token);
    const ssoReplay = await reqJson('/api/v1/looma/sso/exchange', {
      method: 'POST',
      body: { assertion: demoAssertion.data.assertion },
    });
    assert.equal(ssoReplay.status, 401);

    const feedAdsAdapter = await reqJson('/api/v1/looma/feed/ads', {
      method: 'POST',
      headers: { 'x-looma-adapter-key': 'test-adapter-secret-key-2026' },
      body: { slots: [{ slotIndex: 2, placementId: firstPlacementId }], country: 'US', deviceCategory: 'mobile' },
    });
    assert.equal(feedAdsAdapter.status, 200);
    assert.ok(Array.isArray(feedAdsAdapter.data.decisions));

    // Full Ad Delivery Pipeline: request -> creative GET -> impression -> click (valid + bot) -> conversion -> video-event -> install
    const adReq = await reqJson('/api/v1/ad/request', {
      method: 'POST',
      body: { placementId: firstPlacementId, country: 'US', deviceCategory: 'desktop', category: 'business_finance', consentGranted: true },
    });
    assert.equal(adReq.status, 200);
    assert.equal(adReq.data.filled, true);
    assert.ok(adReq.data.tracking.impressionToken);

    const crtRes = await reqJson(`/api/v1/ad/creative/${adReq.data.ad.creativeId}`);
    assert.equal(crtRes.status, 200);

    const impRes = await reqJson('/api/v1/ad/impression', {
      method: 'POST',
      body: { impressionToken: adReq.data.tracking.impressionToken, viewable: true },
    });
    assert.equal(impRes.status, 200);
    assert.equal(impRes.data.recorded, true);

    const clkRes = await reqJson('/api/v1/ad/click', {
      method: 'POST',
      body: { clickToken: adReq.data.tracking.clickToken, sandboxMode: true },
    });
    assert.equal(clkRes.status, 200);
    assert.equal(clkRes.data.valid, true);

    const cnvRes = await reqJson('/api/v1/ad/conversion', {
      method: 'POST',
      body: { conversionToken: adReq.data.tracking.conversionToken, eventName: 'signup', conversionValueMicros: 15_000_000 },
    });
    assert.equal(cnvRes.status, 200);
    assert.equal(cnvRes.data.recorded, true);

    const vidRes = await reqJson('/api/v1/ad/video-event', {
      method: 'POST',
      body: { videoToken: adReq.data.tracking.videoToken, eventName: 'complete', watchedMs: 15000 },
    });
    assert.equal(vidRes.status, 200);
    assert.equal(vidRes.data.recorded, true);

    const insRes = await reqJson('/api/v1/ad/install', {
      method: 'POST',
      body: { installToken: adReq.data.tracking.installToken, appBundleId: 'com.looma.app', deviceOs: 'iOS' },
    });
    assert.equal(insRes.status, 200);
    assert.equal(insRes.data.recorded, true);

    // Bot click raises fraud alert -> admin resolves fraud alert
    const botReq = await reqJson('/api/v1/ad/request', {
      method: 'POST',
      body: { placementId: firstPlacementId, country: 'US', deviceCategory: 'desktop', category: 'business_finance', consentGranted: true, sessionId: 'bot_sess_1' },
    });
    assert.equal(botReq.status, 200);
    if (botReq.data.filled) {
      await reqJson('/api/v1/ad/impression', {
        method: 'POST',
        body: { impressionToken: botReq.data.tracking.impressionToken, viewable: true, sessionId: 'bot_sess_1' },
      });
      const botClk = await reqJson('/api/v1/ad/click', {
        method: 'POST',
        body: { clickToken: botReq.data.tracking.clickToken, simulateBot: true, sessionId: 'bot_sess_1' },
      });
      assert.equal(botClk.status, 200);
      assert.equal(botClk.data.valid, false);
    }

    const fraudList = await reqJson('/api/admin/fraud', { token: adminToken });
    assert.equal(fraudList.status, 200);
    assert.ok(fraudList.data.alerts.length >= 1);
    const alertResolve = await reqJson(`/api/admin/fraud/${fraudList.data.alerts[0].id}/resolve`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'dismissed', resolutionNotes: 'Verified in E2E test' },
    });
    assert.equal(alertResolve.status, 200);

    // Budget reservation release via advertiser endpoint
    const relReq = await reqJson('/api/v1/ad/request', {
      method: 'POST',
      body: { placementId: firstPlacementId, country: 'US', deviceCategory: 'desktop', category: 'business_finance', consentGranted: true, sessionId: 'rel_sess_1' },
    });
    assert.equal(relReq.status, 200);
    if (relReq.data.reservationId) {
      const relRes = await reqJson(`/api/advertiser/reservations/${relReq.data.reservationId}/release`, {
        method: 'POST',
        token: advToken,
      });
      assert.equal(relRes.status, 200);
    }

    // Payment webhooks MUST fail closed (503) when secrets are unconfigured
    assert.equal(
      (
        await reqJson('/api/webhooks/payments/paystack', {
          method: 'POST',
          body: { eventId: 'evt_unconfigured_1', advertiserId: 'adv_1', amountUsd: 500 },
        })
      ).status,
      503
    );
    assert.equal(
      (
        await reqJson('/api/webhooks/payments/flutterwave', {
          method: 'POST',
          body: { eventId: 'evt_unconfigured_2', advertiserId: 'adv_1', amountUsd: 500 },
        })
      ).status,
      503
    );
    assert.equal(
      (
        await reqJson('/api/webhooks/payments/stripe', {
          method: 'POST',
          body: { eventId: 'evt_unconfigured_3', advertiserId: 'adv_1', amountUsd: 500 },
        })
      ).status,
      503
    );

    // Configure webhook secrets -> invalid signatures rejected (401), valid signatures succeed (200)
    process.env.PAYSTACK_WEBHOOK_SECRET = 'paystack-test-secret';
    process.env.FLUTTERWAVE_WEBHOOK_HASH = 'flw-test-hash';
    process.env.STRIPE_WEBHOOK_SECRET = 'stripe-test-secret';

    const psPayload = JSON.stringify({ eventId: 'evt_paystack_e2e_1', advertiserId: 'adv_1', amountUsd: 50 });
    const psBad = await reqJson('/api/webhooks/payments/paystack', {
      method: 'POST',
      headers: { 'x-paystack-signature': 'deadbeef' },
      body: psPayload,
    });
    assert.equal(psBad.status, 401);

    const psSig = crypto.createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET).update(psPayload).digest('hex');
    const wh1 = await reqJson('/api/webhooks/payments/paystack', {
      method: 'POST',
      headers: { 'x-paystack-signature': psSig },
      body: psPayload,
    });
    assert.equal(wh1.status, 200);
    assert.equal(wh1.data.duplicate, false);
    assert.equal(wh1.data.signatureVerified, true);

    const whDup = await reqJson('/api/webhooks/payments/paystack', {
      method: 'POST',
      headers: { 'x-paystack-signature': psSig },
      body: psPayload,
    });
    assert.equal(whDup.status, 200);
    assert.equal(whDup.data.duplicate, true);

    assert.equal(
      (
        await reqJson('/api/webhooks/payments/flutterwave', {
          method: 'POST',
          headers: { 'verif-hash': 'wrong-hash' },
          body: { eventId: 'evt_flw_bad', advertiserId: 'adv_1', amountUsd: 25 },
        })
      ).status,
      401
    );
    assert.equal(
      (
        await reqJson('/api/webhooks/payments/flutterwave', {
          method: 'POST',
          headers: { 'verif-hash': process.env.FLUTTERWAVE_WEBHOOK_HASH },
          body: { eventId: 'evt_flw_e2e_1', advertiserId: 'adv_1', amountUsd: 25 },
        })
      ).status,
      200
    );

    const stripePayload = JSON.stringify({ eventId: 'evt_stripe_e2e_1', advertiserId: 'adv_1', amountUsd: 30 });
    const stripeTs = Math.floor(Date.now() / 1000);
    const stripeSig = crypto
      .createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
      .update(`${stripeTs}.${stripePayload}`)
      .digest('hex');
    assert.equal(
      (
        await reqJson('/api/webhooks/payments/stripe', {
          method: 'POST',
          headers: { 'stripe-signature': `t=${stripeTs},v1=invalid` },
          body: stripePayload,
        })
      ).status,
      401
    );
    assert.equal(
      (
        await reqJson('/api/webhooks/payments/stripe', {
          method: 'POST',
          headers: { 'stripe-signature': `t=${stripeTs},v1=${stripeSig}` },
          body: stripePayload,
        })
      ).status,
      200
    );

    assert.equal(
      (
        await reqJson('/api/webhooks/payments/unknown_provider', {
          method: 'POST',
          body: { eventId: 'evt_bad', advertiserId: 'adv_1', amountUsd: 10 },
        })
      ).status,
      400
    );
  } finally {
    if (prevAdapterKey !== undefined) process.env.LOOMA_ADAPTER_KEY = prevAdapterKey;
    else delete process.env.LOOMA_ADAPTER_KEY;
    if (prevPaystackSecret !== undefined) process.env.PAYSTACK_WEBHOOK_SECRET = prevPaystackSecret;
    else delete process.env.PAYSTACK_WEBHOOK_SECRET;
    if (prevFlwHash !== undefined) process.env.FLUTTERWAVE_WEBHOOK_HASH = prevFlwHash;
    else delete process.env.FLUTTERWAVE_WEBHOOK_HASH;
    if (prevStripeSecret !== undefined) process.env.STRIPE_WEBHOOK_SECRET = prevStripeSecret;
    else delete process.env.STRIPE_WEBHOOK_SECRET;
    await close();
  }
});
