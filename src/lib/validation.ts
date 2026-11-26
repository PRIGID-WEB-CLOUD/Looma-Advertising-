import { getAdFormatSpec, isVideoMediaUrl } from './adFormats';

export type FieldErrors = Record<string, string>;

export interface ValidationResult<T = undefined> {
  valid: boolean;
  errors: FieldErrors;
  firstError: string | null;
  value?: T;
}

export function buildResult<T>(errors: FieldErrors, value?: T): ValidationResult<T> {
  const keys = Object.keys(errors);
  return {
    valid: keys.length === 0,
    errors,
    firstError: keys.length > 0 ? errors[keys[0]] : null,
    value: keys.length === 0 ? value : undefined,
  };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim();
}

export function hasControlChars(value: string, allowNewlines = false): boolean {
  // Reject ASCII control chars (0x00-0x1F, 0x7F) except \n, \r, \t when allowNewlines is true
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x7f) return true;
    if (code < 0x20) {
      if (allowNewlines && (code === 0x0a || code === 0x0d || code === 0x09)) continue;
      return true;
    }
  }
  return false;
}

// ============================================================================
// PRIMITIVE VALIDATORS
// ============================================================================

const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function validateEmail(raw: unknown, label = 'Email address'): string | null {
  const str = asTrimmedString(raw);
  if (!str) return `${label} is required.`;
  if (str.length > 254) return `${label} must be 254 characters or fewer.`;
  if (str.includes('..') || !EMAIL_RE.test(str)) {
    return `Enter a valid ${label.toLowerCase()} (for example, name@company.com).`;
  }
  return null;
}

export function validatePassword(
  raw: unknown,
  opts: { min?: number; max?: number; label?: string } = {}
): string | null {
  const min = opts.min ?? 8;
  const max = opts.max ?? 128;
  const label = opts.label ?? 'Password';
  if (typeof raw !== 'string' || raw.length === 0) return `${label} is required.`;
  if (raw.length < min) return `${label} must be at least ${min} characters.`;
  if (raw.length > max) return `${label} must be ${max} characters or fewer.`;
  if (raw.includes('\0')) return `${label} contains invalid characters.`;
  return null;
}

export function validateTextLength(
  raw: unknown,
  opts: {
    label: string;
    required?: boolean;
    min?: number;
    max?: number;
    allowNewlines?: boolean;
  }
): string | null {
  const { label, required = true, min = 1, max = 500, allowNewlines = false } = opts;
  if (raw === undefined || raw === null || raw === '') {
    return required ? `${label} is required.` : null;
  }
  if (typeof raw !== 'string') return `${label} must be text.`;
  const trimmed = raw.trim();
  if (!trimmed) return required ? `${label} is required.` : null;
  if (hasControlChars(trimmed, allowNewlines)) return `${label} contains unsupported control characters.`;
  if (trimmed.length < min) return `${label} must be at least ${min} characters.`;
  if (trimmed.length > max) return `${label} must be ${max} characters or fewer.`;
  return null;
}

export function validateCountryCode(raw: unknown, required = true): string | null {
  const str = asTrimmedString(raw);
  if (!str) return required ? 'Country code is required.' : null;
  if (!/^[A-Za-z]{2}$/.test(str)) {
    return 'Use a 2-letter ISO country code (for example, US, GB, NG, or DE).';
  }
  return null;
}

export function validateSixDigitCode(raw: unknown, label = 'Verification code'): string | null {
  const str = asTrimmedString(raw);
  if (!str) return `${label} is required.`;
  if (!/^\d{6}$/.test(str)) return `${label} must be a 6-digit numeric code.`;
  return null;
}

export function validateResetToken(raw: unknown): string | null {
  const str = asTrimmedString(raw);
  if (!str) return 'Reset code is required.';
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(str)) {
    return 'Reset code must be 6–32 letters or numbers.';
  }
  return null;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost')
  ) {
    return true;
  }
  // Block raw IPv4 private/loopback/link-local ranges
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  // Block IPv6 ULA / link-local / loopback-mapped
  if (host.includes(':')) {
    if (
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80') ||
      host.startsWith('::ffff:127.') ||
      host.startsWith('::ffff:10.') ||
      host.startsWith('::ffff:169.254.') ||
      host.startsWith('::ffff:192.168.')
    ) {
      return true;
    }
  }
  return false;
}

export function validateHttpUrl(
  raw: unknown,
  opts: { label?: string; required?: boolean; allowPrivateHost?: boolean } = {}
): string | null {
  const label = opts.label ?? 'URL';
  const required = opts.required ?? true;
  const str = asTrimmedString(raw);
  if (!str) return required ? `${label} is required.` : null;
  if (str.length > 2048) return `${label} must be 2,048 characters or fewer.`;
  if (hasControlChars(str)) return `${label} contains invalid characters.`;
  let parsed: URL;
  try {
    parsed = new URL(str);
  } catch {
    return `${label} must be a valid URL starting with https:// or http://.`;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `${label} must use https:// or http://.`;
  }
  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    if (!opts.allowPrivateHost || parsed.hostname !== 'localhost') {
      return `${label} must include a valid domain name.`;
    }
  }
  if (!opts.allowPrivateHost && isBlockedHostname(parsed.hostname)) {
    return `${label} cannot point to localhost or private network addresses.`;
  }
  return null;
}

export function validateMediaUrl(raw: unknown, required = false): string | null {
  const str = asTrimmedString(raw);
  if (!str) return required ? 'Media asset URL is required.' : null;
  if (str.length > 2048) return 'Media URL must be 2,048 characters or fewer.';
  if (hasControlChars(str)) return 'Media URL contains invalid characters.';
  if (str.startsWith('/api/media/') || str.startsWith('/src/assets/')) {
    if (str.includes('..') || /\s/.test(str)) {
      return 'Media asset path is invalid.';
    }
    return null;
  }
  return validateHttpUrl(str, { label: 'Media URL', required });
}

export function validatePublicDomain(raw: unknown, label = 'Domain'): string | null {
  const str = asTrimmedString(raw);
  if (!str) return `${label} is required.`;
  const cleaned = str.toLowerCase();
  if (/^https?:\/\//i.test(cleaned) || cleaned.includes('/') || cleaned.includes(' ')) {
    return `${label} should be a bare hostname without https:// or paths (for example, news.example.com).`;
  }
  if (cleaned.length > 253) return `${label} must be 253 characters or fewer.`;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(cleaned) || isBlockedHostname(cleaned)) {
    return `${label} must be a public domain name (no IP addresses or local hostnames).`;
  }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(cleaned)) {
    return `Enter a valid ${label.toLowerCase()} (for example, example.com).`;
  }
  return null;
}

