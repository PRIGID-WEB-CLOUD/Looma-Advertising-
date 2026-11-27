import crypto from 'node:crypto';
import { createAppRouter, type AppRouter, type Request, type Response } from '../http/router';
import { authenticateBearerToken, getTrackingSecret, hashIp, timingSafeSecretMatch } from '../auth';
import { withTransaction, type DbClient } from '../db/postgres';
import {
  CandidateCampaign,
  computeSingleEventBillMicros,
  CreativeFormat,
  evaluateTrafficQuality,
  PlacementFormat,
  PricingModel,
  selectWinningAd,
  signTrackingToken,
  splitRevenueMicros,
  verifyTrackingToken,
} from '../engine';
import { checkPersistentRateLimit } from '../jobs';
import {
  captureReservationInTx,
  releaseReservationInTx,
  reserveBudgetForRequest,
  type ReserveBudgetResult,
} from '../modules/budgetReservations';
import { getFeatureFlags, isPublisherEligibleForDelivery } from '../modules/featureFlags';
import { recordAdDeliveryMetric, recordFraudBlockedMetric } from '../modules/monitoring';
import {
  asTrimmedString,
  validateCountryCode,
  validateNumberRange,
  validateTextLength,
} from '../../src/lib/validation';

function parseJsonArray(raw: string, fallback: string[]): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : fallback;
  } catch {
    return fallback;
  }
}

async function settlePublisherRevenueInTx(
  tx: DbClient,
  params: {
    publisherId: string;
    actualBilled: number;
    referenceType: string;
    referenceId: string;
    ledgerIdempotencyKey: string;
    description: string;
  }
): Promise<{ publisherShareMicros: number; platformFeeMicros: number }> {
  if (params.actualBilled <= 0) {
    return { publisherShareMicros: 0, platformFeeMicros: 0 };
  }

  const pubRow = await tx.queryOne<{ publisher_type: string | null; custom_revenue_share_bps: number | null }>(
    'SELECT publisher_type, custom_revenue_share_bps FROM publisher_accounts WHERE id = ?',
    [params.publisherId]
  );

  const flags = await getFeatureFlags(tx);
  if (pubRow?.publisher_type === 'third_party' && !flags.third_party_revenue_allocation_enabled) {
    return { publisherShareMicros: 0, platformFeeMicros: params.actualBilled };
  }

  const settingRow = await tx.queryOne<{ value_json: string }>(
    "SELECT value_json FROM platform_settings WHERE key = 'default_publisher_share_bps'"
  );
  let defaultBps = 7000;
  if (settingRow?.value_json) {
    try {
      const parsed = Number(JSON.parse(settingRow.value_json));
      if (Number.isFinite(parsed)) defaultBps = parsed;
    } catch {
      defaultBps = 7000;
    }
  }
  const shareBps = pubRow?.custom_revenue_share_bps ?? defaultBps;

  const { publisherShareMicros, platformFeeMicros } = splitRevenueMicros(params.actualBilled, shareBps);

  const pubWal = await tx.queryOne<{ id: string }>(
    'SELECT id FROM publisher_wallets WHERE publisher_id = ?',
    [params.publisherId]
  );

  if (pubWal && publisherShareMicros > 0) {
    await tx.execute(
      `UPDATE publisher_wallets
       SET estimated_micros = estimated_micros + ?, available_micros = available_micros + ?, lifetime_earned_micros = lifetime_earned_micros + ?, updated_at = ?
       WHERE id = ?`,
      [publisherShareMicros, publisherShareMicros, publisherShareMicros, new Date().toISOString(), pubWal.id]
    );

    const updatedPubWal = (await tx.queryOne<{ available_micros: number }>(
      'SELECT available_micros FROM publisher_wallets WHERE id = ?',
      [pubWal.id]
    ))!;
    const newPubBal = Number(updatedPubWal.available_micros);

    await tx.execute(
      `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
       VALUES (?, ?, 'publisher_wallet', ?, 'publisher_earning', 'credit', ?, ?, 'USD', ?, ?, ?)`,
      [
        `led_${crypto.randomUUID().slice(0, 12)}`,
        params.ledgerIdempotencyKey,
        pubWal.id,
        publisherShareMicros,
        newPubBal,
        params.referenceType,
        params.referenceId,
        params.description,
      ]
    );
  }

  return { publisherShareMicros, platformFeeMicros };
}

export interface AdEventQueueMessage {
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
}

