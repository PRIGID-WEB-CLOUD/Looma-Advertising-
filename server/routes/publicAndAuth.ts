import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import {
  AuthenticatedRequest,
  createAuthMiddleware,
  hashPassword,
  revokeSessionToken,
  signSessionToken,
  timingSafeSecretMatch,
  verifyPassword,
} from '../auth';
import { withTransaction } from '../db';
import { checkPersistentRateLimit } from '../jobs';
import {
  buildOtpAuthUri,
  FX_RATES,
  generateBase32Secret,
  queueTransactionalEmail,
  verifyFlutterwaveSignature,
  verifyPaystackSignature,
  verifyStripeSignature,
  verifyTotpCode,
} from '../security';
import { getFeatureFlags } from '../modules/featureFlags';
import { recordWebhookMetric } from '../modules/monitoring';

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getClientIp(req: Request): string {
  return (req.ip || req.socket.remoteAddress || '127.0.0.1').toString();
}

export function createPublicAndAuthRouter(db: DatabaseSync): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(db);

  function isAdminClaimed(): boolean {
    const row = db
      .prepare("SELECT value_json FROM platform_settings WHERE key = 'admin_claimed'")
      .get() as { value_json: string } | undefined;
    if (!row) return false;
    try {
      return JSON.parse(row.value_json) === true;
    } catch {
      return row.value_json === 'true';
    }
  }

  // GET /api/public/overview
  router.get('/public/overview', (_req: Request, res: Response) => {
    const stats = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM campaigns WHERE status = 'active') AS active_campaigns,
           (SELECT COUNT(*) FROM publisher_properties WHERE approval_status = 'approved') AS approved_properties,
           (SELECT COUNT(*) FROM impressions WHERE is_valid = 1) AS total_impressions,
           (SELECT COUNT(*) FROM ad_placements WHERE status = 'active') AS active_placements`
      )
      .get();

    const featureFlags = getFeatureFlags(db);
    const activePlacements = db
      .prepare(
        `SELECT ap.id, ap.name, ap.format, ap.dimensions, pp.name AS property_name, pp.domain_or_bundle, pp.category,
                pub.publisher_type
         FROM ad_placements ap
         JOIN publisher_properties pp ON pp.id = ap.property_id
         JOIN publisher_accounts pub ON pub.id = ap.publisher_id
         WHERE ap.status = 'active' AND pp.approval_status = 'approved'
           AND (pub.publisher_type = 'first_party' OR ? = 1)`
      )
      .all(featureFlags.third_party_sdk_distribution_enabled || !featureFlags.looma_first_party_only_mode ? 1 : 0);

    res.json({
      stats,
      activePlacements,
      featureFlags,
      pricingModels: [
        { code: 'CPM', name: 'Cost Per Mille', unit: '1,000 verified impressions', minUsd: 0.5 },
        { code: 'CPC', name: 'Cost Per Click', unit: 'Verified user click', minUsd: 0.1 },
        { code: 'CPA', name: 'Cost Per Acquisition', unit: 'Attributed conversion', minUsd: 2.0 },
        { code: 'CPI', name: 'Cost Per Install', unit: 'Verified app install', minUsd: 1.5 },
        { code: 'CPV', name: 'Cost Per View', unit: 'Completed video view', minUsd: 0.05 },
        { code: 'FIXED', name: 'Fixed Sponsorship', unit: 'Guaranteed placement share', minUsd: 500.0 },
      ],
    });
  });

  // GET /api/public/fx-rates
  router.get('/public/fx-rates', (_req: Request, res: Response) => {
    res.json({ baseCurrency: 'USD', rates: FX_RATES });
  });

  // POST /api/public/contact
  router.post('/public/contact', (req: Request, res: Response) => {
    if (!checkPersistentRateLimit(db, `pub_contact:${getClientIp(req)}`, 10)) {
      res.status(429).json({ error: 'Too many inquiries submitted. Please try again shortly.' });
      return;
    }
    const { name, email, company = '', interest = 'advertising', message } = req.body ?? {};
    if (!name || !email || !message) {
      res.status(400).json({ error: 'Name, email, and message are required' });
      return;
    }
    if (!String(email).includes('@')) {
      res.status(400).json({ error: 'Please provide a valid email address' });
      return;
    }

    const id = `inq_${crypto.randomUUID().slice(0, 10)}`;
    db.prepare(
      `INSERT INTO contact_inquiries (id, name, email, company, interest, message) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, String(name).trim(), String(email).trim(), String(company).trim(), String(interest), String(message).trim());

    res.status(201).json({ received: true, inquiryId: id });
  });

  // POST /api/public/privacy-request
  router.post('/public/privacy-request', (req: Request, res: Response) => {
    if (!checkPersistentRateLimit(db, `pub_privacy:${getClientIp(req)}`, 10)) {
      res.status(429).json({ error: 'Too many privacy requests submitted. Please try again shortly.' });
      return;
    }
    const { email, requestType = 'data_export', jurisdiction = 'GDPR', details = '' } = req.body ?? {};
    if (!email || !String(email).includes('@')) {
      res.status(400).json({ error: 'Valid email is required' });
      return;
    }
    if (!['data_export', 'data_deletion', 'consent_withdrawal'].includes(requestType)) {
      res.status(400).json({ error: 'Invalid privacy request type' });
      return;
    }

    const id = `prv_${crypto.randomUUID().slice(0, 10)}`;
    db.prepare(
      `INSERT INTO privacy_requests (id, email, request_type, jurisdiction, details) VALUES (?, ?, ?, ?, ?)`
    ).run(id, String(email).trim(), String(requestType), String(jurisdiction), String(details).trim());

    res.status(201).json({ submitted: true, requestId: id });
  });

  // GET /api/auth/admin-setup-status
  router.get('/auth/admin-setup-status', (_req: Request, res: Response) => {
    res.json({
      adminClaimed: isAdminClaimed(),
      envPasscodeConfigured: Boolean(process.env.ADMIN_PASSCODE?.trim()),
    });
  });

  // POST /api/auth/admin-claim — One-time initial administrator setup when ADMIN_PASSCODE is not set
  router.post('/auth/admin-claim', (req: Request, res: Response) => {
    if (!checkPersistentRateLimit(db, `auth_admin_claim:${getClientIp(req)}`, 5)) {
      res.status(429).json({ error: 'Too many setup attempts. Please wait a minute and try again.' });
      return;
    }
    if (process.env.ADMIN_PASSCODE?.trim()) {
      res.status(403).json({ error: 'Administrator access is managed by ADMIN_PASSCODE. Sign in normally.' });
      return;
    }
    if (isAdminClaimed()) {
      res.status(403).json({ error: 'Administrator credentials have already been claimed. Please sign in.' });
      return;
    }

    const { email, fullName = 'Platform Administrator', password } = req.body ?? {};
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const cleanName = String(fullName || 'Platform Administrator').trim();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      res.status(400).json({ error: 'A valid administrator email address is required' });
      return;
    }
    if (!password || String(password).length < 10) {
      res.status(400).json({ error: 'Administrator password must be at least 10 characters' });
      return;
    }

    const existingOther = db
      .prepare("SELECT id FROM users WHERE email = ? AND id != 'usr_admin_1'")
      .get(normalizedEmail);
    if (existingOther) {
      res.status(409).json({ error: 'That email address is already registered to another account' });
      return;
    }

    const claimedNow = Date.now() + 1;
    const passwordHash = hashPassword(String(password));

    const outcome = withTransaction(db, () => {
      if (isAdminClaimed()) {
        return { alreadyClaimed: true as const };
      }
      const adminRow = db.prepare("SELECT id FROM users WHERE id = 'usr_admin_1'").get() as { id: string } | undefined;
      if (!adminRow) {
        db.prepare(
          `INSERT INTO users (id, email, full_name, password_hash, role_id, status, email_verified, token_valid_after)
           VALUES ('usr_admin_1', ?, ?, ?, 'role_admin', 'active', 1, ?)`
        ).run(normalizedEmail, cleanName, passwordHash, claimedNow);
      } else {
        db.prepare(
          `UPDATE users
           SET email = ?, full_name = ?, password_hash = ?, status = 'active', email_verified = 1,
               token_valid_after = ?, updated_at = datetime('now')
           WHERE id = 'usr_admin_1'`
        ).run(normalizedEmail, cleanName, passwordHash, claimedNow);
      }

      db.prepare(
        `INSERT INTO platform_settings (key, value_json, updated_at)
         VALUES ('admin_claimed', 'true', datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value_json = 'true', updated_at = datetime('now')`
      ).run();

      db.prepare(
        `INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id, details_json)
         VALUES (?, 'usr_admin_1', 'admin_credentials_claimed', 'user', 'usr_admin_1', ?)`
      ).run(`aud_${crypto.randomUUID().slice(0, 12)}`, JSON.stringify({ email: normalizedEmail }));

      return { alreadyClaimed: false as const };
    });

    if (outcome.alreadyClaimed) {
      res.status(403).json({ error: 'Administrator credentials have already been claimed. Please sign in.' });
      return;
    }

    const token = signSessionToken(
      { userId: 'usr_admin_1', email: normalizedEmail, role: 'admin' },
      claimedNow
    );
    res.status(201).json({
      token,
      user: { id: 'usr_admin_1', email: normalizedEmail, fullName: cleanName, role: 'admin' },
    });
  });

  // POST /api/auth/register
  router.post('/auth/register', (req: Request, res: Response) => {
    if (!checkPersistentRateLimit(db, `auth_register:${getClientIp(req)}`, 10)) {
      res.status(429).json({ error: 'Too many registration attempts. Please try again later.' });
      return;
    }
    const { email, fullName, password, role = 'advertiser', organizationName, country = 'US' } = req.body ?? {};
    if (!email || !fullName || !password || !organizationName) {
      res.status(400).json({ error: 'Email, full name, password, and organization name are required' });
      return;
    }
    if (String(password).length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }
    if (!['advertiser', 'publisher'].includes(role)) {
      res.status(400).json({ error: 'Self-registration is available for advertiser or publisher accounts' });
      return;
    }
    if (role === 'publisher' && !getFeatureFlags(db).external_publisher_registration_enabled) {
      res.status(403).json({
        error:
          'External publisher registration is disabled at initial launch. Looma is the exclusive active first-party publisher.',
      });
      return;
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists' });
      return;
    }

    const userId = `usr_${crypto.randomUUID().slice(0, 10)}`;
    const roleId = role === 'publisher' ? 'role_publisher' : 'role_advertiser';
    const passwordHash = hashPassword(String(password));

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO users (id, email, full_name, password_hash, role_id, status) VALUES (?, ?, ?, ?, ?, 'active')`
      ).run(userId, normalizedEmail, String(fullName).trim(), passwordHash, roleId);

      if (role === 'advertiser') {
        const advId = `adv_${crypto.randomUUID().slice(0, 10)}`;
        db.prepare(
          `INSERT INTO advertiser_accounts (id, user_id, company_name, country, currency, verification_status, account_status, billing_email)
           VALUES (?, ?, ?, ?, 'USD', 'pending', 'active', ?)`
        ).run(advId, userId, String(organizationName).trim(), String(country), normalizedEmail);

        db.prepare(
          `INSERT INTO advertiser_wallets (id, advertiser_id, available_micros, reserved_micros, lifetime_deposited_micros, lifetime_spent_micros, currency)
           VALUES (?, ?, 0, 0, 0, 0, 'USD')`
        ).run(`wal_${crypto.randomUUID().slice(0, 10)}`, advId);
      } else {
        const pubId = `pub_${crypto.randomUUID().slice(0, 10)}`;
        db.prepare(
          `INSERT INTO publisher_accounts (id, user_id, organization_name, country, currency, publisher_type, approval_status, traffic_quality_score)
           VALUES (?, ?, ?, ?, 'USD', 'third_party', 'pending', 90)`
        ).run(pubId, userId, String(organizationName).trim(), String(country));

        db.prepare(
          `INSERT INTO publisher_wallets (id, publisher_id, estimated_micros, available_micros, pending_micros, lifetime_earned_micros, invalid_deducted_micros, currency)
           VALUES (?, ?, 0, 0, 0, 0, 0, 'USD')`
        ).run(`wal_${crypto.randomUUID().slice(0, 10)}`, pubId);
      }
    });

    const token = signSessionToken({ userId, email: normalizedEmail, role });
    res.status(201).json({
      token,
      user: { id: userId, email: normalizedEmail, fullName: String(fullName).trim(), role },
    });
  });

  // POST /api/auth/login
  router.post('/auth/login', (req: Request, res: Response) => {
    if (!checkPersistentRateLimit(db, `auth_login:${getClientIp(req)}`, 15)) {
      res.status(429).json({ error: 'Too many sign-in attempts. Please wait a minute and try again.' });
      return;
    }
    const { email, password, totpCode } = req.body ?? {};
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const row = db
      .prepare(
        `SELECT u.id, u.email, u.full_name, u.password_hash, u.status, u.token_valid_after, r.name AS role
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.email = ?`
      )
      .get(String(email).trim().toLowerCase()) as
      | {
          id: string;
          email: string;
          full_name: string;
          password_hash: string;
          status: string;
          token_valid_after: number;
          role: 'advertiser' | 'publisher' | 'admin';
        }
      | undefined;

    const envAdminPasscode = process.env.ADMIN_PASSCODE?.trim();
    const passwordMatches = row
      ? row.role === 'admin' && envAdminPasscode
        ? timingSafeSecretMatch(String(password), envAdminPasscode)
        : verifyPassword(String(password), row.password_hash)
      : false;

    if (!row || !passwordMatches) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    if (row.status !== 'active') {
      res.status(403).json({ error: 'Account is suspended' });
      return;
    }

    // Enforce RFC 6238 TOTP 2FA if user has verified authenticator enrollment
    const totpRow = db
      .prepare('SELECT secret_base32, verified FROM totp_secrets WHERE user_id = ?')
      .get(row.id) as { secret_base32: string; verified: number } | undefined;
    const prefRow = db
      .prepare('SELECT two_factor_enabled FROM user_preferences WHERE user_id = ?')
      .get(row.id) as { two_factor_enabled: number } | undefined;

    if (totpRow?.verified && prefRow?.two_factor_enabled) {
      if (!totpCode) {
        res.status(200).json({
          requiresTwoFactor: true,
          message: 'Enter the 6-digit code from your authenticator app to finish signing in.',
        });
        return;
      }
      if (!verifyTotpCode(totpRow.secret_base32, String(totpCode))) {
        res.status(401).json({ error: 'Invalid or expired 2FA authentication code' });
        return;
      }
    }

    const token = signSessionToken(
      { userId: row.id, email: row.email, role: row.role },
      row.token_valid_after || undefined
    );
    res.json({
      token,
      user: { id: row.id, email: row.email, fullName: row.full_name, role: row.role },
    });
  });

  // POST /api/auth/logout — Immediately revokes the active Bearer token server-side
  router.post('/auth/logout', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    if (req.rawToken && req.auth) {
      revokeSessionToken(db, req.rawToken, req.auth.exp);
    }
    res.json({ loggedOut: true });
  });

  // POST /api/auth/request-email-verification
  router.post('/auth/request-email-verification', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const user = db.prepare('SELECT id, email, email_verified FROM users WHERE id = ?').get(req.auth!.userId) as
      | { id: string; email: string; email_verified: number }
      | undefined;
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (user.email_verified) {
      res.json({ sent: false, alreadyVerified: true });
      return;
    }

    const code = String(crypto.randomInt(100000, 999999));
    const tokenHash = sha256Hex(code);
    const tokenId = `tok_${crypto.randomUUID().slice(0, 10)}`;

    db.prepare(
      `INSERT INTO auth_tokens (id, user_id, token_type, token_hash, expires_at)
       VALUES (?, ?, 'email_verify', ?, datetime('now', '+30 minutes'))`
    ).run(tokenId, user.id, tokenHash);

    queueTransactionalEmail(db, {
      to: user.email,
      subject: 'Looma Advertising — Verify Your Email Address',
      bodyText: `Your email verification code is ${code}. This code expires in 30 minutes.`,
      category: 'security',
    });

    res.json({
      sent: true,
    });
  });

  // POST /api/auth/verify-email
  router.post('/auth/verify-email', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const code = String(req.body?.code || '').trim();
    if (!code) {
      res.status(400).json({ error: 'Verification code is required' });
      return;
    }
    const tokenHash = sha256Hex(code);
    const tokenRow = db
      .prepare(
        `SELECT id FROM auth_tokens
         WHERE user_id = ? AND token_type = 'email_verify' AND token_hash = ?
           AND consumed_at IS NULL AND expires_at >= datetime('now')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(req.auth!.userId, tokenHash) as { id: string } | undefined;

    if (!tokenRow) {
      res.status(400).json({ error: 'Invalid or expired verification code' });
      return;
    }

    withTransaction(db, () => {
      db.prepare("UPDATE auth_tokens SET consumed_at = datetime('now') WHERE id = ?").run(tokenRow.id);
      db.prepare("UPDATE users SET email_verified = 1, updated_at = datetime('now') WHERE id = ?").run(req.auth!.userId);
    });

    res.json({ verified: true });
  });

  // POST /api/auth/forgot-password
  router.post('/auth/forgot-password', (req: Request, res: Response) => {
    if (!checkPersistentRateLimit(db, `auth_forgot:${getClientIp(req)}`, 5)) {
      res.status(429).json({ error: 'Too many password reset requests. Please try again later.' });
      return;
    }
    const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      res.status(400).json({ error: 'Valid email address is required' });
      return;
    }

    const user = db.prepare('SELECT id, email, status FROM users WHERE email = ?').get(normalizedEmail) as
      | { id: string; email: string; status: string }
      | undefined;

    if (user && user.status === 'active') {
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      const tokenHash = sha256Hex(code);
      db.prepare(
        `INSERT INTO auth_tokens (id, user_id, token_type, token_hash, expires_at)
         VALUES (?, ?, 'password_reset', ?, datetime('now', '+30 minutes'))`
      ).run(`tok_${crypto.randomUUID().slice(0, 10)}`, user.id, tokenHash);

      queueTransactionalEmail(db, {
        to: user.email,
        subject: 'Looma Advertising — Password Reset Code',
        bodyText: `Use reset code ${code} within 30 minutes to choose a new password for your Looma Advertising account.`,
        category: 'security',
      });
    }

    res.json({
      requested: true,
      message: 'If an active account matches that email, a password reset code has been dispatched.',
    });
  });

  // POST /api/auth/reset-password
  router.post('/auth/reset-password', (req: Request, res: Response) => {
    if (!checkPersistentRateLimit(db, `auth_reset:${getClientIp(req)}`, 10)) {
      res.status(429).json({ error: 'Too many password reset attempts. Please try again later.' });
      return;
    }
    const { email, token, newPassword } = req.body ?? {};
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const cleanToken = String(token || '').trim().toUpperCase();

    if (!normalizedEmail || !cleanToken || !newPassword) {
      res.status(400).json({ error: 'Email, reset code, and new password are required' });
      return;
    }
    if (String(newPassword).length < 8) {
      res.status(400).json({ error: 'New password must be at least 8 characters' });
      return;
    }

    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail) as { id: string } | undefined;
    if (!user) {
      res.status(400).json({ error: 'Invalid or expired reset code' });
      return;
    }

    const tokenRow = db
      .prepare(
        `SELECT id FROM auth_tokens
         WHERE user_id = ? AND token_type = 'password_reset' AND token_hash = ?
           AND consumed_at IS NULL AND expires_at >= datetime('now')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(user.id, sha256Hex(cleanToken)) as { id: string } | undefined;

    if (!tokenRow) {
      res.status(400).json({ error: 'Invalid or expired reset code' });
      return;
    }

    const invalidatedAt = Date.now() + 1;
    withTransaction(db, () => {
      db.prepare("UPDATE auth_tokens SET consumed_at = datetime('now') WHERE id = ?").run(tokenRow.id);
      db.prepare(
        "UPDATE users SET password_hash = ?, token_valid_after = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(hashPassword(String(newPassword)), invalidatedAt, user.id);
    });

    res.json({ reset: true });
  });

  // POST /api/auth/2fa/setup
  router.post('/auth/2fa/setup', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.auth!.userId) as
      | { id: string; email: string }
      | undefined;
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const secretBase32 = generateBase32Secret(20);
    db.prepare(
      `INSERT INTO totp_secrets (user_id, secret_base32, verified, updated_at)
       VALUES (?, ?, 0, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET secret_base32 = excluded.secret_base32, verified = 0, updated_at = datetime('now')`
    ).run(user.id, secretBase32);

    res.json({
      secretBase32,
      otpAuthUri: buildOtpAuthUri(user.email, secretBase32),
    });
  });

  // POST /api/auth/2fa/verify
  router.post('/auth/2fa/verify', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const code = String(req.body?.code || '').trim();
    const row = db.prepare('SELECT secret_base32 FROM totp_secrets WHERE user_id = ?').get(req.auth!.userId) as
      | { secret_base32: string }
      | undefined;
    if (!row) {
      res.status(400).json({ error: 'Generate a 2FA secret before verifying' });
      return;
    }
    if (!verifyTotpCode(row.secret_base32, code)) {
      res.status(400).json({ error: 'Invalid 6-digit authenticator code' });
      return;
    }

    getOrCreatePrefs(req.auth!.userId);
    withTransaction(db, () => {
      db.prepare("UPDATE totp_secrets SET verified = 1, updated_at = datetime('now') WHERE user_id = ?").run(req.auth!.userId);
      db.prepare("UPDATE user_preferences SET two_factor_enabled = 1, updated_at = datetime('now') WHERE user_id = ?").run(
        req.auth!.userId
      );
    });

    res.json({ enabled: true });
  });

  // POST /api/auth/2fa/disable
  router.post('/auth/2fa/disable', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    getOrCreatePrefs(req.auth!.userId);
    withTransaction(db, () => {
      db.prepare("UPDATE totp_secrets SET verified = 0, updated_at = datetime('now') WHERE user_id = ?").run(req.auth!.userId);
      db.prepare("UPDATE user_preferences SET two_factor_enabled = 0, updated_at = datetime('now') WHERE user_id = ?").run(
        req.auth!.userId
      );
    });
    res.json({ disabled: true });
  });

  // POST /api/auth/demo-session — Disabled to prevent unauthenticated account/admin bypass
  router.post('/auth/demo-session', (_req: Request, res: Response) => {
    res.status(403).json({
      error: 'Unauthenticated sandbox sessions are disabled. Please sign in with valid credentials or create an account.',
    });
  });

  // GET /api/auth/me
  router.get('/auth/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const row = db
      .prepare(
        `SELECT u.id, u.email, u.full_name, r.name AS role
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.id = ?`
      )
      .get(req.auth!.userId);
    if (!row) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user: row });
  });

  // Helper to ensure user_preferences row exists
  function getOrCreatePrefs(userId: string) {
    db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id) VALUES (?)`).run(userId);
    return db
      .prepare(
        `SELECT timezone, preferred_currency, compact_density, email_alerts, fraud_alerts, weekly_digest, two_factor_enabled, session_timeout_minutes
         FROM user_preferences WHERE user_id = ?`
      )
      .get(userId) as {
      timezone: string;
      preferred_currency: string;
      compact_density: number;
      email_alerts: number;
      fraud_alerts: number;
      weekly_digest: number;
      two_factor_enabled: number;
      session_timeout_minutes: number;
    };
  }

  // GET /api/auth/account
  router.get('/auth/account', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const userRow = db
      .prepare(
        `SELECT u.id, u.email, u.full_name, u.status, u.email_verified, u.created_at, r.name AS role
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.id = ?`
      )
      .get(req.auth!.userId) as
      | {
          id: string;
          email: string;
          full_name: string;
          status: string;
          email_verified: number;
          created_at: string;
          role: string;
        }
      | undefined;

    if (!userRow) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    let organizationName = 'Looma Operations';
    let country = 'US';
    let contactEmail = userRow.email;

    if (userRow.role === 'advertiser') {
      const adv = db
        .prepare('SELECT company_name, country, billing_email FROM advertiser_accounts WHERE user_id = ?')
        .get(userRow.id) as { company_name: string; country: string; billing_email: string } | undefined;
      if (adv) {
        organizationName = adv.company_name;
        country = adv.country;
        contactEmail = adv.billing_email;
      }
    } else if (userRow.role === 'publisher') {
      const pub = db
        .prepare('SELECT organization_name, country, payout_destination FROM publisher_accounts WHERE user_id = ?')
        .get(userRow.id) as { organization_name: string; country: string; payout_destination: string } | undefined;
      if (pub) {
        organizationName = pub.organization_name;
        country = pub.country;
      }
    }

    const prefs = getOrCreatePrefs(userRow.id);
    const totpRow = db
      .prepare('SELECT verified FROM totp_secrets WHERE user_id = ?')
      .get(userRow.id) as { verified: number } | undefined;
    const recentEmails = db
      .prepare(
        'SELECT id, subject, category, delivery_status, created_at FROM email_outbox WHERE recipient_email = ? ORDER BY created_at DESC LIMIT 5'
      )
      .all(userRow.email);

    res.json({
      profile: {
        id: userRow.id,
        email: userRow.email,
        fullName: userRow.full_name,
        role: userRow.role,
        organizationName,
        country,
        contactEmail,
        status: userRow.status,
        emailVerified: Boolean(userRow.email_verified),
        createdAt: userRow.created_at,
      },
      settings: {
        twoFactorEnabled: Boolean(prefs.two_factor_enabled),
        totpConfigured: Boolean(totpRow?.verified),
        sessionTimeoutMinutes: prefs.session_timeout_minutes,
      },
      preferences: {
        timezone: prefs.timezone,
        preferredCurrency: prefs.preferred_currency,
        compactDensity: Boolean(prefs.compact_density),
        emailAlerts: Boolean(prefs.email_alerts),
        fraudAlerts: Boolean(prefs.fraud_alerts),
        weeklyDigest: Boolean(prefs.weekly_digest),
      },
      recentEmails,
    });
  });

  // PATCH /api/auth/profile
  router.patch('/auth/profile', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const { fullName, organizationName, country, contactEmail } = req.body ?? {};
    const cleanName = String(fullName ?? '').trim();
    if (!cleanName || cleanName.length < 2) {
      res.status(400).json({ error: 'Full name must be at least 2 characters' });
      return;
    }

    const userId = req.auth!.userId;
    const role = req.auth!.role;

    withTransaction(db, () => {
      db.prepare(`UPDATE users SET full_name = ?, updated_at = datetime('now') WHERE id = ?`).run(cleanName, userId);

      if (role === 'advertiser') {
        const cleanOrg = String(organizationName ?? '').trim();
        const cleanCountry = String(country ?? 'US').trim().toUpperCase().slice(0, 4) || 'US';
        const cleanBilling = String(contactEmail ?? '').trim();
        if (cleanOrg) {
          db.prepare(
            `UPDATE advertiser_accounts SET company_name = ?, country = ?, billing_email = COALESCE(NULLIF(?, ''), billing_email) WHERE user_id = ?`
          ).run(cleanOrg, cleanCountry, cleanBilling, userId);
        }
      } else if (role === 'publisher') {
        const cleanOrg = String(organizationName ?? '').trim();
        const cleanCountry = String(country ?? 'US').trim().toUpperCase().slice(0, 4) || 'US';
        if (cleanOrg) {
          db.prepare(
            `UPDATE publisher_accounts SET organization_name = ?, country = ? WHERE user_id = ?`
          ).run(cleanOrg, cleanCountry, userId);
        }
      }
    });

    res.json({
      updated: true,
      fullName: cleanName,
    });
  });

  // PATCH /api/auth/settings
  router.patch('/auth/settings', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const { twoFactorEnabled, sessionTimeoutMinutes, currentPassword, newPassword } = req.body ?? {};
    const userId = req.auth!.userId;
    const timeout = Number(sessionTimeoutMinutes ?? 60);
    if (!Number.isFinite(timeout) || timeout < 15 || timeout > 1440) {
      res.status(400).json({ error: 'Session timeout must be between 15 and 1440 minutes' });
      return;
    }

    let refreshedToken: string | undefined;
    if (newPassword) {
      if (String(newPassword).length < 8) {
        res.status(400).json({ error: 'New password must be at least 8 characters' });
        return;
      }
      const userRow = db.prepare('SELECT password_hash, email FROM users WHERE id = ?').get(userId) as
        | { password_hash: string; email: string }
        | undefined;
      if (!userRow || !currentPassword || !verifyPassword(String(currentPassword), userRow.password_hash)) {
        res.status(400).json({ error: 'Current password is incorrect' });
        return;
      }
      const invalidatedAt = Date.now() + 1;
      db.prepare(
        `UPDATE users SET password_hash = ?, token_valid_after = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(hashPassword(String(newPassword)), invalidatedAt, userId);
      if (req.rawToken && req.auth) {
        revokeSessionToken(db, req.rawToken, req.auth.exp);
      }
      refreshedToken = signSessionToken(
        { userId, email: userRow.email, role: req.auth!.role },
        invalidatedAt
      );
    }

    getOrCreatePrefs(userId);
    db.prepare(
      `UPDATE user_preferences
       SET two_factor_enabled = ?, session_timeout_minutes = ?, updated_at = datetime('now')
       WHERE user_id = ?`
    ).run(twoFactorEnabled ? 1 : 0, Math.round(timeout), userId);

    res.json({ updated: true, passwordChanged: Boolean(newPassword), token: refreshedToken });
  });

  // PATCH /api/auth/preferences
  router.patch('/auth/preferences', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const { timezone, preferredCurrency, compactDensity, emailAlerts, fraudAlerts, weeklyDigest } = req.body ?? {};
    const userId = req.auth!.userId;
    const cleanTz = String(timezone ?? 'UTC').trim() || 'UTC';
    const cleanCurr = String(preferredCurrency ?? 'USD').trim().toUpperCase();
    if (!['USD', 'EUR', 'GBP', 'CAD', 'NGN', 'KES'].includes(cleanCurr)) {
      res.status(400).json({ error: 'Unsupported display currency' });
      return;
    }

    getOrCreatePrefs(userId);
    db.prepare(
      `UPDATE user_preferences
       SET timezone = ?, preferred_currency = ?, compact_density = ?, email_alerts = ?, fraud_alerts = ?, weekly_digest = ?, updated_at = datetime('now')
       WHERE user_id = ?`
    ).run(
      cleanTz,
      cleanCurr,
      compactDensity ? 1 : 0,
      emailAlerts ? 1 : 0,
      fraudAlerts ? 1 : 0,
      weeklyDigest ? 1 : 0,
      userId
    );

    res.json({ updated: true });
  });

  // POST /api/webhooks/payments/:provider (Cryptographically verified + idempotent payment webhook)
  router.post('/webhooks/payments/:provider', (req: Request, res: Response) => {
    const provider = String(req.params.provider);
    if (!['paystack', 'flutterwave', 'stripe'].includes(provider)) {
      res.status(400).json({ error: 'Unsupported webhook provider' });
      return;
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
    let signatureVerified = false;

    if (provider === 'paystack') {
      const secret = process.env.PAYSTACK_WEBHOOK_SECRET?.trim();
      if (!secret) {
        recordWebhookMetric(false);
        res.status(503).json({ error: 'PAYSTACK_WEBHOOK_SECRET is not configured' });
        return;
      }
      signatureVerified = verifyPaystackSignature(rawBody, req.header('x-paystack-signature'), secret);
      if (!signatureVerified) {
        recordWebhookMetric(false);
        res.status(401).json({ error: 'Invalid Paystack webhook signature' });
        return;
      }
    } else if (provider === 'flutterwave') {
      const secret = process.env.FLUTTERWAVE_WEBHOOK_HASH?.trim();
      if (!secret) {
        recordWebhookMetric(false);
        res.status(503).json({ error: 'FLUTTERWAVE_WEBHOOK_HASH is not configured' });
        return;
      }
      signatureVerified = verifyFlutterwaveSignature(req.header('verif-hash'), secret);
      if (!signatureVerified) {
        recordWebhookMetric(false);
        res.status(401).json({ error: 'Invalid Flutterwave webhook signature' });
        return;
      }
    } else if (provider === 'stripe') {
      const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
      if (!secret) {
        recordWebhookMetric(false);
        res.status(503).json({ error: 'STRIPE_WEBHOOK_SECRET is not configured' });
        return;
      }
      signatureVerified = verifyStripeSignature(rawBody, req.header('stripe-signature'), secret);
      if (!signatureVerified) {
        recordWebhookMetric(false);
        res.status(401).json({ error: 'Invalid Stripe webhook signature' });
        return;
      }
    }

    const { eventId, advertiserId, amountUsd, eventType = 'charge.success' } = req.body ?? {};
    if (!eventId || !advertiserId || !amountUsd) {
      res.status(400).json({ error: 'eventId, advertiserId, and amountUsd are required' });
      return;
    }

    const amountMicros = Math.round(Number(amountUsd) * 1_000_000);
    if (amountMicros <= 0) {
      res.status(400).json({ error: 'Invalid webhook amount' });
      return;
    }

    try {
      const outcome = withTransaction(db, () => {
        const dup = db
          .prepare('SELECT id FROM payment_transactions WHERE provider_event_id = ?')
          .get(String(eventId));
        if (dup) {
          return { duplicate: true };
        }

        const wallet = db
          .prepare(
            `SELECT w.id, w.available_micros, a.billing_email
             FROM advertiser_wallets w
             JOIN advertiser_accounts a ON a.id = w.advertiser_id
             WHERE w.advertiser_id = ?`
          )
          .get(String(advertiserId)) as { id: string; available_micros: number; billing_email: string } | undefined;
        if (!wallet) {
          return { notFound: true };
        }

        db.prepare(
          `INSERT INTO payment_transactions (id, provider, provider_event_id, transaction_type, amount_micros, currency, status, raw_payload_json)
           VALUES (?, ?, ?, ?, ?, 'USD', 'verified', ?)`
        ).run(`ptx_${crypto.randomUUID().slice(0, 10)}`, provider, String(eventId), String(eventType), amountMicros, JSON.stringify(req.body));

        const newBal = wallet.available_micros + amountMicros;
        db.prepare(
          `UPDATE advertiser_wallets SET available_micros = ?, lifetime_deposited_micros = lifetime_deposited_micros + ? WHERE id = ?`
        ).run(newBal, amountMicros, wallet.id);

        db.prepare(
          `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
           VALUES (?, ?, 'advertiser_wallet', ?, 'deposit', 'credit', ?, ?, 'USD', 'webhook', ?, ?)`
        ).run(
          `led_${crypto.randomUUID().slice(0, 12)}`,
          `wh_${provider}_${eventId}`,
          wallet.id,
          amountMicros,
          newBal,
          String(eventId),
          `Verified ${provider} webhook credit`
        );

        return { duplicate: false, balanceAfterMicros: newBal, billingEmail: wallet.billing_email };
      });

      if ('notFound' in outcome && outcome.notFound) {
        res.status(404).json({ error: 'Advertiser wallet not found' });
        return;
      }

      if ('billingEmail' in outcome && outcome.billingEmail && !outcome.duplicate) {
        queueTransactionalEmail(db, {
          to: outcome.billingEmail,
          subject: `Looma Advertising — Prepaid Wallet Credited ($${Number(amountUsd).toFixed(2)})`,
          bodyText: `Your prepaid wallet was credited $${Number(amountUsd).toFixed(2)} via ${provider} webhook (${eventId}).`,
          category: 'billing',
        });
      }

      recordWebhookMetric(true);
      res.json({ processed: true, signatureVerified, ...outcome });
    } catch (error) {
      console.error('Webhook processing error:', error);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
}