export function validateAppBundleId(raw: unknown, label = 'App bundle ID'): string | null {
  const str = asTrimmedString(raw);
  if (!str) return `${label} is required.`;
  if (str.length < 3 || str.length > 150) return `${label} must be between 3 and 150 characters.`;
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_-]+)+$/.test(str)) {
    return `${label} must use reverse-domain format (for example, com.company.app).`;
  }
  return null;
}

export function validateIsoDate(raw: unknown, label = 'Date'): string | null {
  const str = asTrimmedString(raw);
  if (!str) return `${label} is required.`;
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return `${label} must use YYYY-MM-DD format.`;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2020 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return `${label} is not a valid calendar date.`;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return `${label} is not a valid calendar date.`;
  }
  return null;
}

export function validateNumberRange(
  raw: unknown,
  opts: {
    label: string;
    min?: number;
    max?: number;
    integer?: boolean;
    required?: boolean;
    currency?: boolean;
  }
): { error: string | null; value: number | null } {
  const { label, min, max, integer = false, required = true, currency = false } = opts;
  if (raw === undefined || raw === null || raw === '') {
    return { error: required ? `${label} is required.` : null, value: null };
  }
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(num)) {
    return { error: `${label} must be a valid number.`, value: null };
  }
  if (integer && !Number.isInteger(num)) {
    return { error: `${label} must be a whole number.`, value: null };
  }
  const fmt = (n: number) => (currency ? `$${n.toLocaleString('en-US', { minimumFractionDigits: n < 10 ? 2 : 0, maximumFractionDigits: 2 })}` : n.toLocaleString('en-US'));
  if (min !== undefined && num < min) {
    return { error: `${label} must be at least ${fmt(min)}.`, value: null };
  }
  if (max !== undefined && num > max) {
    return { error: `${label} cannot exceed ${fmt(max)}.`, value: null };
  }
  return { error: null, value: num };
}

export function validateDimensions(raw: unknown): string | null {
  const str = asTrimmedString(raw);
  if (!str) return 'Dimensions are required.';
  if (str.length > 40) return 'Dimensions must be 40 characters or fewer.';
  if (
    str === 'responsive' ||
    str === 'text' ||
    /^\d{2,4}x\d{2,4}$/i.test(str) ||
    /^\d{1,2}:\d{1,2}$/.test(str)
  ) {
    return null;
  }
  return 'Use responsive, text, WxH (e.g. 728x90), or aspect ratio (e.g. 16:9).';
}

export function parseListInput(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    if (!raw.every((item) => typeof item === 'string')) return null;
    return raw.map((s) => s.trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return null;
}

// ============================================================================
// DOMAIN CONSTANTS
// ============================================================================

export const ALLOWED_OBJECTIVES = [
  'brand_awareness',
  'website_traffic',
  'lead_generation',
  'sales_conversions',
  'app_installs',
  'video_views',
  'product_promotion',
] as const;

export const ALLOWED_PRICING_MODELS = ['CPM', 'CPC', 'CPA', 'CPI', 'CPV', 'FIXED'] as const;
export const ALLOWED_BIDDING_STRATEGIES = ['manual', 'auto_cpc', 'target_cpa'] as const;
export const ALLOWED_PACING_MODES = ['standard', 'accelerated'] as const;
export const ALLOWED_AD_FORMATS = ['image', 'banner', 'native', 'text', 'video', 'responsive', 'sponsored'] as const;
export const ALLOWED_PLACEMENT_FORMATS = ['banner', 'responsive', 'native', 'video', 'in_feed', 'interstitial'] as const;
export const ALLOWED_PROPERTY_TYPES = ['website', 'ios_app', 'android_app', 'web_app'] as const;
export const ALLOWED_VERIFICATION_METHODS = ['dns_txt', 'meta_tag', 'ads_txt'] as const;
export const ALLOWED_DEPOSIT_PROVIDERS = ['paystack', 'flutterwave', 'stripe', 'bank_transfer'] as const;
export const ALLOWED_PAYOUT_METHODS = ['bank_transfer', 'paystack', 'flutterwave'] as const;
export const ALLOWED_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'NGN', 'KES'] as const;
export const ALLOWED_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Africa/Lagos',
  'Africa/Nairobi',
  'Asia/Singapore',
] as const;
export const ALLOWED_CONTACT_INTERESTS = [
  'advertising',
  'publisher',
  'publisher_monetization',
  'engineering',
  'compliance',
  'billing',
] as const;
export const ALLOWED_PRIVACY_TYPES = [
  'data_export',
  'data_deletion',
  'consent_withdrawal',
  'rectification',
] as const;
export const ALLOWED_PRIVACY_JURISDICTIONS = ['GDPR', 'UK_GDPR', 'CCPA', 'NDPA', 'OTHER'] as const;
export const ALLOWED_DEVICE_CATEGORIES = ['ALL', 'desktop', 'mobile', 'tablet'] as const;
export const ALLOWED_PROPERTY_CATEGORIES = [
  'news_technology',
  'business_finance',
  'software_saas',
  'ecommerce',
  'media_entertainment',
  'gaming',
  'lifestyle',
  'general',
] as const;

// ============================================================================
// AUTH & PUBLIC FORM VALIDATORS
// ============================================================================

export function validateLoginInput(input: {
  email?: unknown;
  password?: unknown;
  totpCode?: unknown;
  requireTotp?: boolean;
}): ValidationResult<{ email: string; password: string; totpCode?: string }> {
  const errors: FieldErrors = {};
  const emailErr = validateEmail(input.email);
  if (emailErr) errors.email = emailErr;

  if (typeof input.password !== 'string' || input.password.length === 0) {
    errors.password = 'Password is required.';
  } else if (input.password.length > 128) {
    errors.password = 'Password must be 128 characters or fewer.';
  }

  const totpRaw = asTrimmedString(input.totpCode);
  if (input.requireTotp) {
    const codeErr = validateSixDigitCode(totpRaw, 'Authenticator code');
    if (codeErr) errors.totpCode = codeErr;
  } else if (totpRaw) {
    const codeErr = validateSixDigitCode(totpRaw, 'Authenticator code');
    if (codeErr) errors.totpCode = codeErr;
  }

  return buildResult(errors, {
    email: (asTrimmedString(input.email) || '').toLowerCase(),
    password: typeof input.password === 'string' ? input.password : '',
    totpCode: totpRaw || undefined,
  });
}

