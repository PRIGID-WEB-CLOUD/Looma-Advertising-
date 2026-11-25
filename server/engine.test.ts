import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CandidateCampaign,
  computeEffectiveCpmMicros,
  computeRotationFactor,
  computeSingleEventBillMicros,
  evaluateTrafficQuality,
  selectWinningAd,
  selectWinningAds,
  signTrackingToken,
  splitRevenueMicros,
  verifyTrackingToken,
} from './engine';
import {
  buildOtpAuthUri,
  convertUsdMicrosToCurrency,
  generateBase32Secret,
  generateTotpCode,
  isPrivateIp,
  isValidPublicDomain,
  scanProhibitedContent,
  validateMediaMagicBytes,
  verifyFlutterwaveSignature,
  verifyPaystackSignature,
  verifyStripeSignature,
  verifyTotpCode,
} from './security';

function makeCandidate(overrides: Partial<CandidateCampaign> = {}): CandidateCampaign {
  return {
    campaignId: 'cmp_test_1',
    advertiserId: 'adv_1',
    campaignName: 'Test Campaign',
    pricingModel: 'CPC',
    biddingStrategy: 'manual',
    status: 'active',
    moderationStatus: 'approved',
    startDate: '2026-01-01',
    endDate: '2027-12-31',
    frequencyCapPerSession: 3,
    dailyBudgetMicros: 100_000_000,
    totalBudgetMicros: 500_000_000,
    spentTodayMicros: 0,
    spentTotalMicros: 0,
    maxBidMicros: 1_500_000,
    pacingMode: 'standard',
    walletAvailableMicros: 100_000_000,
    targeting: {
      countries: ['US', 'GB'],
      languages: ['en'],
      deviceCategories: ['desktop', 'mobile'],
      operatingSystems: ['ALL'],
      browsers: ['ALL'],
      contextualCategories: ['business_finance'],
      consentRequired: true,
    },
    creative: {
      id: 'crt_test_1',
      advertisementId: 'ad_test_1',
      format: 'native',
      title: 'Test Title',
      description: 'Test Description',
      mediaUrl: '/img.jpg',
      destinationUrl: 'https://example.com',
      ctaText: 'Learn More',
      trackingParams: '',
      dimensions: 'responsive',
      approvalStatus: 'approved',
    },
    historicalCtr: 0.02,
    historicalCvr: 0.05,
    qualityScore: 1.0,
    ...overrides,
  };
}

test('selectWinningAd picks highest auctionScore among eligible candidates', () => {
  const lowBid = makeCandidate({ campaignId: 'cmp_low', maxBidMicros: 500_000 });
  const highBid = makeCandidate({ campaignId: 'cmp_high', maxBidMicros: 2_500_000 });

  const winner = selectWinningAd([lowBid, highBid], {
    placementId: 'plc_1',
    placementFormat: 'native',
    floorCpmMicros: 500_000,
    country: 'US',
    language: 'en',
    deviceCategory: 'desktop',
    os: 'macOS',
    browser: 'Chrome',
    category: 'business_finance',
    consentGranted: true,
    sessionImpressionCounts: {},
    nowIso: '2026-11-24T12:00:00Z',
  });

  assert.ok(winner);
  assert.equal(winner.candidate.campaignId, 'cmp_high');
});

test('selectWinningAd prevents overspending when wallet balance is insufficient', () => {
  const brokeCampaign = makeCandidate({
    campaignId: 'cmp_broke',
    walletAvailableMicros: 100_000, // Less than 1_500_000 CPC bid
  });

  const winner = selectWinningAd([brokeCampaign], {
    placementId: 'plc_1',
    placementFormat: 'native',
    floorCpmMicros: 500_000,
    country: 'US',
    language: 'en',
    deviceCategory: 'desktop',
    os: 'macOS',
    browser: 'Chrome',
    category: 'business_finance',
    consentGranted: true,
    sessionImpressionCounts: {},
    nowIso: '2026-11-24T12:00:00Z',
  });

  assert.equal(winner, null);
});