export function createAdDeliveryRouter(
  db: DbClient,
  options?: { onEvent?: (msg: AdEventQueueMessage) => void | Promise<void> }
): AppRouter {
  const router = createAppRouter();
  const emitEvent = (msg: AdEventQueueMessage) => {
    if (options?.onEvent) {
      Promise.resolve(options.onEvent(msg)).catch(() => {});
    }
  };

  // POST /api/v1/ad/request
  router.post('/request', async (req: Request, res: Response) => {
    const startedAt = performance.now();
    const clientIp = (req.ip || req.socket?.remoteAddress || '127.0.0.1').toString();
    if (!(await checkPersistentRateLimit(db, `adreq:${clientIp}`, 240))) {
      res.status(429).json({ error: 'Rate limit exceeded for ad requests' });
      return;
    }

    const {
      placementId,
      country = 'US',
      language = 'en',
      deviceCategory = 'desktop',
      os = 'Web',
      browser = 'Chrome',
      category = 'general',
      consentGranted = true,
      sessionId,
    } = req.body ?? {};

    const cleanPlacementId = asTrimmedString(placementId);
    if (!cleanPlacementId || cleanPlacementId.length > 80) {
      res.status(400).json({ error: 'placementId is required', fieldErrors: { placementId: 'Provide a valid placementId.' } });
      return;
    }
    const countryErr = validateCountryCode(country, true);
    if (countryErr) {
      res.status(400).json({ error: countryErr, fieldErrors: { country: countryErr } });
      return;
    }
    const cleanDevice = asTrimmedString(deviceCategory)?.toLowerCase() || '';
    if (!['desktop', 'mobile', 'tablet'].includes(cleanDevice)) {
      res.status(400).json({
        error: 'deviceCategory must be desktop, mobile, or tablet',
        fieldErrors: { deviceCategory: 'deviceCategory must be desktop, mobile, or tablet.' },
      });
      return;
    }

    const placement = await db.queryOne<{
      id: string;
      property_id: string;
      publisher_id: string;
      format: PlacementFormat;
      dimensions: string;
      floor_cpm_micros: number;
      status: string;
      property_approval: string;
      property_verification: string;
      publisher_approval: string;
      publisher_type: string | null;
    }>(
      `SELECT p.id, p.property_id, p.publisher_id, p.format, p.dimensions, p.floor_cpm_micros, p.status,
              prop.approval_status AS property_approval, prop.verification_status AS property_verification,
              pub.approval_status AS publisher_approval, pub.publisher_type
       FROM ad_placements p
       JOIN publisher_properties prop ON prop.id = p.property_id
       JOIN publisher_accounts pub ON pub.id = p.publisher_id
       WHERE p.id = ?`,
      [cleanPlacementId]
    );

    if (!placement) {
      res.status(404).json({ error: 'Ad placement not found' });
      return;
    }

    const pubEligibility = await isPublisherEligibleForDelivery(
      db,
      placement.publisher_type || 'first_party',
      placement.publisher_approval
    );

    if (
      !pubEligibility.eligible ||
      placement.status !== 'active' ||
      placement.property_approval !== 'approved'
    ) {
      recordAdDeliveryMetric(false, performance.now() - startedAt, false);
      res.status(200).json({
        filled: false,
        reason: pubEligibility.reason || 'placement_or_publisher_not_approved',
        requestId: null,
        ad: null,
      });
      return;
    }

    const ipHash = hashIp(clientIp);
    const sessionHash = hashIp(
      typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : `${clientIp}:${req.headers['user-agent'] || ''}`
    );

    const twoHoursAgoIso = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    // Count session impressions per campaign in last 2 hours for frequency capping
    const freqRows = await db.query<{ campaign_id: string; cnt: number }>(
      `SELECT campaign_id, COUNT(*) AS cnt
       FROM impressions
       WHERE session_hash = ? AND created_at >= ?
       GROUP BY campaign_id`,
      [sessionHash, twoHoursAgoIso]
    );
    const sessionImpressionCounts: Record<string, number> = {};
    for (const row of freqRows) {
      sessionImpressionCounts[row.campaign_id] = Number(row.cnt);
    }

    // Load active candidate campaigns joined with targeting, budgets, creatives, and wallet balance
    const rows = await db.query<{
      campaign_id: string;
      advertiser_id: string;
      campaign_name: string;
      pricing_model: PricingModel;
      bidding_strategy: string;
      status: string;
      moderation_status: string;
      start_date: string;
      end_date: string;
      frequency_cap_per_session: number;
      daily_budget_micros: number;
      total_budget_micros: number;
      spent_today_micros: number;
      spent_total_micros: number;
      max_bid_micros: number;
      pacing_mode: string;
      wallet_available_micros: number;
      countries_json: string;
      languages_json: string;
      device_categories_json: string;
      operating_systems_json: string;
      browsers_json: string;
      contextual_categories_json: string;
      consent_required: number;
      creative_format: CreativeFormat;
      creative_id: string;
      advertisement_id: string;
      title: string;
      description: string;
      media_url: string;
      destination_url: string;
      cta_text: string;
      tracking_params: string;
      dimensions: string;
      creative_approval_status: string;
    }>(
      `SELECT c.id AS campaign_id, c.advertiser_id, c.name AS campaign_name, c.pricing_model,
              c.bidding_strategy, c.status, c.moderation_status, c.start_date, c.end_date,
              c.frequency_cap_per_session,
              b.daily_budget_micros, b.total_budget_micros, b.spent_today_micros, b.spent_total_micros,
              b.max_bid_micros, b.pacing_mode,
              w.available_micros AS wallet_available_micros,
              t.countries_json, t.languages_json, t.device_categories_json, t.operating_systems_json,
              t.browsers_json, t.contextual_categories_json, t.consent_required,
              adv.format AS creative_format, crt.id AS creative_id, crt.advertisement_id,
              crt.title, crt.description, crt.media_url, crt.destination_url, crt.cta_text,
              crt.tracking_params, crt.dimensions, crt.approval_status AS creative_approval_status,
              adv_acc.account_status AS advertiser_status
       FROM campaigns c
       JOIN advertiser_accounts adv_acc ON adv_acc.id = c.advertiser_id
       JOIN advertiser_wallets w ON w.advertiser_id = c.advertiser_id
       JOIN campaign_budgets b ON b.campaign_id = c.id
       JOIN campaign_targeting t ON t.campaign_id = c.id
       JOIN advertisements adv ON adv.campaign_id = c.id AND adv.status = 'active'
       JOIN ad_creatives crt ON crt.advertisement_id = adv.id
       WHERE c.status = 'active' AND c.moderation_status = 'approved' AND adv_acc.account_status = 'active'`
    );

    const candidates: CandidateCampaign[] = rows.map((r) => ({
      campaignId: r.campaign_id,
      advertiserId: r.advertiser_id,
      campaignName: r.campaign_name,
      pricingModel: r.pricing_model,
      biddingStrategy: r.bidding_strategy,
      status: r.status,
      moderationStatus: r.moderation_status,
      startDate: r.start_date,
      endDate: r.end_date,
      frequencyCapPerSession: Number(r.frequency_cap_per_session),
      dailyBudgetMicros: Number(r.daily_budget_micros),
      totalBudgetMicros: Number(r.total_budget_micros),
      spentTodayMicros: Number(r.spent_today_micros),
      spentTotalMicros: Number(r.spent_total_micros),
      maxBidMicros: Number(r.max_bid_micros),
      pacingMode: r.pacing_mode,
      walletAvailableMicros: Number(r.wallet_available_micros),
      targeting: {
        countries: parseJsonArray(r.countries_json, ['ALL']),
        languages: parseJsonArray(r.languages_json, ['ALL']),
        deviceCategories: parseJsonArray(r.device_categories_json, ['ALL']),
        operatingSystems: parseJsonArray(r.operating_systems_json, ['ALL']),
        browsers: parseJsonArray(r.browsers_json, ['ALL']),
        contextualCategories: parseJsonArray(r.contextual_categories_json, ['ALL']),
        consentRequired: Boolean(r.consent_required),
      },
      creative: {
        id: r.creative_id,
        advertisementId: r.advertisement_id,
        format: r.creative_format,
        title: r.title,
        description: r.description,
        mediaUrl: r.media_url,
        destinationUrl: r.destination_url,
        ctaText: r.cta_text,
        trackingParams: r.tracking_params,
        dimensions: r.dimensions,
        approvalStatus: r.creative_approval_status,
      },
      historicalCtr: 0.022,
      historicalCvr: 0.045,
      qualityScore: 1.0,
    }));

    const oneHourAgoIso = new Date(Date.now() - 60 * 60_000).toISOString();
    const recentRows = await db.query<{ campaign_id: string; cnt: number }>(
      `SELECT campaign_id, COUNT(*) AS cnt
       FROM impressions
       WHERE created_at >= ?
       GROUP BY campaign_id`,
      [oneHourAgoIso]
    );
    const recentDeliveryCounts: Record<string, number> = {};
    for (const row of recentRows) {
      recentDeliveryCounts[row.campaign_id] = Number(row.cnt);
    }

    const winner = selectWinningAd(candidates, {
      placementId: placement.id,
      placementFormat: placement.format,
      floorCpmMicros: Number(placement.floor_cpm_micros),
      country: String(country),
      language: String(language),
      deviceCategory: String(deviceCategory),
      os: String(os),
      browser: String(browser),
      category: String(category),
      consentGranted: Boolean(consentGranted),
      sessionImpressionCounts,
      recentDeliveryCounts,
      nowIso: new Date().toISOString(),
    });

    const requestId = `req_${crypto.randomUUID().slice(0, 12)}`;

    let reservation: ReserveBudgetResult | null = null;
    if (winner) {
      reservation = await reserveBudgetForRequest(db, {
        advertiserId: winner.candidate.advertiserId,
        campaignId: winner.candidate.campaignId,
        requestId,
        amountMicros: winner.estimatedBillableMicros,
        ttlMinutes: 30,
      });
    }

    const actuallyFilled = Boolean(winner && reservation?.reserved);

    await db.execute(
      `INSERT INTO ad_requests (id, placement_id, property_id, publisher_id, winning_campaign_id, winning_creative_id, country, device_category, os, browser, language, category, consent_granted, filled, ip_hash, session_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        requestId,
        placement.id,
        placement.property_id,
        placement.publisher_id,
        actuallyFilled && winner ? winner.candidate.campaignId : null,
        actuallyFilled && winner ? winner.candidate.creative.id : null,
        String(country),
        String(deviceCategory),
        String(os),
        String(browser),
        String(language),
        String(category),
        consentGranted ? 1 : 0,
        actuallyFilled ? 1 : 0,
        ipHash,
        sessionHash,
      ]
    );

    recordAdDeliveryMetric(actuallyFilled, performance.now() - startedAt, false);

    if (!actuallyFilled || !winner) {
      res.status(200).json({
        filled: false,
        requestId,
        reason: reservation && !reservation.reserved ? reservation.reason : 'no_eligible_campaign_matched',
        ad: null,
      });
      return;
    }

    const exp = Date.now() + 1000 * 60 * 30; // 30-min signed token validity
    const baseToken = {
      requestId,
      campaignId: winner.candidate.campaignId,
      creativeId: winner.candidate.creative.id,
      placementId: placement.id,
      publisherId: placement.publisher_id,
      advertiserId: winner.candidate.advertiserId,
      pricingModel: winner.candidate.pricingModel,
      clearingPriceMicros: winner.candidate.maxBidMicros,
      exp,
    };

    const trackingSecret = getTrackingSecret();
    const impressionToken = signTrackingToken({ ...baseToken, eventType: 'impression' }, trackingSecret);
    const clickToken = signTrackingToken({ ...baseToken, eventType: 'click' }, trackingSecret);
    const conversionToken = signTrackingToken({ ...baseToken, eventType: 'conversion' }, trackingSecret);
    const videoToken = signTrackingToken({ ...baseToken, eventType: 'video' }, trackingSecret);
    const installToken = signTrackingToken({ ...baseToken, eventType: 'install' }, trackingSecret);

    emitEvent({
      eventType: 'ad_request_filled',
      entityType: 'ad_request',
      entityId: requestId,
      payload: {
        campaignId: winner.candidate.campaignId,
        creativeId: winner.candidate.creative.id,
        placementId: placement.id,
        publisherId: placement.publisher_id,
      },
    });

    const separator = winner.candidate.creative.destinationUrl.includes('?') ? '&' : '?';
    const fullDestinationUrl = winner.candidate.creative.trackingParams
      ? `${winner.candidate.creative.destinationUrl}${separator}${winner.candidate.creative.trackingParams}`
      : winner.candidate.creative.destinationUrl;

    res.json({
      filled: true,
      requestId,
      reservationId: reservation?.reservationId ?? null,
      reservedMicros: reservation?.reservedMicros ?? 0,
      auction: {
        model: 'first_price_controlled_rotation',
        effectiveCpmMicros: winner.effectiveCpmMicros,
        auctionScore: winner.auctionScore,
        rotationFactor: winner.rotationFactor ?? 1,
      },
      ad: {
        campaignId: winner.candidate.campaignId,
        campaignName: winner.candidate.campaignName,
        creativeId: winner.candidate.creative.id,
        format: winner.candidate.creative.format,
        pricingModel: winner.candidate.pricingModel,
        title: winner.candidate.creative.title,
        description: winner.candidate.creative.description,
        mediaUrl: winner.candidate.creative.mediaUrl,
        destinationUrl: fullDestinationUrl,
        ctaText: winner.candidate.creative.ctaText,
        dimensions: winner.candidate.creative.dimensions,
        sponsoredLabel: 'Sponsored · Looma Advertising',
      },
      tracking: {
        impressionToken,
        clickToken,
        conversionToken,
        videoToken,
        installToken,
      },
    });
  });

  // POST /api/v1/ad/impression
  router.post('/impression', async (req: Request, res: Response) => {
    const { impressionToken, viewable = true, sessionId } = req.body ?? {};
    if (!impressionToken || typeof impressionToken !== 'string') {
      res.status(400).json({ error: 'impressionToken is required' });
      return;
    }

    const verified = verifyTrackingToken(impressionToken, getTrackingSecret());
    if (!verified.valid || verified.payload.eventType !== 'impression') {
      res.status(400).json({ error: 'Invalid or expired impression token' });
      return;
    }

    const payload = verified.payload;
    const clientIp = (req.ip || req.socket?.remoteAddress || '127.0.0.1').toString();
    const ipHash = hashIp(clientIp);
    const sessionHash = hashIp(
      typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : `${clientIp}:${req.headers['user-agent'] || ''}`
    );

    if (!viewable) {
      res.status(200).json({ recorded: false, reason: 'impression_not_viewable' });
      return;
    }

    try {
      const outcome = await withTransaction(db, async (tx) => {
        // Deduplicate by request_id
        const existing = await tx.queryOne<{ id: string }>(
          'SELECT id FROM impressions WHERE request_id = ?',
          [payload.requestId]
        );
        if (existing) {
          return { duplicate: true, impressionId: existing.id, billedMicros: 0 };
        }

        const reqRow = await tx.queryOne<{ country: string; device_category: string }>(
          'SELECT country, device_category FROM ad_requests WHERE id = ?',
          [payload.requestId]
        );

        const grossBillMicros = computeSingleEventBillMicros(
          payload.pricingModel,
          payload.clearingPriceMicros,
          'impression'
        );

        let actualBilled = 0;
        let publisherShareMicros = 0;
        let platformFeeMicros = 0;

        if (grossBillMicros > 0) {
          const captured = await captureReservationInTx(tx, {
            advertiserId: payload.advertiserId,
            campaignId: payload.campaignId,
            requestId: payload.requestId,
            chargeMicros: grossBillMicros,
            eventType: 'impression',
            ledgerIdempotencyKey: `imp_adv_${payload.requestId}`,
            description: `Verified ${payload.pricingModel} impression charge`,
          });

          if (captured) {
            actualBilled = captured.capturedMicros;
            const split = await settlePublisherRevenueInTx(tx, {
              publisherId: payload.publisherId,
              actualBilled,
              referenceType: 'impression',
              referenceId: `imp_${payload.requestId}`,
              ledgerIdempotencyKey: `imp_pub_${payload.requestId}`,
              description: 'Publisher revenue share for verified impression',
            });
            publisherShareMicros = split.publisherShareMicros;
            platformFeeMicros = split.platformFeeMicros;
          }
        }

        const impressionId = `imp_${crypto.randomUUID().slice(0, 12)}`;
        await tx.execute(
          `INSERT INTO impressions (id, request_id, campaign_id, creative_id, placement_id, publisher_id, advertiser_id, viewable, is_valid, billed_micros, publisher_share_micros, platform_fee_micros, country, device_category, ip_hash, session_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)`,
          [
            impressionId,
            payload.requestId,
            payload.campaignId,
            payload.creativeId,
            payload.placementId,
            payload.publisherId,
            payload.advertiserId,
            actualBilled,
            publisherShareMicros,
            platformFeeMicros,
            reqRow?.country || 'US',
            reqRow?.device_category || 'desktop',
            ipHash,
            sessionHash,
          ]
        );

        await tx.execute('UPDATE ad_placements SET integration_verified = 1 WHERE id = ?', [payload.placementId]);

        await tx.execute(
          `INSERT INTO event_logs (id, event_type, entity_type, entity_id, payload_json)
           VALUES (?, 'impression_verified', 'impression', ?, ?)`,
          [
            `evt_${crypto.randomUUID().slice(0, 12)}`,
            impressionId,
            JSON.stringify({ campaignId: payload.campaignId, billedMicros: actualBilled }),
          ]
        );

        return { duplicate: false, impressionId, billedMicros: actualBilled };
      });

      res.json({ recorded: !outcome.duplicate, ...outcome });
    } catch (error) {
      console.error('Impression error:', error);
      res.status(500).json({ error: 'Failed to record impression' });
    }
  });

  // POST /api/v1/ad/click
  router.post('/click', async (req: Request, res: Response) => {
    const { clickToken, sessionId, simulateBot = false } = req.body ?? {};
    if (!clickToken || typeof clickToken !== 'string') {
      res.status(400).json({ error: 'clickToken is required' });
      return;
    }

    const verified = verifyTrackingToken(clickToken, getTrackingSecret());
    if (!verified.valid || verified.payload.eventType !== 'click') {
      res.status(400).json({ error: 'Invalid or expired click token' });
      return;
    }

    const payload = verified.payload;
    const clientIp = (req.ip || req.socket?.remoteAddress || '127.0.0.1').toString();
    const ipHash = hashIp(clientIp);
    const rawUa = String(req.headers['user-agent'] || '');
    let allowSandboxUaNormalization = false;
    if (req.body?.sandboxMode) {
      const configuredAdapterKey = process.env.LOOMA_ADAPTER_KEY?.trim();
      const providedAdapterKey = req.header('x-looma-adapter-key') || '';
      if (configuredAdapterKey && timingSafeSecretMatch(providedAdapterKey, configuredAdapterKey)) {
        allowSandboxUaNormalization = true;
      } else {
        const authRes = await authenticateBearerToken(db, req.header('authorization'));
        if (authRes.ok && (authRes.session.role === 'publisher' || authRes.session.role === 'admin')) {
          allowSandboxUaNormalization = true;
        }
      }
    }

    const userAgent = simulateBot
      ? 'python-requests/2.31.0 AutomatedBot'
      : allowSandboxUaNormalization
        ? rawUa.replace(/HeadlessChrome/gi, 'Chrome')
        : rawUa;
    const sessionHash = hashIp(
      typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : `${clientIp}:${rawUa}`
    );

    try {
      const result = await withTransaction(db, async (tx) => {
        const impRow = await tx.queryOne<{ id: string }>(
          'SELECT id FROM impressions WHERE request_id = ?',
          [payload.requestId]
        );

        if (!impRow) {
          return { errorStatus: 400, error: 'Impression must be verified before click attribution' };
        }

        const alreadyClicked = Boolean(
          await tx.queryOne('SELECT id FROM clicks WHERE impression_id = ?', [impRow.id])
        );

        const twoMinutesAgoIso = new Date(Date.now() - 2 * 60_000).toISOString();
        const fiveMinutesAgoIso = new Date(Date.now() - 5 * 60_000).toISOString();

        const recentIpClicksRow = await tx.queryOne<{ cnt: number }>(
          'SELECT COUNT(*) AS cnt FROM clicks WHERE ip_hash = ? AND created_at >= ?',
          [ipHash, twoMinutesAgoIso]
        );
        const recentIpClicks = Number(recentIpClicksRow?.cnt ?? 0);

        const recentSessionImpsRow = await tx.queryOne<{ cnt: number }>(
          'SELECT COUNT(*) AS cnt FROM impressions WHERE session_hash = ? AND created_at >= ?',
          [sessionHash, fiveMinutesAgoIso]
        );
        const recentSessionImps = Number(recentSessionImpsRow?.cnt ?? 0);

        const pubStats = await tx.queryOne<{ imps: number; clks: number }>(
          `SELECT
             (SELECT COUNT(*) FROM impressions WHERE publisher_id = ?) AS imps,
             (SELECT COUNT(*) FROM clicks WHERE publisher_id = ? AND is_valid = 1) AS clks`,
          [payload.publisherId, payload.publisherId]
        );
        const imps = Number(pubStats?.imps ?? 0);
        const clks = Number(pubStats?.clks ?? 0);
        const publisherCtr = imps > 10 ? clks / imps : 0.02;

        const fraudEval = evaluateTrafficQuality({
          userAgent,
          recentClicksSameIpCount: recentIpClicks,
          recentImpressionsSameSessionCount: recentSessionImps,
          alreadyClickedImpression: alreadyClicked,
          publisherCtr,
        });

        if (fraudEval.shouldRaiseAlert && fraudEval.signalType) {
          await tx.execute(
            `INSERT INTO fraud_alerts (id, publisher_id, campaign_id, signal_type, severity, description, evidence_json, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
            [
              `frd_${crypto.randomUUID().slice(0, 12)}`,
              payload.publisherId,
              payload.campaignId,
              fraudEval.signalType,
              fraudEval.severity,
              `Detected ${fraudEval.signalType} on placement ${payload.placementId}`,
              JSON.stringify({ recentIpClicks, recentSessionImps, publisherCtr }),
            ]
          );
        }

        let actualBilled = 0;
        let publisherShareMicros = 0;
        let platformFeeMicros = 0;

        if (fraudEval.isValid) {
          const grossBillMicros = computeSingleEventBillMicros(
            payload.pricingModel,
            payload.clearingPriceMicros,
            'click'
          );

          if (grossBillMicros > 0) {
            const captured = await captureReservationInTx(tx, {
              advertiserId: payload.advertiserId,
              campaignId: payload.campaignId,
              requestId: payload.requestId,
              chargeMicros: grossBillMicros,
              eventType: 'click',
              ledgerIdempotencyKey: `clk_adv_${payload.requestId}`,
              description: 'Verified CPC click charge',
            });

            if (captured) {
              actualBilled = captured.capturedMicros;
              const split = await settlePublisherRevenueInTx(tx, {
                publisherId: payload.publisherId,
                actualBilled,
                referenceType: 'click',
                referenceId: payload.requestId,
                ledgerIdempotencyKey: `clk_pub_${payload.requestId}`,
                description: 'Publisher revenue share for verified click',
              });
              publisherShareMicros = split.publisherShareMicros;
              platformFeeMicros = split.platformFeeMicros;
            }
          }
        } else {
          recordFraudBlockedMetric();
          await releaseReservationInTx(
            tx,
            payload.requestId,
            `Released reservation after invalid click (${fraudEval.reason || 'fraud_blocked'})`
          );
        }

        const clickId = `clk_${crypto.randomUUID().slice(0, 12)}`;
        await tx.execute(
          `INSERT INTO clicks (id, impression_id, request_id, campaign_id, creative_id, placement_id, publisher_id, advertiser_id, is_valid, invalid_reason, billed_micros, publisher_share_micros, platform_fee_micros, ip_hash, session_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            clickId,
            impRow.id,
            payload.requestId,
            payload.campaignId,
            payload.creativeId,
            payload.placementId,
            payload.publisherId,
            payload.advertiserId,
            fraudEval.isValid ? 1 : 0,
            fraudEval.reason,
            actualBilled,
            publisherShareMicros,
            platformFeeMicros,
            ipHash,
            sessionHash,
          ]
        );

        return {
          clickId,
          valid: fraudEval.isValid,
          invalidReason: fraudEval.reason,
          billedMicros: actualBilled,
          publisherShareMicros,
        };
      });

      if ('errorStatus' in result && result.errorStatus) {
        res.status(result.errorStatus).json({ error: result.error });
        return;
      }

      res.json(result);
    } catch (error) {
      console.error('Click tracking error:', error);
      res.status(500).json({ error: 'Failed to process click event' });
    }
  });

  // POST /api/v1/ad/conversion
  router.post('/conversion', async (req: Request, res: Response) => {
    const { conversionToken, eventName = 'purchase', conversionValueMicros = 0 } = req.body ?? {};
    if (!conversionToken || typeof conversionToken !== 'string') {
      res.status(400).json({ error: 'conversionToken is required', fieldErrors: { conversionToken: 'conversionToken is required.' } });
      return;
    }
    const eventErr = validateTextLength(eventName, { label: 'Event name', min: 1, max: 64 });
    if (eventErr) {
      res.status(400).json({ error: eventErr, fieldErrors: { eventName: eventErr } });
      return;
    }
    const valCheck = validateNumberRange(conversionValueMicros, {
      label: 'Conversion value',
      min: 0,
      max: 1_000_000_000_000,
    });
    if (valCheck.error) {
      res.status(400).json({ error: valCheck.error, fieldErrors: { conversionValueMicros: valCheck.error } });
      return;
    }

    const verified = verifyTrackingToken(conversionToken, getTrackingSecret());
    if (!verified.valid || verified.payload.eventType !== 'conversion') {
      res.status(400).json({ error: 'Invalid or expired conversion token' });
      return;
    }

    const payload = verified.payload;

    try {
      const outcome = await withTransaction(db, async (tx) => {
        const existing = await tx.queryOne<{ id: string }>(
          'SELECT id FROM conversions WHERE request_id = ?',
          [payload.requestId]
        );
        if (existing) {
          return { duplicate: true, conversionId: existing.id, billedMicros: 0 };
        }

        const clickRow = await tx.queryOne<{ id: string; impression_id: string }>(
          'SELECT id, impression_id FROM clicks WHERE request_id = ? AND is_valid = 1',
          [payload.requestId]
        );
        const impRow = await tx.queryOne<{ id: string }>(
          'SELECT id FROM impressions WHERE request_id = ?',
          [payload.requestId]
        );

        const grossBillMicros = computeSingleEventBillMicros(
          payload.pricingModel,
          payload.clearingPriceMicros,
          'conversion'
        );

        let actualBilled = 0;
        let publisherShareMicros = 0;
        let platformFeeMicros = 0;

        if (grossBillMicros > 0) {
          const captured = await captureReservationInTx(tx, {
            advertiserId: payload.advertiserId,
            campaignId: payload.campaignId,
            requestId: payload.requestId,
            chargeMicros: grossBillMicros,
            eventType: 'conversion',
            ledgerIdempotencyKey: `cnv_adv_${payload.requestId}`,
            description: `Verified ${payload.pricingModel} conversion charge`,
          });

          if (captured) {
            actualBilled = captured.capturedMicros;
            const split = await settlePublisherRevenueInTx(tx, {
              publisherId: payload.publisherId,
              actualBilled,
              referenceType: 'conversion',
              referenceId: payload.requestId,
              ledgerIdempotencyKey: `cnv_pub_${payload.requestId}`,
              description: 'Publisher revenue share for verified conversion',
            });
            publisherShareMicros = split.publisherShareMicros;
            platformFeeMicros = split.platformFeeMicros;
          }
        }

        const conversionId = `cnv_${crypto.randomUUID().slice(0, 12)}`;
        await tx.execute(
          `INSERT INTO conversions (id, click_id, request_id, campaign_id, advertiser_id, publisher_id, event_name, conversion_value_micros, billed_micros, publisher_share_micros, platform_fee_micros, is_valid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            conversionId,
            clickRow?.id || null,
            payload.requestId,
            payload.campaignId,
            payload.advertiserId,
            payload.publisherId,
            String(eventName),
            Math.max(0, Math.round(Number(conversionValueMicros) || 0)),
            actualBilled,
            publisherShareMicros,
            platformFeeMicros,
          ]
        );

        await tx.execute(
          `INSERT INTO attribution_records (id, conversion_id, click_id, impression_id, attribution_model, window_hours)
           VALUES (?, ?, ?, ?, ?, 168)`,
          [
            `att_${crypto.randomUUID().slice(0, 12)}`,
            conversionId,
            clickRow?.id || null,
            clickRow?.impression_id || impRow?.id || null,
            clickRow ? 'last_click' : 'view_through',
          ]
        );

        return { duplicate: false, conversionId, billedMicros: actualBilled };
      });

      res.json({ recorded: !outcome.duplicate, ...outcome });
    } catch (error) {
      console.error('Conversion tracking error:', error);
      res.status(500).json({ error: 'Failed to record conversion' });
    }
  });

  // POST /api/v1/ad/video-event (Quartile telemetry + CPV billing on verified complete)
  router.post('/video-event', async (req: Request, res: Response) => {
    const { videoToken, eventName = 'complete', watchedMs = 0 } = req.body ?? {};
    if (!videoToken || typeof videoToken !== 'string') {
      res.status(400).json({ error: 'videoToken is required', fieldErrors: { videoToken: 'videoToken is required.' } });
      return;
    }
    if (!['start', 'first_quartile', 'midpoint', 'third_quartile', 'complete', 'mute', 'unmute'].includes(eventName)) {
      res.status(400).json({ error: 'Invalid video eventName', fieldErrors: { eventName: 'Unsupported video event name.' } });
      return;
    }
    const watchedCheck = validateNumberRange(watchedMs, {
      label: 'Watched duration (ms)',
      min: 0,
      max: 86_400_000,
    });
    if (watchedCheck.error) {
      res.status(400).json({ error: watchedCheck.error, fieldErrors: { watchedMs: watchedCheck.error } });
      return;
    }

    const verified = verifyTrackingToken(videoToken, getTrackingSecret());
    if (!verified.valid || verified.payload.eventType !== 'video') {
      res.status(400).json({ error: 'Invalid or expired video token' });
      return;
    }
    const payload = verified.payload;

    try {
      const outcome = await withTransaction(db, async (tx) => {
        const alreadyCompleted =
          eventName === 'complete' &&
          Boolean(
            await tx.queryOne(
              "SELECT id FROM video_events WHERE request_id = ? AND event_name = 'complete'",
              [payload.requestId]
            )
          );

        let actualBilled = 0;
        let publisherShareMicros = 0;
        let platformFeeMicros = 0;

        if (eventName === 'complete' && !alreadyCompleted) {
          const grossBillMicros = computeSingleEventBillMicros(
            payload.pricingModel,
            payload.clearingPriceMicros,
            'video_complete'
          );
          if (grossBillMicros > 0) {
            const captured = await captureReservationInTx(tx, {
              advertiserId: payload.advertiserId,
              campaignId: payload.campaignId,
              requestId: payload.requestId,
              chargeMicros: grossBillMicros,
              eventType: 'video_view',
              ledgerIdempotencyKey: `vid_adv_${payload.requestId}`,
              description: 'Verified CPV video completion charge',
            });

            if (captured) {
              actualBilled = captured.capturedMicros;
              const split = await settlePublisherRevenueInTx(tx, {
                publisherId: payload.publisherId,
                actualBilled,
                referenceType: 'video_view',
                referenceId: payload.requestId,
                ledgerIdempotencyKey: `vid_pub_${payload.requestId}`,
                description: 'Publisher revenue share for verified CPV view',
              });
              publisherShareMicros = split.publisherShareMicros;
              platformFeeMicros = split.platformFeeMicros;
            }
          }
        }

        const videoEventId = `vid_${crypto.randomUUID().slice(0, 12)}`;
        await tx.execute(
          `INSERT INTO video_events (id, request_id, campaign_id, creative_id, placement_id, publisher_id, advertiser_id, event_name, viewable_ms, billed_micros, publisher_share_micros, platform_fee_micros)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            videoEventId,
            payload.requestId,
            payload.campaignId,
            payload.creativeId,
            payload.placementId,
            payload.publisherId,
            payload.advertiserId,
            eventName,
            Math.max(0, Math.round(Number(watchedMs) || 0)),
            actualBilled,
            publisherShareMicros,
            platformFeeMicros,
          ]
        );

        return { videoEventId, eventName, duplicateComplete: alreadyCompleted, billedMicros: actualBilled };
      });

      res.json({ recorded: true, ...outcome });
    } catch (error) {
      console.error('Video event tracking error:', error);
      res.status(500).json({ error: 'Failed to record video event' });
    }
  });

  // POST /api/v1/ad/install (App install attribution + CPI billing)
  router.post('/install', async (req: Request, res: Response) => {
    const { installToken, appBundleId = 'com.app.unknown', deviceOs = 'iOS' } = req.body ?? {};
    if (!installToken || typeof installToken !== 'string') {
      res.status(400).json({ error: 'installToken is required', fieldErrors: { installToken: 'installToken is required.' } });
      return;
    }
    const bundleErr = validateTextLength(appBundleId, { label: 'App bundle ID', min: 3, max: 150 });
    if (bundleErr) {
      res.status(400).json({ error: bundleErr, fieldErrors: { appBundleId: bundleErr } });
      return;
    }
    const osErr = validateTextLength(deviceOs, { label: 'Device OS', min: 2, max: 40 });
    if (osErr) {
      res.status(400).json({ error: osErr, fieldErrors: { deviceOs: osErr } });
      return;
    }

    const verified = verifyTrackingToken(installToken, getTrackingSecret());
    if (!verified.valid || (verified.payload.eventType !== 'install' && verified.payload.eventType !== 'conversion')) {
      res.status(400).json({ error: 'Invalid or expired install token' });
      return;
    }
    const payload = verified.payload;

    try {
      const outcome = await withTransaction(db, async (tx) => {
        const existing = await tx.queryOne<{ id: string }>(
          'SELECT id FROM app_installs WHERE request_id = ?',
          [payload.requestId]
        );
        if (existing) {
          return { duplicate: true, installId: existing.id, billedMicros: 0 };
        }

        const grossBillMicros = computeSingleEventBillMicros(
          payload.pricingModel,
          payload.clearingPriceMicros,
          'install'
        );

        let actualBilled = 0;
        let publisherShareMicros = 0;
        let platformFeeMicros = 0;

        if (grossBillMicros > 0) {
          const captured = await captureReservationInTx(tx, {
            advertiserId: payload.advertiserId,
            campaignId: payload.campaignId,
            requestId: payload.requestId,
            chargeMicros: grossBillMicros,
            eventType: 'app_install',
            ledgerIdempotencyKey: `ins_adv_${payload.requestId}`,
            description: 'Verified CPI app install charge',
          });

          if (captured) {
            actualBilled = captured.capturedMicros;
            const split = await settlePublisherRevenueInTx(tx, {
              publisherId: payload.publisherId,
              actualBilled,
              referenceType: 'app_install',
              referenceId: payload.requestId,
              ledgerIdempotencyKey: `ins_pub_${payload.requestId}`,
              description: 'Publisher revenue share for verified app install',
            });
            publisherShareMicros = split.publisherShareMicros;
            platformFeeMicros = split.platformFeeMicros;
          }
        }

        const installId = `ins_${crypto.randomUUID().slice(0, 12)}`;
        await tx.execute(
          `INSERT INTO app_installs (id, request_id, campaign_id, advertiser_id, publisher_id, app_bundle_id, device_os, billed_micros, publisher_share_micros, platform_fee_micros)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            installId,
            payload.requestId,
            payload.campaignId,
            payload.advertiserId,
            payload.publisherId,
            String(appBundleId).slice(0, 120),
            String(deviceOs).slice(0, 40),
            actualBilled,
            publisherShareMicros,
            platformFeeMicros,
          ]
        );

        return { duplicate: false, installId, billedMicros: actualBilled };
      });

      res.json({ recorded: !outcome.duplicate, ...outcome });
    } catch (error) {
      console.error('Install attribution error:', error);
      res.status(500).json({ error: 'Failed to record app install' });
    }
  });

  // GET /api/v1/ad/creative/:id
  router.get('/creative/:id', async (req: Request, res: Response) => {
    const row = await db.queryOne(
      `SELECT crt.id, crt.title, crt.description, crt.media_url, crt.destination_url, crt.cta_text, crt.dimensions, crt.approval_status, adv.format
       FROM ad_creatives crt
       JOIN advertisements adv ON adv.id = crt.advertisement_id
       JOIN campaigns c ON c.id = adv.campaign_id
       WHERE crt.id = ?
         AND crt.approval_status = 'approved'
         AND c.status = 'active'
         AND c.moderation_status = 'approved'`,
      [String(req.params.id)]
    );
    if (!row) {
      res.status(404).json({ error: 'Creative not found' });
      return;
    }
    res.json(row);
  });

  return router;
}