export function validateRegisterInput(input: {
  email?: unknown;
  fullName?: unknown;
  password?: unknown;
  role?: unknown;
  organizationName?: unknown;
  country?: unknown;
}): ValidationResult<{
  email: string;
  fullName: string;
  password: string;
  role: 'advertiser' | 'publisher';
  organizationName: string;
  country: string;
}> {
  const errors: FieldErrors = {};
  const emailErr = validateEmail(input.email);
  if (emailErr) errors.email = emailErr;

  const nameErr = validateTextLength(input.fullName, { label: 'Full name', min: 2, max: 100 });
  if (nameErr) errors.fullName = nameErr;

  const pwErr = validatePassword(input.password, { min: 8, max: 128 });
  if (pwErr) errors.password = pwErr;

  const orgErr = validateTextLength(input.organizationName, { label: 'Organization name', min: 2, max: 120 });
  if (orgErr) errors.organizationName = orgErr;

  const role = input.role === undefined ? 'advertiser' : String(input.role);
  if (role !== 'advertiser' && role !== 'publisher') {
    errors.role = 'Self-registration is available for advertiser or publisher accounts.';
  }

  const countryRaw = input.country === undefined || input.country === '' ? 'US' : input.country;
  const countryErr = validateCountryCode(countryRaw, true);
  if (countryErr) errors.country = countryErr;

  return buildResult(errors, {
    email: (asTrimmedString(input.email) || '').toLowerCase(),
    fullName: asTrimmedString(input.fullName) || '',
    password: typeof input.password === 'string' ? input.password : '',
    role: role as 'advertiser' | 'publisher',
    organizationName: asTrimmedString(input.organizationName) || '',
    country: (asTrimmedString(countryRaw) || 'US').toUpperCase(),
  });
}

export function validateAdminClaimInput(input: {
  email?: unknown;
  fullName?: unknown;
  password?: unknown;
  confirmPassword?: unknown;
}): ValidationResult<{ email: string; fullName: string; password: string }> {
  const errors: FieldErrors = {};
  const emailErr = validateEmail(input.email, 'Administrator email');
  if (emailErr) errors.email = emailErr;

  const nameVal = input.fullName === undefined || input.fullName === '' ? 'Platform Administrator' : input.fullName;
  const nameErr = validateTextLength(nameVal, { label: 'Full name', min: 2, max: 100 });
  if (nameErr) errors.fullName = nameErr;

  const pwErr = validatePassword(input.password, { min: 10, max: 128, label: 'Administrator password' });
  if (pwErr) errors.password = pwErr;

  if (input.confirmPassword !== undefined && input.password !== input.confirmPassword) {
    errors.confirmPassword = 'Passwords do not match.';
  }

  return buildResult(errors, {
    email: (asTrimmedString(input.email) || '').toLowerCase(),
    fullName: asTrimmedString(nameVal) || 'Platform Administrator',
    password: typeof input.password === 'string' ? input.password : '',
  });
}

export function validateForgotPasswordInput(input: { email?: unknown }): ValidationResult<{ email: string }> {
  const errors: FieldErrors = {};
  const emailErr = validateEmail(input.email);
  if (emailErr) errors.email = emailErr;
  return buildResult(errors, { email: (asTrimmedString(input.email) || '').toLowerCase() });
}

export function validateResetPasswordInput(input: {
  email?: unknown;
  token?: unknown;
  newPassword?: unknown;
}): ValidationResult<{ email: string; token: string; newPassword: string }> {
  const errors: FieldErrors = {};
  const emailErr = validateEmail(input.email);
  if (emailErr) errors.email = emailErr;

  const tokenErr = validateResetToken(input.token);
  if (tokenErr) errors.token = tokenErr;

  const pwErr = validatePassword(input.newPassword, { min: 8, max: 128, label: 'New password' });
  if (pwErr) errors.newPassword = pwErr;

  return buildResult(errors, {
    email: (asTrimmedString(input.email) || '').toLowerCase(),
    token: (asTrimmedString(input.token) || '').toUpperCase(),
    newPassword: typeof input.newPassword === 'string' ? input.newPassword : '',
  });
}

export function validateProfileUpdateInput(input: {
  fullName?: unknown;
  organizationName?: unknown;
  country?: unknown;
  contactEmail?: unknown;
  requireOrganization?: boolean;
}): ValidationResult<{
  fullName: string;
  organizationName: string;
  country: string;
  contactEmail: string;
}> {
  const errors: FieldErrors = {};
  const nameErr = validateTextLength(input.fullName, { label: 'Full name', min: 2, max: 100 });
  if (nameErr) errors.fullName = nameErr;

  const orgStr = asTrimmedString(input.organizationName) || '';
  if (input.requireOrganization || orgStr.length > 0) {
    const orgErr = validateTextLength(input.organizationName, {
      label: 'Organization name',
      required: Boolean(input.requireOrganization),
      min: 2,
      max: 120,
    });
    if (orgErr) errors.organizationName = orgErr;
  }

  const countryVal = input.country === undefined || input.country === '' ? 'US' : input.country;
  const countryErr = validateCountryCode(countryVal, false);
  if (countryErr) errors.country = countryErr;

  const contactStr = asTrimmedString(input.contactEmail) || '';
  if (contactStr.length > 0) {
    const contactErr = validateEmail(contactStr, 'Contact email');
    if (contactErr) errors.contactEmail = contactErr;
  }

  return buildResult(errors, {
    fullName: asTrimmedString(input.fullName) || '',
    organizationName: orgStr,
    country: (asTrimmedString(countryVal) || 'US').toUpperCase(),
    contactEmail: contactStr.toLowerCase(),
  });
}

export function validateSecuritySettingsInput(input: {
  twoFactorEnabled?: unknown;
  sessionTimeoutMinutes?: unknown;
  currentPassword?: unknown;
  newPassword?: unknown;
}): ValidationResult<{
  twoFactorEnabled: boolean;
  sessionTimeoutMinutes: number;
  currentPassword: string;
  newPassword: string;
}> {
  const errors: FieldErrors = {};
  const timeoutRes = validateNumberRange(input.sessionTimeoutMinutes ?? 60, {
    label: 'Session timeout',
    min: 15,
    max: 1440,
    integer: true,
  });
  if (timeoutRes.error) errors.sessionTimeoutMinutes = timeoutRes.error;

  const currentPw = typeof input.currentPassword === 'string' ? input.currentPassword : '';
  const newPw = typeof input.newPassword === 'string' ? input.newPassword : '';
  if (newPw.length > 0) {
    const pwErr = validatePassword(newPw, { min: 8, max: 128, label: 'New password' });
    if (pwErr) errors.newPassword = pwErr;
    if (!currentPw) {
      errors.currentPassword = 'Enter your current password to set a new password.';
    } else if (currentPw === newPw) {
      errors.newPassword = 'New password must be different from your current password.';
    }
  } else if (currentPw.length > 0) {
    errors.newPassword = 'Enter a new password (at least 8 characters) or clear the current password field.';
  }

  return buildResult(errors, {
    twoFactorEnabled: Boolean(input.twoFactorEnabled),
    sessionTimeoutMinutes: timeoutRes.value ?? 60,
    currentPassword: currentPw,
    newPassword: newPw,
  });
}