test('selectWinningAd respects GDPR consent requirement and frequency caps', () => {
  const consentCampaign = makeCandidate();

  const noConsent = selectWinningAd([consentCampaign], {
    placementId: 'plc_1',
    placementFormat: 'native',
    floorCpmMicros: 100_000,
    country: 'GB',
    language: 'en',
    deviceCategory: 'mobile',
    os: 'iOS',
    browser: 'Safari',
    category: 'business_finance',
    consentGranted: false,
    sessionImpressionCounts: {},
    nowIso: '2026-11-24T12:00:00Z',
  });
  assert.equal(noConsent, null);

  const capped = selectWinningAd([consentCampaign], {
    placementId: 'plc_1',
    placementFormat: 'native',
    floorCpmMicros: 100_000,
    country: 'GB',
    language: 'en',
    deviceCategory: 'mobile',
    os: 'iOS',
    browser: 'Safari',
    category: 'business_finance',
    consentGranted: true,
    sessionImpressionCounts: { cmp_test_1: 3 },
    nowIso: '2026-11-24T12:00:00Z',
  });
  assert.equal(capped, null);
});

test('integer minor-unit billing and revenue share split preserve exact sum', () => {
  const grossCpc = computeSingleEventBillMicros('CPC', 1_450_000, 'click');
  assert.equal(grossCpc, 1_450_000);

  const grossCpmImp = computeSingleEventBillMicros('CPM', 6_800_000, 'impression');
  assert.equal(grossCpmImp, 6_800);

  const grossCpv = computeSingleEventBillMicros('CPV', 120_000, 'video_complete');
  assert.equal(grossCpv, 120_000);
  assert.equal(computeSingleEventBillMicros('CPV', 120_000, 'impression'), 0);

  const grossCpi = computeSingleEventBillMicros('CPI', 3_250_000, 'install');
  assert.equal(grossCpi, 3_250_000);
  assert.equal(computeSingleEventBillMicros('CPI', 3_250_000, 'click'), 0);

  const { publisherShareMicros, platformFeeMicros } = splitRevenueMicros(1_450_003, 7200);
  assert.equal(publisherShareMicros + platformFeeMicros, 1_450_003);
  assert.equal(publisherShareMicros, 1_044_002);
  assert.equal(platformFeeMicros, 406_001);
});

test('computeEffectiveCpmMicros normalizes CPC and CPM bids', () => {
  const cpm = computeEffectiveCpmMicros(makeCandidate({ pricingModel: 'CPM', maxBidMicros: 5_000_000 }));
  assert.equal(cpm, 5_000_000);

  const cpc = computeEffectiveCpmMicros(makeCandidate({ pricingModel: 'CPC', maxBidMicros: 1_000_000, historicalCtr: 0.02 }));
  assert.equal(cpc, 20_000_000); // $1 CPC * 2% CTR * 1000 = $20 eCPM
});

test('signed tracking tokens detect tampering and expiration', () => {
  const secret = 'test-signing-secret';
  const token = signTrackingToken(
    {
      eventType: 'click',
      requestId: 'req_1',
      campaignId: 'cmp_1',
      creativeId: 'crt_1',
      placementId: 'plc_1',
      publisherId: 'pub_1',
      advertiserId: 'adv_1',
      pricingModel: 'CPC',
      clearingPriceMicros: 1_450_000,
      exp: 2_000_000_000_000,
    },
    secret
  );

  const ok = verifyTrackingToken(token, secret, 1_000_000_000_000);
  assert.equal(ok.valid, true);

  const tampered = `${token.slice(0, -2)}xx`;
  const badSig = verifyTrackingToken(tampered, secret, 1_000_000_000_000);
  assert.equal(badSig.valid, false);

  const expired = verifyTrackingToken(token, secret, 2_500_000_000_000);
  assert.equal(expired.valid, false);
});

test('evaluateTrafficQuality blocks repeated clicks and bots without auto-blocking single CTR alert', () => {
  const bot = evaluateTrafficQuality({
    userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)',
    recentClicksSameIpCount: 0,
    recentImpressionsSameSessionCount: 1,
    alreadyClickedImpression: false,
    publisherCtr: 0.02,
  });
  assert.equal(bot.isValid, false);
  assert.equal(bot.signalType, 'bot_traffic');

  const repeated = evaluateTrafficQuality({
    userAgent: 'Mozilla/5.0 Chrome/120.0',
    recentClicksSameIpCount: 4,
    recentImpressionsSameSessionCount: 5,
    alreadyClickedImpression: false,
    publisherCtr: 0.02,
  });
  assert.equal(repeated.isValid, false);
  assert.equal(repeated.signalType, 'repeated_clicks');

  const highCtrSingle = evaluateTrafficQuality({
    userAgent: 'Mozilla/5.0 Chrome/120.0',
    recentClicksSameIpCount: 0,
    recentImpressionsSameSessionCount: 1,
    alreadyClickedImpression: false,
    publisherCtr: 0.32,
  });
  assert.equal(highCtrSingle.isValid, true);
  assert.equal(highCtrSingle.shouldRaiseAlert, true);
});

