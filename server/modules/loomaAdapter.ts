import crypto from 'node:crypto';
import { getTrackingSecret, hashIp, hashPassword, signSessionToken } from '../auth';
import { type DbClient, withTransaction } from '../db/postgres';
import {
  CandidateCampaign,
  CreativeFormat,
  PlacementFormat,
  PricingModel,
  selectWinningAds,
  signTrackingToken,
} from '../engine';
import { reserveBudgetForRequest, type ReserveBudgetResult } from './budgetReservations';
import { isPublisherEligibleForDelivery } from './featureFlags';

let fallbackLoomaSsoSecret: string | null = null;

export type LoomaMembershipRole = 'owner' | 'admin' | 'ad_manager' | 'viewer';

export interface LoomaSsoAssertionPayload {
  iss: 'looma-core';
  aud: 'looma-ads';
  jti: string;
  loomaUserId: string;
  email: string;
  fullName: string;
  businessId: string;
  businessName: string;
  membershipRole: LoomaMembershipRole;
  verifiedMembership: boolean;
  country?: string;
  iat: number;
  exp: number;
}

export interface LoomaFeedSlotRequest {
  slotIndex: number;
  placementId: string;
}

export interface LoomaFeedAdDecision {
  slotIndex: number;
  placementId: string;
  filled: boolean;
  requestId: string | null;
  reason?: string;
  reservationId?: string | null;
  reservedMicros?: number;
  auction?: {
    model: 'first_price_controlled_rotation';
    effectiveCpmMicros: number;
    auctionScore: number;
    rotationFactor: number;
  };
  ad: {
    campaignId: string;
    campaignName: string;
    creativeId: string;
    format: CreativeFormat;
    pricingModel: PricingModel;
    title: string;
    description: string;
    mediaUrl: string;
    destinationUrl: string;
    ctaText: string;
    dimensions: string;
    sponsoredLabel: string;
  } | null;
  tracking?: {
    impressionToken: string;
    clickToken: string;
    conversionToken: string;
    videoToken: string;
    installToken: string;
  };
}

export function getLoomaSsoSecret(): string {
  const configured = process.env.LOOMA_SSO_SHARED_SECRET?.trim();
  if (configured) return configured;
  if (!fallbackLoomaSsoSecret) {
    fallbackLoomaSsoSecret = crypto.randomBytes(32).toString('hex');
  }
  return fallbackLoomaSsoSecret;
}

export function verifyLoomaAdapterAuth(providedKey: string | undefined): boolean {
  const configured = (process.env.LOOMA_ADAPTER_KEY || '').trim();
  if (!configured || !providedKey) {
    return false;
  }
  const a = Buffer.from(providedKey.trim(), 'utf8');
  const b = Buffer.from(configured, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function signLoomaSsoAssertion(
  payload: Omit<LoomaSsoAssertionPayload, 'iss' | 'aud' | 'jti' | 'iat' | 'exp'> & {
    jti?: string;
    ttlSeconds?: number;
  },
  secret = getLoomaSsoSecret()
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const full: LoomaSsoAssertionPayload = {
    iss: 'looma-core',
    aud: 'looma-ads',
    jti: payload.jti || `jti_${crypto.randomUUID()}`,
    loomaUserId: payload.loomaUserId,
    email: payload.email.trim().toLowerCase(),
    fullName: payload.fullName.trim(),
    businessId: payload.businessId.trim(),
    businessName: payload.businessName.trim(),
    membershipRole: payload.membershipRole,
    verifiedMembership: payload.verifiedMembership,
    country: payload.country || 'US',
    iat: nowSec,
    exp: nowSec + Math.max(30, Math.min(300, payload.ttlSeconds ?? 180)),
  };
  const encoded = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyLoomaSsoAssertion(
  assertionToken: string,
  secret = getLoomaSsoSecret(),
  nowSec = Math.floor(Date.now() / 1000)
): { valid: true; payload: LoomaSsoAssertionPayload } | { valid: false; reason: string } {
  const parts = String(assertionToken || '').split('.');
  if (parts.length !== 2) {
    return { valid: false, reason: 'malformed_sso_assertion' };
  }
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: 'invalid_sso_signature' };
  }

  let parsed: LoomaSsoAssertionPayload;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as LoomaSsoAssertionPayload;
  } catch {
    return { valid: false, reason: 'invalid_sso_payload' };
  }

  if (parsed.iss !== 'looma-core' || parsed.aud !== 'looma-ads') {
    return { valid: false, reason: 'invalid_sso_issuer_or_audience' };
  }
  if (!parsed.exp || nowSec > parsed.exp) {
    return { valid: false, reason: 'sso_assertion_expired' };
  }
  if (!parsed.jti || !parsed.loomaUserId || !parsed.businessId || !parsed.email) {
    return { valid: false, reason: 'missing_required_sso_claims' };
  }
  if (!parsed.verifiedMembership) {
    return { valid: false, reason: 'business_membership_not_verified' };
  }
  if (!['owner', 'admin', 'ad_manager'].includes(parsed.membershipRole)) {
    return { valid: false, reason: 'insufficient_business_membership_role' };
  }

  return { valid: true, payload: parsed };
}