export function validatePreferencesInput(input: {
  timezone?: unknown;
  preferredCurrency?: unknown;
  compactDensity?: unknown;
  emailAlerts?: unknown;
  fraudAlerts?: unknown;
  weeklyDigest?: unknown;
}): ValidationResult<{
  timezone: string;
  preferredCurrency: string;
  compactDensity: boolean;
  emailAlerts: boolean;
  fraudAlerts: boolean;
  weeklyDigest: boolean;
}> {
  const errors: FieldErrors = {};
  const tz = asTrimmedString(input.timezone ?? 'UTC') || '';
  if (!tz || tz.length > 64 || !/^[A-Za-z0-9_/+.-]+$/.test(tz)) {
    errors.timezone = 'Select a valid reporting timezone.';
  }
  const curr = (asTrimmedString(input.preferredCurrency ?? 'USD') || '').toUpperCase();
  if (!(ALLOWED_CURRENCIES as readonly string[]).includes(curr)) {
    errors.preferredCurrency = 'Unsupported display currency.';
  }
  return buildResult(errors, {
    timezone: tz || 'UTC',
    preferredCurrency: curr || 'USD',
    compactDensity: Boolean(input.compactDensity),
    emailAlerts: Boolean(input.emailAlerts),
    fraudAlerts: Boolean(input.fraudAlerts),
    weeklyDigest: Boolean(input.weeklyDigest),
  });
}

export function validateContactInput(input: {
  name?: unknown;
  email?: unknown;
  company?: unknown;
  interest?: unknown;
  message?: unknown;
}): ValidationResult<{
  name: string;
  email: string;
  company: string;
  interest: string;
  message: string;
}> {
  const errors: FieldErrors = {};
  const nameErr = validateTextLength(input.name, { label: 'Name', min: 2, max: 100 });
  if (nameErr) errors.name = nameErr;

  const emailErr = validateEmail(input.email);
  if (emailErr) errors.email = emailErr;

  const compErr = validateTextLength(input.company ?? '', { label: 'Company', required: false, min: 1, max: 120 });
  if (compErr) errors.company = compErr;

  const interest = asTrimmedString(input.interest ?? 'advertising') || 'advertising';
  if (!(ALLOWED_CONTACT_INTERESTS as readonly string[]).includes(interest)) {
    errors.interest = 'Select a valid inquiry topic.';
  }

  const msgErr = validateTextLength(input.message, {
    label: 'Message',
    min: 10,
    max: 2000,
    allowNewlines: true,
  });
  if (msgErr) errors.message = msgErr;

  return buildResult(errors, {
    name: asTrimmedString(input.name) || '',
    email: (asTrimmedString(input.email) || '').toLowerCase(),
    company: asTrimmedString(input.company ?? '') || '',
    interest,
    message: asTrimmedString(input.message) || '',
  });
}

export function validatePrivacyRequestInput(input: {
  email?: unknown;
  requestType?: unknown;
  jurisdiction?: unknown;
  details?: unknown;
}): ValidationResult<{
  email: string;
  requestType: string;
  jurisdiction: string;
  details: string;
}> {
  const errors: FieldErrors = {};
  const emailErr = validateEmail(input.email, 'Account email');
  if (emailErr) errors.email = emailErr;

  const requestType = asTrimmedString(input.requestType ?? 'data_export') || '';
  if (!(ALLOWED_PRIVACY_TYPES as readonly string[]).includes(requestType)) {
    errors.requestType = 'Select a valid privacy request type.';
  }

  const jurisdiction = asTrimmedString(input.jurisdiction ?? 'GDPR') || '';
  if (!(ALLOWED_PRIVACY_JURISDICTIONS as readonly string[]).includes(jurisdiction)) {
    errors.jurisdiction = 'Select a valid privacy jurisdiction.';
  }

  const detailsErr = validateTextLength(input.details ?? '', {
    label: 'Details',
    required: false,
    min: 1,
    max: 2000,
    allowNewlines: true,
  });
  if (detailsErr) errors.details = detailsErr;

  return buildResult(errors, {
    email: (asTrimmedString(input.email) || '').toLowerCase(),
    requestType,
    jurisdiction,
    details: asTrimmedString(input.details ?? '') || '',
  });
}

// ============================================================================
// ADVERTISER VALIDATORS
// ============================================================================

export function validateTargetingFields(input: {
  countries?: unknown;
  languages?: unknown;
  deviceCategories?: unknown;
  operatingSystems?: unknown;
  browsers?: unknown;
  contextualCategories?: unknown;
  interestCategories?: unknown;
}): ValidationResult<{
  countries: string[];
  languages: string[];
  deviceCategories: string[];
  operatingSystems: string[];
  browsers: string[];
  contextualCategories: string[];
  interestCategories: string[];
}> {
  const errors: FieldErrors = {};

  const countriesList = parseListInput(input.countries ?? ['ALL']);
  if (!countriesList || countriesList.length === 0) {
    errors.countries = 'Provide at least one 2-letter country code or ALL.';
  } else if (countriesList.length > 50) {
    errors.countries = 'You can target at most 50 countries per campaign.';
  } else {
    const normalized = countriesList.map((c) => c.toUpperCase());
    const invalid = normalized.find((c) => c !== 'ALL' && !/^[A-Z]{2}$/.test(c));
    if (invalid) {
      errors.countries = `Invalid country code "${invalid}". Use 2-letter ISO codes (e.g. US, GB, CA) or ALL.`;
    }
  }

  const languagesList = parseListInput(input.languages ?? ['en']);
  if (!languagesList || languagesList.length === 0) {
    errors.languages = 'Provide at least one language code (e.g. en, fr) or ALL.';
  } else if (languagesList.length > 25) {
    errors.languages = 'You can target at most 25 languages per campaign.';
  } else {
    const invalid = languagesList.find((l) => l.toUpperCase() !== 'ALL' && !/^[a-zA-Z]{2,5}(?:-[a-zA-Z]{2,4})?$/.test(l));
    if (invalid) {
      errors.languages = `Invalid language code "${invalid}". Use ISO codes like en, es, fr, or ALL.`;
    }
  }

  const deviceList = parseListInput(input.deviceCategories ?? ['desktop', 'mobile']);
  if (!deviceList || deviceList.length === 0) {
    errors.deviceCategories = 'Select at least one device category (desktop, mobile, tablet, or ALL).';
  } else {
    const invalid = deviceList.find((d) => !(ALLOWED_DEVICE_CATEGORIES as readonly string[]).includes(d === 'ALL' ? 'ALL' : d.toLowerCase()));
    if (invalid) {
      errors.deviceCategories = `Unsupported device "${invalid}". Allowed: desktop, mobile, tablet, or ALL.`;
    }
  }

  const osList = parseListInput(input.operatingSystems ?? ['ALL']);
  if (!osList || osList.length === 0 || osList.length > 20 || osList.some((v) => v.length > 40)) {
    errors.operatingSystems = 'Provide valid operating systems or ALL (max 20 entries).';
  }

  const browserList = parseListInput(input.browsers ?? ['ALL']);
  if (!browserList || browserList.length === 0 || browserList.length > 20 || browserList.some((v) => v.length > 40)) {
    errors.browsers = 'Provide valid browser names or ALL (max 20 entries).';
  }

  const ctxList = parseListInput(input.contextualCategories ?? ['ALL']);
  if (!ctxList || ctxList.length === 0 || ctxList.length > 30 || ctxList.some((v) => v.length > 60)) {
    errors.contextualCategories = 'Provide valid contextual categories or ALL (max 30 entries).';
  }

  const intList = input.interestCategories === undefined ? [] : parseListInput(input.interestCategories);
  if (intList === null || intList.length > 30 || intList.some((v) => v.length > 60)) {
    errors.interestCategories = 'Interest categories must be valid labels (max 30 entries).';
  }

  return buildResult(errors, {
    countries: (countriesList || ['ALL']).map((c) => c.toUpperCase()),
    languages: (languagesList || ['en']).map((l) => (l.toUpperCase() === 'ALL' ? 'ALL' : l.toLowerCase())),
    deviceCategories: (deviceList || ['desktop', 'mobile']).map((d) => (d.toUpperCase() === 'ALL' ? 'ALL' : d.toLowerCase())),
    operatingSystems: osList || ['ALL'],
    browsers: browserList || ['ALL'],
    contextualCategories: ctxList || ['ALL'],
    interestCategories: intList || [],
  });
}

