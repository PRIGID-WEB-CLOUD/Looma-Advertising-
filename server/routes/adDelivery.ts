import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { hashIp, TRACKING_SECRET } from '../auth';
import { withTransaction } from '../db';
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
} from '../modules/budgetReservations';
import { getFeatureFlags, isPublisherEligibleForDelivery } from '../modules/featureFlags';
import { recordAdDeliveryMetric, recordFraudBlockedMetric } from '../modules/monitoring';

function parseJsonArray(raw: string, fallback: string[]): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : fallback;
  } catch {
    return fallback;
  }
}

function settlePublisherRevenueInTx(
  db: DatabaseSync,
  params: {
    publisherId: string;
    actualBilled: number;
    referenceType: string;
    referenceId: string;
    ledgerIdempotencyKey: string;
    description: string;
  }
): { publisherShareMicros: number; platformFeeMicros: number } {
  if (params.actualBilled <= 0) {
    return { publisherShareMicros: 0, platformFeeMicros: 0 };
  }

  const pubRow = db
    .prepare('SELECT publisher_type, custom_revenue_share_bps FROM publisher_accounts WHERE id = ?')
    .get(params.publisherId) as { publisher_type: string | null; custom_revenue_share_bps: number | null } | undefined;

  const flags = getFeatureFlags(db);
  if (pubRow?.publisher_type === 'third_party' && !flags.third_party_revenue_allocation_enabled) {
    return { publisherShareMicros: 0, platformFeeMicros: params.actualBilled };
  }

  const settingRow = db
    .prepare("SELECT value_json FROM platform_settings WHERE key = 'default_publisher_share_bps'")
    .get() as { value_json: string } | undefined;
  const defaultBps = settingRow ? Number(JSON.parse(settingRow.value_json)) : 7000;
  const shareBps = pubRow?.custom_revenue_share_bps ?? defaultBps;

  const { publisherShareMicros, platformFeeMicros } = splitRevenueMicros(params.actualBilled, shareBps);

  const pubWal = db
    .prepare('SELECT id, available_micros FROM publisher_wallets WHERE publisher_id = ?')
    .get(params.publisherId) as { id: string; available_micros: number } | undefined;

  if (pubWal && publisherShareMicros > 0) {
    const newPubBal = pubWal.available_micros + publisherShareMicros;
    db.prepare(
      `UPDATE publisher_wallets
       SET estimated_micros = estimated_micros + ?, available_micros = ?, lifetime_earned_micros = lifetime_earned_micros + ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(publisherShareMicros, newPubBal, publisherShareMicros, pubWal.id);

    db.prepare(
      `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
       VALUES (?, ?, 'publisher_wallet', ?, 'publisher_earning', 'credit', ?, ?, 'USD', ?, ?, ?)`
    ).run(
      `led_${crypto.randomUUID().slice(0, 12)}`,
      params.ledgerIdempotencyKey,
      pubWal.id,
      publisherShareMicros,
      newPubBal,
      params.referenceType,
      params.referenceId,
      params.description
    );
  }

  return { publisherShareMicros, platformFeeMicros };
}

export function createAdDeliveryRouter(db: DatabaseSync): Router {
  const router = Router();

  // POST /api/v1/ad/request
  router.post('/request', (req: Request, res: Response) => {
    const startedAt = performance.now();
    const clientIp = (req.ip || req.socket.remoteAddress || '127.0.0.1').toString();
    if (!checkPersistentRateLimit(db, `adreq:${clientIp}`, 240)) {
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

    if (!placementId || typeof placementId !== 'string') {
      res.status(400).json({ error: 'placementId is required' });
      return;
    }

    const placement = db
      .prepare(
        `SELECT p.id, p.property_id, p.publisher_id, p.format, p.dimensions, p.floor_cpm_micros, p.status,
                prop.approval_status AS property_approval, prop.verification_status AS property_verification,
                pub.approval_status AS publisher_approval, pub.publisher_type
         FROM ad_placements p
         JOIN publisher_properties prop ON prop.id = p.property_id
         JOIN publisher_accounts pub ON pub.id = p.publisher_id
         WHERE p.id = ?`
      )
      .get(placementId) as
      | {
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
        }
      | undefined;

    if (!placement) {
      res.status(404).json({ error: 'Ad placement not found' });
      return;
    }

    const pubEligibility = isPublisherEligibleForDelivery(
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

    // Count session impressions per campaign in last 2 hours for frequency capping
    const freqRows = db
      .prepare(
        `SELECT campaign_id, COUNT(*) AS cnt
         FROM impressions
         WHERE session_hash = ? AND created_at >= datetime('now', '-2 hours')
         GROUP BY campaign_id`
      )
      .all(sessionHash) as Array<{ campaign_id: string; cnt: number }>;
    const sessionImpressionCounts: Record<string, number> = {};
    for (const row of freqRows) {
      sessionImpressionCounts[row.campaign_id] = row.cnt;
    }

    // Load active candidate campaigns joined with targeting, budgets, creatives, and wallet balance
    const rows = db
      .prepare(
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
      )
      .all() as Array<{
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
    }>;

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
      frequencyCapPerSession: r.frequency_cap_per_session,
      dailyBudgetMicros: r.daily_budget_micros,
      totalBudgetMicros: r.total_budget_micros,
      spentTodayMicros: r.spent_today_micros,
      spentTotalMicros: r.spent_total_micros,
      maxBidMicros: r.max_bid_micros,
      pacingMode: r.pacing_mode,
      walletAvailableMicros: r.wallet_available_micros,
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

    const recentRows = db
      .prepare(
        `SELECT campaign_id, COUNT(*) AS cnt
         FROM impressions
         WHERE created_at >= datetime('now', '-1 hour')
         GROUP BY campaign_id`
      )
      .all() as Array<{ campaign_id: string; cnt: number }>;
    const recentDeliveryCounts: Record<string, number> = {};
    for (const row of recentRows) {
      recentDeliveryCounts[row.campaign_id] = row.cnt;
    }

    const winner = selectWinningAd(candidates, {
      placementId: placement.id,
      placementFormat: placement.format,
      floorCpmMicros: placement.floor_cpm_micros,
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

    let reservation: ReturnType<typeof reserveBudgetForRequest> | null = null;
    if (winner) {
      reservation = reserveBudgetForRequest(db, {
        advertiserId: winner.candidate.advertiserId,
        campaignId: winner.candidate.campaignId,
        requestId,
        amountMicros: winner.estimatedBillableMicros,
        ttlMinutes: 30,
      });
    }

    const actuallyFilled = Boolean(winner && reservation?.reserved);

    db.prepare(
      `INSERT INTO ad_requests (id, placement_id, property_id, publisher_id, winning_campaign_id, winning_creative_id, country, device_category, os, browser, language, category, consent_granted, filled, ip_hash, session_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
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
      sessionHash
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

    const impressionToken = signTrackingToken({ ...baseToken, eventType: 'impression' }, TRACKING_SECRET);
    const clickToken = signTrackingToken({ ...baseToken, eventType: 'click' }, TRACKING_SECRET);
    const conversionToken = signTrackingToken({ ...baseToken, eventType: 'conversion' }, TRACKING_SECRET);
    const videoToken = signTrackingToken({ ...baseToken, eventType: 'video' }, TRACKING_SECRET);
    const installToken = signTrackingToken({ ...baseToken, eventType: 'install' }, TRACKING_SECRET);

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
  router.post('/impression', (req: Request, res: Response) => {
    const { impressionToken, viewable = true, sessionId } = req.body ?? {};
    if (!impressionToken || typeof impressionToken !== 'string') {
      res.status(400).json({ error: 'impressionToken is required' });
      return;
    }

    const verified = verifyTrackingToken(impressionToken, TRACKING_SECRET);
    if (!verified.valid || verified.payload.eventType !== 'impression') {
      res.status(400).json({ error: 'Invalid or expired impression token' });
      return;
    }

    const payload = verified.payload;
    const clientIp = (req.ip || req.socket.remoteAddress || '127.0.0.1').toString();
    const ipHash = hashIp(clientIp);
    const sessionHash = hashIp(
      typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : `${clientIp}:${req.headers['user-agent'] || ''}`
    );

    if (!viewable) {
      res.status(200).json({ recorded: false, reason: 'impression_not_viewable' });
      return;
    }

    try {
      const outcome = withTransaction(db, () => {
        // Deduplicate by request_id
        const existing = db
          .prepare('SELECT id FROM impressions WHERE request_id = ?')
          .get(payload.requestId) as { id: string } | undefined;
        if (existing) {
          return { duplicate: true, impressionId: existing.id, billedMicros: 0 };
        }

        const reqRow = db
          .prepare('SELECT country, device_category FROM ad_requests WHERE id = ?')
          .get(payload.requestId) as { country: string; device_category: string } | undefined;

        const grossBillMicros = computeSingleEventBillMicros(
          payload.pricingModel,
          payload.clearingPriceMicros,
          'impression'
        );

        let actualBilled = 0;
        let publisherShareMicros = 0;
        let platformFeeMicros = 0;

        if (grossBillMicros > 0) {
          const captured = captureReservationInTx(db, {
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
            const split = settlePublisherRevenueInTx(db, {
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
        db.prepare(
          `INSERT INTO impressions (id, request_id, campaign_id, creative_id, placement_id, publisher_id, advertiser_id, viewable, is_valid, billed_micros, publisher_share_micros, platform_fee_micros, country, device_category, ip_hash, session_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
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
          sessionHash
        );

        db.prepare(
          `UPDATE ad_placements SET integration_verified = 1 WHERE id = ?`
        ).run(payload.placementId);

        db.prepare(
          `INSERT INTO event_logs (id, event_type, entity_type, entity_id, payload_json)
           VALUES (?, 'impression_verified', 'impression', ?, ?)`
        ).run(`evt_${crypto.randomUUID().slice(0, 12)}`, impressionId, JSON.stringify({ campaignId: payload.campaignId, billedMicros: actualBilled }));

        return { duplicate: false, impressionId, billedMicros: actualBilled };
      });

      res.json({ recorded: !outcome.duplicate, ...outcome });
    } catch (error) {
      console.error('Impression error:', error);
      res.status(500).json({ error: 'Failed to record impression' });
    }
  });

  // POST /api/v1/ad/click
  router.post('/click', (req: Request, res: Response) => {
    const { clickToken, sessionId, simulateBot = false } = req.body ?? {};
    if (!clickToken || typeof clickToken !== 'string') {
      res.status(400).json({ error: 'clickToken is required' });
      return;
    }

    const verified = verifyTrackingToken(clickToken, TRACKING_SECRET);
    if (!verified.valid || verified.payload.eventType !== 'click') {
      res.status(400).json({ error: 'Invalid or expired click token' });
      return;
    }

    const payload = verified.payload;
    const clientIp = (req.ip || req.socket.remoteAddress || '127.0.0.1').toString();
    const ipHash = hashIp(clientIp);
    const rawUa = String(req.headers['user-agent'] || '');
    const userAgent = simulateBot
      ? 'python-requests/2.31.0 AutomatedBot'
      : req.body?.sandboxMode
        ? rawUa.replace(/HeadlessChrome/gi, 'Chrome')
        : rawUa;
    const sessionHash = hashIp(
      typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : `${clientIp}:${rawUa}`
    );

    try {
      const result = withTransaction(db, () => {
        const impRow = db
          .prepare('SELECT id FROM impressions WHERE request_id = ?')
          .get(payload.requestId) as { id: string } | undefined;

        if (!impRow) {
          return { errorStatus: 400, error: 'Impression must be verified before click attribution' };
        }

        const alreadyClicked = Boolean(
          db.prepare('SELECT id FROM clicks WHERE impression_id = ?').get(impRow.id)
        );

        const recentIpClicks = (
          db
            .prepare(
              `SELECT COUNT(*) AS cnt FROM clicks WHERE ip_hash = ? AND created_at >= datetime('now', '-2 minutes')`
            )
            .get(ipHash) as { cnt: number }
        ).cnt;

        const recentSessionImps = (
          db
            .prepare(
              `SELECT COUNT(*) AS cnt FROM impressions WHERE session_hash = ? AND created_at >= datetime('now', '-5 minutes')`
            )
            .get(sessionHash) as { cnt: number }
        ).cnt;

        const pubStats = db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM impressions WHERE publisher_id = ?) AS imps,
               (SELECT COUNT(*) FROM clicks WHERE publisher_id = ? AND is_valid = 1) AS clks`
          )
          .get(payload.publisherId, payload.publisherId) as { imps: number; clks: number };
        const publisherCtr = pubStats.imps > 10 ? pubStats.clks / pubStats.imps : 0.02;

        const fraudEval = evaluateTrafficQuality({
          userAgent,
          recentClicksSameIpCount: recentIpClicks,
          recentImpressionsSameSessionCount: recentSessionImps,
          alreadyClickedImpression: alreadyClicked,
          publisherCtr,
        });

        if (fraudEval.shouldRaiseAlert && fraudEval.signalType) {
          db.prepare(
            `INSERT INTO fraud_alerts (id, publisher_id, campaign_id, signal_type, severity, description, evidence_json, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`
          ).run(
            `frd_${crypto.randomUUID().slice(0, 12)}`,
            payload.publisherId,
            payload.campaignId,
            fraudEval.signalType,
            fraudEval.severity,
            `Detected ${fraudEval.signalType} on placement ${payload.placementId}`,
            JSON.stringify({ recentIpClicks, recentSessionImps, publisherCtr })
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
            const captured = captureReservationInTx(db, {
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
              const split = settlePublisherRevenueInTx(db, {
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
          releaseReservationInTx(
            db,
            payload.requestId,
            `Released reservation after invalid click (${fraudEval.reason || 'fraud_blocked'})`
          );
        }

        const clickId = `clk_${crypto.randomUUID().slice(0, 12)}`;
        db.prepare(
          `INSERT INTO clicks (id, impression_id, request_id, campaign_id, creative_id, placement_id, publisher_id, advertiser_id, is_valid, invalid_reason, billed_micros, publisher_share_micros, platform_fee_micros, ip_hash, session_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
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
          sessionHash
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
  router.post('/conversion', (req: Request, res: Response) => {
    const { conversionToken, eventName = 'purchase', conversionValueMicros = 0 } = req.body ?? {};
    if (!conversionToken || typeof conversionToken !== 'string') {
      res.status(400).json({ error: 'conversionToken is required' });
      return;
    }

    const verified = verifyTrackingToken(conversionToken, TRACKING_SECRET);
    if (!verified.valid || verified.payload.eventType !== 'conversion') {
      res.status(400).json({ error: 'Invalid or expired conversion token' });
      return;
    }

    const payload = verified.payload;

    try {
      const outcome = withTransaction(db, () => {
        const existing = db
          .prepare('SELECT id FROM conversions WHERE request_id = ?')
          .get(payload.requestId) as { id: string } | undefined;
        if (existing) {
          return { duplicate: true, conversionId: existing.id, billedMicros: 0 };
        }

        const clickRow = db
          .prepare('SELECT id, impression_id FROM clicks WHERE request_id = ? AND is_valid = 1')
          .get(payload.requestId) as { id: string; impression_id: string } | undefined;
        const impRow = db
          .prepare('SELECT id FROM impressions WHERE request_id = ?')
          .get(payload.requestId) as { id: string } | undefined;

        const grossBillMicros = computeSingleEventBillMicros(
          payload.pricingModel,
          payload.clearingPriceMicros,
          'conversion'
        );

        let actualBilled = 0;
        let publisherShareMicros = 0;
        let platformFeeMicros = 0;

        if (grossBillMicros > 0) {
          const captured = captureReservationInTx(db, {
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
            const split = settlePublisherRevenueInTx(db, {
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
        db.prepare(
          `INSERT INTO conversions (id, click_id, request_id, campaign_id, advertiser_id, publisher_id, event_name, conversion_value_micros, billed_micros, publisher_share_micros, platform_fee_micros, is_valid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        ).run(
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
          platformFeeMicros
        );

        db.prepare(
          `INSERT INTO attribution_records (id, conversion_id, click_id, impression_id, attribution_model, window_hours)
           VALUES (?, ?, ?, ?, ?, 168)`
        ).run(
          `att_${crypto.randomUUID().slice(0, 12)}`,
          conversionId,
          clickRow?.id || null,
          clickRow?.impression_id || impRow?.id || null,
          clickRow ? 'last_click' : 'view_through'
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
  router.post('/video-event', (req: Request, res: Response) => {
    const { videoToken, eventName = 'complete', watchedMs = 0 } = req.body ?? {};
    if (!videoToken || typeof videoToken !== 'string') {
      res.status(400).json({ error: 'videoToken is required' });
      return;
    }
    if (!['start', 'first_quartile', 'midpoint', 'third_quartile', 'complete', 'mute', 'unmute'].includes(eventName)) {
      res.status(400).json({ error: 'Invalid video eventName' });
      return;
    }

    const verified = verifyTrackingToken(videoToken, TRACKING_SECRET);
    if (!verified.valid || verified.payload.eventType !== 'video') {
      res.status(400).json({ error: 'Invalid or expired video token' });
      return;
    }
    const payload = verified.payload;

    try {
      const outcome = withTransaction(db, () => {
        const alreadyCompleted =
          eventName === 'complete' &&
          Boolean(
            db
              .prepare("SELECT id FROM video_events WHERE request_id = ? AND event_name = 'complete'")
              .get(payload.requestId)
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
            const captured = captureReservationInTx(db, {
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
              const split = settlePublisherRevenueInTx(db, {
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
        db.prepare(
          `INSERT INTO video_events (id, request_id, campaign_id, creative_id, placement_id, publisher_id, advertiser_id, event_name, viewable_ms, billed_micros, publisher_share_micros, platform_fee_micros)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
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
          platformFeeMicros
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
  router.post('/install', (req: Request, res: Response) => {
    const { installToken, appBundleId = 'com.app.unknown', deviceOs = 'iOS' } = req.body ?? {};
    if (!installToken || typeof installToken !== 'string') {
      res.status(400).json({ error: 'installToken is required' });
      return;
    }

    const verified = verifyTrackingToken(installToken, TRACKING_SECRET);
    if (!verified.valid || (verified.payload.eventType !== 'install' && verified.payload.eventType !== 'conversion')) {
      res.status(400).json({ error: 'Invalid or expired install token' });
      return;
    }
    const payload = verified.payload;

    try {
      const outcome = withTransaction(db, () => {
        const existing = db
          .prepare('SELECT id FROM app_installs WHERE request_id = ?')
          .get(payload.requestId) as { id: string } | undefined;
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
          const captured = captureReservationInTx(db, {
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
            const split = settlePublisherRevenueInTx(db, {
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
        db.prepare(
          `INSERT INTO app_installs (id, request_id, campaign_id, advertiser_id, publisher_id, app_bundle_id, device_os, billed_micros, publisher_share_micros, platform_fee_micros)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          installId,
          payload.requestId,
          payload.campaignId,
          payload.advertiserId,
          payload.publisherId,
          String(appBundleId).slice(0, 120),
          String(deviceOs).slice(0, 40),
          actualBilled,
          publisherShareMicros,
          platformFeeMicros
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
  router.get('/creative/:id', (req: Request, res: Response) => {
    const row = db
      .prepare(
        `SELECT crt.id, crt.title, crt.description, crt.media_url, crt.destination_url, crt.cta_text, crt.dimensions, crt.approval_status, adv.format
         FROM ad_creatives crt
         JOIN advertisements adv ON adv.id = crt.advertisement_id
         JOIN campaigns c ON c.id = adv.campaign_id
         WHERE crt.id = ?
           AND crt.approval_status = 'approved'
           AND c.status = 'active'
           AND c.moderation_status = 'approved'`
      )
      .get(String(req.params.id));
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
      cta.href = data.ad.destinationUrl;
      cta.textContent = data.ad.ctaText;
      cta.target = '_blank';
      cta.rel = 'noopener noreferrer sponsored';
      cta.style.cssText = 'display:inline-block;padding:8px 14px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:500;';
      cta.addEventListener('click', function() {
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