test('RFC 6238 TOTP 2FA generates valid 6-digit codes and rejects wrong codes', () => {
  const secret = generateBase32Secret();
  assert.ok(secret.length >= 24);
  const now = 1_760_000_000_000;
  const code = generateTotpCode(secret, now);
  assert.match(code, /^\d{6}$/);
  assert.equal(verifyTotpCode(secret, code, now), true);
  assert.equal(verifyTotpCode(secret, '000000', now), false);
  assert.ok(buildOtpAuthUri('alice@example.com', secret).startsWith('otpauth://totp/'));
});

test('cryptographic payment webhook verifiers accept valid HMACs and reject tampered or stale payloads', () => {
  const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', amount: 50000 }), 'utf8');

  const paystackSecret = 'sk_test_paystack_secret';
  const paystackSig = crypto.createHmac('sha512', paystackSecret).update(rawBody).digest('hex');
  assert.equal(verifyPaystackSignature(rawBody, paystackSig, paystackSecret), true);
  assert.equal(verifyPaystackSignature(Buffer.from('{"tampered":true}'), paystackSig, paystackSecret), false);

  assert.equal(verifyFlutterwaveSignature('flw_hash_123', 'flw_hash_123'), true);
  assert.equal(verifyFlutterwaveSignature('flw_hash_wrong', 'flw_hash_123'), false);

  const stripeSecret = 'whsec_test_stripe';
  const ts = 1_760_000_000;
  const stripeV1 = crypto.createHmac('sha256', stripeSecret).update(`${ts}.${rawBody.toString('utf8')}`).digest('hex');
  const stripeHeader = `t=${ts},v1=${stripeV1}`;
  assert.equal(verifyStripeSignature(rawBody, stripeHeader, stripeSecret, 300, ts + 30), true);
  assert.equal(verifyStripeSignature(rawBody, stripeHeader, stripeSecret, 300, ts + 900), false);
  assert.equal(verifyStripeSignature(Buffer.from('modified'), stripeHeader, stripeSecret, 300, ts + 10), false);
});

test('SSRF guards block private IPs and local hostnames while allowing public domains', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.0.0.5'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true);
  assert.equal(isPrivateIp('192.168.1.10'), true);
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('93.184.216.34'), false);

  assert.equal(isValidPublicDomain('localhost'), null);
  assert.equal(isValidPublicDomain('127.0.0.1'), null);
  assert.equal(isValidPublicDomain('metadata.internal'), null);
  assert.equal(isValidPublicDomain('https://News.Example.com/path'), 'news.example.com');
});

test('scanProhibitedContent flags blocked and review keywords accurately', () => {
  const rules = [
    { id: 'r1', name: 'Malware', keywords: ['trojan', 'keylogger'], severity: 'block' as const, active: true },
    { id: 'r2', name: 'Finance', keywords: ['guaranteed profit'], severity: 'review' as const, active: true },
    { id: 'r3', name: 'Disabled', keywords: ['cloud'], severity: 'block' as const, active: false },
  ];

  const blocked = scanProhibitedContent('Download our fast keylogger cloud tool', rules);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].severity, 'block');
  assert.equal(blocked[0].matchedKeyword, 'keylogger');

  const review = scanProhibitedContent('Try our strategy for guaranteed profit today', rules);
  assert.equal(review.length, 1);
  assert.equal(review[0].severity, 'review');

  const clean = scanProhibitedContent('Enterprise cloud analytics for modern finance teams', rules);
  assert.equal(clean.length, 0);
});