export function validateCampaignCreateInput(input: Record<string, unknown>): ValidationResult<{
  name: string;
  objective: string;
  pricingModel: string;
  biddingStrategy: string;
  pacingMode: string;
  format: string;
  dimensions: string;
  title: string;
  description: string;
  mediaUrl: string;
  destinationUrl: string;
  ctaText: string;
  trackingParams: string;
  dailyBudgetUsd: number;
  totalBudgetUsd: number;
  maxBidUsd: number;
  startDate: string;
  endDate: string;
  targeting: {
    countries: string[];
    languages: string[];
    deviceCategories: string[];
    operatingSystems: string[];
    browsers: string[];
    contextualCategories: string[];
    interestCategories: string[];
  };
}> {
  const errors: FieldErrors = {};

  const nameErr = validateTextLength(input.name, { label: 'Campaign name', min: 2, max: 120 });
  if (nameErr) errors.name = nameErr;

  const objective = asTrimmedString(input.objective ?? 'website_traffic') || '';
  if (!(ALLOWED_OBJECTIVES as readonly string[]).includes(objective)) {
    errors.objective = 'Select a valid advertising objective.';
  }

  const pricingModel = asTrimmedString(input.pricingModel ?? 'CPC') || '';
  if (!(ALLOWED_PRICING_MODELS as readonly string[]).includes(pricingModel)) {
    errors.pricingModel = 'Select a valid pricing model.';
  }

  const biddingStrategy = asTrimmedString(input.biddingStrategy ?? 'manual') || '';
  if (!(ALLOWED_BIDDING_STRATEGIES as readonly string[]).includes(biddingStrategy)) {
    errors.biddingStrategy = 'Select a valid bidding strategy.';
  }

  const pacingMode = asTrimmedString(input.pacingMode ?? 'standard') || '';
  if (!(ALLOWED_PACING_MODES as readonly string[]).includes(pacingMode)) {
    errors.pacingMode = 'Select a valid delivery pacing mode.';
  }

  const format = asTrimmedString(input.format ?? 'native') || '';
  if (!(ALLOWED_AD_FORMATS as readonly string[]).includes(format)) {
    errors.format = 'Select a valid ad format.';
  }

  const spec = getAdFormatSpec(format || 'native');

  const rawDims = asTrimmedString(input.dimensions);
  const resolvedDims = rawDims || spec.defaultDimensions;
  const dimsErr = validateDimensions(resolvedDims);
  if (dimsErr) errors.dimensions = dimsErr;

  const titleErr = validateTextLength(input.title, {
    label: spec.titleLabel,
    min: 2,
    max: Math.max(spec.titleMaxLength, 120),
  });
  if (titleErr) errors.title = titleErr;

  const descErr = validateTextLength(input.description, {
    label: spec.descriptionLabel,
    min: 4,
    max: Math.max(spec.descriptionMaxLength, 300),
    allowNewlines: true,
  });
  if (descErr) errors.description = descErr;

  const destErr = validateHttpUrl(input.destinationUrl, { label: 'Destination URL', required: true });
  if (destErr) errors.destinationUrl = destErr;

  const mediaStr = format === 'text' ? '' : asTrimmedString(input.mediaUrl ?? '') || '';
  if (format !== 'text') {
    if (mediaStr) {
      const mErr = validateMediaUrl(mediaStr, false);
      if (mErr) errors.mediaUrl = mErr;
      else if (spec.mediaMode === 'image' && isVideoMediaUrl(mediaStr)) {
        errors.mediaUrl = `${spec.label} requires an image asset rather than a video file.`;
      }
    } else if (spec.mediaRequired && input.enforceFormatMedia === true) {
      errors.mediaUrl =
        spec.mediaMode === 'video'
          ? 'Video Ad requires an MP4/WEBM video upload or direct video stream URL.'
          : `${spec.label} requires an image asset.`;
    }
  }

  const ctaStr = asTrimmedString(input.ctaText ?? 'Learn More') || 'Learn More';
  const ctaErr = validateTextLength(ctaStr, { label: 'Call-to-action label', min: 1, max: 40 });
  if (ctaErr) errors.ctaText = ctaErr;

  const trackStr = asTrimmedString(input.trackingParams ?? '') || '';
  if (trackStr) {
    const trackErr = validateTextLength(trackStr, { label: 'Tracking parameters', required: false, min: 1, max: 300 });
    if (trackErr) errors.trackingParams = trackErr;
    else if (/\s/.test(trackStr)) errors.trackingParams = 'Tracking parameters cannot contain spaces.';
  }

  const dailyRes = validateNumberRange(input.dailyBudgetUsd ?? 50, {
    label: 'Daily budget',
    min: 5,
    max: 1_000_000,
    currency: true,
  });
  if (dailyRes.error) errors.dailyBudgetUsd = dailyRes.error;

  const totalRes = validateNumberRange(input.totalBudgetUsd ?? 500, {
    label: 'Total budget',
    min: 5,
    max: 50_000_000,
    currency: true,
  });
  if (totalRes.error) errors.totalBudgetUsd = totalRes.error;

  const bidRes = validateNumberRange(input.maxBidUsd ?? 1.25, {
    label: 'Max bid',
    min: 0.05,
    max: 10_000,
    currency: true,
  });
  if (bidRes.error) errors.maxBidUsd = bidRes.error;

  if (dailyRes.value !== null && totalRes.value !== null && totalRes.value < dailyRes.value) {
    errors.totalBudgetUsd = 'Total budget must be greater than or equal to the daily budget.';
  }
  if (dailyRes.value !== null && bidRes.value !== null && bidRes.value > dailyRes.value && pricingModel !== 'FIXED') {
    errors.maxBidUsd = 'Max bid cannot exceed your daily budget cap.';
  }

  const startDate = asTrimmedString(input.startDate ?? '2026-01-01') || '2026-01-01';
  const endDate = asTrimmedString(input.endDate ?? '2027-12-31') || '2027-12-31';
  const startErr = validateIsoDate(startDate, 'Start date');
  const endErr = validateIsoDate(endDate, 'End date');
  if (startErr) errors.startDate = startErr;
  if (endErr) errors.endDate = endErr;
  if (!startErr && !endErr && endDate < startDate) {
    errors.endDate = 'End date must be on or after the start date.';
  }

  const targetingRes = validateTargetingFields({
    countries: input.countries,
    languages: input.languages,
    deviceCategories: input.deviceCategories,
    operatingSystems: input.operatingSystems,
    browsers: input.browsers,
    contextualCategories: input.contextualCategories,
    interestCategories: input.interestCategories,
  });
  Object.assign(errors, targetingRes.errors);

  let normalizedDest = asTrimmedString(input.destinationUrl) || '';
  if (!destErr && normalizedDest) {
    try {
      normalizedDest = new URL(normalizedDest).toString();
    } catch {
      // already caught
    }
  }

  return buildResult(errors, {
    name: asTrimmedString(input.name) || '',
    objective,
    pricingModel,
    biddingStrategy,
    pacingMode,
    format,
    dimensions: resolvedDims,
    title: asTrimmedString(input.title) || '',
    description: asTrimmedString(input.description) || '',
    mediaUrl: mediaStr,
    destinationUrl: normalizedDest,
    ctaText: ctaStr,
    trackingParams: trackStr,
    dailyBudgetUsd: dailyRes.value ?? 50,
    totalBudgetUsd: totalRes.value ?? 500,
    maxBidUsd: bidRes.value ?? 1.25,
    startDate,
    endDate,
    targeting: targetingRes.value || {
      countries: ['ALL'],
      languages: ['en'],
      deviceCategories: ['desktop', 'mobile'],
      operatingSystems: ['ALL'],
      browsers: ['ALL'],
      contextualCategories: ['ALL'],
      interestCategories: [],
    },
  });
}

