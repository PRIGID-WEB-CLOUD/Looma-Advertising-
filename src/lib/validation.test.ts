import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEmail,
  validatePassword,
  validateTextLength,
  validateCountryCode,
  validateSixDigitCode,
  validateResetToken,
  validateHttpUrl,
  validateMediaUrl,
  validatePublicDomain,
  validateAppBundleId,
  validateIsoDate,
  validateNumberRange,
  validateDimensions,
  validateLoginInput,
  validateRegisterInput,
  validateAdminClaimInput,
  validateForgotPasswordInput,
  validateResetPasswordInput,
  validateProfileUpdateInput,
  validateSecuritySettingsInput,
  validatePreferencesInput,
  validateContactInput,
  validatePrivacyRequestInput,
  validateTargetingFields,
  validateCampaignCreateInput,
  validateBudgetBiddingInput,
  validateAppealInput,
  validateDepositInput,
  validateRefundInput,
  validateMediaUploadFile,
  validatePropertyCreateInput,
  validatePlacementCreateInput,
  validatePayoutMethodInput,
  validateWithdrawalInput,
  validateProhibitedCategoryInput,
  validatePlatformSettingsInput,
} from './validation';

test('Primitive validators: email, password, text length, country, codes, reset token', () => {
  assert.equal(validateEmail('alice@company.com'), null);
  assert.equal(validateEmail('alice+ads@sub.company.co.uk'), null);
  assert.ok(validateEmail(''));
  assert.ok(validateEmail('not-an-email'));
  assert.ok(validateEmail('a..b@example.com'));
  assert.ok(validateEmail(`${'a'.repeat(250)}@example.com`));

  assert.equal(validatePassword('StrongPass!1'), null);
  assert.ok(validatePassword(''));
  assert.ok(validatePassword('short'));
  assert.ok(validatePassword('a'.repeat(129)));
  assert.ok(validatePassword('bad\0password'));

  assert.equal(validateTextLength('Hello world', { label: 'Title', min: 2, max: 50 }), null);
  assert.equal(validateTextLength('', { label: 'Optional', required: false }), null);
  assert.ok(validateTextLength('', { label: 'Title', required: true }));
  assert.ok(validateTextLength('a', { label: 'Title', min: 2 }));
  assert.ok(validateTextLength('hello\u0007bell', { label: 'Title' }));
  assert.equal(validateTextLength('line1\nline2', { label: 'Bio', allowNewlines: true }), null);
  assert.ok(validateTextLength('line1\nline2', { label: 'Title', allowNewlines: false }));

  assert.equal(validateCountryCode('US'), null);
  assert.equal(validateCountryCode('ng'), null);
  assert.ok(validateCountryCode('USA'));
  assert.ok(validateCountryCode('12'));

  assert.equal(validateSixDigitCode('012345'), null);
  assert.ok(validateSixDigitCode('12345'));
  assert.ok(validateSixDigitCode('12345a'));

  assert.equal(validateResetToken('AB12CD34'), null);
  assert.ok(validateResetToken('123'));
  assert.ok(validateResetToken('bad token!'));
});