test('validateMediaMagicBytes verifies genuine binary signatures and rejects spoofed buffers', () => {
  const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const jpgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const mp4Buf = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const spoofedBuf = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');

  assert.equal(validateMediaMagicBytes(pngBuf, 'image/png'), true);
  assert.equal(validateMediaMagicBytes(jpgBuf, 'image/jpeg'), true);
  assert.equal(validateMediaMagicBytes(mp4Buf, 'video/mp4'), true);
  assert.equal(validateMediaMagicBytes(spoofedBuf, 'image/png'), false);
  assert.equal(validateMediaMagicBytes(pngBuf, 'image/jpeg'), false);
});

test('convertUsdMicrosToCurrency converts USD micros accurately across supported currencies', () => {
  assert.equal(convertUsdMicrosToCurrency(100_000_000, 'USD'), 100);
  assert.equal(convertUsdMicrosToCurrency(100_000_000, 'EUR'), 92);
  assert.equal(convertUsdMicrosToCurrency(10_000_000, 'NGN'), 15_800);
});

test('computeRotationFactor and selectWinningAds enforce controlled rotation and multi-slot campaign deduplication', () => {
  assert.equal(computeRotationFactor(0, 0), 1);
  assert.ok(computeRotationFactor(5, 0) < computeRotationFactor(1, 0));
  assert.ok(computeRotationFactor(2, 2) < computeRotationFactor(2, 0));

  const cmpA1 = makeCandidate({
    campaignId: 'cmp_rot_a',
    pricingModel: 'CPM',
    maxBidMicros: 12_000_000,
    creative: {
      id: 'crt_rot_a1',
      advertisementId: 'ad_rot_a1',
      format: 'native',
      approvalStatus: 'approved',
      title: 'Campaign A Creative 1',
      description: 'Body A1',
      ctaText: 'Learn More',
      destinationUrl: 'https://example.com/a1',
      mediaUrl: '/img-a1.jpg',
      trackingParams: '',
      dimensions: 'responsive',
    },
  });
  const cmpA2 = makeCandidate({
    campaignId: 'cmp_rot_a',
    pricingModel: 'CPM',
    maxBidMicros: 12_000_000,
    creative: {
      id: 'crt_rot_a2',
      advertisementId: 'ad_rot_a2',
      format: 'native',
      approvalStatus: 'approved',
      title: 'Campaign A Creative 2',
      description: 'Body A2',
      ctaText: 'Shop',
      destinationUrl: 'https://example.com/a2',
      mediaUrl: '/img-a2.jpg',
      trackingParams: '',
      dimensions: 'responsive',
    },
  });
  const cmpB = makeCandidate({
    campaignId: 'cmp_rot_b',
    pricingModel: 'CPM',
    maxBidMicros: 9_500_000,
    creative: {
      id: 'crt_rot_b1',
      advertisementId: 'ad_rot_b1',
      format: 'native',
      approvalStatus: 'approved',
      title: 'Campaign B Creative 1',
      description: 'Body B1',
      ctaText: 'Explore',
      destinationUrl: 'https://example.com/b1',
      mediaUrl: '/img-b1.jpg',
      trackingParams: '',
      dimensions: 'responsive',
    },
  });

  // When Campaign A has high recent delivery counts, controlled rotation lets Campaign B win slot 1
  const winners = selectWinningAds(
    [cmpA1, cmpA2, cmpB],
    {
      placementId: 'plc_looma_feed_native',
      placementFormat: 'native',
      floorCpmMicros: 1_000_000,
      country: 'US',
      language: 'en',
      deviceCategory: 'desktop',
      os: 'macOS',
      browser: 'Chrome',
      category: 'business_finance',
      consentGranted: true,
      sessionImpressionCounts: {},
      recentDeliveryCounts: { cmp_rot_a: 6, cmp_rot_b: 0 },
      nowIso: '2026-06-01T12:00:00.000Z',
    },
    3
  );

  // Deduplicated by campaignId: max 2 unique campaigns returned even though 3 creatives & 3 slots requested
  assert.equal(winners.length, 2);
  assert.equal(winners[0].candidate.campaignId, 'cmp_rot_b');
  assert.equal(winners[1].candidate.campaignId, 'cmp_rot_a');
  assert.equal(winners[0].rotationFactor, 1);
  assert.ok((winners[1].rotationFactor ?? 1) < 0.7);
});


