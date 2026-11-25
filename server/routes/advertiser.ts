import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { AuthenticatedRequest, createAuthMiddleware, requireRole } from '../auth';
import { withTransaction } from '../db';
import {
  ALLOWED_MEDIA_MIMES,
  initializeProviderDeposit,
  queueTransactionalEmail,
  scanProhibitedContent,
  validateMediaMagicBytes,
} from '../security';
import { releaseReservationInTx } from '../modules/budgetReservations';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export function createAdvertiserRouter(db: DatabaseSync): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(db);
  router.use(requireAuth, requireRole('advertiser', 'admin'));

  function resolveAdvertiserId(req: AuthenticatedRequest): string | null {
    if (req.auth?.role === 'admin' && typeof req.query.advertiserId === 'string') {
      return req.query.advertiserId;
    }
    const row = db
      .prepare('SELECT id FROM advertiser_accounts WHERE user_id = ?')
      .get(req.auth!.userId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  function queryDailyPerformanceSeries(
    advertiserId: string,
    days = 30,
    campaignId?: string
  ): Array<{
    day: string;
    impressions: number;
    clicks: number;
    conversions: number;
    spendMicros: number;
    ctr: number;
    conversionRate: number;
  }> {
    const windowClause = `-${Math.max(1, Math.min(90, days))} days`;
    const cmpFilter = campaignId && campaignId !== 'all' ? ' AND campaign_id = ?' : '';
    const impParams = cmpFilter ? [advertiserId, windowClause, campaignId!] : [advertiserId, windowClause];

    const impSeries = db
      .prepare(
        `SELECT date(created_at) AS day,
                COUNT(*) AS impressions,
                COALESCE(SUM(billed_micros), 0) AS imp_spend_micros
         FROM impressions
         WHERE advertiser_id = ? AND is_valid = 1 AND created_at >= datetime('now', ?)${cmpFilter}
         GROUP BY date(created_at)
         ORDER BY day ASC`
      )
      .all(...impParams) as Array<{ day: string; impressions: number; imp_spend_micros: number }>;

    const clkSeries = db
      .prepare(
        `SELECT date(created_at) AS day,
                COUNT(*) AS clicks,
                COALESCE(SUM(billed_micros), 0) AS clk_spend_micros
         FROM clicks
         WHERE advertiser_id = ? AND is_valid = 1 AND created_at >= datetime('now', ?)${cmpFilter}
         GROUP BY date(created_at)
         ORDER BY day ASC`
      )
      .all(...impParams) as Array<{ day: string; clicks: number; clk_spend_micros: number }>;

    const cnvSeries = db
      .prepare(
        `SELECT date(created_at) AS day,
                COUNT(*) AS conversions,
                COALESCE(SUM(billed_micros), 0) AS cnv_spend_micros
         FROM conversions
         WHERE advertiser_id = ? AND is_valid = 1 AND created_at >= datetime('now', ?)${cmpFilter}
         GROUP BY date(created_at)
         ORDER BY day ASC`
      )
      .all(...impParams) as Array<{ day: string; conversions: number; cnv_spend_micros: number }>;

    const allDays = Array.from(
      new Set([
        ...impSeries.map((r) => r.day),
        ...clkSeries.map((r) => r.day),
        ...cnvSeries.map((r) => r.day),
      ])
    ).sort();

    const impMap = new Map(impSeries.map((r) => [r.day, r]));
    const clkMap = new Map(clkSeries.map((r) => [r.day, r]));
    const cnvMap = new Map(cnvSeries.map((r) => [r.day, r]));

    return allDays.map((day) => {
      const imp = impMap.get(day);
      const clk = clkMap.get(day);
      const cnv = cnvMap.get(day);
      const impressions = imp?.impressions ?? 0;
      const clicks = clk?.clicks ?? 0;
      const conversions = cnv?.conversions ?? 0;
      const spendMicros = (imp?.imp_spend_micros ?? 0) + (clk?.clk_spend_micros ?? 0) + (cnv?.cnv_spend_micros ?? 0);
      const ctr = impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0;
      const conversionRate = clicks > 0 ? Number(((conversions / clicks) * 100).toFixed(2)) : 0;
      return {
        day,
        impressions,
        clicks,
        conversions,
        spendMicros,
        ctr,
        conversionRate,
      };
    });
  }

  // GET /api/advertiser/overview
  router.get('/overview', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const account = db
      .prepare('SELECT * FROM advertiser_accounts WHERE id = ?')
      .get(advertiserId);
    const wallet = db
      .prepare('SELECT * FROM advertiser_wallets WHERE advertiser_id = ?')
      .get(advertiserId);

    const kpis = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM impressions WHERE advertiser_id = ? AND is_valid = 1) AS impressions,
           (SELECT COUNT(*) FROM clicks WHERE advertiser_id = ? AND is_valid = 1) AS clicks,
           (SELECT COALESCE(SUM(billed_micros), 0) FROM clicks WHERE advertiser_id = ? AND is_valid = 1) AS click_spend_micros,
           (SELECT COUNT(*) FROM conversions WHERE advertiser_id = ? AND is_valid = 1) AS conversions,
           (SELECT COALESCE(SUM(spent_total_micros), 0) FROM campaign_budgets b JOIN campaigns c ON c.id = b.campaign_id WHERE c.advertiser_id = ?) AS total_spend_micros`
      )
      .get(advertiserId, advertiserId, advertiserId, advertiserId, advertiserId) as {
      impressions: number;
      clicks: number;
      click_spend_micros: number;
      conversions: number;
      total_spend_micros: number;
    };

    const performanceSeries = queryDailyPerformanceSeries(advertiserId, 30);

    const notifications = db
      .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 6')
      .all(req.auth!.userId);

    res.json({
      account,
      wallet,
      kpis: {
        ...kpis,
        ctr: kpis.impressions > 0 ? kpis.clicks / kpis.impressions : 0,
        conversionRate: kpis.clicks > 0 ? kpis.conversions / kpis.clicks : 0,
        avgCpcMicros: kpis.clicks > 0 ? Math.round((kpis.click_spend_micros || kpis.total_spend_micros) / kpis.clicks) : 0,
      },
      performanceSeries,
      notifications,
    });
  });

  // GET /api/advertiser/campaigns
  router.get('/campaigns', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const campaigns = db
      .prepare(
        `SELECT c.*, b.daily_budget_micros, b.total_budget_micros, b.spent_today_micros, b.spent_total_micros,
                b.max_bid_micros, b.pacing_mode,
                t.countries_json, t.languages_json, t.device_categories_json, t.operating_systems_json,
                t.browsers_json, t.interest_categories_json, t.contextual_categories_json, t.retargeting_enabled, t.consent_required,
                adv.id AS advertisement_id, adv.format AS ad_format,
                crt.id AS creative_id, crt.title AS creative_title, crt.description AS creative_description,
                crt.media_url, crt.destination_url, crt.cta_text, crt.tracking_params, crt.approval_status AS creative_approval_status,
                (SELECT COUNT(*) FROM impressions i WHERE i.campaign_id = c.id AND i.is_valid = 1) AS impressions,
                (SELECT COUNT(*) FROM clicks k WHERE k.campaign_id = c.id AND k.is_valid = 1) AS clicks,
                (SELECT COUNT(*) FROM conversions v WHERE v.campaign_id = c.id AND v.is_valid = 1) AS conversions
         FROM campaigns c
         JOIN campaign_budgets b ON b.campaign_id = c.id
         JOIN campaign_targeting t ON t.campaign_id = c.id
         LEFT JOIN advertisements adv ON adv.campaign_id = c.id
         LEFT JOIN ad_creatives crt ON crt.advertisement_id = adv.id
         WHERE c.advertiser_id = ?
         ORDER BY c.created_at DESC`
      )
      .all(advertiserId);

    res.json({ campaigns });
  });

  // POST /api/advertiser/campaigns
  router.post('/campaigns', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const body = req.body ?? {};
    const {
      name,
      objective = 'website_traffic',
      pricingModel = 'CPC',
      biddingStrategy = 'manual',
      startDate = '2026-01-01',
      endDate = '2027-12-31',
      dailyBudgetUsd = 50,
      totalBudgetUsd = 500,
      maxBidUsd = 1.25,
      pacingMode = 'standard',
      format = 'native',
      title,
      description,
      mediaUrl = '',
      destinationUrl,
      ctaText = 'Learn More',
      trackingParams = '',
      countries = ['ALL'],
      languages = ['en'],
      deviceCategories = ['desktop', 'mobile'],
      operatingSystems = ['ALL'],
      browsers = ['ALL'],
      contextualCategories = ['ALL'],
      interestCategories = [],
      retargetingEnabled = false,
      consentRequired = true,
    } = body;

    if (!name || !title || !description || !destinationUrl) {
      res.status(400).json({ error: 'Campaign name, ad title, description, and destination URL are required' });
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(destinationUrl);
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        throw new Error('Invalid protocol');
      }
    } catch {
      res.status(400).json({ error: 'Destination URL must be a valid http(s) URL' });
      return;
    }

    // Automated prohibited category & policy compliance scan
    const policyRows = db
      .prepare('SELECT id, name, keywords_json, severity, active FROM prohibited_categories WHERE active = 1')
      .all() as Array<{ id: string; name: string; keywords_json: string; severity: 'block' | 'review'; active: number }>;

    const rules = policyRows.map((r) => ({
      id: r.id,
      name: r.name,
      keywords: (() => {
        try {
          return JSON.parse(r.keywords_json) as string[];
        } catch {
          return [];
        }
      })(),
      severity: r.severity,
      active: Boolean(r.active),
    }));

    const violations = scanProhibitedContent(
      `${name} ${title} ${description} ${destinationUrl}`,
      rules
    );
    const blocking = violations.filter((v) => v.severity === 'block');
    if (blocking.length > 0) {
      res.status(422).json({
        error: `Campaign blocked by policy (${blocking[0].categoryName}): prohibited term "${blocking[0].matchedKeyword}" detected.`,
        violations: blocking,
      });
      return;
    }

    if (!['CPM', 'CPC', 'CPA', 'CPI', 'CPV', 'FIXED'].includes(String(pricingModel))) {
      res.status(400).json({ error: 'Invalid pricing model' });
      return;
    }
    if (!['manual', 'auto_cpc', 'target_cpa'].includes(String(biddingStrategy))) {
      res.status(400).json({ error: 'Invalid bidding strategy' });
      return;
    }
    if (!['standard', 'accelerated'].includes(String(pacingMode))) {
      res.status(400).json({ error: 'Invalid pacing mode' });
      return;
    }
    if (!['image', 'banner', 'native', 'text', 'video', 'responsive', 'sponsored'].includes(String(format))) {
      res.status(400).json({ error: 'Invalid ad format' });
      return;
    }
    const parsedDaily = Number(dailyBudgetUsd);
    const parsedTotal = Number(totalBudgetUsd);
    const parsedBid = Number(maxBidUsd);
    if (!Number.isFinite(parsedDaily) || !Number.isFinite(parsedTotal) || !Number.isFinite(parsedBid) || parsedDaily <= 0 || parsedTotal <= 0 || parsedBid <= 0) {
      res.status(400).json({ error: 'Daily budget, total budget, and max bid must be positive numbers' });
      return;
    }

    const dailyMicros = Math.max(5_000_000, Math.round(parsedDaily * 1_000_000));
    const totalMicros = Math.max(dailyMicros, Math.round(parsedTotal * 1_000_000));
    const bidMicros = Math.max(100_000, Math.round(parsedBid * 1_000_000));

    const campaignId = `cmp_${crypto.randomUUID().slice(0, 10)}`;

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO campaigns (id, advertiser_id, name, objective, pricing_model, bidding_strategy, status, moderation_status, start_date, end_date)
         VALUES (?, ?, ?, ?, ?, ?, 'pending_review', 'pending', ?, ?)`
      ).run(campaignId, advertiserId, String(name).trim(), String(objective), String(pricingModel), String(biddingStrategy), String(startDate), String(endDate));

      db.prepare(
        `INSERT INTO campaign_budgets (id, campaign_id, daily_budget_micros, total_budget_micros, max_bid_micros, pacing_mode, currency)
         VALUES (?, ?, ?, ?, ?, ?, 'USD')`
      ).run(`bdg_${crypto.randomUUID().slice(0, 10)}`, campaignId, dailyMicros, totalMicros, bidMicros, String(pacingMode));

      db.prepare(
        `INSERT INTO campaign_targeting (id, campaign_id, countries_json, languages_json, device_categories_json, operating_systems_json, browsers_json, interest_categories_json, contextual_categories_json, retargeting_enabled, consent_required)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `tgt_${crypto.randomUUID().slice(0, 10)}`,
        campaignId,
        JSON.stringify(countries),
        JSON.stringify(languages),
        JSON.stringify(deviceCategories),
        JSON.stringify(operatingSystems),
        JSON.stringify(browsers),
        JSON.stringify(interestCategories),
        JSON.stringify(contextualCategories),
        retargetingEnabled ? 1 : 0,
        consentRequired ? 1 : 0
      );

      const adId = `ad_${crypto.randomUUID().slice(0, 10)}`;
      db.prepare(
        `INSERT INTO advertisements (id, campaign_id, advertiser_id, name, format, status)
         VALUES (?, ?, ?, ?, ?, 'active')`
      ).run(adId, campaignId, advertiserId, String(title).trim(), String(format));

      db.prepare(
        `INSERT INTO ad_creatives (id, advertisement_id, title, description, media_url, destination_url, cta_text, tracking_params, dimensions, approval_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'responsive', 'pending')`
      ).run(
        `crt_${crypto.randomUUID().slice(0, 10)}`,
        adId,
        String(title).trim(),
        String(description).trim(),
        String(mediaUrl),
        parsedUrl.toString(),
        String(ctaText).trim() || 'Learn More',
        String(trackingParams).trim()
      );

      if (violations.length > 0) {
        db.prepare(
          `INSERT INTO moderation_reviews (id, target_type, target_id, reviewer_id, decision, reason)
           VALUES (?, 'campaign', ?, ?, 'policy_flagged', ?)`
        ).run(
          `mod_${crypto.randomUUID().slice(0, 10)}`,
          campaignId,
          req.auth!.userId,
          `Automated review flag: ${violations.map((v) => `${v.categoryName} ("${v.matchedKeyword}")`).join('; ')}`
        );
      }
    });

    res.status(201).json({ campaignId, status: 'pending_review', reviewFlags: violations });
  });

  // GET /api/advertiser/media
  router.get('/media', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }
    const rows = db
      .prepare('SELECT id, original_name, stored_name, mime_type, size_bytes, sha256, created_at FROM media_assets WHERE advertiser_id = ? ORDER BY created_at DESC LIMIT 30')
      .all(advertiserId) as Array<Record<string, any>>;
    const assets = rows.map((row) => ({
      ...row,
      url: `/api/media/${row.stored_name}`,
    }));
    res.json({ assets });
  });

  // POST /api/advertiser/media (Direct validated image/video upload)
  router.post('/media', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const { filename = 'creative', mimeType, dataBase64 } = req.body ?? {};
    const cleanMime = String(mimeType || '').trim().toLowerCase();
    const ext = ALLOWED_MEDIA_MIMES[cleanMime];
    if (!ext) {
      res.status(400).json({ error: 'Unsupported media format. Allowed: JPEG, PNG, WEBP, MP4, WEBM.' });
      return;
    }
    if (!dataBase64 || typeof dataBase64 !== 'string') {
      res.status(400).json({ error: 'Media payload (dataBase64) is required' });
      return;
    }

    const stripped = dataBase64.includes(',') ? dataBase64.slice(dataBase64.indexOf(',') + 1) : dataBase64;
    const buffer = Buffer.from(stripped, 'base64');
    if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: 'Media asset must be non-empty and under 10 MB' });
      return;
    }
    if (!validateMediaMagicBytes(buffer, cleanMime)) {
      res.status(400).json({ error: 'File contents do not match the declared image or video format' });
      return;
    }

    const uploadDir = path.resolve(process.cwd(), process.env.LOOMA_STORAGE_DIR || 'data/uploads');
    fs.mkdirSync(uploadDir, { recursive: true });

    const assetId = `med_${crypto.randomUUID().slice(0, 10)}`;
    const storedName = `${assetId}_${crypto.randomUUID().slice(0, 8)}${ext}`;
    const targetPath = path.resolve(uploadDir, storedName);
    if (!targetPath.startsWith(uploadDir + path.sep)) {
      res.status(400).json({ error: 'Invalid upload destination path' });
      return;
    }

    fs.writeFileSync(targetPath, buffer);
    const url = `/api/media/${storedName}`;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const safeOriginal = path.basename(String(filename)).slice(0, 120) || storedName;

    db.prepare(
      `INSERT INTO media_assets (id, advertiser_id, original_name, stored_name, mime_type, size_bytes, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(assetId, advertiserId, safeOriginal, storedName, cleanMime, buffer.length, sha256);

    res.status(201).json({
      assetId,
      originalName: safeOriginal,
      mimeType: cleanMime,
      sizeBytes: buffer.length,
      sha256,
      url,
    });
  });

  // DELETE /api/advertiser/media/:id
  router.delete('/media/:id', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }
    const row = db
      .prepare('SELECT id, stored_name FROM media_assets WHERE id = ? AND advertiser_id = ?')
      .get(String(req.params.id), advertiserId) as { id: string; stored_name: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Media asset not found' });
      return;
    }

    db.prepare('DELETE FROM media_assets WHERE id = ? AND advertiser_id = ?').run(row.id, advertiserId);

    const uploadDir = path.resolve(process.cwd(), process.env.LOOMA_STORAGE_DIR || 'data/uploads');
    const filePath = path.resolve(uploadDir, row.stored_name);
    if (filePath.startsWith(uploadDir + path.sep) && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore filesystem unlink errors after DB deletion
      }
    }

    res.json({ deleted: true, id: row.id });
  });

  // GET /api/advertiser/appeals
  router.get('/appeals', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }
    const appeals = db
      .prepare(
        `SELECT ap.*, ap.resolution_notes AS admin_response, c.name AS campaign_name, c.status AS campaign_status
         FROM campaign_appeals ap
         JOIN campaigns c ON c.id = ap.campaign_id
         WHERE ap.advertiser_id = ?
         ORDER BY ap.created_at DESC`
      )
      .all(advertiserId);
    res.json({ appeals });
  });

  // POST /api/advertiser/campaigns/:id/appeal
  router.post('/campaigns/:id/appeal', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 10) {
      res.status(400).json({ error: 'Please explain why this campaign complies with policy (at least 10 characters)' });
      return;
    }

    const camp = db
      .prepare('SELECT id, name, status, moderation_status FROM campaigns WHERE id = ? AND advertiser_id = ?')
      .get(String(req.params.id), advertiserId) as
      | { id: string; name: string; status: string; moderation_status: string }
      | undefined;

    if (!camp) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    if (!['rejected', 'suspended'].includes(camp.status) && !['rejected', 'suspended'].includes(camp.moderation_status)) {
      res.status(400).json({ error: 'Only rejected or suspended campaigns can be appealed' });
      return;
    }

    const appealId = `apl_${crypto.randomUUID().slice(0, 10)}`;
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO campaign_appeals (id, campaign_id, advertiser_id, reason, status)
         VALUES (?, ?, ?, ?, 'open')`
      ).run(appealId, camp.id, advertiserId, reason);

      db.prepare(
        `INSERT INTO moderation_reviews (id, target_type, target_id, reviewer_id, decision, reason)
         VALUES (?, 'campaign', ?, ?, 'appeal_submitted', ?)`
      ).run(`mod_${crypto.randomUUID().slice(0, 10)}`, camp.id, req.auth!.userId, reason);
    });

    res.status(201).json({ appealId, campaignId: camp.id, status: 'open' });
  });

  // GET /api/advertiser/campaigns/:id
  router.get('/campaigns/:id', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const campaign = db
      .prepare(
        `SELECT c.*, b.daily_budget_micros, b.total_budget_micros, b.spent_today_micros, b.spent_total_micros,
                b.max_bid_micros, b.pacing_mode,
                t.countries_json, t.languages_json, t.device_categories_json, t.operating_systems_json,
                t.browsers_json, t.interest_categories_json, t.contextual_categories_json, t.retargeting_enabled, t.consent_required,
                adv.id AS advertisement_id, adv.format AS ad_format,
                crt.id AS creative_id, crt.title AS creative_title, crt.description AS creative_description,
                crt.media_url, crt.destination_url, crt.cta_text, crt.tracking_params, crt.approval_status AS creative_approval_status,
                (SELECT COUNT(*) FROM impressions i WHERE i.campaign_id = c.id AND i.is_valid = 1) AS impressions,
                (SELECT COUNT(*) FROM clicks k WHERE k.campaign_id = c.id AND k.is_valid = 1) AS clicks,
                (SELECT COUNT(*) FROM conversions v WHERE v.campaign_id = c.id AND v.is_valid = 1) AS conversions
         FROM campaigns c
         JOIN campaign_budgets b ON b.campaign_id = c.id
         JOIN campaign_targeting t ON t.campaign_id = c.id
         LEFT JOIN advertisements adv ON adv.campaign_id = c.id
         LEFT JOIN ad_creatives crt ON crt.advertisement_id = adv.id
         WHERE c.id = ? AND c.advertiser_id = ?`
      )
      .get(String(req.params.id), advertiserId);

    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    res.json({ campaign });
  });

  // PATCH & PUT /api/advertiser/campaigns/:id
  const handleUpdateCampaign = (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const existing = db
      .prepare('SELECT id, moderation_status, status FROM campaigns WHERE id = ? AND advertiser_id = ?')
      .get(String(req.params.id), advertiserId) as { id: string; moderation_status: string; status: string } | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const {
      status,
      name,
      biddingStrategy,
      startDate,
      endDate,
      dailyBudgetUsd,
      totalBudgetUsd,
      maxBidUsd,
      pacingMode,
      targeting,
      title,
      description,
      destinationUrl,
      ctaText,
      mediaUrl,
      trackingParams,
    } = req.body ?? {};

    if (status) {
      if (status === 'active' && existing.moderation_status !== 'approved') {
        res.status(400).json({ error: 'Campaign must pass moderation approval before activation' });
        return;
      }
      if (!['active', 'paused', 'archived'].includes(status)) {
        res.status(400).json({ error: 'Invalid campaign status transition' });
        return;
      }
    }

    if (biddingStrategy && !['manual', 'auto_cpc', 'target_cpa'].includes(biddingStrategy)) {
      res.status(400).json({ error: 'Invalid bidding strategy' });
      return;
    }

    if (pacingMode && !['standard', 'accelerated'].includes(pacingMode)) {
      res.status(400).json({ error: 'Invalid pacing mode' });
      return;
    }

    if (dailyBudgetUsd !== undefined && (!Number.isFinite(Number(dailyBudgetUsd)) || Number(dailyBudgetUsd) <= 0)) {
      res.status(400).json({ error: 'dailyBudgetUsd must be a positive number' });
      return;
    }
    if (totalBudgetUsd !== undefined && (!Number.isFinite(Number(totalBudgetUsd)) || Number(totalBudgetUsd) <= 0)) {
      res.status(400).json({ error: 'totalBudgetUsd must be a positive number' });
      return;
    }
    if (maxBidUsd !== undefined && (!Number.isFinite(Number(maxBidUsd)) || Number(maxBidUsd) <= 0)) {
      res.status(400).json({ error: 'maxBidUsd must be a positive number' });
      return;
    }

    let validatedDestUrl: string | undefined;
    if (destinationUrl !== undefined) {
      try {
        const parsed = new URL(String(destinationUrl));
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('Invalid protocol');
        }
        validatedDestUrl = parsed.toString();
      } catch {
        res.status(400).json({ error: 'Destination URL must be a valid http(s) URL' });
        return;
      }
    }

    withTransaction(db, () => {
      if (status) {
        db.prepare("UPDATE campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, existing.id);
      }
      if (name) {
        db.prepare("UPDATE campaigns SET name = ?, updated_at = datetime('now') WHERE id = ?").run(String(name).trim(), existing.id);
      }
      if (biddingStrategy) {
        db.prepare("UPDATE campaigns SET bidding_strategy = ?, updated_at = datetime('now') WHERE id = ?").run(biddingStrategy, existing.id);
      }
      if (startDate && endDate) {
        db.prepare("UPDATE campaigns SET start_date = ?, end_date = ?, updated_at = datetime('now') WHERE id = ?").run(
          String(startDate),
          String(endDate),
          existing.id
        );
      }

      if (dailyBudgetUsd !== undefined) {
        const dailyMicros = Math.max(5_000_000, Math.round(Number(dailyBudgetUsd) * 1_000_000));
        db.prepare(
          "UPDATE campaign_budgets SET daily_budget_micros = ?, total_budget_micros = MAX(total_budget_micros, ?), updated_at = datetime('now') WHERE campaign_id = ?"
        ).run(dailyMicros, dailyMicros, existing.id);
      }
      if (totalBudgetUsd !== undefined) {
        const currentBudget = db
          .prepare('SELECT daily_budget_micros FROM campaign_budgets WHERE campaign_id = ?')
          .get(existing.id) as { daily_budget_micros: number };
        const totalMicros = Math.max(currentBudget.daily_budget_micros, Math.round(Number(totalBudgetUsd) * 1_000_000));
        db.prepare("UPDATE campaign_budgets SET total_budget_micros = ?, updated_at = datetime('now') WHERE campaign_id = ?").run(totalMicros, existing.id);
      }
      if (maxBidUsd !== undefined) {
        const bidMicros = Math.max(100_000, Math.round(Number(maxBidUsd) * 1_000_000));
        db.prepare("UPDATE campaign_budgets SET max_bid_micros = ?, updated_at = datetime('now') WHERE campaign_id = ?").run(bidMicros, existing.id);
      }
      if (pacingMode) {
        db.prepare("UPDATE campaign_budgets SET pacing_mode = ?, updated_at = datetime('now') WHERE campaign_id = ?").run(pacingMode, existing.id);
      }

      if (title !== undefined || description !== undefined || validatedDestUrl !== undefined || ctaText !== undefined || mediaUrl !== undefined || trackingParams !== undefined) {
        const adRow = db.prepare('SELECT id FROM advertisements WHERE campaign_id = ? LIMIT 1').get(existing.id) as { id: string } | undefined;
        if (adRow) {
          if (title !== undefined) {
            db.prepare('UPDATE advertisements SET name = ? WHERE id = ?').run(String(title).trim(), adRow.id);
            db.prepare('UPDATE ad_creatives SET title = ? WHERE advertisement_id = ?').run(String(title).trim(), adRow.id);
          }
          if (description !== undefined) {
            db.prepare('UPDATE ad_creatives SET description = ? WHERE advertisement_id = ?').run(String(description).trim(), adRow.id);
          }
          if (validatedDestUrl !== undefined) {
            db.prepare('UPDATE ad_creatives SET destination_url = ? WHERE advertisement_id = ?').run(validatedDestUrl, adRow.id);
          }
          if (ctaText !== undefined) {
            db.prepare('UPDATE ad_creatives SET cta_text = ? WHERE advertisement_id = ?').run(String(ctaText).trim() || 'Learn More', adRow.id);
          }
          if (mediaUrl !== undefined) {
            db.prepare('UPDATE ad_creatives SET media_url = ? WHERE advertisement_id = ?').run(String(mediaUrl).trim(), adRow.id);
          }
          if (trackingParams !== undefined) {
            db.prepare('UPDATE ad_creatives SET tracking_params = ? WHERE advertisement_id = ?').run(String(trackingParams).trim(), adRow.id);
          }
        }
      }

      if (targeting && typeof targeting === 'object') {
        const sanitizeList = (arr: unknown, fallback: string[]) =>
          Array.isArray(arr) && arr.length > 0 ? arr.map((v) => String(v).trim()).filter(Boolean) : fallback;

        db.prepare(
          `UPDATE campaign_targeting
           SET countries_json = ?,
               languages_json = ?,
               device_categories_json = ?,
               operating_systems_json = ?,
               browsers_json = ?,
               interest_categories_json = ?,
               contextual_categories_json = ?,
               retargeting_enabled = ?,
               consent_required = ?
           WHERE campaign_id = ?`
        ).run(
          JSON.stringify(sanitizeList(targeting.countries, ['ALL'])),
          JSON.stringify(sanitizeList(targeting.languages, ['en'])),
          JSON.stringify(sanitizeList(targeting.deviceCategories, ['desktop', 'mobile'])),
          JSON.stringify(sanitizeList(targeting.operatingSystems, ['ALL'])),
          JSON.stringify(sanitizeList(targeting.browsers, ['ALL'])),
          JSON.stringify(sanitizeList(targeting.interestCategories, [])),
          JSON.stringify(sanitizeList(targeting.contextualCategories, ['ALL'])),
          targeting.retargetingEnabled ? 1 : 0,
          targeting.consentRequired === false ? 0 : 1,
          existing.id
        );
      }
    });

    res.json({ updated: true, id: existing.id });
  };

  router.patch('/campaigns/:id', handleUpdateCampaign);
  router.put('/campaigns/:id', handleUpdateCampaign);

  // DELETE /api/advertiser/campaigns/:id
  router.delete('/campaigns/:id', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const existing = db
      .prepare('SELECT id FROM campaigns WHERE id = ? AND advertiser_id = ?')
      .get(String(req.params.id), advertiserId) as { id: string } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const hasHistory = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM ad_requests WHERE winning_campaign_id = ?) +
           (SELECT COUNT(*) FROM impressions WHERE campaign_id = ?) +
           (SELECT COUNT(*) FROM clicks WHERE campaign_id = ?) +
           (SELECT COUNT(*) FROM conversions WHERE campaign_id = ?) +
           (SELECT COUNT(*) FROM budget_reservations WHERE campaign_id = ?) +
           (SELECT COUNT(*) FROM video_events WHERE campaign_id = ?) +
           (SELECT COUNT(*) FROM app_installs WHERE campaign_id = ?) +
           (SELECT COUNT(*) FROM fraud_alerts WHERE campaign_id = ?) AS cnt`
      )
      .get(existing.id, existing.id, existing.id, existing.id, existing.id, existing.id, existing.id, existing.id) as {
      cnt: number;
    };

    if (hasHistory.cnt > 0) {
      db.prepare("UPDATE campaigns SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(existing.id);
      res.json({ deleted: false, archived: true, id: existing.id });
      return;
    }

    withTransaction(db, () => {
      db.prepare('DELETE FROM campaign_appeals WHERE campaign_id = ?').run(existing.id);
      db.prepare('DELETE FROM ad_creatives WHERE advertisement_id IN (SELECT id FROM advertisements WHERE campaign_id = ?)').run(existing.id);
      db.prepare('DELETE FROM advertisements WHERE campaign_id = ?').run(existing.id);
      db.prepare('DELETE FROM campaign_targeting WHERE campaign_id = ?').run(existing.id);
      db.prepare('DELETE FROM campaign_budgets WHERE campaign_id = ?').run(existing.id);
      db.prepare('DELETE FROM campaigns WHERE id = ?').run(existing.id);
    });

    res.json({ deleted: true, archived: false, id: existing.id });
  });

  // POST /api/advertiser/campaigns/:id/duplicate
  router.post('/campaigns/:id/duplicate', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const src = db
      .prepare('SELECT * FROM campaigns WHERE id = ? AND advertiser_id = ?')
      .get(String(req.params.id), advertiserId) as Record<string, any> | undefined;
    if (!src) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const srcBudget = db.prepare('SELECT * FROM campaign_budgets WHERE campaign_id = ?').get(src.id) as Record<string, any>;
    const srcTarget = db.prepare('SELECT * FROM campaign_targeting WHERE campaign_id = ?').get(src.id) as Record<string, any>;
    const srcAd = db.prepare('SELECT * FROM advertisements WHERE campaign_id = ?').get(src.id) as Record<string, any>;
    const srcCrt = srcAd ? (db.prepare('SELECT * FROM ad_creatives WHERE advertisement_id = ?').get(srcAd.id) as Record<string, any>) : null;

    const newCampId = `cmp_${crypto.randomUUID().slice(0, 10)}`;

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO campaigns (id, advertiser_id, name, objective, pricing_model, bidding_strategy, status, moderation_status, start_date, end_date, frequency_cap_per_session)
         VALUES (?, ?, ?, ?, ?, ?, 'pending_review', 'pending', ?, ?, ?)`
      ).run(newCampId, advertiserId, `${src.name} (Copy)`, src.objective, src.pricing_model, src.bidding_strategy, src.start_date, src.end_date, src.frequency_cap_per_session);

      db.prepare(
        `INSERT INTO campaign_budgets (id, campaign_id, daily_budget_micros, total_budget_micros, max_bid_micros, pacing_mode, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(`bdg_${crypto.randomUUID().slice(0, 10)}`, newCampId, srcBudget.daily_budget_micros, srcBudget.total_budget_micros, srcBudget.max_bid_micros, srcBudget.pacing_mode, srcBudget.currency);

      db.prepare(
        `INSERT INTO campaign_targeting (id, campaign_id, countries_json, regions_json, cities_json, languages_json, device_categories_json, operating_systems_json, browsers_json, interest_categories_json, contextual_categories_json, custom_segments_json, retargeting_enabled, consent_required)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`tgt_${crypto.randomUUID().slice(0, 10)}`, newCampId, srcTarget.countries_json, srcTarget.regions_json, srcTarget.cities_json, srcTarget.languages_json, srcTarget.device_categories_json, srcTarget.operating_systems_json, srcTarget.browsers_json, srcTarget.interest_categories_json, srcTarget.contextual_categories_json, srcTarget.custom_segments_json, srcTarget.retargeting_enabled, srcTarget.consent_required);

      if (srcAd && srcCrt) {
        const newAdId = `ad_${crypto.randomUUID().slice(0, 10)}`;
        db.prepare(
          `INSERT INTO advertisements (id, campaign_id, advertiser_id, name, format, status) VALUES (?, ?, ?, ?, ?, 'active')`
        ).run(newAdId, newCampId, advertiserId, srcAd.name, srcAd.format);
        db.prepare(
          `INSERT INTO ad_creatives (id, advertisement_id, title, description, media_url, destination_url, cta_text, tracking_params, dimensions, approval_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
        ).run(`crt_${crypto.randomUUID().slice(0, 10)}`, newAdId, srcCrt.title, srcCrt.description, srcCrt.media_url, srcCrt.destination_url, srcCrt.cta_text, srcCrt.tracking_params, srcCrt.dimensions);
      }
    });

    res.status(201).json({ campaignId: newCampId });
  });

  // GET /api/advertiser/reporting
  router.get('/reporting', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const days = Math.max(1, Math.min(90, Number(req.query.days) || 30));
    const campaignId = typeof req.query.campaignId === 'string' && req.query.campaignId !== 'all'
      ? req.query.campaignId
      : undefined;
    const cmpClause = campaignId ? ' AND i.campaign_id = ?' : '';
    const geoParams = campaignId ? [advertiserId, `-${days} days`, campaignId] : [advertiserId, `-${days} days`];

    const byGeo = db
      .prepare(
        `SELECT i.country,
                COUNT(DISTINCT i.id) AS impressions,
                COUNT(DISTINCT k.id) AS clicks,
                COALESCE(SUM(i.billed_micros), 0) + COALESCE(SUM(k.billed_micros), 0) AS spend_micros
         FROM impressions i
         LEFT JOIN clicks k ON k.impression_id = i.id AND k.is_valid = 1
         WHERE i.advertiser_id = ? AND i.is_valid = 1 AND i.created_at >= datetime('now', ?)${cmpClause}
         GROUP BY i.country
         ORDER BY impressions DESC`
      )
      .all(...geoParams);

    const byDevice = db
      .prepare(
        `SELECT i.device_category,
                COUNT(DISTINCT i.id) AS impressions,
                COUNT(DISTINCT k.id) AS clicks,
                COALESCE(SUM(i.billed_micros), 0) + COALESCE(SUM(k.billed_micros), 0) AS spend_micros
         FROM impressions i
         LEFT JOIN clicks k ON k.impression_id = i.id AND k.is_valid = 1
         WHERE i.advertiser_id = ? AND i.is_valid = 1 AND i.created_at >= datetime('now', ?)${cmpClause}
         GROUP BY i.device_category
         ORDER BY impressions DESC`
      )
      .all(...geoParams);

    const byCampaign = db
      .prepare(
        `SELECT c.id, c.name, c.pricing_model, c.status,
                (SELECT COUNT(*) FROM impressions i WHERE i.campaign_id = c.id AND i.is_valid = 1 AND i.created_at >= datetime('now', ?)) AS impressions,
                (SELECT COUNT(*) FROM clicks k WHERE k.campaign_id = c.id AND k.is_valid = 1 AND k.created_at >= datetime('now', ?)) AS clicks,
                (SELECT COUNT(*) FROM conversions v WHERE v.campaign_id = c.id AND v.is_valid = 1 AND v.created_at >= datetime('now', ?)) AS conversions,
                b.spent_total_micros AS spend_micros
         FROM campaigns c
         JOIN campaign_budgets b ON b.campaign_id = c.id
         WHERE c.advertiser_id = ?`
      )
      .all(`-${days} days`, `-${days} days`, `-${days} days`, advertiserId);

    const dailySeries = queryDailyPerformanceSeries(advertiserId, days, campaignId);

    res.json({ byGeo, byDevice, byCampaign, dailySeries });
  });

  // GET /api/advertiser/reporting/csv
  router.get('/reporting/csv', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.pricing_model, c.status,
                (SELECT COUNT(*) FROM impressions i WHERE i.campaign_id = c.id AND i.is_valid = 1) AS impressions,
                (SELECT COUNT(*) FROM clicks k WHERE k.campaign_id = c.id AND k.is_valid = 1) AS clicks,
                (SELECT COUNT(*) FROM conversions v WHERE v.campaign_id = c.id AND v.is_valid = 1) AS conversions,
                b.spent_total_micros
         FROM campaigns c
         JOIN campaign_budgets b ON b.campaign_id = c.id
         WHERE c.advertiser_id = ?`
      )
      .all(advertiserId) as Array<{
      id: string;
      name: string;
      pricing_model: string;
      status: string;
      impressions: number;
      clicks: number;
      conversions: number;
      spent_total_micros: number;
    }>;

    const lines = ['Campaign ID,Campaign Name,Pricing Model,Status,Impressions,Clicks,CTR,Conversions,Spend (USD)'];
    for (const r of rows) {
      const ctr = r.impressions > 0 ? ((r.clicks / r.impressions) * 100).toFixed(2) : '0.00';
      const spendUsd = (r.spent_total_micros / 1_000_000).toFixed(2);
      const safeName = `"${r.name.replace(/"/g, '""')}"`;
      lines.push(`${r.id},${safeName},${r.pricing_model},${r.status},${r.impressions},${r.clicks},${ctr}%,${r.conversions},${spendUsd}`);
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="looma-campaign-report.csv"');
    res.send(lines.join('\n'));
  });

  // GET /api/advertiser/billing
  router.get('/billing', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const wallet = db
      .prepare('SELECT * FROM advertiser_wallets WHERE advertiser_id = ?')
      .get(advertiserId) as { id: string } | undefined;
    if (!wallet) {
      res.status(404).json({ error: 'Advertiser wallet not found' });
      return;
    }
    const deposits = db
      .prepare('SELECT * FROM deposits WHERE advertiser_id = ? ORDER BY created_at DESC')
      .all(advertiserId);
    const invoices = db
      .prepare('SELECT * FROM invoices WHERE advertiser_id = ? ORDER BY issued_at DESC')
      .all(advertiserId);
    const ledger = db
      .prepare("SELECT * FROM financial_ledger WHERE account_type = 'advertiser_wallet' AND account_id = ? ORDER BY created_at DESC LIMIT 50")
      .all(wallet.id);
    const reservations = db
      .prepare(
        `SELECT r.*, c.name AS campaign_name
         FROM budget_reservations r
         JOIN campaigns c ON c.id = r.campaign_id
         WHERE r.advertiser_id = ?
         ORDER BY r.created_at DESC
         LIMIT 30`
      )
      .all(advertiserId);

    res.json({ wallet, deposits, invoices, ledger, reservations });
  });

  // POST /api/advertiser/reservations/:id/release
  router.post('/reservations/:id/release', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const row = db
      .prepare("SELECT id, request_id, status FROM budget_reservations WHERE id = ? AND advertiser_id = ?")
      .get(String(req.params.id), advertiserId) as { id: string; request_id: string; status: string } | undefined;

    if (!row) {
      res.status(404).json({ error: 'Budget reservation not found' });
      return;
    }
    if (row.status !== 'active') {
      res.status(400).json({ error: `Reservation is already ${row.status}` });
      return;
    }

    const outcome = withTransaction(db, () =>
      releaseReservationInTx(db, row.request_id, 'Released by advertiser wallet control')
    );
    res.json(outcome);
  });

  // POST /api/advertiser/deposit (Live Paystack/Flutterwave/Stripe checkout when secrets exist, verified sandbox fallback)
  router.post('/deposit', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const { amountUsd, provider = 'paystack', idempotencyKey } = req.body ?? {};
    const parsedAmount = Number(amountUsd);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 10 || parsedAmount > 500000) {
      res.status(400).json({ error: 'Deposit amount must be between $10 and $500,000' });
      return;
    }
    if (!['paystack', 'flutterwave', 'stripe', 'bank_transfer'].includes(provider)) {
      res.status(400).json({ error: 'Unsupported payment provider' });
      return;
    }

    const amountMicros = Math.round(parsedAmount * 1_000_000);
    const idem = typeof idempotencyKey === 'string' && idempotencyKey.length > 0 ? idempotencyKey : `dep_${crypto.randomUUID()}`;

    const existing = db
      .prepare('SELECT id, advertiser_id, amount_micros, provider_ref, status FROM deposits WHERE idempotency_key = ?')
      .get(idem) as { id: string; advertiser_id: string; amount_micros: number; provider_ref: string; status: string } | undefined;
    if (existing) {
      if (existing.advertiser_id !== advertiserId) {
        res.status(409).json({ error: 'Idempotency key is already in use by another account' });
        return;
      }
      res.status(200).json({
        duplicate: true,
        depositId: existing.id,
        providerRef: existing.provider_ref,
        amountMicros: existing.amount_micros,
        status: existing.status,
      });
      return;
    }

    const advAccount = db
      .prepare('SELECT billing_email FROM advertiser_accounts WHERE id = ?')
      .get(advertiserId) as { billing_email: string } | undefined;
    const depositId = `dep_${crypto.randomUUID().slice(0, 10)}`;

    let checkout;
    try {
      checkout = await initializeProviderDeposit({
        provider: provider as 'paystack' | 'flutterwave' | 'stripe' | 'bank_transfer',
        amountUsd: parsedAmount,
        email: advAccount?.billing_email || req.auth!.email,
        reference: depositId,
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Payment gateway initialization failed',
      });
      return;
    }

    if (checkout.mode === 'live') {
      db.prepare(
        `INSERT INTO deposits (id, advertiser_id, provider, provider_ref, idempotency_key, amount_micros, currency, status)
         VALUES (?, ?, ?, ?, ?, ?, 'USD', 'pending')`
      ).run(depositId, advertiserId, provider, checkout.providerRef, idem, amountMicros);

      res.status(201).json({
        duplicate: false,
        mode: 'live',
        status: 'pending',
        depositId,
        providerRef: checkout.providerRef,
        checkoutUrl: checkout.checkoutUrl,
      });
      return;
    }

    const result = withTransaction(db, () => {
      const wallet = db
        .prepare('SELECT id, available_micros FROM advertiser_wallets WHERE advertiser_id = ?')
        .get(advertiserId) as { id: string; available_micros: number };

      const newBalance = wallet.available_micros + amountMicros;

      db.prepare(
        `INSERT INTO deposits (id, advertiser_id, provider, provider_ref, idempotency_key, amount_micros, currency, status)
         VALUES (?, ?, ?, ?, ?, ?, 'USD', 'completed')`
      ).run(depositId, advertiserId, provider, checkout.providerRef, idem, amountMicros);

      db.prepare(
        `UPDATE advertiser_wallets
         SET available_micros = ?, lifetime_deposited_micros = lifetime_deposited_micros + ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(newBalance, amountMicros, wallet.id);

      const invNumber = `LOOMA-INV-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      db.prepare(
        `INSERT INTO invoices (id, advertiser_id, invoice_number, deposit_id, amount_micros, currency, status)
         VALUES (?, ?, ?, ?, ?, 'USD', 'paid')`
      ).run(`inv_${crypto.randomUUID().slice(0, 10)}`, advertiserId, invNumber, depositId, amountMicros);

      db.prepare(
        `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
         VALUES (?, ?, 'advertiser_wallet', ?, 'deposit', 'credit', ?, ?, 'USD', 'deposit', ?, ?)`
      ).run(
        `led_${crypto.randomUUID().slice(0, 12)}`,
        `led_${idem}`,
        wallet.id,
        amountMicros,
        newBalance,
        depositId,
        `Prepaid wallet credit via ${provider} (${checkout.providerRef})`
      );

      return {
        duplicate: false,
        mode: 'sandbox',
        status: 'completed',
        depositId,
        providerRef: checkout.providerRef,
        invoiceNumber: invNumber,
        balanceAfterMicros: newBalance,
      };
    });

    if (advAccount?.billing_email) {
      queueTransactionalEmail(db, {
        to: advAccount.billing_email,
        subject: `Looma Advertising — Deposit Receipt (${result.invoiceNumber})`,
        bodyText: `We credited $${parsedAmount.toFixed(2)} to your prepaid advertising wallet via ${provider} (${result.providerRef}).`,
        category: 'billing',
      });
    }

    res.status(201).json(result);
  });

  // POST /api/advertiser/refund
  router.post('/refund', (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const { amountUsd, reason = 'Unused prepaid wallet balance withdrawal' } = req.body ?? {};
    const parsedAmount = Number(amountUsd);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 5) {
      res.status(400).json({ error: 'Refund amount must be at least $5.00' });
      return;
    }

    const amountMicros = Math.round(parsedAmount * 1_000_000);
    const outcome = withTransaction(db, () => {
      const wallet = db
        .prepare('SELECT id, available_micros FROM advertiser_wallets WHERE advertiser_id = ?')
        .get(advertiserId) as { id: string; available_micros: number };

      if (wallet.available_micros < amountMicros) {
        return { error: 'Requested refund exceeds available wallet balance' };
      }

      const newBalance = wallet.available_micros - amountMicros;
      const refId = `rfd_${crypto.randomUUID().slice(0, 10)}`;

      db.prepare(
        `UPDATE advertiser_wallets SET available_micros = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(newBalance, wallet.id);

      db.prepare(
        `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
         VALUES (?, ?, 'advertiser_wallet', ?, 'refund', 'debit', ?, ?, 'USD', 'refund', ?, ?)`
      ).run(`led_${crypto.randomUUID().slice(0, 12)}`, `led_${refId}`, wallet.id, amountMicros, newBalance, refId, String(reason));

      return { refundId: refId, balanceAfterMicros: newBalance };
    });

    if ('error' in outcome) {
      res.status(400).json({ error: outcome.error });
      return;
    }
    res.status(201).json(outcome);
  });

  return router;
}
