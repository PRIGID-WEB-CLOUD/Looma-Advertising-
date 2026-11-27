import crypto from 'node:crypto';
import { createAppRouter, type AppRouter, type Response } from '../http/router';
import { AuthenticatedRequest, createAuthMiddleware, requireRole } from '../auth';
import { withTransaction, type DbClient } from '../db/postgres';
import { createLocalMediaStorage, type MediaStorage } from '../storage/mediaStorage';
import {
  ALLOWED_MEDIA_MIMES,
  initializeProviderDeposit,
  queueTransactionalEmail,
  scanProhibitedContent,
  validateMediaMagicBytes,
} from '../security';
import { releaseReservationInTx } from '../modules/budgetReservations';
import {
  ALLOWED_AD_FORMATS,
  ALLOWED_BIDDING_STRATEGIES,
  ALLOWED_OBJECTIVES,
  ALLOWED_PACING_MODES,
  ALLOWED_PRICING_MODELS,
  asTrimmedString,
  validateAppealInput,
  validateCampaignCreateInput,
  validateDepositInput,
  validateDimensions,
  validateHttpUrl,
  validateIsoDate,
  validateMediaUrl,
  validateNumberRange,
  validateRefundInput,
  validateTargetingFields,
  validateTextLength,
} from '../../src/lib/validation';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export function createAdvertiserRouter(db: DbClient, mediaStorage?: MediaStorage): AppRouter {
  const storage = mediaStorage ?? createLocalMediaStorage();
  const router = createAppRouter();
  const requireAuth = createAuthMiddleware(db);
  router.use(requireAuth, requireRole('advertiser', 'admin'));

  async function resolveAdvertiserId(req: AuthenticatedRequest): Promise<string | null> {
    if (req.auth?.role === 'admin' && typeof req.query.advertiserId === 'string') {
      return req.query.advertiserId;
    }
    const row = await db.queryOne<{ id: string }>(
      'SELECT id FROM advertiser_accounts WHERE user_id = ?',
      [req.auth!.userId]
    );
    return row?.id ?? null;
  }

  async function queryDailyPerformanceSeries(
    advertiserId: string,
    days = 30,
    campaignId?: string
  ): Promise<
    Array<{
      day: string;
      impressions: number;
      clicks: number;
      conversions: number;
      spendMicros: number;
      ctr: number;
      conversionRate: number;
    }>
  > {
    const windowDays = Math.max(1, Math.min(90, days));
    const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const cmpFilter = campaignId && campaignId !== 'all' ? ' AND campaign_id = ?' : '';
    const impParams = cmpFilter ? [advertiserId, sinceIso, campaignId!] : [advertiserId, sinceIso];

    const impSeries = await db.query<{ day: string; impressions: number; imp_spend_micros: number }>(
      `SELECT date(created_at) AS day,
              COUNT(*) AS impressions,
              COALESCE(SUM(billed_micros), 0) AS imp_spend_micros
       FROM impressions
       WHERE advertiser_id = ? AND is_valid = 1 AND created_at >= ?${cmpFilter}
       GROUP BY date(created_at)
       ORDER BY day ASC`,
      impParams
    );

    const clkSeries = await db.query<{ day: string; clicks: number; clk_spend_micros: number }>(
      `SELECT date(created_at) AS day,
              COUNT(*) AS clicks,
              COALESCE(SUM(billed_micros), 0) AS clk_spend_micros
       FROM clicks
       WHERE advertiser_id = ? AND is_valid = 1 AND created_at >= ?${cmpFilter}
       GROUP BY date(created_at)
       ORDER BY day ASC`,
      impParams
    );

    const cnvSeries = await db.query<{ day: string; conversions: number; cnv_spend_micros: number }>(
      `SELECT date(created_at) AS day,
              COUNT(*) AS conversions,
              COALESCE(SUM(billed_micros), 0) AS cnv_spend_micros
       FROM conversions
       WHERE advertiser_id = ? AND is_valid = 1 AND created_at >= ?${cmpFilter}
       GROUP BY date(created_at)
       ORDER BY day ASC`,
      impParams
    );

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
      const impressions = Number(imp?.impressions ?? 0);
      const clicks = Number(clk?.clicks ?? 0);
      const conversions = Number(cnv?.conversions ?? 0);
      const spendMicros =
        Number(imp?.imp_spend_micros ?? 0) +
        Number(clk?.clk_spend_micros ?? 0) +
        Number(cnv?.cnv_spend_micros ?? 0);
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
  router.get('/overview', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const account = await db.queryOne('SELECT * FROM advertiser_accounts WHERE id = ?', [advertiserId]);
    const wallet = await db.queryOne('SELECT * FROM advertiser_wallets WHERE advertiser_id = ?', [advertiserId]);

    const kpis = (await db.queryOne<{
      impressions: number;
      clicks: number;
      click_spend_micros: number;
      conversions: number;
      total_spend_micros: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM impressions WHERE advertiser_id = ? AND is_valid = 1) AS impressions,
         (SELECT COUNT(*) FROM clicks WHERE advertiser_id = ? AND is_valid = 1) AS clicks,
         (SELECT COALESCE(SUM(billed_micros), 0) FROM clicks WHERE advertiser_id = ? AND is_valid = 1) AS click_spend_micros,
         (SELECT COUNT(*) FROM conversions WHERE advertiser_id = ? AND is_valid = 1) AS conversions,
         (SELECT COALESCE(SUM(spent_total_micros), 0) FROM campaign_budgets b JOIN campaigns c ON c.id = b.campaign_id WHERE c.advertiser_id = ?) AS total_spend_micros`,
      [advertiserId, advertiserId, advertiserId, advertiserId, advertiserId]
    ))!;

    const impressions = Number(kpis.impressions);
    const clicks = Number(kpis.clicks);
    const clickSpendMicros = Number(kpis.click_spend_micros);
    const conversions = Number(kpis.conversions);
    const totalSpendMicros = Number(kpis.total_spend_micros);

    const performanceSeries = await queryDailyPerformanceSeries(advertiserId, 30);

    const notifications = await db.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 6',
      [req.auth!.userId]
    );

    res.json({
      account,
      wallet,
      kpis: {
        impressions,
        clicks,
        click_spend_micros: clickSpendMicros,
        conversions,
        total_spend_micros: totalSpendMicros,
        ctr: impressions > 0 ? clicks / impressions : 0,
        conversionRate: clicks > 0 ? conversions / clicks : 0,
        avgCpcMicros: clicks > 0 ? Math.round((clickSpendMicros || totalSpendMicros) / clicks) : 0,
      },
      performanceSeries,
      notifications,
    });
  });

  // GET /api/advertiser/campaigns
  router.get('/campaigns', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const campaigns = await db.query(
      `SELECT c.*, b.daily_budget_micros, b.total_budget_micros, b.spent_today_micros, b.spent_total_micros,
              b.max_bid_micros, b.pacing_mode,
              t.countries_json, t.languages_json, t.device_categories_json, t.operating_systems_json,
              t.browsers_json, t.interest_categories_json, t.contextual_categories_json, t.retargeting_enabled, t.consent_required,
              adv.id AS advertisement_id, adv.format AS ad_format,
              crt.id AS creative_id, crt.title AS creative_title, crt.description AS creative_description,
              crt.media_url, crt.destination_url, crt.cta_text, crt.tracking_params, crt.dimensions, crt.approval_status AS creative_approval_status,
              (SELECT COUNT(*) FROM impressions i WHERE i.campaign_id = c.id AND i.is_valid = 1) AS impressions,
              (SELECT COUNT(*) FROM clicks k WHERE k.campaign_id = c.id AND k.is_valid = 1) AS clicks,
              (SELECT COUNT(*) FROM conversions v WHERE v.campaign_id = c.id AND v.is_valid = 1) AS conversions
       FROM campaigns c
       JOIN campaign_budgets b ON b.campaign_id = c.id
       JOIN campaign_targeting t ON t.campaign_id = c.id
       LEFT JOIN advertisements adv ON adv.campaign_id = c.id
       LEFT JOIN ad_creatives crt ON crt.advertisement_id = adv.id
       WHERE c.advertiser_id = ?
       ORDER BY c.created_at DESC`,
      [advertiserId]
    );

    res.json({ campaigns });
  });

  // POST /api/advertiser/campaigns
  router.post('/campaigns', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const body = req.body ?? {};
    const validation = validateCampaignCreateInput(body);
    if (!validation.valid || !validation.value) {
      res.status(400).json({ error: validation.firstError, fieldErrors: validation.errors });
      return;
    }

    const {
      name,
      objective,
      pricingModel,
      biddingStrategy,
      startDate,
      endDate,
      dailyBudgetUsd,
      totalBudgetUsd,
      maxBidUsd,
      pacingMode,
      format,
      dimensions: resolvedDimensions,
      title,
      description,
      mediaUrl: resolvedMediaUrl,
      destinationUrl,
      ctaText,
      trackingParams,
      targeting,
    } = validation.value;
    const {
      countries,
      languages,
      deviceCategories,
      operatingSystems,
      browsers,
      contextualCategories,
      interestCategories,
    } = targeting;
    const retargetingEnabled = Boolean(body.retargetingEnabled);
    const consentRequired = body.consentRequired === false ? false : true;

    // Automated prohibited category & policy compliance scan
    const policyRows = await db.query<{
      id: string;
      name: string;
      keywords_json: string;
      severity: 'block' | 'review';
      active: number;
    }>('SELECT id, name, keywords_json, severity, active FROM prohibited_categories WHERE active = 1');

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

    const dailyMicros = Math.round(dailyBudgetUsd * 1_000_000);
    const totalMicros = Math.round(totalBudgetUsd * 1_000_000);
    const bidMicros = Math.round(maxBidUsd * 1_000_000);

    const campaignId = `cmp_${crypto.randomUUID().slice(0, 10)}`;

    await withTransaction(db, async (tx) => {
      await tx.execute(
        `INSERT INTO campaigns (id, advertiser_id, name, objective, pricing_model, bidding_strategy, status, moderation_status, start_date, end_date)
         VALUES (?, ?, ?, ?, ?, ?, 'pending_review', 'pending', ?, ?)`,
        [
          campaignId,
          advertiserId,
          String(name).trim(),
          String(objective),
          String(pricingModel),
          String(biddingStrategy),
          String(startDate),
          String(endDate),
        ]
      );

      await tx.execute(
        `INSERT INTO campaign_budgets (id, campaign_id, daily_budget_micros, total_budget_micros, max_bid_micros, pacing_mode, currency)
         VALUES (?, ?, ?, ?, ?, ?, 'USD')`,
        [
          `bdg_${crypto.randomUUID().slice(0, 10)}`,
          campaignId,
          dailyMicros,
          totalMicros,
          bidMicros,
          String(pacingMode),
        ]
      );

      await tx.execute(
        `INSERT INTO campaign_targeting (id, campaign_id, countries_json, languages_json, device_categories_json, operating_systems_json, browsers_json, interest_categories_json, contextual_categories_json, retargeting_enabled, consent_required)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
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
          consentRequired ? 1 : 0,
        ]
      );

      const adId = `ad_${crypto.randomUUID().slice(0, 10)}`;
      await tx.execute(
        `INSERT INTO advertisements (id, campaign_id, advertiser_id, name, format, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
        [adId, campaignId, advertiserId, String(title).trim(), String(format)]
      );

      const creativeId = `crt_${crypto.randomUUID().slice(0, 10)}`;
      await tx.execute(
        `INSERT INTO ad_creatives (id, advertisement_id, title, description, media_url, destination_url, cta_text, tracking_params, dimensions, approval_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          creativeId,
          adId,
          title,
          description,
          resolvedMediaUrl,
          destinationUrl,
          ctaText,
          trackingParams,
          resolvedDimensions,
        ]
      );

      if (violations.length > 0) {
        await tx.execute(
          `INSERT INTO moderation_reviews (id, target_type, target_id, reviewer_id, decision, reason)
           VALUES (?, 'campaign', ?, ?, 'policy_flagged', ?)`,
          [
            `mod_${crypto.randomUUID().slice(0, 10)}`,
            campaignId,
            req.auth!.userId,
            `Automated review flag: ${violations.map((v) => `${v.categoryName} ("${v.matchedKeyword}")`).join('; ')}`,
          ]
        );
      }

      return creativeId;
    });

    res.status(201).json({ campaignId, status: 'pending_review', reviewFlags: violations });
  });

  // GET /api/advertiser/media
  router.get('/media', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }
    const rows = await db.query<Record<string, any>>(
      'SELECT id, original_name, stored_name, mime_type, size_bytes, sha256, created_at FROM media_assets WHERE advertiser_id = ? ORDER BY created_at DESC LIMIT 30',
      [advertiserId]
    );
    const assets = rows.map((row) => ({
      ...row,
      url: `/api/media/${row.stored_name}`,
    }));
    res.json({ assets });
  });

  // POST /api/advertiser/media (Direct validated image/video upload)
  router.post('/media', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
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

    const assetId = `med_${crypto.randomUUID().slice(0, 10)}`;
    const storedName = `${assetId}_${crypto.randomUUID().slice(0, 8)}${ext}`;

    try {
      await storage.put(storedName, new Uint8Array(buffer), cleanMime);
    } catch {
      res.status(400).json({ error: 'Invalid upload destination path' });
      return;
    }

    const url = `/api/media/${storedName}`;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const safeOriginal = String(filename).replace(/\\/g, '/').split('/').pop()?.slice(0, 120) || storedName;

    await db.execute(
      `INSERT INTO media_assets (id, advertiser_id, original_name, stored_name, mime_type, size_bytes, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [assetId, advertiserId, safeOriginal, storedName, cleanMime, buffer.length, sha256]
    );

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
  router.delete('/media/:id', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }
    const row = await db.queryOne<{ id: string; stored_name: string }>(
      'SELECT id, stored_name FROM media_assets WHERE id = ? AND advertiser_id = ?',
      [String(req.params.id), advertiserId]
    );
    if (!row) {
      res.status(404).json({ error: 'Media asset not found' });
      return;
    }

    await db.execute('DELETE FROM media_assets WHERE id = ? AND advertiser_id = ?', [row.id, advertiserId]);
    await storage.delete(row.stored_name);

    res.json({ deleted: true, id: row.id });
  });

  // GET /api/advertiser/appeals
  router.get('/appeals', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }
    const appeals = await db.query(
      `SELECT ap.*, ap.resolution_notes AS admin_response, c.name AS campaign_name, c.status AS campaign_status
       FROM campaign_appeals ap
       JOIN campaigns c ON c.id = ap.campaign_id
       WHERE ap.advertiser_id = ?
       ORDER BY ap.created_at DESC`,
      [advertiserId]
    );
    res.json({ appeals });
  });

  // POST /api/advertiser/campaigns/:id/appeal
  router.post('/campaigns/:id/appeal', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const appealValidation = validateAppealInput(req.body ?? {});
    if (!appealValidation.valid || !appealValidation.value) {
      res.status(400).json({ error: appealValidation.firstError, fieldErrors: appealValidation.errors });
      return;
    }
    const { reason } = appealValidation.value;

    const camp = await db.queryOne<{
      id: string;
      name: string;
      status: string;
      moderation_status: string;
    }>('SELECT id, name, status, moderation_status FROM campaigns WHERE id = ? AND advertiser_id = ?', [
      String(req.params.id),
      advertiserId,
    ]);

    if (!camp) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    if (!['rejected', 'suspended'].includes(camp.status) && !['rejected', 'suspended'].includes(camp.moderation_status)) {
      res.status(400).json({ error: 'Only rejected or suspended campaigns can be appealed' });
      return;
    }

    const appealId = `apl_${crypto.randomUUID().slice(0, 10)}`;
    await withTransaction(db, async (tx) => {
      await tx.execute(
        `INSERT INTO campaign_appeals (id, campaign_id, advertiser_id, reason, status)
         VALUES (?, ?, ?, ?, 'open')`,
        [appealId, camp.id, advertiserId, reason]
      );

      await tx.execute(
        `INSERT INTO moderation_reviews (id, target_type, target_id, reviewer_id, decision, reason)
         VALUES (?, 'campaign', ?, ?, 'appeal_submitted', ?)`,
        [`mod_${crypto.randomUUID().slice(0, 10)}`, camp.id, req.auth!.userId, reason]
      );
    });

    res.status(201).json({ appealId, campaignId: camp.id, status: 'open' });
  });

  // GET /api/advertiser/campaigns/:id
  router.get('/campaigns/:id', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const campaign = await db.queryOne(
      `SELECT c.*, b.daily_budget_micros, b.total_budget_micros, b.spent_today_micros, b.spent_total_micros,
              b.max_bid_micros, b.pacing_mode,
              t.countries_json, t.languages_json, t.device_categories_json, t.operating_systems_json,
              t.browsers_json, t.interest_categories_json, t.contextual_categories_json, t.retargeting_enabled, t.consent_required,
              adv.id AS advertisement_id, adv.format AS ad_format,
              crt.id AS creative_id, crt.title AS creative_title, crt.description AS creative_description,
              crt.media_url, crt.destination_url, crt.cta_text, crt.tracking_params, crt.dimensions, crt.approval_status AS creative_approval_status,
              (SELECT COUNT(*) FROM impressions i WHERE i.campaign_id = c.id AND i.is_valid = 1) AS impressions,
              (SELECT COUNT(*) FROM clicks k WHERE k.campaign_id = c.id AND k.is_valid = 1) AS clicks,
              (SELECT COUNT(*) FROM conversions v WHERE v.campaign_id = c.id AND v.is_valid = 1) AS conversions
       FROM campaigns c
       JOIN campaign_budgets b ON b.campaign_id = c.id
       JOIN campaign_targeting t ON t.campaign_id = c.id
       LEFT JOIN advertisements adv ON adv.campaign_id = c.id
       LEFT JOIN ad_creatives crt ON crt.advertisement_id = adv.id
       WHERE c.id = ? AND c.advertiser_id = ?`,
      [String(req.params.id), advertiserId]
    );

    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    res.json({ campaign });
  });

  // PATCH & PUT /api/advertiser/campaigns/:id
  const handleUpdateCampaign = async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const existing = await db.queryOne<{
      id: string;
      moderation_status: string;
      status: string;
      pricing_model: string;
      start_date: string;
      end_date: string;
      daily_budget_micros: number;
      total_budget_micros: number;
    }>(
      `SELECT c.id, c.moderation_status, c.status, c.pricing_model, c.start_date, c.end_date,
              b.daily_budget_micros, b.total_budget_micros
       FROM campaigns c
       JOIN campaign_budgets b ON b.campaign_id = c.id
       WHERE c.id = ? AND c.advertiser_id = ?`,
      [String(req.params.id), advertiserId]
    );

    if (!existing) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const {
      status,
      name,
      objective,
      pricingModel,
      biddingStrategy,
      startDate,
      endDate,
      dailyBudgetUsd,
      totalBudgetUsd,
      maxBidUsd,
      pacingMode,
      targeting,
      format,
      dimensions,
      title,
      description,
      destinationUrl,
      ctaText,
      mediaUrl,
      trackingParams,
    } = req.body ?? {};

    const fieldErrors: Record<string, string> = {};

    if (status !== undefined) {
      if (status === 'active' && existing.moderation_status !== 'approved') {
        fieldErrors.status = 'Campaign must pass moderation approval before activation.';
      } else if (!['active', 'paused', 'archived'].includes(String(status))) {
        fieldErrors.status = 'Invalid campaign status transition.';
      }
    }

    if (name !== undefined) {
      const err = validateTextLength(name, { label: 'Campaign name', min: 2, max: 120 });
      if (err) fieldErrors.name = err;
    }
    if (objective !== undefined && !(ALLOWED_OBJECTIVES as readonly string[]).includes(String(objective))) {
      fieldErrors.objective = 'Select a valid advertising objective.';
    }
    if (pricingModel !== undefined && !(ALLOWED_PRICING_MODELS as readonly string[]).includes(String(pricingModel))) {
      fieldErrors.pricingModel = 'Select a valid pricing model.';
    }
    if (biddingStrategy !== undefined && !(ALLOWED_BIDDING_STRATEGIES as readonly string[]).includes(String(biddingStrategy))) {
      fieldErrors.biddingStrategy = 'Select a valid bidding strategy.';
    }
    if (pacingMode !== undefined && !(ALLOWED_PACING_MODES as readonly string[]).includes(String(pacingMode))) {
      fieldErrors.pacingMode = 'Select a valid delivery pacing mode.';
    }
    if (format !== undefined && !(ALLOWED_AD_FORMATS as readonly string[]).includes(String(format))) {
      fieldErrors.format = 'Select a valid ad format.';
    }
    if (dimensions !== undefined && dimensions !== '') {
      const dimErr = validateDimensions(dimensions);
      if (dimErr) fieldErrors.dimensions = dimErr;
    }
    if (title !== undefined) {
      const err = validateTextLength(title, { label: 'Ad headline', min: 2, max: 120 });
      if (err) fieldErrors.title = err;
    }
    if (description !== undefined) {
      const err = validateTextLength(description, { label: 'Ad description', min: 4, max: 300, allowNewlines: true });
      if (err) fieldErrors.description = err;
    }
    if (ctaText !== undefined) {
      const err = validateTextLength(ctaText, { label: 'Call-to-action label', min: 1, max: 40 });
      if (err) fieldErrors.ctaText = err;
    }
    if (trackingParams !== undefined && trackingParams !== '') {
      const tStr = asTrimmedString(trackingParams);
      if (tStr === null || tStr.length > 300 || /\s/.test(tStr)) {
        fieldErrors.trackingParams = 'Tracking parameters must be 300 characters or fewer with no spaces.';
      }
    }
    if (mediaUrl !== undefined && String(format ?? '') !== 'text') {
      const mErr = validateMediaUrl(mediaUrl, false);
      if (mErr) fieldErrors.mediaUrl = mErr;
    }

    let validatedDestUrl: string | undefined;
    if (destinationUrl !== undefined) {
      const destErr = validateHttpUrl(destinationUrl, { label: 'Destination URL', required: true });
      if (destErr) {
        fieldErrors.destinationUrl = destErr;
      } else {
        validatedDestUrl = new URL(asTrimmedString(destinationUrl)!).toString();
      }
    }

    const effectivePricing = pricingModel !== undefined ? String(pricingModel) : existing.pricing_model;
    let nextDailyUsd = Number(existing.daily_budget_micros) / 1_000_000;
    let nextTotalUsd = Number(existing.total_budget_micros) / 1_000_000;

    if (dailyBudgetUsd !== undefined) {
      const dRes = validateNumberRange(dailyBudgetUsd, { label: 'Daily budget', min: 5, max: 1_000_000, currency: true });
      if (dRes.error) fieldErrors.dailyBudgetUsd = dRes.error;
      else if (dRes.value !== null) nextDailyUsd = dRes.value;
    }
    if (totalBudgetUsd !== undefined) {
      const tRes = validateNumberRange(totalBudgetUsd, { label: 'Total budget', min: 5, max: 50_000_000, currency: true });
      if (tRes.error) fieldErrors.totalBudgetUsd = tRes.error;
      else if (tRes.value !== null) nextTotalUsd = tRes.value;
    }
    if (maxBidUsd !== undefined) {
      const bRes = validateNumberRange(maxBidUsd, { label: 'Max bid', min: 0.05, max: 10_000, currency: true });
      if (bRes.error) fieldErrors.maxBidUsd = bRes.error;
      else if (bRes.value !== null && bRes.value > nextDailyUsd && effectivePricing !== 'FIXED') {
        fieldErrors.maxBidUsd = 'Max bid cannot exceed the daily budget cap.';
      }
    }
    if (totalBudgetUsd !== undefined && !fieldErrors.dailyBudgetUsd && !fieldErrors.totalBudgetUsd && nextTotalUsd < nextDailyUsd) {
      fieldErrors.totalBudgetUsd = 'Total budget must be greater than or equal to the daily budget.';
    }

    const effectiveStart = startDate !== undefined ? asTrimmedString(startDate) || '' : existing.start_date;
    const effectiveEnd = endDate !== undefined ? asTrimmedString(endDate) || '' : existing.end_date;
    if (startDate !== undefined) {
      const sErr = validateIsoDate(startDate, 'Start date');
      if (sErr) fieldErrors.startDate = sErr;
    }
    if (endDate !== undefined) {
      const eErr = validateIsoDate(endDate, 'End date');
      if (eErr) fieldErrors.endDate = eErr;
    }
    if ((startDate !== undefined || endDate !== undefined) && !fieldErrors.startDate && !fieldErrors.endDate && effectiveStart && effectiveEnd && effectiveEnd < effectiveStart) {
      fieldErrors.endDate = 'End date must be on or after the start date.';
    }

    let validatedTargeting: ReturnType<typeof validateTargetingFields>['value'];
    if (targeting !== undefined) {
      if (!targeting || typeof targeting !== 'object' || Array.isArray(targeting)) {
        fieldErrors.targeting = 'Targeting configuration must be an object.';
      } else {
        const tVal = validateTargetingFields(targeting as Record<string, unknown>);
        if (!tVal.valid) {
          Object.assign(fieldErrors, tVal.errors);
        } else {
          validatedTargeting = tVal.value;
        }
      }
    }

    const firstErrKey = Object.keys(fieldErrors)[0];
    if (firstErrKey) {
      res.status(400).json({ error: fieldErrors[firstErrKey], fieldErrors });
      return;
    }

    // Policy compliance scan when campaign name, creative copy, or destination URL is edited
    let reviewFlags: Array<{ categoryId: string; categoryName: string; matchedKeyword: string; severity: 'block' | 'review' }> = [];
    if (name !== undefined || title !== undefined || description !== undefined || validatedDestUrl !== undefined) {
      const policyRows = await db.query<{
        id: string;
        name: string;
        keywords_json: string;
        severity: 'block' | 'review';
        active: number;
      }>('SELECT id, name, keywords_json, severity, active FROM prohibited_categories WHERE active = 1');

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
        `${name ?? ''} ${title ?? ''} ${description ?? ''} ${validatedDestUrl ?? ''}`,
        rules
      );
      const blocking = violations.filter((v) => v.severity === 'block');
      if (blocking.length > 0) {
        res.status(422).json({
          error: `Campaign update blocked by policy (${blocking[0].categoryName}): prohibited term "${blocking[0].matchedKeyword}" detected.`,
          violations: blocking,
        });
        return;
      }
      reviewFlags = violations;
    }

    let remoderationRequired = false;
    const nowIso = new Date().toISOString();
    await withTransaction(db, async (tx) => {
      if (status) {
        await tx.execute('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso, existing.id]);
      }
      if (name !== undefined && String(name).trim()) {
        await tx.execute('UPDATE campaigns SET name = ?, updated_at = ? WHERE id = ?', [
          String(name).trim(),
          nowIso,
          existing.id,
        ]);
      }
      if (objective !== undefined) {
        await tx.execute('UPDATE campaigns SET objective = ?, updated_at = ? WHERE id = ?', [
          String(objective),
          nowIso,
          existing.id,
        ]);
      }
      if (pricingModel !== undefined) {
        await tx.execute('UPDATE campaigns SET pricing_model = ?, updated_at = ? WHERE id = ?', [
          String(pricingModel),
          nowIso,
          existing.id,
        ]);
      }
      if (biddingStrategy) {
        await tx.execute('UPDATE campaigns SET bidding_strategy = ?, updated_at = ? WHERE id = ?', [
          biddingStrategy,
          nowIso,
          existing.id,
        ]);
      }
      if (startDate !== undefined || endDate !== undefined) {
        await tx.execute('UPDATE campaigns SET start_date = ?, end_date = ?, updated_at = ? WHERE id = ?', [
          effectiveStart,
          effectiveEnd,
          nowIso,
          existing.id,
        ]);
      }

      if (dailyBudgetUsd !== undefined) {
        const dailyMicros = Math.round(nextDailyUsd * 1_000_000);
        await tx.execute(
          `UPDATE campaign_budgets
           SET daily_budget_micros = ?,
               total_budget_micros = CASE WHEN total_budget_micros >= ? THEN total_budget_micros ELSE ? END,
               updated_at = ?
           WHERE campaign_id = ?`,
          [dailyMicros, dailyMicros, dailyMicros, nowIso, existing.id]
        );
      }
      if (totalBudgetUsd !== undefined) {
        const totalMicros = Math.round(nextTotalUsd * 1_000_000);
        await tx.execute('UPDATE campaign_budgets SET total_budget_micros = ?, updated_at = ? WHERE campaign_id = ?', [
          totalMicros,
          nowIso,
          existing.id,
        ]);
      }
      if (maxBidUsd !== undefined) {
        const bidMicros = Math.round(Number(maxBidUsd) * 1_000_000);
        await tx.execute('UPDATE campaign_budgets SET max_bid_micros = ?, updated_at = ? WHERE campaign_id = ?', [
          bidMicros,
          nowIso,
          existing.id,
        ]);
      }
      if (pacingMode) {
        await tx.execute('UPDATE campaign_budgets SET pacing_mode = ?, updated_at = ? WHERE campaign_id = ?', [
          pacingMode,
          nowIso,
          existing.id,
        ]);
      }

      let creativeContentModified = false;
      if (
        format !== undefined ||
        dimensions !== undefined ||
        title !== undefined ||
        description !== undefined ||
        validatedDestUrl !== undefined ||
        ctaText !== undefined ||
        mediaUrl !== undefined ||
        trackingParams !== undefined
      ) {
        const adRow = await tx.queryOne<{
          id: string;
          format: string;
          title: string | null;
          description: string | null;
          destination_url: string | null;
          cta_text: string | null;
          media_url: string | null;
          tracking_params: string | null;
        }>(
          `SELECT a.id, a.format, c.title, c.description, c.destination_url, c.cta_text, c.media_url, c.tracking_params
           FROM advertisements a
           LEFT JOIN ad_creatives c ON c.advertisement_id = a.id
           WHERE a.campaign_id = ?
           LIMIT 1`,
          [existing.id]
        );
        if (adRow) {
          const nextFormat = format !== undefined ? String(format) : adRow.format;
          if (format !== undefined && nextFormat !== adRow.format) {
            creativeContentModified = true;
            await tx.execute('UPDATE advertisements SET format = ? WHERE id = ?', [nextFormat, adRow.id]);
          }
          if (title !== undefined) {
            const cleanTitle = String(title).trim();
            if (cleanTitle !== (adRow.title ?? '')) creativeContentModified = true;
            await tx.execute('UPDATE advertisements SET name = ? WHERE id = ?', [cleanTitle, adRow.id]);
            await tx.execute('UPDATE ad_creatives SET title = ? WHERE advertisement_id = ?', [cleanTitle, adRow.id]);
          }
          if (description !== undefined) {
            const cleanDesc = String(description).trim();
            if (cleanDesc !== (adRow.description ?? '')) creativeContentModified = true;
            await tx.execute('UPDATE ad_creatives SET description = ? WHERE advertisement_id = ?', [cleanDesc, adRow.id]);
          }
          if (validatedDestUrl !== undefined) {
            if (validatedDestUrl !== (adRow.destination_url ?? '')) creativeContentModified = true;
            await tx.execute('UPDATE ad_creatives SET destination_url = ? WHERE advertisement_id = ?', [
              validatedDestUrl,
              adRow.id,
            ]);
          }
          if (ctaText !== undefined) {
            const cleanCta = String(ctaText).trim() || 'Learn More';
            if (cleanCta !== (adRow.cta_text ?? '')) creativeContentModified = true;
            await tx.execute('UPDATE ad_creatives SET cta_text = ? WHERE advertisement_id = ?', [cleanCta, adRow.id]);
          }
          if (nextFormat === 'text') {
            if ((adRow.media_url ?? '') !== '') creativeContentModified = true;
            await tx.execute("UPDATE ad_creatives SET media_url = '' WHERE advertisement_id = ?", [adRow.id]);
          } else if (mediaUrl !== undefined) {
            const cleanMedia = String(mediaUrl).trim();
            if (cleanMedia !== (adRow.media_url ?? '')) creativeContentModified = true;
            await tx.execute('UPDATE ad_creatives SET media_url = ? WHERE advertisement_id = ?', [cleanMedia, adRow.id]);
          }
          if (trackingParams !== undefined) {
            const cleanParams = String(trackingParams).trim();
            if (cleanParams !== (adRow.tracking_params ?? '')) creativeContentModified = true;
            await tx.execute('UPDATE ad_creatives SET tracking_params = ? WHERE advertisement_id = ?', [
              cleanParams,
              adRow.id,
            ]);
          }
          if (dimensions !== undefined && String(dimensions).trim()) {
            await tx.execute('UPDATE ad_creatives SET dimensions = ? WHERE advertisement_id = ?', [
              String(dimensions).trim().slice(0, 40),
              adRow.id,
            ]);
          } else if (format !== undefined && nextFormat === 'text') {
            await tx.execute("UPDATE ad_creatives SET dimensions = 'text' WHERE advertisement_id = ?", [adRow.id]);
          }

          if (
            creativeContentModified &&
            existing.moderation_status === 'approved' &&
            req.auth?.role !== 'admin' &&
            status !== 'archived'
          ) {
            remoderationRequired = true;
            await tx.execute(
              `UPDATE campaigns SET moderation_status = 'pending', status = 'pending_review', updated_at = ? WHERE id = ?`,
              [nowIso, existing.id]
            );
            await tx.execute(
              `UPDATE ad_creatives SET approval_status = 'pending' WHERE advertisement_id = ?`,
              [adRow.id]
            );
          }
        }
      }

      if (validatedTargeting && targeting && typeof targeting === 'object') {
        await tx.execute(
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
           WHERE campaign_id = ?`,
          [
            JSON.stringify(validatedTargeting.countries),
            JSON.stringify(validatedTargeting.languages),
            JSON.stringify(validatedTargeting.deviceCategories),
            JSON.stringify(validatedTargeting.operatingSystems),
            JSON.stringify(validatedTargeting.browsers),
            JSON.stringify(validatedTargeting.interestCategories),
            JSON.stringify(validatedTargeting.contextualCategories),
            targeting.retargetingEnabled ? 1 : 0,
            targeting.consentRequired === false ? 0 : 1,
            existing.id,
          ]
        );
      }

      if (reviewFlags.length > 0) {
        await tx.execute(
          `INSERT INTO moderation_reviews (id, target_type, target_id, reviewer_id, decision, reason)
           VALUES (?, 'campaign', ?, ?, 'policy_flagged', ?)`,
          [
            `mod_${crypto.randomUUID().slice(0, 10)}`,
            existing.id,
            req.auth!.userId,
            `Automated edit review flag: ${reviewFlags.map((v) => `${v.categoryName} ("${v.matchedKeyword}")`).join('; ')}`,
          ]
        );
      }
    });

    res.json({ updated: true, id: existing.id, reviewFlags, remoderationRequired });
  };

  router.patch('/campaigns/:id', handleUpdateCampaign);
  router.put('/campaigns/:id', handleUpdateCampaign);

  // DELETE /api/advertiser/campaigns/:id
  router.delete('/campaigns/:id', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const existing = await db.queryOne<{ id: string }>(
      'SELECT id FROM campaigns WHERE id = ? AND advertiser_id = ?',
      [String(req.params.id), advertiserId]
    );
    if (!existing) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const hasHistory = (await db.queryOne<{ cnt: number }>(
      `SELECT
         (SELECT COUNT(*) FROM ad_requests WHERE winning_campaign_id = ?) +
         (SELECT COUNT(*) FROM impressions WHERE campaign_id = ?) +
         (SELECT COUNT(*) FROM clicks WHERE campaign_id = ?) +
         (SELECT COUNT(*) FROM conversions WHERE campaign_id = ?) +
         (SELECT COUNT(*) FROM budget_reservations WHERE campaign_id = ?) +
         (SELECT COUNT(*) FROM video_events WHERE campaign_id = ?) +
         (SELECT COUNT(*) FROM app_installs WHERE campaign_id = ?) +
         (SELECT COUNT(*) FROM fraud_alerts WHERE campaign_id = ?) AS cnt`,
      [existing.id, existing.id, existing.id, existing.id, existing.id, existing.id, existing.id, existing.id]
    ))!;

    if (Number(hasHistory.cnt) > 0) {
      await db.execute("UPDATE campaigns SET status = 'archived', updated_at = ? WHERE id = ?", [
        new Date().toISOString(),
        existing.id,
      ]);
      res.json({ deleted: false, archived: true, id: existing.id });
      return;
    }

    await withTransaction(db, async (tx) => {
      await tx.execute('DELETE FROM campaign_appeals WHERE campaign_id = ?', [existing.id]);
      await tx.execute(
        'DELETE FROM ad_creatives WHERE advertisement_id IN (SELECT id FROM advertisements WHERE campaign_id = ?)',
        [existing.id]
      );
      await tx.execute('DELETE FROM advertisements WHERE campaign_id = ?', [existing.id]);
      await tx.execute('DELETE FROM campaign_targeting WHERE campaign_id = ?', [existing.id]);
      await tx.execute('DELETE FROM campaign_budgets WHERE campaign_id = ?', [existing.id]);
      await tx.execute('DELETE FROM campaigns WHERE id = ?', [existing.id]);
    });

    res.json({ deleted: true, archived: false, id: existing.id });
  });

  // POST /api/advertiser/campaigns/:id/duplicate
  router.post('/campaigns/:id/duplicate', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const src = await db.queryOne<Record<string, any>>(
      'SELECT * FROM campaigns WHERE id = ? AND advertiser_id = ?',
      [String(req.params.id), advertiserId]
    );
    if (!src) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const srcBudget = (await db.queryOne<Record<string, any>>(
      'SELECT * FROM campaign_budgets WHERE campaign_id = ?',
      [src.id]
    ))!;
    const srcTarget = (await db.queryOne<Record<string, any>>(
      'SELECT * FROM campaign_targeting WHERE campaign_id = ?',
      [src.id]
    ))!;
    const srcAd = await db.queryOne<Record<string, any>>(
      'SELECT * FROM advertisements WHERE campaign_id = ?',
      [src.id]
    );
    const srcCrt = srcAd
      ? await db.queryOne<Record<string, any>>('SELECT * FROM ad_creatives WHERE advertisement_id = ?', [srcAd.id])
      : null;

    const newCampId = `cmp_${crypto.randomUUID().slice(0, 10)}`;

    await withTransaction(db, async (tx) => {
      await tx.execute(
        `INSERT INTO campaigns (id, advertiser_id, name, objective, pricing_model, bidding_strategy, status, moderation_status, start_date, end_date, frequency_cap_per_session)
         VALUES (?, ?, ?, ?, ?, ?, 'pending_review', 'pending', ?, ?, ?)`,
        [
          newCampId,
          advertiserId,
          `${src.name} (Copy)`,
          src.objective,
          src.pricing_model,
          src.bidding_strategy,
          src.start_date,
          src.end_date,
          src.frequency_cap_per_session,
        ]
      );

      await tx.execute(
        `INSERT INTO campaign_budgets (id, campaign_id, daily_budget_micros, total_budget_micros, max_bid_micros, pacing_mode, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          `bdg_${crypto.randomUUID().slice(0, 10)}`,
          newCampId,
          srcBudget.daily_budget_micros,
          srcBudget.total_budget_micros,
          srcBudget.max_bid_micros,
          srcBudget.pacing_mode,
          srcBudget.currency,
        ]
      );

      await tx.execute(
        `INSERT INTO campaign_targeting (id, campaign_id, countries_json, regions_json, cities_json, languages_json, device_categories_json, operating_systems_json, browsers_json, interest_categories_json, contextual_categories_json, custom_segments_json, retargeting_enabled, consent_required)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `tgt_${crypto.randomUUID().slice(0, 10)}`,
          newCampId,
          srcTarget.countries_json,
          srcTarget.regions_json,
          srcTarget.cities_json,
          srcTarget.languages_json,
          srcTarget.device_categories_json,
          srcTarget.operating_systems_json,
          srcTarget.browsers_json,
          srcTarget.interest_categories_json,
          srcTarget.contextual_categories_json,
          srcTarget.custom_segments_json,
          srcTarget.retargeting_enabled,
          srcTarget.consent_required,
        ]
      );

      if (srcAd && srcCrt) {
        const newAdId = `ad_${crypto.randomUUID().slice(0, 10)}`;
        await tx.execute(
          `INSERT INTO advertisements (id, campaign_id, advertiser_id, name, format, status) VALUES (?, ?, ?, ?, ?, 'active')`,
          [newAdId, newCampId, advertiserId, srcAd.name, srcAd.format]
        );
        await tx.execute(
          `INSERT INTO ad_creatives (id, advertisement_id, title, description, media_url, destination_url, cta_text, tracking_params, dimensions, approval_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          [
            `crt_${crypto.randomUUID().slice(0, 10)}`,
            newAdId,
            srcCrt.title,
            srcCrt.description,
            srcCrt.media_url,
            srcCrt.destination_url,
            srcCrt.cta_text,
            srcCrt.tracking_params,
            srcCrt.dimensions,
          ]
        );
      }
    });

    res.status(201).json({ campaignId: newCampId });
  });

  // GET /api/advertiser/reporting
  router.get('/reporting', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const days = Math.max(1, Math.min(90, Number(req.query.days) || 30));
    const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
    const campaignId = typeof req.query.campaignId === 'string' && req.query.campaignId !== 'all'
      ? req.query.campaignId
      : undefined;
    const cmpClause = campaignId ? ' AND i.campaign_id = ?' : '';
    const geoParams = campaignId ? [advertiserId, sinceIso, campaignId] : [advertiserId, sinceIso];

    const byGeo = await db.query(
      `SELECT i.country,
              COUNT(DISTINCT i.id) AS impressions,
              COUNT(DISTINCT k.id) AS clicks,
              COALESCE(SUM(i.billed_micros), 0) + COALESCE(SUM(k.billed_micros), 0) AS spend_micros
       FROM impressions i
       LEFT JOIN clicks k ON k.impression_id = i.id AND k.is_valid = 1
       WHERE i.advertiser_id = ? AND i.is_valid = 1 AND i.created_at >= ?${cmpClause}
       GROUP BY i.country
       ORDER BY impressions DESC`,
      geoParams
    );

    const byDevice = await db.query(
      `SELECT i.device_category,
              COUNT(DISTINCT i.id) AS impressions,
              COUNT(DISTINCT k.id) AS clicks,
              COALESCE(SUM(i.billed_micros), 0) + COALESCE(SUM(k.billed_micros), 0) AS spend_micros
       FROM impressions i
       LEFT JOIN clicks k ON k.impression_id = i.id AND k.is_valid = 1
       WHERE i.advertiser_id = ? AND i.is_valid = 1 AND i.created_at >= ?${cmpClause}
       GROUP BY i.device_category
       ORDER BY impressions DESC`,
      geoParams
    );

    const byCampaign = await db.query(
      `SELECT c.id, c.name, c.pricing_model, c.status,
              (SELECT COUNT(*) FROM impressions i WHERE i.campaign_id = c.id AND i.is_valid = 1 AND i.created_at >= ?) AS impressions,
              (SELECT COUNT(*) FROM clicks k WHERE k.campaign_id = c.id AND k.is_valid = 1 AND k.created_at >= ?) AS clicks,
              (SELECT COUNT(*) FROM conversions v WHERE v.campaign_id = c.id AND v.is_valid = 1 AND v.created_at >= ?) AS conversions,
              b.spent_total_micros AS spend_micros
       FROM campaigns c
       JOIN campaign_budgets b ON b.campaign_id = c.id
       WHERE c.advertiser_id = ?`,
      [sinceIso, sinceIso, sinceIso, advertiserId]
    );

    const dailySeries = await queryDailyPerformanceSeries(advertiserId, days, campaignId);

    res.json({ byGeo, byDevice, byCampaign, dailySeries });
  });

  // GET /api/advertiser/reporting/csv
  router.get('/reporting/csv', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const rows = await db.query<{
      id: string;
      name: string;
      pricing_model: string;
      status: string;
      impressions: number;
      clicks: number;
      conversions: number;
      spent_total_micros: number;
    }>(
      `SELECT c.id, c.name, c.pricing_model, c.status,
              (SELECT COUNT(*) FROM impressions i WHERE i.campaign_id = c.id AND i.is_valid = 1) AS impressions,
              (SELECT COUNT(*) FROM clicks k WHERE k.campaign_id = c.id AND k.is_valid = 1) AS clicks,
              (SELECT COUNT(*) FROM conversions v WHERE v.campaign_id = c.id AND v.is_valid = 1) AS conversions,
              b.spent_total_micros
       FROM campaigns c
       JOIN campaign_budgets b ON b.campaign_id = c.id
       WHERE c.advertiser_id = ?`,
      [advertiserId]
    );

    const lines = ['Campaign ID,Campaign Name,Pricing Model,Status,Impressions,Clicks,CTR,Conversions,Spend (USD)'];
    for (const r of rows) {
      const imps = Number(r.impressions);
      const clks = Number(r.clicks);
      const ctr = imps > 0 ? ((clks / imps) * 100).toFixed(2) : '0.00';
      const spendUsd = (Number(r.spent_total_micros) / 1_000_000).toFixed(2);
      const safeName = `"${r.name.replace(/"/g, '""')}"`;
      lines.push(`${r.id},${safeName},${r.pricing_model},${r.status},${imps},${clks},${ctr}%,${Number(r.conversions)},${spendUsd}`);
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="looma-campaign-report.csv"');
    res.send(lines.join('\n'));
  });

  // GET /api/advertiser/billing
  router.get('/billing', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const wallet = await db.queryOne<{ id: string }>(
      'SELECT * FROM advertiser_wallets WHERE advertiser_id = ?',
      [advertiserId]
    );
    if (!wallet) {
      res.status(404).json({ error: 'Advertiser wallet not found' });
      return;
    }
    const deposits = await db.query(
      'SELECT * FROM deposits WHERE advertiser_id = ? ORDER BY created_at DESC',
      [advertiserId]
    );
    const invoices = await db.query(
      'SELECT * FROM invoices WHERE advertiser_id = ? ORDER BY issued_at DESC',
      [advertiserId]
    );
    const ledger = await db.query(
      "SELECT * FROM financial_ledger WHERE account_type = 'advertiser_wallet' AND account_id = ? ORDER BY created_at DESC LIMIT 50",
      [wallet.id]
    );
    const reservations = await db.query(
      `SELECT r.*, c.name AS campaign_name
       FROM budget_reservations r
       JOIN campaigns c ON c.id = r.campaign_id
       WHERE r.advertiser_id = ?
       ORDER BY r.created_at DESC
       LIMIT 30`,
      [advertiserId]
    );

    res.json({ wallet, deposits, invoices, ledger, reservations });
  });

  // POST /api/advertiser/reservations/:id/release
  router.post('/reservations/:id/release', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const row = await db.queryOne<{ id: string; request_id: string; status: string }>(
      'SELECT id, request_id, status FROM budget_reservations WHERE id = ? AND advertiser_id = ?',
      [String(req.params.id), advertiserId]
    );

    if (!row) {
      res.status(404).json({ error: 'Budget reservation not found' });
      return;
    }
    if (row.status !== 'active') {
      res.status(400).json({ error: `Reservation is already ${row.status}` });
      return;
    }

    const outcome = await withTransaction(db, async (tx) =>
      releaseReservationInTx(tx, row.request_id, 'Released by advertiser wallet control')
    );
    res.json(outcome);
  });

  // POST /api/advertiser/deposit (Live Paystack/Flutterwave/Stripe checkout when secrets exist, verified sandbox fallback)
  router.post('/deposit', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const depValidation = validateDepositInput(req.body ?? {});
    if (!depValidation.valid || !depValidation.value) {
      res.status(400).json({ error: depValidation.firstError, fieldErrors: depValidation.errors });
      return;
    }
    const { amountUsd: parsedAmount, provider, idempotencyKey } = depValidation.value;

    const amountMicros = Math.round(parsedAmount * 1_000_000);
    const idem = idempotencyKey || `dep_${crypto.randomUUID()}`;

    const existing = await db.queryOne<{
      id: string;
      advertiser_id: string;
      amount_micros: number;
      provider_ref: string;
      status: string;
    }>('SELECT id, advertiser_id, amount_micros, provider_ref, status FROM deposits WHERE idempotency_key = ?', [idem]);
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

    const advAccount = await db.queryOne<{ billing_email: string }>(
      'SELECT billing_email FROM advertiser_accounts WHERE id = ?',
      [advertiserId]
    );
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

    const sandboxDepositsAllowed =
      process.env.ALLOW_SANDBOX_DEPOSITS === 'true' ||
      (process.env.ALLOW_SANDBOX_DEPOSITS !== 'false' &&
        process.env.NODE_ENV !== 'production' &&
        process.env.LOOMA_RUNTIME !== 'cloudflare-worker');

    if (checkout.mode === 'live') {
      await db.execute(
        `INSERT INTO deposits (id, advertiser_id, provider, provider_ref, idempotency_key, amount_micros, currency, status)
         VALUES (?, ?, ?, ?, ?, ?, 'USD', 'pending')`,
        [depositId, advertiserId, provider, checkout.providerRef, idem, amountMicros]
      );

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

    if (!sandboxDepositsAllowed) {
      if (provider === 'bank_transfer') {
        await db.execute(
          `INSERT INTO deposits (id, advertiser_id, provider, provider_ref, idempotency_key, amount_micros, currency, status)
           VALUES (?, ?, ?, ?, ?, ?, 'USD', 'pending')`,
          [depositId, advertiserId, provider, checkout.providerRef, idem, amountMicros]
        );

        res.status(201).json({
          duplicate: false,
          mode: 'live',
          status: 'pending',
          depositId,
          providerRef: checkout.providerRef,
          detail: 'Bank transfer deposit recorded as pending reconciliation. Wallet will be credited once settlement is confirmed.',
        });
        return;
      }

      res.status(503).json({
        error: `Live payment gateway credentials are not configured for ${provider}. Instant sandbox credits are disabled in production.`,
      });
      return;
    }

    const result = await withTransaction(db, async (tx) => {
      const wallet = (await tx.queryOne<{ id: string }>(
        'SELECT id FROM advertiser_wallets WHERE advertiser_id = ?',
        [advertiserId]
      ))!;

      await tx.execute(
        `INSERT INTO deposits (id, advertiser_id, provider, provider_ref, idempotency_key, amount_micros, currency, status)
         VALUES (?, ?, ?, ?, ?, ?, 'USD', 'completed')`,
        [depositId, advertiserId, provider, checkout.providerRef, idem, amountMicros]
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
      const newBalance = Number(updatedWallet.available_micros);

      const invNumber = `LOOMA-INV-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      await tx.execute(
        `INSERT INTO invoices (id, advertiser_id, invoice_number, deposit_id, amount_micros, currency, status)
         VALUES (?, ?, ?, ?, ?, 'USD', 'paid')`,
        [`inv_${crypto.randomUUID().slice(0, 10)}`, advertiserId, invNumber, depositId, amountMicros]
      );

      await tx.execute(
        `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
         VALUES (?, ?, 'advertiser_wallet', ?, 'deposit', 'credit', ?, ?, 'USD', 'deposit', ?, ?)`,
        [
          `led_${crypto.randomUUID().slice(0, 12)}`,
          `led_${idem}`,
          wallet.id,
          amountMicros,
          newBalance,
          depositId,
          `Prepaid wallet credit via ${provider} (${checkout.providerRef})`,
        ]
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
      await queueTransactionalEmail(db, {
        to: advAccount.billing_email,
        subject: `Looma Advertising — Deposit Receipt (${result.invoiceNumber})`,
        bodyText: `We credited $${parsedAmount.toFixed(2)} to your prepaid advertising wallet via ${provider} (${result.providerRef}).`,
        category: 'billing',
      });
    }

    res.status(201).json(result);
  });

  // POST /api/advertiser/refund
  router.post('/refund', async (req: AuthenticatedRequest, res: Response) => {
    const advertiserId = await resolveAdvertiserId(req);
    if (!advertiserId) {
      res.status(404).json({ error: 'Advertiser account not found' });
      return;
    }

    const refValidation = validateRefundInput(req.body ?? {});
    if (!refValidation.valid || !refValidation.value) {
      res.status(400).json({ error: refValidation.firstError, fieldErrors: refValidation.errors });
      return;
    }
    const { amountUsd: parsedAmount, reason } = refValidation.value;

    const amountMicros = Math.round(parsedAmount * 1_000_000);
    const outcome = await withTransaction(db, async (tx) => {
      const wallet = await tx.queryOne<{ id: string }>(
        'SELECT id FROM advertiser_wallets WHERE advertiser_id = ?',
        [advertiserId]
      );
      if (!wallet) {
        return { error: 'Advertiser wallet not found' };
      }

      const debitRes = await tx.execute(
        `UPDATE advertiser_wallets
         SET available_micros = available_micros - ?, updated_at = ?
         WHERE id = ? AND available_micros >= ?`,
        [amountMicros, new Date().toISOString(), wallet.id, amountMicros]
      );
      if (debitRes.rowCount === 0) {
        return { error: 'Requested refund exceeds available wallet balance' };
      }

      const updatedWallet = (await tx.queryOne<{ available_micros: number }>(
        'SELECT available_micros FROM advertiser_wallets WHERE id = ?',
        [wallet.id]
      ))!;
      const newBalance = Number(updatedWallet.available_micros);
      const refId = `rfd_${crypto.randomUUID().slice(0, 10)}`;

      await tx.execute(
        `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
         VALUES (?, ?, 'advertiser_wallet', ?, 'refund', 'debit', ?, ?, 'USD', 'refund', ?, ?)`,
        [
          `led_${crypto.randomUUID().slice(0, 12)}`,
          `led_${refId}`,
          wallet.id,
          amountMicros,
          newBalance,
          refId,
          String(reason),
        ]
      );

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