export function validateBudgetBiddingInput(input: {
  biddingStrategy?: unknown;
  pacingMode?: unknown;
  maxBidUsd?: unknown;
  dailyBudgetUsd?: unknown;
  totalBudgetUsd?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  pricingModel?: string;
}): ValidationResult<{
  biddingStrategy: string;
  pacingMode: string;
  maxBidUsd: number;
  dailyBudgetUsd: number;
  totalBudgetUsd: number;
  startDate: string;
  endDate: string;
}> {
  const errors: FieldErrors = {};
  const biddingStrategy = asTrimmedString(input.biddingStrategy) || '';
  if (!(ALLOWED_BIDDING_STRATEGIES as readonly string[]).includes(biddingStrategy)) {
    errors.biddingStrategy = 'Select a valid bidding strategy.';
  }
  const pacingMode = asTrimmedString(input.pacingMode) || '';
  if (!(ALLOWED_PACING_MODES as readonly string[]).includes(pacingMode)) {
    errors.pacingMode = 'Select a valid pacing mode.';
  }
  const dailyRes = validateNumberRange(input.dailyBudgetUsd, {
    label: 'Daily cap',
    min: 5,
    max: 1_000_000,
    currency: true,
  });
  if (dailyRes.error) errors.dailyBudgetUsd = dailyRes.error;

  const totalRes = validateNumberRange(input.totalBudgetUsd, {
    label: 'Total budget',
    min: 5,
    max: 50_000_000,
    currency: true,
  });
  if (totalRes.error) errors.totalBudgetUsd = totalRes.error;

  const bidRes = validateNumberRange(input.maxBidUsd, {
    label: 'Max bid',
    min: 0.05,
    max: 10_000,
    currency: true,
  });
  if (bidRes.error) errors.maxBidUsd = bidRes.error;

  if (dailyRes.value !== null && totalRes.value !== null && totalRes.value < dailyRes.value) {
    errors.totalBudgetUsd = 'Total budget must be greater than or equal to the daily cap.';
  }
  if (dailyRes.value !== null && bidRes.value !== null && bidRes.value > dailyRes.value && input.pricingModel !== 'FIXED') {
    errors.maxBidUsd = 'Max bid cannot exceed the daily cap.';
  }

  const startDate = asTrimmedString(input.startDate) || '';
  const endDate = asTrimmedString(input.endDate) || '';
  if (startDate) {
    const sErr = validateIsoDate(startDate, 'Start date');
    if (sErr) errors.startDate = sErr;
  }
  if (endDate) {
    const eErr = validateIsoDate(endDate, 'End date');
    if (eErr) errors.endDate = eErr;
  }
  if (startDate && endDate && !errors.startDate && !errors.endDate && endDate < startDate) {
    errors.endDate = 'End date must be on or after the start date.';
  }

  return buildResult(errors, {
    biddingStrategy,
    pacingMode,
    maxBidUsd: bidRes.value ?? 1,
    dailyBudgetUsd: dailyRes.value ?? 50,
    totalBudgetUsd: totalRes.value ?? 500,
    startDate,
    endDate,
  });
}

export function validateAppealInput(input: { reason?: unknown }): ValidationResult<{ reason: string }> {
  const errors: FieldErrors = {};
  const err = validateTextLength(input.reason, {
    label: 'Appeal explanation',
    min: 10,
    max: 2000,
    allowNewlines: true,
  });
  if (err) errors.reason = err;
  return buildResult(errors, { reason: asTrimmedString(input.reason) || '' });
}

