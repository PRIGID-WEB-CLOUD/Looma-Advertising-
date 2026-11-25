import crypto from 'node:crypto';
import { Router, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { AuthenticatedRequest, createAuthMiddleware, requireRole } from '../auth';
import { withTransaction } from '../db';
import { verifyDomainOwnershipLive } from '../security';
import { getFeatureFlags } from '../modules/featureFlags';

export function createPublisherRouter(db: DatabaseSync): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(db);
  router.use(requireAuth, requireRole('publisher', 'admin'));

  function resolvePublisherId(req: AuthenticatedRequest): string | null {
    if (req.auth?.role === 'admin' && typeof req.query.publisherId === 'string') {
      return req.query.publisherId;
    }
    const row = db
      .prepare('SELECT id FROM publisher_accounts WHERE user_id = ?')
      .get(req.auth!.userId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  // GET /api/publisher/overview
  router.get('/overview', (req: AuthenticatedRequest, res: Response) => {
    const publisherId = resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const account = db.prepare('SELECT * FROM publisher_accounts WHERE id = ?').get(publisherId);
    const wallet = db.prepare('SELECT * FROM publisher_wallets WHERE publisher_id = ?').get(publisherId);
    const settingRow = db
      .prepare("SELECT value_json FROM platform_settings WHERE key = 'default_publisher_share_bps'")
      .get() as { value_json: string } | undefined;
    const defaultBps = settingRow ? Number(JSON.parse(settingRow.value_json)) : 7000;

    const minPayoutRow = db
      .prepare("SELECT value_json FROM platform_settings WHERE key = 'minimum_publisher_payout_micros'")
      .get() as { value_json: string } | undefined;
    const minPayoutMicros = minPayoutRow ? Number(JSON.parse(minPayoutRow.value_json)) : 50_000_000;

    const stats = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM ad_requests WHERE publisher_id = ?) AS total_requests,
           (SELECT COUNT(*) FROM ad_requests WHERE publisher_id = ? AND filled = 1) AS filled_requests,
           (SELECT COUNT(*) FROM impressions WHERE publisher_id = ? AND is_valid = 1) AS impressions,
           (SELECT COUNT(*) FROM clicks WHERE publisher_id = ? AND is_valid = 1) AS clicks`
      )
      .get(publisherId, publisherId, publisherId, publisherId) as {
      total_requests: number;
      filled_requests: number;
      impressions: number;
      clicks: number;
    };

    const dailyRevenue = db
      .prepare(
        `SELECT date(created_at) AS day,
                COUNT(*) AS impressions,
                COALESCE(SUM(publisher_share_micros), 0) AS imp_earnings_micros
         FROM impressions
         WHERE publisher_id = ? AND is_valid = 1
         GROUP BY date(created_at)
         ORDER BY day ASC
         LIMIT 14`
      )
      .all(publisherId) as Array<{ day: string; impressions: number; imp_earnings_micros: number }>;

    const clickRev = db
      .prepare(
        `SELECT date(created_at) AS day,
                COUNT(*) AS clicks,
                COALESCE(SUM(publisher_share_micros), 0) AS clk_earnings_micros
         FROM clicks
         WHERE publisher_id = ? AND is_valid = 1
         GROUP BY date(created_at)`
      )
      .all(publisherId) as Array<{ day: string; clicks: number; clk_earnings_micros: number }>;
    const clickMap = new Map(clickRev.map((c) => [c.day, c]));

    const revenueSeries = dailyRevenue.map((d) => {
      const clk = clickMap.get(d.day);
      return {
        day: d.day,
        impressions: d.impressions,
        clicks: clk?.clicks ?? 0,
        earningsMicros: d.imp_earnings_micros + (clk?.clk_earnings_micros ?? 0),
      };
    });

    const fillRate = stats.total_requests > 0 ? stats.filled_requests / stats.total_requests : 0;
    const ctr = stats.impressions > 0 ? stats.clicks / stats.impressions : 0;
    const totalSeriesMicros = revenueSeries.reduce((sum, r) => sum + r.earningsMicros, 0);
    const ecpmMicros = stats.impressions > 0 ? Math.round((totalSeriesMicros / stats.impressions) * 1000) : 0;

    res.json({
      account,
      wallet,
      defaultShareBps: defaultBps,
      minPayoutMicros,
      featureFlags: getFeatureFlags(db),
      kpis: {
        ...stats,
        fillRate,
        ctr,
        ecpmMicros,
      },
      revenueSeries,
    });
  });

  // GET /api/publisher/properties
  router.get('/properties', (req: AuthenticatedRequest, res: Response) => {
    const publisherId = resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const properties = db
      .prepare(
        `SELECT p.*,
                dv.method AS verification_method, dv.verification_token, dv.verified_at,
                (SELECT COUNT(*) FROM ad_placements ap WHERE ap.property_id = p.id) AS placement_count
         FROM publisher_properties p
         LEFT JOIN domain_verifications dv ON dv.property_id = p.id
         WHERE p.publisher_id = ?
         ORDER BY p.created_at DESC`
      )
      .all(publisherId);

    res.json({ properties });
  });

  // POST /api/publisher/properties
  router.post('/properties', (req: AuthenticatedRequest, res: Response) => {
    const publisherId = resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const {
      propertyType = 'website',
      name,
      domainOrBundle,
      category = 'news_technology',
      language = 'en',
      monthlyPageviews = 50000,
      verificationMethod = 'dns_txt',
    } = req.body ?? {};

    if (!name || !domainOrBundle) {
      res.status(400).json({ error: 'Property name and domain or app bundle ID are required' });
      return;
    }
    if (!['website', 'ios_app', 'android_app', 'web_app'].includes(String(propertyType))) {
      res.status(400).json({ error: 'Invalid propertyType' });
      return;
    }
    if (!['dns_txt', 'meta_tag', 'ads_txt'].includes(String(verificationMethod))) {
      res.status(400).json({ error: 'Invalid verificationMethod' });
      return;
    }

    const propId = `prop_${crypto.randomUUID().slice(0, 10)}`;
    const token =
      verificationMethod === 'ads_txt'
        ? `looma-ads.com, ${publisherId}, DIRECT, ${crypto.randomBytes(4).toString('hex')}`
        : `looma-verify=${crypto.randomBytes(6).toString('hex')}`;

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO publisher_properties (id, publisher_id, property_type, name, domain_or_bundle, category, language, verification_status, approval_status, monthly_pageviews)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?)`
      ).run(propId, publisherId, String(propertyType), String(name).trim(), String(domainOrBundle).trim(), String(category), String(language), Math.max(0, Number(monthlyPageviews) || 0));

      db.prepare(
        `INSERT INTO domain_verifications (id, property_id, method, verification_token, status)
         VALUES (?, ?, ?, ?, 'pending')`
      ).run(`ver_${crypto.randomUUID().slice(0, 10)}`, propId, String(verificationMethod), token);
    });

    res.status(201).json({ propertyId: propId, verificationToken: token });
  });

  // PATCH /api/publisher/properties/:id
  router.patch('/properties/:id', (req: AuthenticatedRequest, res: Response) => {
    const publisherId = resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }
    const existing = db
      .prepare('SELECT id, name, category, language, monthly_pageviews FROM publisher_properties WHERE id = ? AND publisher_id = ?')
      .get(String(req.params.id), publisherId) as
      | { id: string; name: string; category: string; language: string; monthly_pageviews: number }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Property not found' });
      return;
    }

    const { name, category, language, monthlyPageviews } = req.body ?? {};
    const nextName = name !== undefined ? String(name).trim() : existing.name;
    if (!nextName) {
      res.status(400).json({ error: 'Property name cannot be empty' });
      return;
    }
    const nextCategory = category !== undefined ? String(category).trim() || existing.category : existing.category;
    const nextLang = language !== undefined ? String(language).trim() || existing.language : existing.language;
    const nextViews =
      monthlyPageviews !== undefined
        ? Math.max(0, Number.isFinite(Number(monthlyPageviews)) ? Math.round(Number(monthlyPageviews)) : existing.monthly_pageviews)
        : existing.monthly_pageviews;

    db.prepare(
      'UPDATE publisher_properties SET name = ?, category = ?, language = ?, monthly_pageviews = ? WHERE id = ? AND publisher_id = ?'
    ).run(nextName, nextCategory, nextLang, nextViews, existing.id, publisherId);

    res.json({ updated: true, id: existing.id });
  });

  // DELETE /api/publisher/properties/:id
  router.delete('/properties/:id', (req: AuthenticatedRequest, res: Response) => {
    const publisherId = resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }
    const existing = db
      .prepare('SELECT id FROM publisher_properties WHERE id = ? AND publisher_id = ?')
      .get(String(req.params.id), publisherId) as { id: string } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Property not found' });
      return;
    }

    const placementCount = db
      .prepare('SELECT COUNT(*) AS cnt FROM ad_placements WHERE property_id = ?')
      .get(existing.id) as { cnt: number };
    const reqCount = db
      .prepare('SELECT COUNT(*) AS cnt FROM ad_requests WHERE property_id = ?')
      .get(existing.id) as { cnt: number };

    if (placementCount.cnt > 0 || reqCount.cnt > 0) {
      res.status(409).json({ error: 'Cannot delete a property that has active placements or ad delivery history' });
      return;
    }

    withTransaction(db, () => {
      db.prepare('DELETE FROM domain_verifications WHERE property_id = ?').run(existing.id);
      db.prepare('DELETE FROM publisher_properties WHERE id = ? AND publisher_id = ?').run(existing.id, publisherId);
    });

    res.json({ deleted: true, id: existing.id });
  });

  // POST /api/publisher/properties/:id/verify (Live DNS TXT / ads.txt / meta verification with optional sandbox override)
  router.post('/properties/:id/verify', async (req: AuthenticatedRequest, res: Response) => {
    const publisherId = resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const prop = db
      .prepare(
        `SELECT p.id, p.domain_or_bundle, dv.method, dv.verification_token
         FROM publisher_properties p
         LEFT JOIN domain_verifications dv ON dv.property_id = p.id
         WHERE p.id = ? AND p.publisher_id = ?`
      )
      .get(String(req.params.id), publisherId) as
      | { id: string; domain_or_bundle: string; method: string | null; verification_token: string | null }
      | undefined;

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
      withTransaction(db, () => {
        db.prepare("UPDATE publisher_properties SET verification_status = 'verified' WHERE id = ?").run(prop.id);
        db.prepare("UPDATE domain_verifications SET status = 'verified', verified_at = datetime('now') WHERE property_id = ?").run(prop.id);
      });
      res.json({
        verified: true,
        mode: 'sandbox',
        propertyId: prop.id,
        checkedTarget: prop.domain_or_bundle,
        recordsChecked: 1,
        detail: `Verified ${prop.domain_or_bundle} in sandbox testing mode.`,
      });
      return;
    }

    const liveResult = await verifyDomainOwnershipLive(prop.domain_or_bundle, method, token);
    if (liveResult.verified) {
      withTransaction(db, () => {
        db.prepare("UPDATE publisher_properties SET verification_status = 'verified' WHERE id = ?").run(prop.id);
        db.prepare("UPDATE domain_verifications SET status = 'verified', verified_at = datetime('now') WHERE property_id = ?").run(prop.id);
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
  router.get('/placements', (req: AuthenticatedRequest, res: Response) => {
    const publisherId = resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const placements = db
      .prepare(
        `SELECT ap.*, pp.name AS property_name, pp.domain_or_bundle, pp.approval_status AS property_approval,
                (SELECT COUNT(*) FROM impressions i WHERE i.placement_id = ap.id AND i.is_valid = 1) AS impressions,
                (SELECT COUNT(*) FROM clicks k WHERE k.placement_id = ap.id AND k.is_valid = 1) AS clicks
         FROM ad_placements ap
         JOIN publisher_properties pp ON pp.id = ap.property_id
         WHERE ap.publisher_id = ?
         ORDER BY ap.created_at DESC`
      )
      .all(publisherId);

    res.json({ placements });
  });

  // POST /api/publisher/placements
  router.post('/placements', (req: AuthenticatedRequest, res: Response) => {
    const publisherId = resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const { propertyId, name, format = 'native', dimensions = 'responsive', floorCpmUsd = 0.75 } = req.body ?? {};
    if (!propertyId || !name) {
      res.status(400).json({ error: 'Property and placement name are required' });
      return;
    }

    if (!['banner', 'responsive', 'native', 'video', 'in_feed', 'interstitial'].includes(String(format))) {
      res.status(400).json({ error: 'Invalid placement format' });
      return;
    }
    const parsedFloor = Number(floorCpmUsd);
    if (!Number.isFinite(parsedFloor) || parsedFloor < 0) {
      res.status(400).json({ error: 'floorCpmUsd must be a valid non-negative number' });
      return;
    }

    const prop = db
      .prepare('SELECT id FROM publisher_properties WHERE id = ? AND publisher_id = ?')
      .get(propertyId, publisherId);
    if (!prop) {
      res.status(404).json({ error: 'Publisher property not found' });
      return;
    }

    const placementId = `plc_${crypto.randomUUID().slice(0, 10)}`;
    const floorMicros = Math.max(100_000, Math.round(parsedFloor * 1_000_000));

    db.prepare(
      `INSERT INTO ad_placements (id, property_id, publisher_id, name, format, dimensions, floor_cpm_micros, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
    ).run(placementId, propertyId, publisherId, String(name).trim(), String(format), String(dimensions), floorMicros);

    res.status(201).json({ placementId });
  });

  // PATCH /api/publisher/placements/:id
  router.patch('/placements/:id', (req: AuthenticatedRequest, res: Response) => {
    const publisherId = resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const existing = db
      .prepare('SELECT id, name, dimensions, floor_cpm_micros, status FROM ad_placements WHERE id = ? AND publisher_id = ?')
      .get(String(req.params.id), publisherId) as
      | { id: string; name: string; dimensions: string; floor_cpm_micros: number; status: string }
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Placement not found' });
      return;
    }

    const { status, name, dimensions, floorCpmUsd } = req.body ?? {};
    if (status !== undefined && !['active', 'paused', 'disabled'].includes(String(status))) {
      res.status(400).json({ error: 'Invalid status' });
      return;
    }
    if (floorCpmUsd !== undefined && (!Number.isFinite(Number(floorCpmUsd)) || Number(floorCpmUsd) < 0)) {
      res.status(400).json({ error: 'floorCpmUsd must be a valid non-negative number' });
      return;
    }

    const nextStatus = status !== undefined ? String(status) : existing.status;
    const nextName = name !== undefined ? String(name).trim() || existing.name : existing.name;
    const nextDimensions = dimensions !== undefined ? String(dimensions).trim() || existing.dimensions : existing.dimensions;
    const nextFloorMicros =
      floorCpmUsd !== undefined ? Math.max(100_000, Math.round(Number(floorCpmUsd) * 1_000_000)) : existing.floor_cpm_micros;

    db.prepare(
      'UPDATE ad_placements SET status = ?, name = ?, dimensions = ?, floor_cpm_micros = ? WHERE id = ? AND publisher_id = ?'
    ).run(nextStatus, nextName, nextDimensions, nextFloorMicros, existing.id, publisherId);

    res.json({ updated: true, id: existing.id });
  });

  // DELETE /api/publisher/placements/:id
  router.delete('/placements/:id', (req: AuthenticatedRequest, res: Response) => {
    const publisherId = resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const existing = db
      .prepare('SELECT id FROM ad_placements WHERE id = ? AND publisher_id = ?')
      .get(String(req.params.id), publisherId) as { id: string } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Placement not found' });
      return;
    }

    const historyCount = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM ad_requests WHERE placement_id = ?) +
           (SELECT COUNT(*) FROM impressions WHERE placement_id = ?) +
           (SELECT COUNT(*) FROM clicks WHERE placement_id = ?) +
           (SELECT COUNT(*) FROM video_events WHERE placement_id = ?) AS cnt`
      )
      .get(existing.id, existing.id, existing.id, existing.id) as { cnt: number };

    if (historyCount.cnt > 0) {
      db.prepare("UPDATE ad_placements SET status = 'disabled' WHERE id = ? AND publisher_id = ?").run(existing.id, publisherId);
      res.json({ deleted: false, disabled: true, id: existing.id });
      return;
    }

    db.prepare('DELETE FROM ad_placements WHERE id = ? AND publisher_id = ?').run(existing.id, publisherId);
    res.json({ deleted: true, disabled: false, id: existing.id });
  });

  // GET /api/publisher/earnings
  router.get('/earnings', (req: AuthenticatedRequest, res: Response) => {
    const publisherId = resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const wallet = db.prepare('SELECT * FROM publisher_wallets WHERE publisher_id = ?').get(publisherId) as { id: string } | undefined;
    if (!wallet) {
      res.status(404).json({ error: 'Publisher wallet not found' });
      return;
    }
    const account = db
      .prepare('SELECT payout_method_type, payout_destination, custom_revenue_share_bps, publisher_type FROM publisher_accounts WHERE id = ?')
      .get(publisherId);
    const withdrawals = db.prepare('SELECT * FROM withdrawals WHERE publisher_id = ? ORDER BY created_at DESC').all(publisherId);
    const ledger = db
      .prepare("SELECT * FROM financial_ledger WHERE account_type = 'publisher_wallet' AND account_id = ? ORDER BY created_at DESC LIMIT 50")
      .all(wallet.id);

    const minPayoutRow = db
      .prepare("SELECT value_json FROM platform_settings WHERE key = 'minimum_publisher_payout_micros'")
      .get() as { value_json: string } | undefined;
    const minPayoutMicros = minPayoutRow ? Number(JSON.parse(minPayoutRow.value_json)) : 50_000_000;

    res.json({ wallet, account, withdrawals, ledger, minPayoutMicros, featureFlags: getFeatureFlags(db) });
  });

  // POST /api/publisher/withdraw
  router.post('/withdraw', (req: AuthenticatedRequest, res: Response) => {
    const publisherId = resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }

    const pubTypeRow = db
      .prepare('SELECT publisher_type FROM publisher_accounts WHERE id = ?')
      .get(publisherId) as { publisher_type: string | null } | undefined;
    if (
      pubTypeRow?.publisher_type === 'third_party' &&
      !getFeatureFlags(db).third_party_publisher_payouts_enabled
    ) {
      res.status(403).json({
        error: 'Third-party publisher payouts are disabled until the external publisher expansion phase.',
      });
      return;
    }

    const { amountUsd, payoutMethod, payoutDestination } = req.body ?? {};
    const parsedAmount = Number(amountUsd);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      res.status(400).json({ error: 'Valid withdrawal amount is required' });
      return;
    }

    const amountMicros = Math.round(parsedAmount * 1_000_000);
    const minPayoutRow = db
      .prepare("SELECT value_json FROM platform_settings WHERE key = 'minimum_publisher_payout_micros'")
      .get() as { value_json: string } | undefined;
    const minPayoutMicros = minPayoutRow ? Number(JSON.parse(minPayoutRow.value_json)) : 50_000_000;

    if (amountMicros < minPayoutMicros) {
      res.status(400).json({
        error: `Minimum withdrawal threshold is $${(minPayoutMicros / 1_000_000).toFixed(2)}`,
      });
      return;
    }

    const outcome = withTransaction(db, () => {
      const wallet = db
        .prepare('SELECT id, available_micros, pending_micros FROM publisher_wallets WHERE publisher_id = ?')
        .get(publisherId) as { id: string; available_micros: number; pending_micros: number };
      const pub = db
        .prepare('SELECT payout_method_type, payout_destination FROM publisher_accounts WHERE id = ?')
        .get(publisherId) as { payout_method_type: string; payout_destination: string };

      if (wallet.available_micros < amountMicros) {
        return { error: 'Withdrawal amount exceeds finalized available balance' };
      }

      const method = String(payoutMethod || pub.payout_method_type || 'bank_transfer');
      const destination = String(payoutDestination || pub.payout_destination || '').trim();
      if (!destination) {
        return { error: 'Please configure a payout destination before requesting withdrawal' };
      }

      const newAvailable = wallet.available_micros - amountMicros;
      const newPending = wallet.pending_micros + amountMicros;
      const withdrawalId = `wdr_${crypto.randomUUID().slice(0, 10)}`;

      db.prepare(
        `UPDATE publisher_wallets SET available_micros = ?, pending_micros = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(newAvailable, newPending, wallet.id);

      db.prepare(
        `INSERT INTO withdrawals (id, publisher_id, amount_micros, currency, payout_method, payout_destination, status, notes)
         VALUES (?, ?, ?, 'USD', ?, ?, 'pending', 'Publisher payout request queued for admin reconciliation')`
      ).run(withdrawalId, publisherId, amountMicros, method, destination);

      return { withdrawalId, availableMicros: newAvailable, pendingMicros: newPending };
    });

    if ('error' in outcome) {
      res.status(400).json({ error: outcome.error });
      return;
    }
    res.status(201).json(outcome);
  });

  // PATCH /api/publisher/payout-method
  router.patch('/payout-method', (req: AuthenticatedRequest, res: Response) => {
    const publisherId = resolvePublisherId(req);
    if (!publisherId) {
      res.status(404).json({ error: 'Publisher account not found' });
      return;
    }
    const { payoutMethodType, payoutDestination } = req.body ?? {};
    if (!payoutMethodType || !payoutDestination) {
      res.status(400).json({ error: 'Payout method and destination are required' });
      return;
    }
    db.prepare(
      'UPDATE publisher_accounts SET payout_method_type = ?, payout_destination = ? WHERE id = ?'
    ).run(String(payoutMethodType), String(payoutDestination).trim(), publisherId);
    res.json({ updated: true });
  });

  return router;
}