export async function exchangeLoomaSsoSession(
  db: DbClient,
  assertionToken: string,
  secret = getLoomaSsoSecret()
): Promise<
  | {
      ok: true;
      token: string;
      user: { id: string; email: string; fullName: string; role: 'advertiser' };
      identityLink: {
        loomaUserId: string;
        loomaBusinessId: string;
        membershipRole: LoomaMembershipRole;
        advertiserId: string;
      };
    }
  | { ok: false; status: number; error: string }
> {
  const verified = verifyLoomaSsoAssertion(assertionToken, secret);
  if (!verified.valid) {
    const status =
      verified.reason === 'business_membership_not_verified' ||
      verified.reason === 'insufficient_business_membership_role'
        ? 403
        : 401;
    return { ok: false, status, error: verified.reason };
  }

  const claims = verified.payload;

  return withTransaction(db, async (tx) => {
    const replayed = await tx.queryOne('SELECT jti FROM looma_sso_nonces WHERE jti = ?', [claims.jti]);
    if (replayed) {
      return { ok: false as const, status: 401, error: 'sso_assertion_replayed' };
    }

    const expIso = new Date(claims.exp * 1000).toISOString();
    await tx.execute(
      `INSERT INTO looma_sso_nonces (jti, looma_user_id, expires_at)
       VALUES (?, ?, ?)`,
      [claims.jti, claims.loomaUserId, expIso]
    );

    const existingLink = await tx.queryOne<{
      id: string;
      user_id: string;
      advertiser_id: string;
      email: string;
      full_name: string;
      status: string;
    }>(
      `SELECT l.id, l.user_id, l.advertiser_id, u.email, u.full_name, u.status
       FROM looma_identity_links l
       JOIN users u ON u.id = l.user_id
       WHERE l.looma_user_id = ? AND l.looma_business_id = ?`,
      [claims.loomaUserId, claims.businessId]
    );

    if (existingLink) {
      if (existingLink.status !== 'active') {
        return { ok: false as const, status: 403, error: 'linked_account_suspended' };
      }
      await tx.execute(
        `UPDATE looma_identity_links
         SET membership_role = ?, last_verified_at = ?
         WHERE id = ?`,
        [claims.membershipRole, new Date().toISOString(), existingLink.id]
      );

      const token = signSessionToken({
        userId: existingLink.user_id,
        email: existingLink.email,
        role: 'advertiser',
      });
      return {
        ok: true as const,
        token,
        user: {
          id: existingLink.user_id,
          email: existingLink.email,
          fullName: existingLink.full_name,
          role: 'advertiser' as const,
        },
        identityLink: {
          loomaUserId: claims.loomaUserId,
          loomaBusinessId: claims.businessId,
          membershipRole: claims.membershipRole,
          advertiserId: existingLink.advertiser_id,
        },
      };
    }

    const userRow = await tx.queryOne<{
      id: string;
      email: string;
      full_name: string;
      status: string;
      role_id: string;
    }>('SELECT id, email, full_name, status, role_id FROM users WHERE email = ?', [claims.email]);

    let userId: string;
    let advertiserId: string;

    if (userRow) {
      if (userRow.role_id === 'role_admin') {
        return { ok: false as const, status: 403, error: 'admin_sso_not_allowed' };
      }
      if (userRow.status !== 'active') {
        return { ok: false as const, status: 403, error: 'linked_account_suspended' };
      }
      userId = userRow.id;
      const existingAdv = await tx.queryOne<{ id: string }>(
        'SELECT id FROM advertiser_accounts WHERE user_id = ?',
        [userId]
      );
      if (existingAdv) {
        advertiserId = existingAdv.id;
      } else {
        advertiserId = `adv_${crypto.randomUUID().slice(0, 10)}`;
        await tx.execute(
          `INSERT INTO advertiser_accounts (id, user_id, company_name, country, currency, verification_status, account_status, billing_email)
           VALUES (?, ?, ?, ?, 'USD', 'verified', 'active', ?)`,
          [advertiserId, userId, claims.businessName, claims.country || 'US', claims.email]
        );
        await tx.execute(
          `INSERT INTO advertiser_wallets (id, advertiser_id, available_micros, reserved_micros, lifetime_deposited_micros, lifetime_spent_micros, currency)
           VALUES (?, ?, 0, 0, 0, 0, 'USD')`,
          [`wal_${crypto.randomUUID().slice(0, 10)}`, advertiserId]
        );
      }
    } else {
      userId = `usr_sso_${crypto.randomUUID().slice(0, 10)}`;
      advertiserId = `adv_${crypto.randomUUID().slice(0, 10)}`;
      await tx.execute(
        `INSERT INTO users (id, email, full_name, password_hash, role_id, status, email_verified)
         VALUES (?, ?, ?, ?, 'role_advertiser', 'active', 1)`,
        [userId, claims.email, claims.fullName, hashPassword(crypto.randomBytes(24).toString('hex'))]
      );

      await tx.execute(
        `INSERT INTO advertiser_accounts (id, user_id, company_name, country, currency, verification_status, account_status, billing_email)
         VALUES (?, ?, ?, ?, 'USD', 'verified', 'active', ?)`,
        [advertiserId, userId, claims.businessName, claims.country || 'US', claims.email]
      );

      await tx.execute(
        `INSERT INTO advertiser_wallets (id, advertiser_id, available_micros, reserved_micros, lifetime_deposited_micros, lifetime_spent_micros, currency)
         VALUES (?, ?, 0, 0, 0, 0, 'USD')`,
        [`wal_${crypto.randomUUID().slice(0, 10)}`, advertiserId]
      );
    }

    await tx.execute(
      `INSERT INTO looma_identity_links (id, looma_user_id, looma_business_id, membership_role, user_id, advertiser_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`lnk_${crypto.randomUUID().slice(0, 10)}`, claims.loomaUserId, claims.businessId, claims.membershipRole, userId, advertiserId]
    );

    const token = signSessionToken({ userId, email: claims.email, role: 'advertiser' });
    return {
      ok: true as const,
      token,
      user: {
        id: userId,
        email: claims.email,
        fullName: claims.fullName,
        role: 'advertiser' as const,
      },
      identityLink: {
        loomaUserId: claims.loomaUserId,
        loomaBusinessId: claims.businessId,
        membershipRole: claims.membershipRole,
        advertiserId,
      },
    };
  });
}

function parseJsonArray(raw: string, fallback: string[]): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : fallback;
  } catch {
    return fallback;
  }
}

export async function selectLoomaFeedAds(
  db: DbClient,
  params: {
    slots: LoomaFeedSlotRequest[];
    country: string;
    language: string;
    deviceCategory: string;
    os: string;
    browser: string;
    feedCategory: string;
    consentGranted: boolean;
    sessionId: string;
    clientIp: string;
    userAgent: string;
  }
): Promise<{
  contractVersion: string;
  publisherMode: 'first_party_adapter';
  fallbackBehavior: 'skip_slot_continue_feed';
  decisions: LoomaFeedAdDecision[];
}> {
  const ipHash = hashIp(params.clientIp);
  const sessionHash = hashIp(params.sessionId || `${params.clientIp}:${params.userAgent}`);
  const twoHoursAgoIso = new Date(Date.now() - 2 * 3600_000).toISOString();
  const oneHourAgoIso = new Date(Date.now() - 3600_000).toISOString();

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

  const boundedSlots = params.slots.slice(0, 10);
  const excludedCampaignIds = new Set<string>();
  const decisions: LoomaFeedAdDecision[] = [];

  for (const slot of boundedSlots) {
    const placement = await db.queryOne<{
      id: string;
      property_id: string;
      publisher_id: string;
      format: PlacementFormat;
      dimensions: string;
      floor_cpm_micros: number;
      status: string;
      property_approval: string;
      publisher_approval: string;
      publisher_type: string;
    }>(
      `SELECT p.id, p.property_id, p.publisher_id, p.format, p.dimensions, p.floor_cpm_micros, p.status,
              prop.approval_status AS property_approval,
              pub.approval_status AS publisher_approval, pub.publisher_type
       FROM ad_placements p
       JOIN publisher_properties prop ON prop.id = p.property_id
       JOIN publisher_accounts pub ON pub.id = p.publisher_id
       WHERE p.id = ?`,
      [slot.placementId]
    );

    if (!placement) {
      decisions.push({
        slotIndex: slot.slotIndex,
        placementId: slot.placementId,
        filled: false,
        requestId: null,
        reason: 'placement_not_found',
        ad: null,
      });
      continue;
    }

    const pubEligibility = await isPublisherEligibleForDelivery(
      db,
      placement.publisher_type || 'first_party',
      placement.publisher_approval
    );
    if (!pubEligibility.eligible || placement.status !== 'active' || placement.property_approval !== 'approved') {
      decisions.push({
        slotIndex: slot.slotIndex,
        placementId: slot.placementId,
        filled: false,
        requestId: null,
        reason: pubEligibility.reason || 'placement_not_eligible',
        ad: null,
      });
      continue;
    }

    const rows = await db.query<Record<string, any>>(
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
              crt.tracking_params, crt.dimensions, crt.approval_status AS creative_approval_status
       FROM campaigns c
       JOIN advertiser_accounts adv_acc ON adv_acc.id = c.advertiser_id
       JOIN advertiser_wallets w ON w.advertiser_id = c.advertiser_id
       JOIN campaign_budgets b ON b.campaign_id = c.id
       JOIN campaign_targeting t ON t.campaign_id = c.id
       JOIN advertisements adv ON adv.campaign_id = c.id AND adv.status = 'active'
       JOIN ad_creatives crt ON crt.advertisement_id = adv.id
       WHERE c.status = 'active' AND c.moderation_status = 'approved' AND adv_acc.account_status = 'active'`
    );

    const candidates: CandidateCampaign[] = rows
      .filter((r) => !excludedCampaignIds.has(r.campaign_id))
      .map((r) => ({
        campaignId: r.campaign_id,
        advertiserId: r.advertiser_id,
        campaignName: r.campaign_name,
        pricingModel: r.pricing_model as PricingModel,
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
          format: r.creative_format as CreativeFormat,
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

    const winners = selectWinningAds(
      candidates,
      {
        placementId: placement.id,
        placementFormat: placement.format,
        floorCpmMicros: Number(placement.floor_cpm_micros),
        country: params.country,
        language: params.language,
        deviceCategory: params.deviceCategory,
        os: params.os,
        browser: params.browser,
        category: params.feedCategory,
        consentGranted: params.consentGranted,
        sessionImpressionCounts,
        recentDeliveryCounts,
        nowIso: new Date().toISOString(),
      },
      1
    );

    const requestId = `req_${crypto.randomUUID().slice(0, 12)}`;
    const winner = winners[0] ?? null;

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
      `INSERT INTO ad_requests
         (id, placement_id, property_id, publisher_id, winning_campaign_id, winning_creative_id, country, device_category, os, browser, language, category, consent_granted, filled, ip_hash, session_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        requestId,
        placement.id,
        placement.property_id,
        placement.publisher_id,
        actuallyFilled && winner ? winner.candidate.campaignId : null,
        actuallyFilled && winner ? winner.candidate.creative.id : null,
        params.country,
        params.deviceCategory,
        params.os,
        params.browser,
        params.language,
        params.feedCategory,
        params.consentGranted ? 1 : 0,
        actuallyFilled ? 1 : 0,
        ipHash,
        sessionHash,
      ]
    );

    if (!actuallyFilled || !winner) {
      decisions.push({
        slotIndex: slot.slotIndex,
        placementId: placement.id,
        filled: false,
        requestId,
        reason: reservation && !reservation.reserved ? reservation.reason : 'no_eligible_campaign_matched',
        ad: null,
      });
      continue;
    }

    excludedCampaignIds.add(winner.candidate.campaignId);
    sessionImpressionCounts[winner.candidate.campaignId] =
      (sessionImpressionCounts[winner.candidate.campaignId] ?? 0) + 1;

    const exp = Date.now() + 1000 * 60 * 30;
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

    const sep = winner.candidate.creative.destinationUrl.includes('?') ? '&' : '?';
    const fullDestinationUrl = winner.candidate.creative.trackingParams
      ? `${winner.candidate.creative.destinationUrl}${sep}${winner.candidate.creative.trackingParams}`
      : winner.candidate.creative.destinationUrl;

    decisions.push({
      slotIndex: slot.slotIndex,
      placementId: placement.id,
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
        sponsoredLabel: 'Sponsored · Looma Ads',
      },
      tracking: {
        impressionToken: signTrackingToken({ ...baseToken, eventType: 'impression' }, getTrackingSecret()),
        clickToken: signTrackingToken({ ...baseToken, eventType: 'click' }, getTrackingSecret()),
        conversionToken: signTrackingToken({ ...baseToken, eventType: 'conversion' }, getTrackingSecret()),
        videoToken: signTrackingToken({ ...baseToken, eventType: 'video' }, getTrackingSecret()),
        installToken: signTrackingToken({ ...baseToken, eventType: 'install' }, getTrackingSecret()),
      },
    });
  }

  return {
    contractVersion: '2026-11-v1',
    publisherMode: 'first_party_adapter',
    fallbackBehavior: 'skip_slot_continue_feed',
    decisions,
  };
}