export function validateDepositInput(input: {
  amountUsd?: unknown;
  provider?: unknown;
  idempotencyKey?: unknown;
}): ValidationResult<{ amountUsd: number; provider: string; idempotencyKey?: string }> {
  const errors: FieldErrors = {};
  const amountRes = validateNumberRange(input.amountUsd, {
    label: 'Deposit amount',
    min: 10,
    max: 500_000,
    currency: true,
  });
  if (amountRes.error) errors.amountUsd = amountRes.error;

  const provider = asTrimmedString(input.provider ?? 'paystack') || '';
  if (!(ALLOWED_DEPOSIT_PROVIDERS as readonly string[]).includes(provider)) {
    errors.provider = 'Select a supported payment provider.';
  }

  const idem = input.idempotencyKey !== undefined ? asTrimmedString(input.idempotencyKey) : null;
  if (input.idempotencyKey !== undefined && (idem === null || idem.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(idem))) {
    errors.idempotencyKey = 'Idempotency key must be 1–120 alphanumeric/hyphen characters.';
  }

  return buildResult(errors, {
    amountUsd: amountRes.value ?? 0,
    provider,
    idempotencyKey: idem || undefined,
  });
}

export function validateRefundInput(input: {
  amountUsd?: unknown;
  reason?: unknown;
  maxAvailableUsd?: number;
}): ValidationResult<{ amountUsd: number; reason: string }> {
  const errors: FieldErrors = {};
  const amountRes = validateNumberRange(input.amountUsd, {
    label: 'Refund amount',
    min: 5,
    max: 500_000,
    currency: true,
  });
  if (amountRes.error) {
    errors.amountUsd = amountRes.error;
  } else if (
    input.maxAvailableUsd !== undefined &&
    amountRes.value !== null &&
    amountRes.value > input.maxAvailableUsd + 0.0001
  ) {
    errors.amountUsd = `Refund amount cannot exceed your available balance ($${input.maxAvailableUsd.toFixed(2)}).`;
  }

  const reasonStr = asTrimmedString(input.reason ?? 'Unused prepaid wallet balance withdrawal') || 'Unused prepaid wallet balance withdrawal';
  const reasonErr = validateTextLength(reasonStr, { label: 'Refund reason', required: false, min: 1, max: 300 });
  if (reasonErr) errors.reason = reasonErr;

  return buildResult(errors, { amountUsd: amountRes.value ?? 0, reason: reasonStr });
}

export function validateMediaUploadFile(
  file: { name: string; type: string; size: number },
  format: string
): string | null {
  const MAX_BYTES = 10 * 1024 * 1024;
  if (!file || file.size <= 0) return 'Selected file is empty.';
  if (file.size > MAX_BYTES) return 'Media file must be 10 MB or smaller.';
  const spec = getAdFormatSpec(format);
  if (spec.mediaMode === 'none') {
    return 'Text ads do not accept uploaded media files.';
  }
  const allowedImage = ['image/jpeg', 'image/png', 'image/webp'];
  const allowedVideo = ['video/mp4', 'video/webm'];
  if (spec.mediaMode === 'video' && !allowedVideo.includes(file.type)) {
    return 'Video Ad uploads must be MP4 or WEBM files.';
  }
  if (spec.mediaMode === 'image' && !allowedImage.includes(file.type)) {
    return `${spec.label} uploads must be JPEG, PNG, or WEBP images.`;
  }
  return null;
}

// ============================================================================
// PUBLISHER VALIDATORS
// ============================================================================

export function validatePropertyCreateInput(input: {
  propertyType?: unknown;
  name?: unknown;
  domainOrBundle?: unknown;
  category?: unknown;
  language?: unknown;
  monthlyPageviews?: unknown;
  verificationMethod?: unknown;
}): ValidationResult<{
  propertyType: string;
  name: string;
  domainOrBundle: string;
  category: string;
  language: string;
  monthlyPageviews: number;
  verificationMethod: string;
}> {
  const errors: FieldErrors = {};

  const propertyType = asTrimmedString(input.propertyType ?? 'website') || '';
  if (!(ALLOWED_PROPERTY_TYPES as readonly string[]).includes(propertyType)) {
    errors.propertyType = 'Select a valid property type.';
  }

  const nameErr = validateTextLength(input.name, { label: 'Property name', min: 2, max: 100 });
  if (nameErr) errors.name = nameErr;

  if (propertyType === 'ios_app' || propertyType === 'android_app') {
    const bundleErr = validateAppBundleId(input.domainOrBundle, 'App bundle ID');
    if (bundleErr) errors.domainOrBundle = bundleErr;
  } else {
    const domErr = validatePublicDomain(input.domainOrBundle, 'Domain');
    if (domErr) errors.domainOrBundle = domErr;
  }

  const category = asTrimmedString(input.category ?? 'news_technology') || 'news_technology';
  if (category.length > 60 || !/^[a-z0-9_]+$/i.test(category)) {
    errors.category = 'Select a valid content category.';
  }

  const language = asTrimmedString(input.language ?? 'en') || 'en';
  if (!/^[a-zA-Z]{2,5}(?:-[a-zA-Z]{2,4})?$/.test(language)) {
    errors.language = 'Use a valid ISO language code (for example, en).';
  }

  const viewsRes = validateNumberRange(input.monthlyPageviews ?? 50000, {
    label: 'Monthly pageviews',
    min: 0,
    max: 1_000_000_000,
    integer: true,
  });
  if (viewsRes.error) errors.monthlyPageviews = viewsRes.error;

  const verificationMethod = asTrimmedString(input.verificationMethod ?? 'dns_txt') || '';
  if (!(ALLOWED_VERIFICATION_METHODS as readonly string[]).includes(verificationMethod)) {
    errors.verificationMethod = 'Select a valid verification method.';
  }

  return buildResult(errors, {
    propertyType,
    name: asTrimmedString(input.name) || '',
    domainOrBundle: (asTrimmedString(input.domainOrBundle) || '').toLowerCase(),
    category,
    language: language.toLowerCase(),
    monthlyPageviews: viewsRes.value ?? 0,
    verificationMethod,
  });
}