test('Primitive validators: URL safety, media URLs, public domains, bundle IDs, calendar dates, numbers, dimensions', () => {
  // Safe public HTTP/HTTPS URLs pass
  assert.equal(validateHttpUrl('https://example.com/landing?ref=looma'), null);
  assert.equal(validateHttpUrl('http://promo.acme.io/offer'), null);

  // Dangerous schemes & private/loopback/link-local hosts rejected
  for (const badUrl of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://files.example.com/ad.png',
    'http://localhost/admin',
    'https://sub.localhost/test',
    'http://127.0.0.1:3000/api',
    'http://10.0.0.1/internal',
    'http://169.254.169.254/latest/meta-data/',
    'http://172.16.0.5/secret',
    'http://192.168.1.1/router',
    'http://[::1]/loopback',
    'http://[fe80::1]/linklocal',
    'http://service.internal/path',
    'http://printer.local/status',
    'not a url',
  ]) {
    assert.ok(validateHttpUrl(badUrl), `Expected URL to be rejected: ${badUrl}`);
  }

  // Media URL allows relative uploaded assets or safe public URLs, rejects traversal/unsafe URLs
  assert.equal(validateMediaUrl('/api/media/asset_123.png', true), null);
  assert.equal(validateMediaUrl('https://cdn.example.com/banner.webp', true), null);
  assert.ok(validateMediaUrl('/api/media/../secret.txt', true));
  assert.ok(validateMediaUrl('http://127.0.0.1/evil.png', true));

  // Public domain rejects protocol, paths, IPs, localhost
  assert.equal(validatePublicDomain('news.example.com'), null);
  assert.ok(validatePublicDomain('https://news.example.com'));
  assert.ok(validatePublicDomain('news.example.com/path'));
  assert.ok(validatePublicDomain('192.168.1.1'));
  assert.ok(validatePublicDomain('localhost'));

  // App bundle ID
  assert.equal(validateAppBundleId('com.looma.social'), null);
  assert.ok(validateAppBundleId('singleword'));
  assert.ok(validateAppBundleId('123.invalid.bundle'));

  // Strict ISO calendar dates (including leap years)
  assert.equal(validateIsoDate('2028-02-29'), null);
  assert.equal(validateIsoDate('2026-11-30'), null);
  assert.ok(validateIsoDate('2026-02-29'));
  assert.ok(validateIsoDate('2026-04-31'));
  assert.ok(validateIsoDate('11/30/2026'));

  // Number ranges
  assert.deepEqual(validateNumberRange(50, { label: 'Budget', min: 10, max: 100 }), { error: null, value: 50 });
  assert.ok(validateNumberRange(5, { label: 'Budget', min: 10, currency: true }).error);
  assert.ok(validateNumberRange(12.5, { label: 'Count', integer: true }).error);
  assert.ok(validateNumberRange('abc', { label: 'Amount' }).error);

  // Dimensions
  assert.equal(validateDimensions('responsive'), null);
  assert.equal(validateDimensions('text'), null);
  assert.equal(validateDimensions('728x90'), null);
  assert.equal(validateDimensions('16:9'), null);
  assert.ok(validateDimensions('huge banner'));
});

test('Auth, account, contact, and privacy validators', () => {
  const badLogin = validateLoginInput({ email: 'bad', password: '', totpCode: '12' });
  assert.equal(badLogin.valid, false);
  assert.ok(badLogin.errors.email);
  assert.ok(badLogin.errors.password);
  assert.ok(badLogin.errors.totpCode);

  const okLogin = validateLoginInput({ email: 'user@example.com', password: 'Password123!' });
  assert.equal(okLogin.valid, true);

  const badReg = validateRegisterInput({
    email: 'invalid',
    fullName: 'A',
    password: '123',
    role: 'admin',
    organizationName: 'X',
    country: 'ZZZ',
  });
  assert.equal(badReg.valid, false);
  assert.ok(badReg.errors.email);
  assert.ok(badReg.errors.fullName);
  assert.ok(badReg.errors.password);
  assert.ok(badReg.errors.role);
  assert.ok(badReg.errors.organizationName);
  assert.ok(badReg.errors.country);

  const badClaim = validateAdminClaimInput({
    email: 'admin@looma.io',
    fullName: 'Root Admin',
    password: 'short',
    confirmPassword: 'different',
  });
  assert.equal(badClaim.valid, false);
  assert.ok(badClaim.errors.password);
  assert.ok(badClaim.errors.confirmPassword);

  assert.equal(validateForgotPasswordInput({ email: 'bad' }).valid, false);
  assert.equal(validateResetPasswordInput({ email: 'ok@example.com', token: '!!', newPassword: '123' }).valid, false);

  const badProfile = validateProfileUpdateInput({
    fullName: 'A',
    organizationName: '',
    country: 'INVALID',
    contactEmail: 'nope',
    requireOrganization: true,
  });
  assert.equal(badProfile.valid, false);
  assert.ok(badProfile.errors.fullName);
  assert.ok(badProfile.errors.organizationName);
  assert.ok(badProfile.errors.country);
  assert.ok(badProfile.errors.contactEmail);

  const samePw = validateSecuritySettingsInput({
    sessionTimeoutMinutes: 5,
    currentPassword: 'Password123!',
    newPassword: 'Password123!',
  });
  assert.equal(samePw.valid, false);
  assert.ok(samePw.errors.sessionTimeoutMinutes);
  assert.ok(samePw.errors.newPassword);

  const missingCurrentPw = validateSecuritySettingsInput({
    sessionTimeoutMinutes: 60,
    currentPassword: '',
    newPassword: 'NewPassword123!',
  });
  assert.equal(missingCurrentPw.valid, false);
  assert.ok(missingCurrentPw.errors.currentPassword);

  const badPref = validatePreferencesInput({ timezone: 'Bad Zone!!', preferredCurrency: 'BTC' });
  assert.equal(badPref.valid, false);
  assert.ok(badPref.errors.timezone);
  assert.ok(badPref.errors.preferredCurrency);

  const badContact = validateContactInput({ name: 'A', email: 'bad', interest: 'spam', message: 'short' });
  assert.equal(badContact.valid, false);
  assert.ok(badContact.errors.name);
  assert.ok(badContact.errors.email);
  assert.ok(badContact.errors.interest);
  assert.ok(badContact.errors.message);

  const badPrivacy = validatePrivacyRequestInput({
    email: 'bad',
    requestType: 'unknown',
    jurisdiction: 'MARS',
  });
  assert.equal(badPrivacy.valid, false);
  assert.ok(badPrivacy.errors.email);
  assert.ok(badPrivacy.errors.requestType);
  assert.ok(badPrivacy.errors.jurisdiction);
});

