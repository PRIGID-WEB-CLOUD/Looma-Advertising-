import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { authenticateBearerToken } from '../auth';
import { checkPersistentRateLimit } from '../jobs';
import { getFeatureFlags } from '../modules/featureFlags';
import {
  exchangeLoomaSsoSession,
  selectLoomaFeedAds,
  signLoomaSsoAssertion,
  verifyLoomaAdapterAuth,
  type LoomaFeedSlotRequest,
} from '../modules/loomaAdapter';
import { recordAdDeliveryMetric, recordSsoMetric } from '../modules/monitoring';

export function createLoomaIntegrationRouter(db: DatabaseSync): Router {
  const router = Router();

  // GET /api/v1/looma/contract — Public Looma publisher integration contract metadata
  router.get('/contract', (_req: Request, res: Response) => {
    const loomaPublisher = db
      .prepare(
        `SELECT id, organization_name, publisher_type, approval_status
         FROM publisher_accounts
         WHERE publisher_type = 'first_party'
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get() as
      | { id: string; organization_name: string; publisher_type: string; approval_status: string }
      | undefined;

    const placements = loomaPublisher
      ? (db
          .prepare(
            `SELECT ap.id, ap.name, ap.format, ap.dimensions, ap.floor_cpm_micros, ap.status,
                    pp.name AS property_name, pp.domain_or_bundle
             FROM ad_placements ap
             JOIN publisher_properties pp ON pp.id = ap.property_id
             WHERE ap.publisher_id = ? AND ap.status = 'active'
             ORDER BY ap.id ASC`
          )
          .all(loomaPublisher.id) as Array<Record<string, unknown>>)
      : [];

    res.json({
      contractVersion: '2026-11-v1',
      publisher: loomaPublisher || null,
      placements,
      featureFlags: getFeatureFlags(db),
      endpoints: {
        feedAdSelection: '/api/v1/looma/feed/ads',
        ssoExchange: '/api/v1/looma/sso/exchange',
        impressionTracking: '/api/v1/ad/impression',
        clickTracking: '/api/v1/ad/click',
        conversionTracking: '/api/v1/ad/conversion',
      },
      sla: {
        recommendedClientTimeoutMs: 450,
        fallbackBehavior: 'skip_slot_continue_feed',
        renderingOwnership: 'looma_client',
        billingOwnership: 'looma_ads_server',
      },
    });
  });

  // POST /api/v1/looma/sso/demo-assertion — Restricted to trusted Looma backend callers presenting LOOMA_ADAPTER_KEY
  router.post('/sso/demo-assertion', (req: Request, res: Response) => {
    if (!process.env.LOOMA_ADAPTER_KEY?.trim()) {
      res.status(403).json({ error: 'Looma SSO assertion minting requires LOOMA_ADAPTER_KEY to be configured' });
      return;
    }
    if (!verifyLoomaAdapterAuth(req.header('x-looma-adapter-key'))) {
      res.status(401).json({ error: 'Unauthorized Looma integration adapter key' });
      return;
    }

    const {
      loomaUserId = 'looma_usr_atlas_01',
      email = 'maya.lin@atlascommerce.io',
      fullName = 'Maya Lin',
      businessId = 'looma_biz_atlas_01',
      businessName = 'Atlas Commerce Global',
      membershipRole = 'owner',
      verifiedMembership = true,
      country = 'US',
    } = req.body ?? {};

    const assertion = signLoomaSsoAssertion({
      loomaUserId: String(loomaUserId),
      email: String(email),
      fullName: String(fullName),
      businessId: String(businessId),
      businessName: String(businessName),
      membershipRole: ['owner', 'admin', 'ad_manager', 'viewer'].includes(String(membershipRole))
        ? (String(membershipRole) as 'owner' | 'admin' | 'ad_manager' | 'viewer')
        : 'owner',
      verifiedMembership: Boolean(verifiedMembership),
      country: String(country),
    });

    res.json({ assertion, issuer: 'looma-core', audience: 'looma-ads', expiresInSeconds: 180 });
  });

  // POST /api/v1/looma/sso/exchange — Cryptographically verified Looma SSO + business membership exchange
  router.post('/sso/exchange', (req: Request, res: Response) => {
    const assertion = String(req.body?.assertion || '').trim();
    if (!assertion) {
      recordSsoMetric(false);
      res.status(400).json({ error: 'Signed Looma SSO assertion is required' });
      return;
    }

    const result = exchangeLoomaSsoSession(db, assertion);
    if (!result.ok) {
      recordSsoMetric(false);
      res.status(result.status).json({ error: result.error });
      return;
    }

    recordSsoMetric(true);
    res.json({
      token: result.token,
      user: result.user,
      identityLink: result.identityLink,
      ssoProvider: 'looma-core',
    });
  });

  // POST /api/v1/looma/feed/ads — Multi-slot Looma Feed Ad Selection Adapter (requires adapter key or publisher/admin session)
  router.post('/feed/ads', (req: Request, res: Response) => {
    const startedAt = performance.now();
    const hasAdapterKey = verifyLoomaAdapterAuth(req.header('x-looma-adapter-key'));
    if (!hasAdapterKey) {
      const authResult = authenticateBearerToken(db, req.headers.authorization);
      if (!authResult.ok || !['publisher', 'admin'].includes(authResult.session.role)) {
        res.status(401).json({ error: 'Unauthorized: provide a valid Looma adapter key or sign in as a publisher/admin' });
        return;
      }
    }

    const clientIp = (req.ip || req.socket.remoteAddress || '127.0.0.1').toString();
    if (!checkPersistentRateLimit(db, `loomafeed:${clientIp}`, 360)) {
      res.status(429).json({ error: 'Rate limit exceeded for Looma feed ad selection' });
      return;
    }

    const {
      slots,
      country = 'US',
      language = 'en',
      deviceCategory = 'mobile',
      os = 'iOS',
      browser = 'LoomaApp',
      feedCategory = 'business_finance',
      consentGranted = true,
      sessionId = '',
    } = req.body ?? {};

    let normalizedSlots: LoomaFeedSlotRequest[] = [];
    if (Array.isArray(slots) && slots.length > 0) {
      normalizedSlots = slots
        .slice(0, 10)
        .map((s: Record<string, unknown>, idx: number) => ({
          slotIndex: Number.isFinite(Number(s?.slotIndex)) ? Number(s.slotIndex) : idx,
          placementId: String(s?.placementId || '').trim(),
        }))
        .filter((s) => s.placementId.length > 0);
    } else {
      const defaultPlacements = db
        .prepare(
          `SELECT ap.id
           FROM ad_placements ap
           JOIN publisher_accounts pub ON pub.id = ap.publisher_id
           WHERE pub.publisher_type = 'first_party' AND ap.status = 'active'
           ORDER BY ap.id ASC
           LIMIT 3`
        )
        .all() as Array<{ id: string }>;
      normalizedSlots = defaultPlacements.map((p, idx) => ({
        slotIndex: idx * 4 + 2,
        placementId: p.id,
      }));
    }

    if (normalizedSlots.length === 0) {
      res.status(400).json({ error: 'At least one valid Looma placement slot is required' });
      return;
    }

    const response = selectLoomaFeedAds(db, {
      slots: normalizedSlots,
      country: String(country),
      language: String(language),
      deviceCategory: String(deviceCategory),
      os: String(os),
      browser: String(browser),
      feedCategory: String(feedCategory),
      consentGranted: Boolean(consentGranted),
      sessionId: String(sessionId),
      clientIp,
      userAgent: String(req.headers['user-agent'] || ''),
    });

    const elapsedMs = performance.now() - startedAt;
    const anyFilled = response.decisions.some((d) => d.filled);
    recordAdDeliveryMetric(anyFilled, elapsedMs, true);

    res.setHeader('X-Looma-Contract-Version', response.contractVersion);
    res.setHeader('X-Looma-Fallback-Policy', response.fallbackBehavior);
    res.json({
      ...response,
      latencyMs: Math.round(elapsedMs * 100) / 100,
    });
  });

  return router;
}
