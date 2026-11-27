import crypto from 'node:crypto';
import { createAppRouter, type AppRouter, type Response } from '../http/router';
import { AuthenticatedRequest, createAuthMiddleware, requireRole } from '../auth';
import { withTransaction, type DbClient } from '../db/postgres';
import { verifyDomainOwnershipLive } from '../security';
import { getFeatureFlags } from '../modules/featureFlags';
import {
  asTrimmedString,
  validateDimensions,
  validateNumberRange,
  validatePayoutMethodInput,
  validatePlacementCreateInput,
  validatePropertyCreateInput,
  validateTextLength,
  validateWithdrawalInput,
} from '../../src/lib/validation';

export function createPublisherRouter(db: DbClient): AppRouter {
  const router = createAppRouter();
  const requireAuth = createAuthMiddleware(db);
  router.use(requireAuth, requireRole('publisher', 'admin'));

  async function resolvePublisherId(req: AuthenticatedRequest): Promise<string | null> {
    if (req.auth?.role === 'admin' && typeof req.query.publisherId === 'string') {
      return req.query.publisherId;
    }
    const row = await db.queryOne<{ id: string }>(
      'SELECT id FROM publisher_accounts WHERE user_id = ?',
      [req.auth!.userId]
    );
    return row?.id ?? null;
  }

  function parseSettingNumber(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    try {
      const parsed = Number(JSON.parse(raw));
      return Number.isFinite(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  // GET /api/publisher/overview
  router.get('/overview', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = await resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const account = await db.queryOne('SELECT * FROM publisher_accounts WHERE id = ?', [publisherId]);
    const wallet = await db.queryOne('SELECT * FROM publisher_wallets WHERE publisher_id = ?', [publisherId]);
    const settingRow = await db.queryOne<{ value_json: string }>(
      "SELECT value_json FROM platform_settings WHERE key = 'default_publisher_share_bps'"
    );
    const defaultBps = parseSettingNumber(settingRow?.value_json, 7000);

    const minPayoutRow = await db.queryOne<{ value_json: string }>(
      "SELECT value_json FROM platform_settings WHERE key = 'minimum_publisher_payout_micros'"
    );
    const minPayoutMicros = parseSettingNumber(minPayoutRow?.value_json, 50_000_000);

    const stats = (await db.queryOne<{
      total_requests: number;
      filled_requests: number;
      impressions: number;
      clicks: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM ad_requests WHERE publisher_id = ?) AS total_requests,
         (SELECT COUNT(*) FROM ad_requests WHERE publisher_id = ? AND filled = 1) AS filled_requests,
         (SELECT COUNT(*) FROM impressions WHERE publisher_id = ? AND is_valid = 1) AS impressions,
         (SELECT COUNT(*) FROM clicks WHERE publisher_id = ? AND is_valid = 1) AS clicks`,
      [publisherId, publisherId, publisherId, publisherId]
    ))!;

    const totalRequests = Number(stats.total_requests);
    const filledRequests = Number(stats.filled_requests);
    const impressionsCount = Number(stats.impressions);
    const clicksCount = Number(stats.clicks);

    const dailyRevenue = await db.query<{
      day: string;
      impressions: number;
      imp_earnings_micros: number;
    }>(
      `SELECT date(created_at) AS day,
              COUNT(*) AS impressions,
              COALESCE(SUM(publisher_share_micros), 0) AS imp_earnings_micros
       FROM impressions
       WHERE publisher_id = ? AND is_valid = 1
       GROUP BY date(created_at)
       ORDER BY day ASC
       LIMIT 14`,
      [publisherId]
    );

    const clickRev = await db.query<{
      day: string;
      clicks: number;
      clk_earnings_micros: number;
    }>(
      `SELECT date(created_at) AS day,
              COUNT(*) AS clicks,
              COALESCE(SUM(publisher_share_micros), 0) AS clk_earnings_micros
       FROM clicks
       WHERE publisher_id = ? AND is_valid = 1
       GROUP BY date(created_at)`,
      [publisherId]
    );
    const clickMap = new Map(clickRev.map((c) => [c.day, c]));

    const revenueSeries = dailyRevenue.map((d) => {
      const clk = clickMap.get(d.day);
      return {
        day: d.day,
        impressions: Number(d.impressions),
        clicks: Number(clk?.clicks ?? 0),
        earningsMicros: Number(d.imp_earnings_micros) + Number(clk?.clk_earnings_micros ?? 0),
      };
    });

    const fillRate = totalRequests > 0 ? filledRequests / totalRequests : 0;
    const ctr = impressionsCount > 0 ? clicksCount / impressionsCount : 0;
    const totalSeriesMicros = revenueSeries.reduce((sum, r) => sum + r.earningsMicros, 0);
    const ecpmMicros = impressionsCount > 0 ? Math.round((totalSeriesMicros / impressionsCount) * 1000) : 0;

    res.json({
      account,
      wallet,
      defaultShareBps: defaultBps,
      minPayoutMicros,
      featureFlags: await getFeatureFlags(db),
      kpis: {
        total_requests: totalRequests,
        filled_requests: filledRequests,
        impressions: impressionsCount,
        clicks: clicksCount,
        fillRate,
        ctr,
        ecpmMicros,
      },
      revenueSeries,
    });
  });

  // GET /api/publisher/properties
  router.get('/properties', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = await resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const properties = await db.query(
      `SELECT p.*,
              dv.method AS verification_method, dv.verification_token, dv.verified_at,
              (SELECT COUNT(*) FROM ad_placements ap WHERE ap.property_id = p.id) AS placement_count
       FROM publisher_properties p
       LEFT JOIN domain_verifications dv ON dv.property_id = p.id
       WHERE p.publisher_id = ?
       ORDER BY p.created_at DESC`,
      [publisherId]
    );

    res.json({ properties });
  });

  // POST /api/publisher/properties
  router.post('/properties', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = await resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const validation = validatePropertyCreateInput(req.body ?? {});
    if (!validation.valid || !validation.value) {
      res.status(400).json({ error: validation.firstError, fieldErrors: validation.errors });
      return;
    }
    const { propertyType, name, domainOrBundle, category, language, monthlyPageviews, verificationMethod } =
      validation.value;

    const propId = `prop_${crypto.randomUUID().slice(0, 10)}`;
    const token =
      verificationMethod === 'ads_txt'
        ? `looma-ads.com, ${publisherId}, DIRECT, ${crypto.randomBytes(4).toString('hex')}`
        : `looma-verify=${crypto.randomBytes(6).toString('hex')}`;

    await withTransaction(db, async (tx) => {
      await tx.execute(
        `INSERT INTO publisher_properties (id, publisher_id, property_type, name, domain_or_bundle, category, language, verification_status, approval_status, monthly_pageviews)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?)`,
        [propId, publisherId, propertyType, name, domainOrBundle, category, language, monthlyPageviews]
      );

      await tx.execute(
        `INSERT INTO domain_verifications (id, property_id, method, verification_token, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [`ver_${crypto.randomUUID().slice(0, 10)}`, propId, verificationMethod, token]
      );
    });

    res.status(201).json({ propertyId: propId, verificationToken: token });
  });

  // PATCH /api/publisher/properties/:id
  router.patch('/properties/:id', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = await resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }
    const existing = await db.queryOne<{
      id: string;
      name: string;
      category: string;
      language: string;
      monthly_pageviews: number;
    }>(
      'SELECT id, name, category, language, monthly_pageviews FROM publisher_properties WHERE id = ? AND publisher_id = ?',
      [String(req.params.id), publisherId]
    );
    if (!existing) {
      res.status(404).json({ error: 'Property not found' });
      return;
    }

    const { name, category, language, monthlyPageviews } = req.body ?? {};
    const fieldErrors: Record<string, string> = {};
    let nextName = existing.name;
    if (name !== undefined) {
      const err = validateTextLength(name, { label: 'Property name', min: 2, max: 100 });
      if (err) fieldErrors.name = err;
      else nextName = asTrimmedString(name) || existing.name;
    }
    let nextCategory = existing.category;
    if (category !== undefined) {
      const cleanCat = asTrimmedString(category);
      if (!cleanCat || cleanCat.length > 60 || !/^[a-z0-9_]+$/i.test(cleanCat)) {
        fieldErrors.category = 'Select a valid content category.';
      } else {
        nextCategory = cleanCat;
      }
    }
    let nextLang = existing.language;
    if (language !== undefined) {
      const cleanLang = asTrimmedString(language);
      if (!cleanLang || !/^[a-zA-Z]{2,5}(?:-[a-zA-Z]{2,4})?$/.test(cleanLang)) {
        fieldErrors.language = 'Use a valid ISO language code (for example, en).';
      } else {
        nextLang = cleanLang.toLowerCase();
      }
    }
    let nextViews = Number(existing.monthly_pageviews);
    if (monthlyPageviews !== undefined) {
      const viewsRes = validateNumberRange(monthlyPageviews, {
        label: 'Monthly pageviews',
        min: 0,
        max: 1_000_000_000,
        integer: true,
      });
      if (viewsRes.error) fieldErrors.monthlyPageviews = viewsRes.error;
      else if (viewsRes.value !== null) nextViews = viewsRes.value;
    }

    const firstKey = Object.keys(fieldErrors)[0];
    if (firstKey) {
      res.status(400).json({ error: fieldErrors[firstKey], fieldErrors });
      return;
    }

    await db.execute(
      'UPDATE publisher_properties SET name = ?, category = ?, language = ?, monthly_pageviews = ? WHERE id = ? AND publisher_id = ?',
      [nextName, nextCategory, nextLang, nextViews, existing.id, publisherId]
    );

    res.json({ updated: true, id: existing.id });
  });

  // DELETE /api/publisher/properties/:id
  router.delete('/properties/:id', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = await resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }
    const existing = await db.queryOne<{ id: string }>(
      'SELECT id FROM publisher_properties WHERE id = ? AND publisher_id = ?',
      [String(req.params.id), publisherId]
    );
    if (!existing) {
      res.status(404).json({ error: 'Property not found' });
      return;
    }

    const placementCount = await db.queryOne<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM ad_placements WHERE property_id = ?',
      [existing.id]
    );
    const reqCount = await db.queryOne<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM ad_requests WHERE property_id = ?',
      [existing.id]
    );

    if (Number(placementCount?.cnt ?? 0) > 0 || Number(reqCount?.cnt ?? 0) > 0) {
      res.status(409).json({ error: 'Cannot delete a property that has active placements or ad delivery history' });
      return;
    }

    await withTransaction(db, async (tx) => {
      await tx.execute('DELETE FROM domain_verifications WHERE property_id = ?', [existing.id]);
      await tx.execute('DELETE FROM publisher_properties WHERE id = ? AND publisher_id = ?', [existing.id, publisherId]);
    });

    res.json({ deleted: true, id: existing.id });
  });

  // POST /api/publisher/properties/:id/verify (Live DNS TXT / ads.txt / meta verification with optional sandbox override)
  router.post('/properties/:id/verify', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = await resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const prop = await db.queryOne<{
      id: string;
      domain_or_bundle: string;
      method: string | null;
      verification_token: string | null;
    }>(
      `SELECT p.id, p.domain_or_bundle, dv.method, dv.verification_token
       FROM publisher_properties p
       LEFT JOIN domain_verifications dv ON dv.property_id = p.id
       WHERE p.id = ? AND p.publisher_id = ?`,
      [String(req.params.id), publisherId]
    );

    if (!prop) {
      res.status(404).json({ error: 'Property not found' });
      return;
    }

    const sandboxOverride = Boolean(req.body?.sandboxOverride);
    const method = (prop.method === 'ads_txt' || prop.method === 'meta_tag' ? prop.method : 'dns_txt') as
      | 'dns_txt'
      | 'ads_txt'
      | 'meta_tag';
    const token = prop.verification_token || '';

    if (sandboxOverride) {
      const sandboxVerificationAllowed =
        req.auth?.role === 'admin' ||
        process.env.ALLOW_SANDBOX_VERIFICATION === 'true' ||
        (process.env.ALLOW_SANDBOX_VERIFICATION !== 'false' &&
          process.env.NODE_ENV !== 'production' &&
          process.env.LOOMA_RUNTIME !== 'cloudflare-worker');

      if (!sandboxVerificationAllowed) {
        res.status(403).json({
          error: 'Sandbox domain verification override requires administrator privileges in production.',
        });
        return;
      }

      const nowIso = new Date().toISOString();
      await withTransaction(db, async (tx) => {
        await tx.execute("UPDATE publisher_properties SET verification_status = 'verified' WHERE id = ?", [prop.id]);
        await tx.execute("UPDATE domain_verifications SET status = 'verified', verified_at = ? WHERE property_id = ?", [
          nowIso,
          prop.id,
        ]);
      });
      res.json({
        verified: true,
        mode: 'sandbox',
        propertyId: prop.id,
        checkedTarget: prop.domain_or_bundle,
        recordsChecked: 1,
        detail: `Verified ${prop.domain_or_bundle} ownership.`,
      });
      return;
    }

    const liveResult = await verifyDomainOwnershipLive(prop.domain_or_bundle, method, token);
    if (liveResult.verified) {
      const nowIso = new Date().toISOString();
      await withTransaction(db, async (tx) => {
        await tx.execute("UPDATE publisher_properties SET verification_status = 'verified' WHERE id = ?", [prop.id]);
        await tx.execute("UPDATE domain_verifications SET status = 'verified', verified_at = ? WHERE property_id = ?", [
          nowIso,
          prop.id,
        ]);
      });
    }

    res.json({
      verified: liveResult.verified,
      mode: 'live',
      propertyId: prop.id,
      checkedTarget: liveResult.checkedTarget,
      recordsChecked: liveResult.recordsChecked,
      detail: liveResult.detail,
    });
  });

  // GET /api/publisher/placements
  router.get('/placements', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = await resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const placements = await db.query(
      `SELECT ap.*, pp.name AS property_name, pp.domain_or_bundle, pp.approval_status AS property_approval,
              (SELECT COUNT(*) FROM impressions i WHERE i.placement_id = ap.id AND i.is_valid = 1) AS impressions,
              (SELECT COUNT(*) FROM clicks k WHERE k.placement_id = ap.id AND k.is_valid = 1) AS clicks
       FROM ad_placements ap
       JOIN publisher_properties pp ON pp.id = ap.property_id
       WHERE ap.publisher_id = ?
       ORDER BY ap.created_at DESC`,
      [publisherId]
    );

    res.json({ placements });
  });

  // POST /api/publisher/placements
  router.post('/placements', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = await resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const validation = validatePlacementCreateInput(req.body ?? {});
    if (!validation.valid || !validation.value) {
      res.status(400).json({ error: validation.firstError, fieldErrors: validation.errors });
      return;
    }
    const { propertyId, name, format, dimensions, floorCpmUsd } = validation.value;

    const prop = await db.queryOne(
      'SELECT id FROM publisher_properties WHERE id = ? AND publisher_id = ?',
      [propertyId, publisherId]
    );
    if (!prop) {
      res.status(404).json({ error: 'Publisher property not found' });
      return;
    }

    const placementId = `plc_${crypto.randomUUID().slice(0, 10)}`;
    const floorMicros = Math.round(floorCpmUsd * 1_000_000);

    await db.execute(
      `INSERT INTO ad_placements (id, property_id, publisher_id, name, format, dimensions, floor_cpm_micros, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [placementId, propertyId, publisherId, name, format, dimensions, floorMicros]
    );

    res.status(201).json({ placementId });
  });

  // PATCH /api/publisher/placements/:id
  router.patch('/placements/:id', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = await resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const existing = await db.queryOne<{
      id: string;
      name: string;
      dimensions: string;
      floor_cpm_micros: number;
      status: string;
    }>(
      'SELECT id, name, dimensions, floor_cpm_micros, status FROM ad_placements WHERE id = ? AND publisher_id = ?',
      [String(req.params.id), publisherId]
    );

    if (!existing) {
      res.status(404).json({ error: 'Placement not found' });
      return;
    }

    const { status, name, dimensions, floorCpmUsd } = req.body ?? {};
    const fieldErrors: Record<string, string> = {};
    let nextStatus = existing.status;
    if (status !== undefined) {
      if (!['active', 'paused', 'disabled'].includes(String(status))) {
        fieldErrors.status = 'Status must be active, paused, or disabled.';
      } else {
        nextStatus = String(status);
      }
    }
    let nextName = existing.name;
    if (name !== undefined) {
      const nameErr = validateTextLength(name, { label: 'Placement name', min: 2, max: 100 });
      if (nameErr) fieldErrors.name = nameErr;
      else nextName = asTrimmedString(name) || existing.name;
    }
    let nextDimensions = existing.dimensions;
    if (dimensions !== undefined) {
      const dimErr = validateDimensions(dimensions);
      if (dimErr) fieldErrors.dimensions = dimErr;
      else nextDimensions = asTrimmedString(dimensions) || existing.dimensions;
    }
    let nextFloorMicros = Number(existing.floor_cpm_micros);
    if (floorCpmUsd !== undefined) {
      const floorRes = validateNumberRange(floorCpmUsd, { label: 'Floor CPM', min: 0.1, max: 500, currency: true });
      if (floorRes.error) fieldErrors.floorCpmUsd = floorRes.error;
      else if (floorRes.value !== null) nextFloorMicros = Math.round(floorRes.value * 1_000_000);
    }

    const firstKey = Object.keys(fieldErrors)[0];
    if (firstKey) {
      res.status(400).json({ error: fieldErrors[firstKey], fieldErrors });
      return;
    }

    await db.execute(
      'UPDATE ad_placements SET status = ?, name = ?, dimensions = ?, floor_cpm_micros = ? WHERE id = ? AND publisher_id = ?',
      [nextStatus, nextName, nextDimensions, nextFloorMicros, existing.id, publisherId]
    );

    res.json({ updated: true, id: existing.id });
  });

  // DELETE /api/publisher/placements/:id
  router.delete('/placements/:id', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = await resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const existing = await db.queryOne<{ id: string }>(
      'SELECT id FROM ad_placements WHERE id = ? AND publisher_id = ?',
      [String(req.params.id), publisherId]
    );
    if (!existing) {
      res.status(404).json({ error: 'Placement not found' });
      return;
    }

    const historyCount = await db.queryOne<{ cnt: number }>(
      `SELECT
         (SELECT COUNT(*) FROM ad_requests WHERE placement_id = ?) +
         (SELECT COUNT(*) FROM impressions WHERE placement_id = ?) +
         (SELECT COUNT(*) FROM clicks WHERE placement_id = ?) +
         (SELECT COUNT(*) FROM video_events WHERE placement_id = ?) AS cnt`,
      [existing.id, existing.id, existing.id, existing.id]
    );

    if (Number(historyCount?.cnt ?? 0) > 0) {
      await db.execute("UPDATE ad_placements SET status = 'disabled' WHERE id = ? AND publisher_id = ?", [
        existing.id,
        publisherId,
      ]);
      res.json({ deleted: false, disabled: true, id: existing.id });
      return;
    }

    await db.execute('DELETE FROM ad_placements WHERE id = ? AND publisher_id = ?', [existing.id, publisherId]);
    res.json({ deleted: true, disabled: false, id: existing.id });
  });

  // GET /api/publisher/earnings
  router.get('/earnings', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = await resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const wallet = await db.queryOne<{ id: string }>(
      'SELECT * FROM publisher_wallets WHERE publisher_id = ?',
      [publisherId]
    );
    if (!wallet) {
      res.status(404).json({ error: 'Publisher wallet not found' });
      return;
    }
    const account = await db.queryOne(
      'SELECT payout_method_type, payout_destination, custom_revenue_share_bps, publisher_type FROM publisher_accounts WHERE id = ?',
      [publisherId]
    );
    const withdrawals = await db.query(
      'SELECT * FROM withdrawals WHERE publisher_id = ? ORDER BY created_at DESC',
      [publisherId]
    );
    const ledger = await db.query(
      "SELECT * FROM financial_ledger WHERE account_type = 'publisher_wallet' AND account_id = ? ORDER BY created_at DESC LIMIT 50",
      [wallet.id]
    );

    const minPayoutRow = await db.queryOne<{ value_json: string }>(
      "SELECT value_json FROM platform_settings WHERE key = 'minimum_publisher_payout_micros'"
    );
    const minPayoutMicros = parseSettingNumber(minPayoutRow?.value_json, 50_000_000);

    res.json({ wallet, account, withdrawals, ledger, minPayoutMicros, featureFlags: await getFeatureFlags(db) });
  });

  // POST /api/publisher/withdraw
  router.post('/withdraw', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = await resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const pubTypeRow = await db.queryOne<{ publisher_type: string | null }>(
      'SELECT publisher_type FROM publisher_accounts WHERE id = ?',
      [publisherId]
    );
    const flags = await getFeatureFlags(db);
    if (
      pubTypeRow?.publisher_type === 'third_party' &&
      !flags.third_party_publisher_payouts_enabled
    ) {
      res.status(403).json({
        error: 'Third-party publisher payouts are disabled until the external publisher expansion phase.',
      });
      return;
    }

    const minPayoutRow = await db.queryOne<{ value_json: string }>(
      "SELECT value_json FROM platform_settings WHERE key = 'minimum_publisher_payout_micros'"
    );
    const minPayoutMicros = parseSettingNumber(minPayoutRow?.value_json, 50_000_000);

    const wdrValidation = validateWithdrawalInput({
      ...(req.body ?? {}),
      minPayoutUsd: minPayoutMicros / 1_000_000,
    });
    if (!wdrValidation.valid || !wdrValidation.value) {
      res.status(400).json({ error: wdrValidation.firstError, fieldErrors: wdrValidation.errors });
      return;
    }
    const { amountUsd: parsedAmount, payoutMethod, payoutDestination } = wdrValidation.value;
    const amountMicros = Math.round(parsedAmount * 1_000_000);

    const outcome = await withTransaction(db, async (tx) => {
      const wallet = await tx.queryOne<{ id: string }>(
        'SELECT id FROM publisher_wallets WHERE publisher_id = ?',
        [publisherId]
      );
      const pub = await tx.queryOne<{ payout_method_type: string; payout_destination: string }>(
        'SELECT payout_method_type, payout_destination FROM publisher_accounts WHERE id = ?',
        [publisherId]
      );
      if (!wallet || !pub) {
        return { error: 'Publisher wallet not found' };
      }

      const method = String(payoutMethod || pub.payout_method_type || 'bank_transfer');
      const destination = String(payoutDestination || pub.payout_destination || '').trim();
      if (!destination) {
        return { error: 'Please configure a payout destination before requesting withdrawal' };
      }

      const debitRes = await tx.execute(
        `UPDATE publisher_wallets
         SET available_micros = available_micros - ?, pending_micros = pending_micros + ?, updated_at = ?
         WHERE id = ? AND available_micros >= ?`,
        [amountMicros, amountMicros, new Date().toISOString(), wallet.id, amountMicros]
      );
      if (debitRes.rowCount === 0) {
        return { error: 'Withdrawal amount exceeds finalized available balance' };
      }

      const updatedWallet = (await tx.queryOne<{ available_micros: number; pending_micros: number }>(
        'SELECT available_micros, pending_micros FROM publisher_wallets WHERE id = ?',
        [wallet.id]
      ))!;
      const newAvailable = Number(updatedWallet.available_micros);
      const newPending = Number(updatedWallet.pending_micros);
      const withdrawalId = `wdr_${crypto.randomUUID().slice(0, 10)}`;

      await tx.execute(
        `INSERT INTO withdrawals (id, publisher_id, amount_micros, currency, payout_method, payout_destination, status, notes)
         VALUES (?, ?, ?, 'USD', ?, ?, 'pending', 'Publisher payout request queued for admin reconciliation')`,
        [withdrawalId, publisherId, amountMicros, method, destination]
      );

      return { withdrawalId, availableMicros: newAvailable, pendingMicros: newPending };
    });

    if ('error' in outcome) {
      res.status(400).json({ error: outcome.error });
      return;
    }
    res.status(201).json(outcome);
  });

  // PATCH /api/publisher/payout-method
  router.patch('/payout-method', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = await resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }
    const pmValidation = validatePayoutMethodInput(req.body ?? {});
    if (!pmValidation.valid || !pmValidation.value) {
      res.status(400).json({ error: pmValidation.firstError, fieldErrors: pmValidation.errors });
      return;
    }
    await db.execute(
      'UPDATE publisher_accounts SET payout_method_type = ?, payout_destination = ? WHERE id = ?',
      [pmValidation.value.payoutMethodType, pmValidation.value.payoutDestination, publisherId]
    );
    res.json({ updated: true });
  });

  return router;
}
