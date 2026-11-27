import crypto from 'node:crypto';
import { createAppRouter, type AppRouter, type Request, type Response } from '../http/router';
import {
  AuthenticatedRequest,
  createAuthMiddleware,
  hashPassword,
  revokeSessionToken,
  signSessionToken,
  timingSafeSecretMatch,
  verifyPassword,
} from '../auth';
import { withTransaction, type DbClient } from '../db/postgres';
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
import {
  asTrimmedString,
  validateAdminClaimInput,
  validateContactInput,
  validateForgotPasswordInput,
  validateLoginInput,
  validateNumberRange,
  validatePreferencesInput,
  validatePrivacyRequestInput,
  validateProfileUpdateInput,
  validateRegisterInput,
  validateResetPasswordInput,
  validateSecuritySettingsInput,
  validateSixDigitCode,
} from '../../src/lib/validation';

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getClientIp(req: Request): string {
  return (req.ip || req.socket?.remoteAddress || '127.0.0.1').toString();
}

export function createPublicAndAuthRouter(db: DbClient): AppRouter {
  const router = createAppRouter();
  const requireAuth = createAuthMiddleware(db);

  async function isAdminClaimed(client: DbClient = db): Promise<boolean> {
    const hasActiveAdmin = await client.queryOne(
      `SELECT 1 AS ok
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.name = 'admin' AND u.status = 'active'
       LIMIT 1`
    );
    if (!hasActiveAdmin) return false;

    const row = await client.queryOne<{ value_json: string }>(
      "SELECT value_json FROM platform_settings WHERE key = 'admin_claimed'"
    );
    if (!row) return false;
    try {
      return JSON.parse(row.value_json) === true;
    } catch {
      return row.value_json === 'true';
    }
  }

  // GET /api/public/overview
  router.get('/public/overview', async (_req: Request, res: Response) => {
    const stats = await db.queryOne(
      `SELECT
         (SELECT COUNT(*) FROM campaigns WHERE status = 'active') AS active_campaigns,
         (SELECT COUNT(*) FROM publisher_properties WHERE approval_status = 'approved') AS approved_properties,
         (SELECT COUNT(*) FROM impressions WHERE is_valid = 1) AS total_impressions,
         (SELECT COUNT(*) FROM ad_placements WHERE status = 'active') AS active_placements`
    );

    const featureFlags = await getFeatureFlags(db);
    const activePlacements = await db.query(
      `SELECT ap.id, ap.name, ap.format, ap.dimensions, pp.name AS property_name, pp.domain_or_bundle, pp.category,
              pub.publisher_type
       FROM ad_placements ap
       JOIN publisher_properties pp ON pp.id = ap.property_id
       JOIN publisher_accounts pub ON pub.id = ap.publisher_id
       WHERE ap.status = 'active' AND pp.approval_status = 'approved'
         AND (pub.publisher_type = 'first_party' OR ? = 1)`,
      [featureFlags.third_party_sdk_distribution_enabled || !featureFlags.looma_first_party_only_mode ? 1 : 0]
    );

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
  router.post('/public/contact', async (req: Request, res: Response) => {
    if (!(await checkPersistentRateLimit(db, `pub_contact:${getClientIp(req)}`, 10))) {
      res.status(429).json({ error: 'Too many inquiries submitted. Please try again shortly.' });
      return;
    }
    const validation = validateContactInput(req.body ?? {});
    if (!validation.valid || !validation.value) {
      res.status(400).json({ error: validation.firstError, fieldErrors: validation.errors });
      return;
    }
    const { name, email, company, interest, message } = validation.value;

    const id = `inq_${crypto.randomUUID().slice(0, 10)}`;
    await db.execute(
      `INSERT INTO contact_inquiries (id, name, email, company, interest, message) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, name, email, company, interest, message]
    );

    res.status(201).json({ received: true, inquiryId: id });
  });

  // POST /api/public/privacy-request
  router.post('/public/privacy-request', async (req: Request, res: Response) => {
    if (!(await checkPersistentRateLimit(db, `pub_privacy:${getClientIp(req)}`, 10))) {
      res.status(429).json({ error: 'Too many privacy requests submitted. Please try again shortly.' });
      return;
    }
    const validation = validatePrivacyRequestInput(req.body ?? {});
    if (!validation.valid || !validation.value) {
      res.status(400).json({ error: validation.firstError, fieldErrors: validation.errors });
      return;
    }
    const { email, requestType, jurisdiction, details } = validation.value;

    const id = `prv_${crypto.randomUUID().slice(0, 10)}`;
    await db.execute(
      `INSERT INTO privacy_requests (id, email, request_type, jurisdiction, details) VALUES (?, ?, ?, ?, ?)`,
      [id, email, requestType, jurisdiction, details]
    );

    res.status(201).json({ submitted: true, requestId: id });
  });

  // GET /api/auth/admin-setup-status
  router.get('/auth/admin-setup-status', async (_req: Request, res: Response) => {
    res.json({
      adminClaimed: await isAdminClaimed(),
      envPasscodeConfigured: Boolean(process.env.ADMIN_PASSCODE?.trim()),
    });
  });

  // POST /api/auth/admin-claim — One-time initial administrator setup when ADMIN_PASSCODE is not set
  router.post('/auth/admin-claim', async (req: Request, res: Response) => {
    if (!(await checkPersistentRateLimit(db, `auth_admin_claim:${getClientIp(req)}`, 5))) {
      res.status(429).json({ error: 'Too many setup attempts. Please wait a minute and try again.' });
      return;
    }
    if (process.env.ADMIN_PASSCODE?.trim()) {
      res.status(403).json({ error: 'Administrator access is managed by ADMIN_PASSCODE. Sign in normally.' });
      return;
    }
    if (await isAdminClaimed()) {
      res.status(403).json({ error: 'Administrator credentials have already been claimed. Please sign in.' });
      return;
    }

    const claimValidation = validateAdminClaimInput(req.body ?? {});
    if (!claimValidation.valid || !claimValidation.value) {
      res.status(400).json({ error: claimValidation.firstError, fieldErrors: claimValidation.errors });
      return;
    }
    const { email: normalizedEmail, fullName: cleanName, password } = claimValidation.value;

    const existingOther = await db.queryOne(
      "SELECT id FROM users WHERE email = ? AND id != 'usr_admin_1'",
      [normalizedEmail]
    );
    if (existingOther) {
      res.status(409).json({ error: 'That email address is already registered to another account' });
      return;
    }

    const claimedNow = Date.now() + 1;
    const nowIso = new Date().toISOString();
    const passwordHash = hashPassword(String(password));

    const outcome = await withTransaction(db, async (tx) => {
      if (await isAdminClaimed(tx)) {
        return { alreadyClaimed: true as const };
      }
      const adminRow = await tx.queryOne<{ id: string }>("SELECT id FROM users WHERE id = 'usr_admin_1'");
      if (!adminRow) {
        await tx.execute(
          `INSERT INTO users (id, email, full_name, password_hash, role_id, status, email_verified, token_valid_after)
           VALUES ('usr_admin_1', ?, ?, ?, 'role_admin', 'active', 1, ?)`,
          [normalizedEmail, cleanName, passwordHash, claimedNow]
        );
      } else {
        await tx.execute(
          `UPDATE users
           SET email = ?, full_name = ?, password_hash = ?, status = 'active', email_verified = 1,
               token_valid_after = ?, updated_at = ?
           WHERE id = 'usr_admin_1'`,
          [normalizedEmail, cleanName, passwordHash, claimedNow, nowIso]
        );
      }

      await tx.execute(
        `INSERT INTO platform_settings (key, value_json, updated_at)
         VALUES ('admin_claimed', 'true', ?)
         ON CONFLICT (key) DO UPDATE SET value_json = 'true', updated_at = ?`,
        [nowIso, nowIso]
      );

      await tx.execute(
        `INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id, details_json)
         VALUES (?, 'usr_admin_1', 'admin_credentials_claimed', 'user', 'usr_admin_1', ?)`,
        [`aud_${crypto.randomUUID().slice(0, 12)}`, JSON.stringify({ email: normalizedEmail })]
      );

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
  router.post('/auth/register', async (req: Request, res: Response) => {
    if (!(await checkPersistentRateLimit(db, `auth_register:${getClientIp(req)}`, 10))) {
      res.status(429).json({ error: 'Too many registration attempts. Please try again later.' });
      return;
    }
    const regValidation = validateRegisterInput(req.body ?? {});
    if (!regValidation.valid || !regValidation.value) {
      res.status(400).json({ error: regValidation.firstError, fieldErrors: regValidation.errors });
      return;
    }
    const { email: normalizedEmail, fullName, password, role, organizationName, country } = regValidation.value;
    const flags = await getFeatureFlags(db);
    if (role === 'publisher' && !flags.external_publisher_registration_enabled) {
      res.status(403).json({
        error:
          'External publisher registration is disabled at initial launch. Looma is the exclusive active first-party publisher.',
      });
      return;
    }

    const existing = await db.queryOne('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists' });
      return;
    }

    const userId = `usr_${crypto.randomUUID().slice(0, 10)}`;
    const roleId = role === 'publisher' ? 'role_publisher' : 'role_advertiser';
    const passwordHash = hashPassword(String(password));

    await withTransaction(db, async (tx) => {
      await tx.execute(
        `INSERT INTO users (id, email, full_name, password_hash, role_id, status) VALUES (?, ?, ?, ?, ?, 'active')`,
        [userId, normalizedEmail, String(fullName).trim(), passwordHash, roleId]
      );

      if (role === 'advertiser') {
        const advId = `adv_${crypto.randomUUID().slice(0, 10)}`;
        await tx.execute(
          `INSERT INTO advertiser_accounts (id, user_id, company_name, country, currency, verification_status, account_status, billing_email)
           VALUES (?, ?, ?, ?, 'USD', 'pending', 'active', ?)`,
          [advId, userId, String(organizationName).trim(), String(country), normalizedEmail]
        );

        await tx.execute(
          `INSERT INTO advertiser_wallets (id, advertiser_id, available_micros, reserved_micros, lifetime_deposited_micros, lifetime_spent_micros, currency)
           VALUES (?, ?, 0, 0, 0, 0, 'USD')`,
          [`wal_${crypto.randomUUID().slice(0, 10)}`, advId]
        );
      } else {
        const pubId = `pub_${crypto.randomUUID().slice(0, 10)}`;
        await tx.execute(
          `INSERT INTO publisher_accounts (id, user_id, organization_name, country, currency, publisher_type, approval_status, traffic_quality_score)
           VALUES (?, ?, ?, ?, 'USD', 'third_party', 'pending', 90)`,
          [pubId, userId, String(organizationName).trim(), String(country)]
        );

        await tx.execute(
          `INSERT INTO publisher_wallets (id, publisher_id, estimated_micros, available_micros, pending_micros, lifetime_earned_micros, invalid_deducted_micros, currency)
           VALUES (?, ?, 0, 0, 0, 0, 0, 'USD')`,
          [`wal_${crypto.randomUUID().slice(0, 10)}`, pubId]
        );
      }
    });

    const token = signSessionToken({ userId, email: normalizedEmail, role });
    res.status(201).json({
      token,
      user: { id: userId, email: normalizedEmail, fullName: String(fullName).trim(), role },
    });
  });

  // POST /api/auth/login
  router.post('/auth/login', async (req: Request, res: Response) => {
    if (!(await checkPersistentRateLimit(db, `auth_login:${getClientIp(req)}`, 15))) {
      res.status(429).json({ error: 'Too many sign-in attempts. Please wait a minute and try again.' });
      return;
    }
    const loginValidation = validateLoginInput(req.body ?? {});
    if (!loginValidation.valid || !loginValidation.value) {
      res.status(400).json({ error: loginValidation.firstError, fieldErrors: loginValidation.errors });
      return;
    }
    const { email, password, totpCode } = loginValidation.value;

    const row = await db.queryOne<{
      id: string;
      email: string;
      full_name: string;
      password_hash: string;
      status: string;
      token_valid_after: number;
      role: 'advertiser' | 'publisher' | 'admin';
    }>(
      `SELECT u.id, u.email, u.full_name, u.password_hash, u.status, u.token_valid_after, r.name AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.email = ?`,
      [email]
    );

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
    const totpRow = await db.queryOne<{ secret_base32: string; verified: number }>(
      'SELECT secret_base32, verified FROM totp_secrets WHERE user_id = ?',
      [row.id]
    );
    const prefRow = await db.queryOne<{ two_factor_enabled: number }>(
      'SELECT two_factor_enabled FROM user_preferences WHERE user_id = ?',
      [row.id]
    );

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
      Number(row.token_valid_after || 0) || undefined
    );
    res.json({
      token,
      user: { id: row.id, email: row.email, fullName: row.full_name, role: row.role },
    });
  });

  // POST /api/auth/logout — Immediately revokes the active Bearer token server-side
  router.post('/auth/logout', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (req.rawToken && req.auth) {
      await revokeSessionToken(db, req.rawToken, req.auth.exp);
    }
    res.json({ loggedOut: true });
  });

  // POST /api/auth/request-email-verification
  router.post('/auth/request-email-verification', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const user = await db.queryOne<{ id: string; email: string; email_verified: number }>(
      'SELECT id, email, email_verified FROM users WHERE id = ?',
      [req.auth!.userId]
    );
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
    const expiresAtIso = new Date(Date.now() + 30 * 60_000).toISOString();

    await db.execute(
      `INSERT INTO auth_tokens (id, user_id, token_type, token_hash, expires_at)
       VALUES (?, ?, 'email_verify', ?, ?)`,
      [tokenId, user.id, tokenHash, expiresAtIso]
    );

    await queueTransactionalEmail(db, {
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
  router.post('/auth/verify-email', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const codeErr = validateSixDigitCode(req.body?.code, 'Verification code');
    if (codeErr) {
      res.status(400).json({ error: codeErr, fieldErrors: { code: codeErr } });
      return;
    }
    const code = asTrimmedString(req.body?.code) || '';
    const tokenHash = sha256Hex(code);
    const nowIso = new Date().toISOString();

    const tokenRow = await db.queryOne<{ id: string }>(
      `SELECT id FROM auth_tokens
       WHERE user_id = ? AND token_type = 'email_verify' AND token_hash = ?
         AND consumed_at IS NULL AND expires_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
      [req.auth!.userId, tokenHash, nowIso]
    );

    if (!tokenRow) {
      res.status(400).json({ error: 'Invalid or expired verification code' });
      return;
    }

    await withTransaction(db, async (tx) => {
      await tx.execute('UPDATE auth_tokens SET consumed_at = ? WHERE id = ?', [nowIso, tokenRow.id]);
      await tx.execute('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?', [nowIso, req.auth!.userId]);
    });

    res.json({ verified: true });
  });

  // POST /api/auth/forgot-password
  router.post('/auth/forgot-password', async (req: Request, res: Response) => {
    if (!(await checkPersistentRateLimit(db, `auth_forgot:${getClientIp(req)}`, 5))) {
      res.status(429).json({ error: 'Too many password reset requests. Please try again later.' });
      return;
    }
    const forgotValidation = validateForgotPasswordInput(req.body ?? {});
    if (!forgotValidation.valid || !forgotValidation.value) {
      res.status(400).json({ error: forgotValidation.firstError, fieldErrors: forgotValidation.errors });
      return;
    }
    const normalizedEmail = forgotValidation.value.email;

    const user = await db.queryOne<{ id: string; email: string; status: string }>(
      'SELECT id, email, status FROM users WHERE email = ?',
      [normalizedEmail]
    );

    if (user && user.status === 'active') {
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      const tokenHash = sha256Hex(code);
      const expiresAtIso = new Date(Date.now() + 30 * 60_000).toISOString();
      await db.execute(
        `INSERT INTO auth_tokens (id, user_id, token_type, token_hash, expires_at)
         VALUES (?, ?, 'password_reset', ?, ?)`,
        [`tok_${crypto.randomUUID().slice(0, 10)}`, user.id, tokenHash, expiresAtIso]
      );

      await queueTransactionalEmail(db, {
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
  router.post('/auth/reset-password', async (req: Request, res: Response) => {
    if (!(await checkPersistentRateLimit(db, `auth_reset:${getClientIp(req)}`, 10))) {
      res.status(429).json({ error: 'Too many password reset attempts. Please try again later.' });
      return;
    }
    const resetValidation = validateResetPasswordInput(req.body ?? {});
    if (!resetValidation.valid || !resetValidation.value) {
      res.status(400).json({ error: resetValidation.firstError, fieldErrors: resetValidation.errors });
      return;
    }
    const { email: normalizedEmail, token: cleanToken, newPassword } = resetValidation.value;

    const user = await db.queryOne<{ id: string }>('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (!user) {
      res.status(400).json({ error: 'Invalid or expired reset code' });
      return;
    }

    const nowIso = new Date().toISOString();
    const tokenRow = await db.queryOne<{ id: string }>(
      `SELECT id FROM auth_tokens
       WHERE user_id = ? AND token_type = 'password_reset' AND token_hash = ?
         AND consumed_at IS NULL AND expires_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, sha256Hex(cleanToken), nowIso]
    );

    if (!tokenRow) {
      res.status(400).json({ error: 'Invalid or expired reset code' });
      return;
    }

    const invalidatedAt = Date.now() + 1;
    const newHash = hashPassword(String(newPassword));
    await withTransaction(db, async (tx) => {
      await tx.execute('UPDATE auth_tokens SET consumed_at = ? WHERE id = ?', [nowIso, tokenRow.id]);
      await tx.execute(
        'UPDATE users SET password_hash = ?, token_valid_after = ?, updated_at = ? WHERE id = ?',
        [newHash, invalidatedAt, nowIso, user.id]
      );
    });

    res.json({ reset: true });
  });

  // POST /api/auth/2fa/setup
  router.post('/auth/2fa/setup', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const user = await db.queryOne<{ id: string; email: string }>(
      'SELECT id, email FROM users WHERE id = ?',
      [req.auth!.userId]
    );
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const secretBase32 = generateBase32Secret(20);
    const nowIso = new Date().toISOString();
    await db.execute(
      `INSERT INTO totp_secrets (user_id, secret_base32, verified, updated_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT (user_id) DO UPDATE SET secret_base32 = EXCLUDED.secret_base32, verified = 0, updated_at = ?`,
      [user.id, secretBase32, nowIso, nowIso]
    );

    res.json({
      secretBase32,
      otpAuthUri: buildOtpAuthUri(user.email, secretBase32),
    });
  });

  // POST /api/auth/2fa/verify
  router.post('/auth/2fa/verify', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const codeErr = validateSixDigitCode(req.body?.code, 'Authenticator code');
    if (codeErr) {
      res.status(400).json({ error: codeErr, fieldErrors: { code: codeErr } });
      return;
    }
    const code = asTrimmedString(req.body?.code) || '';
    const row = await db.queryOne<{ secret_base32: string }>(
      'SELECT secret_base32 FROM totp_secrets WHERE user_id = ?',
      [req.auth!.userId]
    );
    if (!row) {
      res.status(400).json({ error: 'Generate a 2FA secret before verifying' });
      return;
    }
    if (!verifyTotpCode(row.secret_base32, code)) {
      res.status(400).json({ error: 'Invalid 6-digit authenticator code', fieldErrors: { code: 'Invalid or expired 6-digit code.' } });
      return;
    }

    await getOrCreatePrefs(req.auth!.userId);
    const nowIso = new Date().toISOString();
    await withTransaction(db, async (tx) => {
      await tx.execute('UPDATE totp_secrets SET verified = 1, updated_at = ? WHERE user_id = ?', [nowIso, req.auth!.userId]);
      await tx.execute('UPDATE user_preferences SET two_factor_enabled = 1, updated_at = ? WHERE user_id = ?', [
        nowIso,
        req.auth!.userId,
      ]);
    });

    res.json({ enabled: true });
  });

  // POST /api/auth/2fa/disable
  router.post('/auth/2fa/disable', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await getOrCreatePrefs(req.auth!.userId);
    const nowIso = new Date().toISOString();
    await withTransaction(db, async (tx) => {
      await tx.execute('UPDATE totp_secrets SET verified = 0, updated_at = ? WHERE user_id = ?', [nowIso, req.auth!.userId]);
      await tx.execute('UPDATE user_preferences SET two_factor_enabled = 0, updated_at = ? WHERE user_id = ?', [
        nowIso,
        req.auth!.userId,
      ]);
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
  router.get('/auth/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const row = await db.queryOne(
      `SELECT u.id, u.email, u.full_name, r.name AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`,
      [req.auth!.userId]
    );
    if (!row) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user: row });
  });

  // Helper to ensure user_preferences row exists
  async function getOrCreatePrefs(userId: string) {
    await db.execute(
      `INSERT INTO user_preferences (user_id) VALUES (?) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    return (await db.queryOne<{
      timezone: string;
      preferred_currency: string;
      compact_density: number;
      email_alerts: number;
      fraud_alerts: number;
      weekly_digest: number;
      two_factor_enabled: number;
      session_timeout_minutes: number;
    }>(
      `SELECT timezone, preferred_currency, compact_density, email_alerts, fraud_alerts, weekly_digest, two_factor_enabled, session_timeout_minutes
       FROM user_preferences WHERE user_id = ?`,
      [userId]
    ))!;
  }

  // GET /api/auth/account
  router.get('/auth/account', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userRow = await db.queryOne<{
      id: string;
      email: string;
      full_name: string;
      status: string;
      email_verified: number;
      created_at: string;
      role: string;
    }>(
      `SELECT u.id, u.email, u.full_name, u.status, u.email_verified, u.created_at, r.name AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`,
      [req.auth!.userId]
    );

    if (!userRow) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    let organizationName = 'Looma Operations';
    let country = 'US';
    let contactEmail = userRow.email;

    if (userRow.role === 'advertiser') {
      const adv = await db.queryOne<{ company_name: string; country: string; billing_email: string }>(
        'SELECT company_name, country, billing_email FROM advertiser_accounts WHERE user_id = ?',
        [userRow.id]
      );
      if (adv) {
        organizationName = adv.company_name;
        country = adv.country;
        contactEmail = adv.billing_email;
      }
    } else if (userRow.role === 'publisher') {
      const pub = await db.queryOne<{ organization_name: string; country: string; payout_destination: string }>(
        'SELECT organization_name, country, payout_destination FROM publisher_accounts WHERE user_id = ?',
        [userRow.id]
      );
      if (pub) {
        organizationName = pub.organization_name;
        country = pub.country;
      }
    }

    const prefs = await getOrCreatePrefs(userRow.id);
    const totpRow = await db.queryOne<{ verified: number }>(
      'SELECT verified FROM totp_secrets WHERE user_id = ?',
      [userRow.id]
    );
    const recentEmails = await db.query(
      'SELECT id, subject, category, delivery_status, created_at FROM email_outbox WHERE recipient_email = ? ORDER BY created_at DESC LIMIT 5',
      [userRow.email]
    );

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
  router.patch('/auth/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const profileValidation = validateProfileUpdateInput(req.body ?? {});
    if (!profileValidation.valid || !profileValidation.value) {
      res.status(400).json({ error: profileValidation.firstError, fieldErrors: profileValidation.errors });
      return;
    }
    const { fullName: cleanName, organizationName: cleanOrg, country: cleanCountry, contactEmail: cleanBilling } =
      profileValidation.value;

    const userId = req.auth!.userId;
    const role = req.auth!.role;
    const nowIso = new Date().toISOString();

    await withTransaction(db, async (tx) => {
      await tx.execute('UPDATE users SET full_name = ?, updated_at = ? WHERE id = ?', [cleanName, nowIso, userId]);

      if (role === 'advertiser') {
        if (cleanOrg) {
          await tx.execute(
            `UPDATE advertiser_accounts SET company_name = ?, country = ?, billing_email = COALESCE(NULLIF(?, ''), billing_email) WHERE user_id = ?`,
            [cleanOrg, cleanCountry, cleanBilling, userId]
          );
        }
      } else if (role === 'publisher') {
        if (cleanOrg) {
          await tx.execute(
            `UPDATE publisher_accounts SET organization_name = ?, country = ? WHERE user_id = ?`,
            [cleanOrg, cleanCountry, userId]
          );
        }
      }
    });

    res.json({
      updated: true,
      fullName: cleanName,
    });
  });

  // PATCH /api/auth/settings
  router.patch('/auth/settings', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const settingsValidation = validateSecuritySettingsInput(req.body ?? {});
    if (!settingsValidation.valid || !settingsValidation.value) {
      res.status(400).json({ error: settingsValidation.firstError, fieldErrors: settingsValidation.errors });
      return;
    }
    const { twoFactorEnabled, sessionTimeoutMinutes: timeout, currentPassword, newPassword } = settingsValidation.value;
    const userId = req.auth!.userId;
    const nowIso = new Date().toISOString();

    let refreshedToken: string | undefined;
    if (newPassword) {
      const userRow = await db.queryOne<{ password_hash: string; email: string }>(
        'SELECT password_hash, email FROM users WHERE id = ?',
        [userId]
      );
      if (!userRow || !currentPassword || !verifyPassword(currentPassword, userRow.password_hash)) {
        res.status(400).json({
          error: 'Current password is incorrect',
          fieldErrors: { currentPassword: 'Current password is incorrect.' },
        });
        return;
      }
      const invalidatedAt = Date.now() + 1;
      await db.execute(
        'UPDATE users SET password_hash = ?, token_valid_after = ?, updated_at = ? WHERE id = ?',
        [hashPassword(newPassword), invalidatedAt, nowIso, userId]
      );
      if (req.rawToken && req.auth) {
        await revokeSessionToken(db, req.rawToken, req.auth.exp);
      }
      refreshedToken = signSessionToken(
        { userId, email: userRow.email, role: req.auth!.role },
        invalidatedAt
      );
    }

    await getOrCreatePrefs(userId);
    await db.execute(
      `UPDATE user_preferences
       SET two_factor_enabled = ?, session_timeout_minutes = ?, updated_at = ?
       WHERE user_id = ?`,
      [twoFactorEnabled ? 1 : 0, Math.round(timeout), nowIso, userId]
    );

    res.json({ updated: true, passwordChanged: Boolean(newPassword), token: refreshedToken });
  });

  // PATCH /api/auth/preferences
  router.patch('/auth/preferences', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const prefsValidation = validatePreferencesInput(req.body ?? {});
    if (!prefsValidation.valid || !prefsValidation.value) {
      res.status(400).json({ error: prefsValidation.firstError, fieldErrors: prefsValidation.errors });
      return;
    }
    const { timezone: cleanTz, preferredCurrency: cleanCurr, compactDensity, emailAlerts, fraudAlerts, weeklyDigest } =
      prefsValidation.value;
    const userId = req.auth!.userId;
    const nowIso = new Date().toISOString();

    await getOrCreatePrefs(userId);
    await db.execute(
      `UPDATE user_preferences
       SET timezone = ?, preferred_currency = ?, compact_density = ?, email_alerts = ?, fraud_alerts = ?, weekly_digest = ?, updated_at = ?
       WHERE user_id = ?`,
      [
        cleanTz,
        cleanCurr,
        compactDensity ? 1 : 0,
        emailAlerts ? 1 : 0,
        fraudAlerts ? 1 : 0,
        weeklyDigest ? 1 : 0,
        nowIso,
        userId,
      ]
    );

    res.json({ updated: true });
  });

  // POST /api/webhooks/payments/:provider (Cryptographically verified + idempotent payment webhook)
  router.post('/webhooks/payments/:provider', async (req: Request, res: Response) => {
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
    const normalizedEventType = String(eventType || '').trim().toLowerCase();
    const SETTLED_CREDIT_EVENTS = new Set(['charge.success', 'charge.completed', 'payment_intent.succeeded']);
    if (!SETTLED_CREDIT_EVENTS.has(normalizedEventType)) {
      recordWebhookMetric(true);
      res.json({
        processed: false,
        ignored: true,
        signatureVerified,
        eventType: normalizedEventType,
        reason: 'non_credit_event_type',
      });
      return;
    }

    const cleanEventId = asTrimmedString(eventId);
    const cleanAdvertiserId = asTrimmedString(advertiserId);
    const amountCheck = validateNumberRange(amountUsd, { label: 'Webhook amount', min: 0.01, max: 1_000_000, currency: true });
    if (!cleanEventId || !cleanAdvertiserId || amountCheck.error || amountCheck.value === null) {
      res.status(400).json({
        error: amountCheck.error || 'eventId, advertiserId, and a valid positive amountUsd are required',
      });
      return;
    }

    const amountMicros = Math.round(amountCheck.value * 1_000_000);

    try {
      const outcome = await withTransaction(db, async (tx) => {
        const dup = await tx.queryOne(
          'SELECT id FROM payment_transactions WHERE provider_event_id = ?',
          [String(eventId)]
        );
        if (dup) {
          return { duplicate: true };
        }

        const wallet = await tx.queryOne<{ id: string; billing_email: string }>(
          `SELECT w.id, a.billing_email
           FROM advertiser_wallets w
           JOIN advertiser_accounts a ON a.id = w.advertiser_id
           WHERE w.advertiser_id = ?`,
          [String(advertiserId)]
        );
        if (!wallet) {
          return { notFound: true };
        }

        await tx.execute(
          `INSERT INTO payment_transactions (id, provider, provider_event_id, transaction_type, amount_micros, currency, status, raw_payload_json)
           VALUES (?, ?, ?, ?, ?, 'USD', 'verified', ?)`,
          [
            `ptx_${crypto.randomUUID().slice(0, 10)}`,
            provider,
            String(eventId),
            normalizedEventType,
            amountMicros,
            JSON.stringify(req.body),
          ]
        );

        await tx.execute(
          `UPDATE advertiser_wallets
           SET available_micros = available_micros + ?, lifetime_deposited_micros = lifetime_deposited_micros + ?, updated_at = ?
           WHERE id = ?`,
          [amountMicros, amountMicros, new Date().toISOString(), wallet.id]
        );

        const updatedWallet = (await tx.queryOne<{ available_micros: number }>(
          'SELECT available_micros FROM advertiser_wallets WHERE id = ?',
          [wallet.id]
        ))!;
        const newBal = Number(updatedWallet.available_micros);

        await tx.execute(
          `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
           VALUES (?, ?, 'advertiser_wallet', ?, 'deposit', 'credit', ?, ?, 'USD', 'webhook', ?, ?)`,
          [
            `led_${crypto.randomUUID().slice(0, 12)}`,
            `wh_${provider}_${eventId}`,
            wallet.id,
            amountMicros,
            newBal,
            String(eventId),
            `Verified ${provider} webhook credit`,
          ]
        );

        return { duplicate: false, balanceAfterMicros: newBal, billingEmail: wallet.billing_email };
      });

      if ('notFound' in outcome && outcome.notFound) {
        res.status(404).json({ error: 'Advertiser wallet not found' });
        return;
      }

      if ('billingEmail' in outcome && outcome.billingEmail && !outcome.duplicate) {
        await queueTransactionalEmail(db, {
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