test('Advertiser validators: targeting, campaign cross-field rules, budget, appeal, deposit, refund, media upload', () => {
  const badTarget = validateTargetingFields({
    countries: ['USA'],
    languages: ['123456'],
    deviceCategories: ['smartwatch'],
  });
  assert.equal(badTarget.valid, false);
  assert.ok(badTarget.errors.countries);
  assert.ok(badTarget.errors.languages);
  assert.ok(badTarget.errors.deviceCategories);

  const badCampaign = validateCampaignCreateInput({
    name: 'Test Campaign',
    objective: 'website_traffic',
    pricingModel: 'CPC',
    biddingStrategy: 'manual',
    pacingMode: 'standard',
    format: 'banner',
    dimensions: '728x90',
    title: 'Valid Headline',
    description: 'Valid campaign description copy',
    mediaUrl: 'https://cdn.example.com/clip.mp4',
    destinationUrl: 'javascript:alert(1)',
    dailyBudgetUsd: 100,
    totalBudgetUsd: 50,
    maxBidUsd: 150,
    startDate: '2026-06-15',
    endDate: '2026-06-01',
    enforceFormatMedia: true,
  });
  assert.equal(badCampaign.valid, false);
  assert.ok(badCampaign.errors.mediaUrl);
  assert.ok(badCampaign.errors.destinationUrl);
  assert.ok(badCampaign.errors.totalBudgetUsd);
  assert.ok(badCampaign.errors.maxBidUsd);
  assert.ok(badCampaign.errors.endDate);

  const okCampaign = validateCampaignCreateInput({
    name: 'Q4 Growth Launch',
    objective: 'website_traffic',
    pricingModel: 'CPC',
    biddingStrategy: 'manual',
    pacingMode: 'standard',
    format: 'native',
    dimensions: 'responsive',
    title: 'Ship Faster With Looma',
    description: 'Reach verified enterprise teams across curated inventory.',
    mediaUrl: 'https://cdn.example.com/hero.jpg',
    destinationUrl: 'https://example.com/signup',
    dailyBudgetUsd: 100,
    totalBudgetUsd: 1000,
    maxBidUsd: 2.5,
    startDate: '2026-06-01',
    endDate: '2026-07-01',
  });
  assert.equal(okCampaign.valid, true);

  const badBudget = validateBudgetBiddingInput({
    biddingStrategy: 'manual',
    pacingMode: 'standard',
    dailyBudgetUsd: 50,
    totalBudgetUsd: 25,
    maxBidUsd: 75,
    startDate: '2026-08-10',
    endDate: '2026-08-01',
  });
  assert.equal(badBudget.valid, false);
  assert.ok(badBudget.errors.totalBudgetUsd);
  assert.ok(badBudget.errors.maxBidUsd);
  assert.ok(badBudget.errors.endDate);

  assert.equal(validateAppealInput({ reason: 'too short' }).valid, false);
  assert.equal(validateAppealInput({ reason: 'Updated disclosures and landing page compliance.' }).valid, true);

  const badDeposit = validateDepositInput({ amountUsd: 5, provider: 'crypto', idempotencyKey: 'bad key!' });
  assert.equal(badDeposit.valid, false);
  assert.ok(badDeposit.errors.amountUsd);
  assert.ok(badDeposit.errors.provider);
  assert.ok(badDeposit.errors.idempotencyKey);

  const overRefund = validateRefundInput({ amountUsd: 150, maxAvailableUsd: 100 });
  assert.equal(overRefund.valid, false);
  assert.ok(overRefund.errors.amountUsd);

  // Media upload file validation
  assert.ok(validateMediaUploadFile({ name: 'empty.png', type: 'image/png', size: 0 }, 'banner'));
  assert.ok(validateMediaUploadFile({ name: 'huge.png', type: 'image/png', size: 11 * 1024 * 1024 }, 'banner'));
  assert.ok(validateMediaUploadFile({ name: 'clip.mp4', type: 'video/mp4', size: 1024 }, 'banner'));
  assert.ok(validateMediaUploadFile({ name: 'img.png', type: 'image/png', size: 1024 }, 'video'));
  assert.ok(validateMediaUploadFile({ name: 'img.png', type: 'image/png', size: 1024 }, 'text'));
  assert.equal(validateMediaUploadFile({ name: 'clip.mp4', type: 'video/mp4', size: 1024 }, 'video'), null);
  assert.equal(validateMediaUploadFile({ name: 'hero.webp', type: 'image/webp', size: 2048 }, 'native'), null);
});