export function getPublisherSdkScript(): string {
  return `(function(w, d) {
  var LoomaAds = {
    version: '1.0.0',
    renderPlacement: async function(opts) {
      var container = typeof opts.container === 'string' ? d.querySelector(opts.container) : opts.container;
      if (!container) return;
      var endpoint = opts.endpoint || '/api/v1/ad/request';
      var res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          placementId: opts.placementId,
          country: opts.country || 'US',
          deviceCategory: opts.deviceCategory || 'desktop',
          category: opts.category || 'general',
          consentGranted: opts.consentGranted !== false
        })
      });
      var data = await res.json();
      if (!data.filled || !data.ad) {
        container.setAttribute('data-looma-status', 'unfilled');
        return data;
      }
      var card = d.createElement('div');
      card.style.cssText = 'border:1px solid #e2e8f0;border-radius:8px;padding:16px;font-family:sans-serif;background:#ffffff;color:#0f172a;';
      var label = d.createElement('div');
      label.textContent = data.ad.sponsoredLabel;
      label.style.cssText = 'font-size:11px;color:#64748b;margin-bottom:6px;';
      var title = d.createElement('div');
      title.textContent = data.ad.title;
      title.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:4px;';
      var desc = d.createElement('p');
      desc.textContent = data.ad.description;
      desc.style.cssText = 'font-size:13px;color:#475569;margin:0 0 12px 0;';
      var cta = d.createElement('a');
      var dest = typeof data.ad.destinationUrl === 'string' && /^https?:\\/\\//i.test(data.ad.destinationUrl)
        ? data.ad.destinationUrl
        : '#';
      cta.href = dest;
      cta.textContent = data.ad.ctaText;
      cta.target = '_blank';
      cta.rel = 'noopener noreferrer sponsored';
      cta.style.cssText = 'display:inline-block;padding:8px 14px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:500;';
      cta.addEventListener('click', function(ev) {
        if (dest === '#') ev.preventDefault();
        fetch('/api/v1/ad/click', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clickToken: data.tracking.clickToken })
        });
      });
      card.appendChild(label);
      card.appendChild(title);
      card.appendChild(desc);
      card.appendChild(cta);
      container.replaceChildren(card);
      await fetch('/api/v1/ad/impression', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ impressionToken: data.tracking.impressionToken, viewable: true })
      });
      return data;
    }
  };
  w.LoomaAds = LoomaAds;
})(window, document);
`;
}