export function validatePlacementCreateInput(input: {
  propertyId?: unknown;
  name?: unknown;
  format?: unknown;
  dimensions?: unknown;
  floorCpmUsd?: unknown;
}): ValidationResult<{
  propertyId: string;
  name: string;
  format: string;
  dimensions: string;
  floorCpmUsd: number;
}> {
  const errors: FieldErrors = {};

  const propId = asTrimmedString(input.propertyId);
  if (!propId) errors.propertyId = 'Select a publisher property.';

  const nameErr = validateTextLength(input.name, { label: 'Placement name', min: 2, max: 100 });
  if (nameErr) errors.name = nameErr;

  const format = asTrimmedString(input.format ?? 'native') || '';
  if (!(ALLOWED_PLACEMENT_FORMATS as readonly string[]).includes(format)) {
    errors.format = 'Select a valid placement format.';
  }

  const dimensions = asTrimmedString(input.dimensions ?? 'responsive') || 'responsive';
  const dimErr = validateDimensions(dimensions);
  if (dimErr) errors.dimensions = dimErr;

  const floorRes = validateNumberRange(input.floorCpmUsd ?? 0.75, {
    label: 'Floor CPM',
    min: 0.1,
    max: 500,
    currency: true,
  });
  if (floorRes.error) errors.floorCpmUsd = floorRes.error;

  return buildResult(errors, {
    propertyId: propId || '',
    name: asTrimmedString(input.name) || '',
    format,
    dimensions,
    floorCpmUsd: floorRes.value ?? 0.75,
  });
}

export function validatePayoutMethodInput(input: {
  payoutMethodType?: unknown;
  payoutDestination?: unknown;
}): ValidationResult<{ payoutMethodType: string; payoutDestination: string }> {
  const errors: FieldErrors = {};
  const method = asTrimmedString(input.payoutMethodType) || '';
  if (!(ALLOWED_PAYOUT_METHODS as readonly string[]).includes(method)) {
    errors.payoutMethodType = 'Select a supported payout method.';
  }
  const destErr = validateTextLength(input.payoutDestination, {
    label: 'Account / recipient destination',
    min: 6,
    max: 160,
  });
  if (destErr) errors.payoutDestination = destErr;

  return buildResult(errors, {
    payoutMethodType: method,
    payoutDestination: asTrimmedString(input.payoutDestination) || '',
  });
}

export function validateWithdrawalInput(input: {
  amountUsd?: unknown;
  minPayoutUsd?: number;
  maxAvailableUsd?: number;
  payoutMethod?: unknown;
  payoutDestination?: unknown;
}): ValidationResult<{ amountUsd: number; payoutMethod?: string; payoutDestination?: string }> {
  const errors: FieldErrors = {};
  const minUsd = input.minPayoutUsd ?? 50;
  const amountRes = validateNumberRange(input.amountUsd, {
    label: 'Withdrawal amount',
    min: minUsd,
    max: 1_000_000,
    currency: true,
  });
  if (amountRes.error) {
    errors.amountUsd = amountRes.error;
  } else if (
    input.maxAvailableUsd !== undefined &&
    amountRes.value !== null &&
    amountRes.value > input.maxAvailableUsd + 0.0001
  ) {
    errors.amountUsd = `Withdrawal amount cannot exceed your available balance ($${input.maxAvailableUsd.toFixed(2)}).`;
  }

  let method: string | undefined;
  if (input.payoutMethod !== undefined && input.payoutMethod !== '') {
    const m = asTrimmedString(input.payoutMethod) || '';
    if (!(ALLOWED_PAYOUT_METHODS as readonly string[]).includes(m)) {
      errors.payoutMethod = 'Unsupported payout method.';
    } else {
      method = m;
    }
  }

  let dest: string | undefined;
  if (input.payoutDestination !== undefined && input.payoutDestination !== '') {
    const destErr = validateTextLength(input.payoutDestination, {
      label: 'Payout destination',
      min: 6,
      max: 160,
    });
    if (destErr) errors.payoutDestination = destErr;
    else dest = asTrimmedString(input.payoutDestination) || undefined;
  }

  return buildResult(errors, {
    amountUsd: amountRes.value ?? 0,
    payoutMethod: method,
    payoutDestination: dest,
  });
}

// ============================================================================
// ADMIN VALIDATORS
// ============================================================================

export function validateProhibitedCategoryInput(input: {
  name?: unknown;
  keywords?: unknown;
  severity?: unknown;
}): ValidationResult<{ name: string; keywords: string[]; severity: 'block' | 'review' }> {
  const errors: FieldErrors = {};
  const nameErr = validateTextLength(input.name, { label: 'Category name', min: 2, max: 80 });
  if (nameErr) errors.name = nameErr;

  const keywords = parseListInput(input.keywords);
  if (!keywords || keywords.length === 0) {
    errors.keywords = 'Enter at least one trigger keyword (comma-separated).';
  } else if (keywords.length > 50) {
    errors.keywords = 'A policy rule can have at most 50 trigger keywords.';
  } else {
    const bad = keywords.find((k) => k.length < 2 || k.length > 60 || hasControlChars(k));
    if (bad) {
      errors.keywords = 'Each keyword must be 2–60 valid characters.';
    }
  }

  const severity = asTrimmedString(input.severity ?? 'block') || '';
  if (severity !== 'block' && severity !== 'review') {
    errors.severity = 'Severity must be block or review.';
  }

  return buildResult(errors, {
    name: asTrimmedString(input.name) || '',
    keywords: keywords || [],
    severity: severity as 'block' | 'review',
  });
}

export function validatePlatformSettingsInput(input: Record<string, unknown>): ValidationResult<Record<string, unknown>> {
  const errors: FieldErrors = {};
  const normalized: Record<string, unknown> = {};

  const NUMERIC_BOUNDS: Record<string, { min: number; max: number; label: string }> = {
    default_publisher_share_bps: { min: 1000, max: 9500, label: 'Default publisher revenue share (bps)' },
    minimum_publisher_payout_micros: { min: 1_000_000, max: 10_000_000_000, label: 'Minimum publisher payout (micros)' },
    minimum_campaign_budget_micros: { min: 1_000_000, max: 10_000_000_000, label: 'Minimum campaign budget (micros)' },
  };

  const BOOLEAN_KEYS = new Set([
    'gdpr_consent_enforcement',
    'looma_first_party_only_mode',
    'external_publisher_registration_enabled',
    'third_party_sdk_distribution_enabled',
    'third_party_revenue_allocation_enabled',
    'third_party_publisher_payouts_enabled',
    'postpaid_advertiser_credit_enabled',
    'admin_claimed',
  ]);

  for (const [key, val] of Object.entries(input)) {
    if (!/^[a-z0-9_]{2,64}$/.test(key)) {
      errors[key] = `Invalid setting key "${key}".`;
      continue;
    }
    if (key in NUMERIC_BOUNDS) {
      const rule = NUMERIC_BOUNDS[key];
      const res = validateNumberRange(val, { label: rule.label, min: rule.min, max: rule.max, integer: true });
      if (res.error) errors[key] = res.error;
      else normalized[key] = res.value;
    } else if (BOOLEAN_KEYS.has(key)) {
      if (typeof val !== 'boolean') {
        errors[key] = `${key} must be true or false.`;
      } else {
        normalized[key] = val;
      }
    } else {
      normalized[key] = val;
    }
  }

  return buildResult(errors, normalized);
}