test('Publisher and Admin validators', () => {
  const badWebProp = validatePropertyCreateInput({
    propertyType: 'website',
    name: 'A',
    domainOrBundle: 'http://localhost/feed',
    monthlyPageviews: -10,
  });
  assert.equal(badWebProp.valid, false);
  assert.ok(badWebProp.errors.name);
  assert.ok(badWebProp.errors.domainOrBundle);
  assert.ok(badWebProp.errors.monthlyPageviews);

  const okIosProp = validatePropertyCreateInput({
    propertyType: 'ios_app',
    name: 'Looma iOS',
    domainOrBundle: 'com.looma.ios',
    monthlyPageviews: 250000,
  });
  assert.equal(okIosProp.valid, true);

  const badPlc = validatePlacementCreateInput({
    propertyId: '',
    name: 'X',
    format: 'popup',
    dimensions: 'giant',
    floorCpmUsd: 0.01,
  });
  assert.equal(badPlc.valid, false);
  assert.ok(badPlc.errors.propertyId);
  assert.ok(badPlc.errors.name);
  assert.ok(badPlc.errors.format);
  assert.ok(badPlc.errors.dimensions);
  assert.ok(badPlc.errors.floorCpmUsd);

  assert.equal(validatePayoutMethodInput({ payoutMethodType: 'wire', payoutDestination: '123' }).valid, false);
  assert.equal(validatePayoutMethodInput({ payoutMethodType: 'paystack', payoutDestination: 'NG-ACCT-001122' }).valid, true);

  const badWdr = validateWithdrawalInput({ amountUsd: 20, minPayoutUsd: 50, maxAvailableUsd: 100 });
  assert.equal(badWdr.valid, false);
  assert.ok(badWdr.errors.amountUsd);

  const overWdr = validateWithdrawalInput({ amountUsd: 200, minPayoutUsd: 50, maxAvailableUsd: 100 });
  assert.equal(overWdr.valid, false);
  assert.ok(overWdr.errors.amountUsd);

  const badCat = validateProhibitedCategoryInput({ name: 'X', keywords: '', severity: 'delete' });
  assert.equal(badCat.valid, false);
  assert.ok(badCat.errors.name);
  assert.ok(badCat.errors.keywords);
  assert.ok(badCat.errors.severity);

  const badSettings = validatePlatformSettingsInput({
    default_publisher_share_bps: 9999,
    gdpr_consent_enforcement: 'yes',
    'Bad Key!': true,
  });
  assert.equal(badSettings.valid, false);
  assert.ok(badSettings.errors.default_publisher_share_bps);
  assert.ok(badSettings.errors.gdpr_consent_enforcement);
  assert.ok(badSettings.errors['Bad Key!']);
});
