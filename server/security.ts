import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import type { DatabaseSync } from 'node:sqlite';

// ============================================================================
// 1. MULTI-CURRENCY FX RATES (Base ledger stays strictly in integer USD micros)
// ============================================================================
export const FX_RATES: Record<string, { rate: number; symbol: string; name: string }> = {
  USD: { rate: 1, symbol: '$', name: 'US Dollar' },
  EUR: { rate: 0.92, symbol: '€', name: 'Euro' },
  GBP: { rate: 0.79, symbol: '£', name: 'British Pound' },
  CAD: { rate: 1.38, symbol: 'CA$', name: 'Canadian Dollar' },
  NGN: { rate: 1580, symbol: '₦', name: 'Nigerian Naira' },
  KES: { rate: 129, symbol: 'KSh', name: 'Kenyan Shilling' },
};

export function convertUsdMicrosToCurrency(usdMicros: number, currency: string): number {
  const code = currency.toUpperCase();
  const entry = FX_RATES[code] ?? FX_RATES.USD;
  return (usdMicros / 1_000_000) * entry.rate;
}

// ============================================================================
// 2. RFC 6238 TOTP (Authenticator App 2FA — Pure Node Crypto)
// ============================================================================
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encodeBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function decodeBase32(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateBase32Secret(byteLength = 20): string {
  return encodeBase32(crypto.randomBytes(byteLength));
}

export function generateTotpCode(secretBase32: string, timestampMs = Date.now(), stepSeconds = 30): string {
  const key = decodeBase32(secretBase32);
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

export function verifyTotpCode(secretBase32: string, code: string, timestampMs = Date.now(), window = 1): boolean {
  const normalized = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const candidateBuf = Buffer.from(normalized, 'utf8');
  for (let delta = -window; delta <= window; delta++) {
    const expected = generateTotpCode(secretBase32, timestampMs + delta * 30_000);
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (expectedBuf.length === candidateBuf.length && crypto.timingSafeEqual(expectedBuf, candidateBuf)) {
      return true;
    }
  }
  return false;
}

export function buildOtpAuthUri(email: string, secretBase32: string, issuer = 'Looma Advertising'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ============================================================================
// 3. CRYPTOGRAPHIC WEBHOOK SIGNATURE VERIFICATION
// ============================================================================
export function verifyPaystackSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(signatureHeader.trim().toLowerCase(), 'utf8');
  const expBuf = Buffer.from(expected.toLowerCase(), 'utf8');
  return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
}

export function verifyFlutterwaveSignature(verifHashHeader: string | undefined, secretHash: string): boolean {
  if (!verifHashHeader || !secretHash) return false;
  const sigBuf = Buffer.from(verifHashHeader.trim(), 'utf8');
  const expBuf = Buffer.from(secretHash.trim(), 'utf8');
  return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
}

export function verifyStripeSignature(
  rawBody: Buffer,
  stripeSigHeader: string | undefined,
  webhookSecret: string,
  toleranceSeconds = 300,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  if (!stripeSigHeader || !webhookSecret) return false;
  const parts = Object.fromEntries(
    stripeSigHeader.split(',').map((kv) => {
      const idx = kv.indexOf('=');
      return idx > 0 ? [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()] : [kv.trim(), ''];
    })
  );
  const timestamp = Number(parts.t);
  const sigV1 = parts.v1;
  if (!Number.isFinite(timestamp) || !sigV1) return false;
  if (Math.abs(nowSec - timestamp) > toleranceSeconds) return false;

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');
  const sigBuf = Buffer.from(sigV1.toLowerCase(), 'utf8');
  const expBuf = Buffer.from(expected.toLowerCase(), 'utf8');
  return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
}

// ============================================================================
// 4. PAYMENT PROVIDER CHECKOUT & PAYOUT ADAPTERS (LIVE + SANDBOX)
// ============================================================================
export interface ProviderCheckoutResult {
  mode: 'live' | 'sandbox';
  providerRef: string;
  checkoutUrl: string | null;
  status: 'completed' | 'pending';
}

export async function initializeProviderDeposit(params: {
  provider: 'paystack' | 'flutterwave' | 'stripe' | 'bank_transfer';
  amountUsd: number;
  email: string;
  reference: string;
}): Promise<ProviderCheckoutResult> {
  const { provider, amountUsd, email, reference } = params;

  if (provider === 'paystack' && process.env.PAYSTACK_SECRET_KEY) {
    const res = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        amount: Math.round(amountUsd * 100),
        currency: 'USD',
        reference,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { status?: boolean; data?: { reference?: string; authorization_url?: string }; message?: string };
    if (!res.ok || !data.status) {
      throw new Error(data.message || 'Paystack transaction initialization failed');
    }
    return {
      mode: 'live',
      providerRef: data.data?.reference || reference,
      checkoutUrl: data.data?.authorization_url || null,
      status: 'pending',
    };
  }

  if (provider === 'flutterwave' && process.env.FLUTTERWAVE_SECRET_KEY) {
    const res = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tx_ref: reference,
        amount: amountUsd,
        currency: 'USD',
        customer: { email },
        customizations: { title: 'Looma Advertising Prepaid Wallet' },
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { status?: string; data?: { link?: string }; message?: string };
    if (!res.ok || data.status !== 'success') {
      throw new Error(data.message || 'Flutterwave checkout initialization failed');
    }
    return {
      mode: 'live',
      providerRef: reference,
      checkoutUrl: data.data?.link || null,
      status: 'pending',
    };
  }

  if (provider === 'stripe' && process.env.STRIPE_SECRET_KEY) {
    const body = new URLSearchParams({
      amount: String(Math.round(amountUsd * 100)),
      currency: 'usd',
      'metadata[reference]': reference,
      receipt_email: email,
    });
    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { id?: string; error?: { message?: string } };
    if (!res.ok || !data.id) {
      throw new Error(data.error?.message || 'Stripe PaymentIntent initialization failed');
    }
    return {
      mode: 'live',
      providerRef: data.id,
      checkoutUrl: null,
      status: 'pending',
    };
  }

  return {
    mode: 'sandbox',
    providerRef: `${provider.slice(0, 3).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    checkoutUrl: null,
    status: 'completed',
  };
}

export async function dispatchProviderPayout(params: {
  payoutMethod: string;
  destination: string;
  amountUsd: number;
  withdrawalId: string;
}): Promise<{ mode: 'live' | 'sandbox'; transferRef: string }> {
  const { payoutMethod, destination, amountUsd, withdrawalId } = params;
  // Live Paystack transfer when Paystack secret is configured and destination is a recipient code
  if (payoutMethod === 'paystack' && process.env.PAYSTACK_SECRET_KEY && destination.startsWith('RCP_')) {
    const res = await fetch('https://api.paystack.co/transfer', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'balance',
        amount: Math.round(amountUsd * 100),
        recipient: destination,
        reference: withdrawalId,
        reason: 'Looma Advertising Publisher Settlement',
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { status?: boolean; data?: { transfer_code?: string }; message?: string };
    if (!res.ok || !data.status) {
      throw new Error(data.message || 'Paystack transfer dispatch failed');
    }
    return { mode: 'live', transferRef: data.data?.transfer_code || withdrawalId };
  }

  return {
    mode: 'sandbox',
    transferRef: `TRF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
  };
}

// ============================================================================
// 5. SSRF-SAFE LIVE DOMAIN & ADS.TXT VERIFICATION
// ============================================================================
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80') ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:169.254.') ||
      normalized.startsWith('::ffff:192.168.')
    );
  }
  return true;
}

export function isValidPublicDomain(input: string): string | null {
  const raw = String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  if (!raw || raw.length > 253) return null;
  if (net.isIP(raw)) return null;
  if (raw === 'localhost' || raw.endsWith('.local') || raw.endsWith('.internal') || raw.endsWith('.localhost')) {
    return null;
  }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(raw)) {
    return null;
  }
  return raw;
}

export interface LiveVerificationOutcome {
  verified: boolean;
  method: string;
  checkedTarget: string;
  recordsChecked: number;
  detail: string;
}

export async function verifyDomainOwnershipLive(
  domainOrBundle: string,
  method: 'dns_txt' | 'ads_txt' | 'meta_tag',
  expectedToken: string
): Promise<LiveVerificationOutcome> {
  const domain = isValidPublicDomain(domainOrBundle);
  if (!domain) {
    return {
      verified: false,
      method,
      checkedTarget: domainOrBundle,
      recordsChecked: 0,
      detail: 'Domain must be a valid public hostname (no IP addresses or local hostnames).',
    };
  }

  // Resolve IP addresses first to block SSRF to loopback/private/link-local targets
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(domain, { all: true });
  } catch {
    return {
      verified: false,
      method,
      checkedTarget: domain,
      recordsChecked: 0,
      detail: `DNS lookup failed for ${domain}. Ensure DNS records have propagated.`,
    };
  }

  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    return {
      verified: false,
      method,
      checkedTarget: domain,
      recordsChecked: 0,
      detail: `Blocked verification for ${domain}: resolves to a non-public or private IP range.`,
    };
  }

  if (method === 'dns_txt') {
    try {
      const txtGroups = await dns.resolveTxt(domain);
      const flattened = txtGroups.map((chunks) => chunks.join(''));
      const matched = flattened.some((record) => record.includes(expectedToken));
      return {
        verified: matched,
        method,
        checkedTarget: `TXT ${domain}`,
        recordsChecked: flattened.length,
        detail: matched
          ? `Verified live DNS TXT token on ${domain}.`
          : `Checked ${flattened.length} TXT record(s) on ${domain}; token "${expectedToken}" not found yet.`,
      };
    } catch {
      return {
        verified: false,
        method,
        checkedTarget: `TXT ${domain}`,
        recordsChecked: 0,
        detail: `No DNS TXT records found for ${domain}.`,
      };
    }
  }

  const targetUrl = method === 'ads_txt' ? `https://${domain}/ads.txt` : `https://${domain}/`;
  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'error',
      headers: { 'User-Agent': 'LoomaAdsVerifier/1.0' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return {
        verified: false,
        method,
        checkedTarget: targetUrl,
        recordsChecked: 0,
        detail: `HTTP ${res.status} returned from ${targetUrl}.`,
      };
    }
    const text = (await res.text()).slice(0, 65536);
    const matched = text.includes(expectedToken);
    return {
      verified: matched,
      method,
      checkedTarget: targetUrl,
      recordsChecked: 1,
      detail: matched
        ? `Verified live ${method === 'ads_txt' ? 'ads.txt entry' : 'HTML meta token'} at ${targetUrl}.`
        : `Fetched ${targetUrl}, but token "${expectedToken}" was not present.`,
    };
  } catch (err) {
    return {
      verified: false,
      method,
      checkedTarget: targetUrl,
      recordsChecked: 0,
      detail: `Unable to fetch ${targetUrl}: ${err instanceof Error ? err.message : 'network error'}`,
    };
  }
}

// ============================================================================
// 6. PROHIBITED POLICY CATEGORY SCANNER
// ============================================================================
export interface PolicyViolation {
  categoryId: string;
  categoryName: string;
  severity: 'block' | 'review';
  matchedKeyword: string;
}

export function scanProhibitedContent(
  text: string,
  rules: Array<{ id: string; name: string; keywords: string[]; severity: 'block' | 'review'; active: boolean }>
): PolicyViolation[] {
  const haystack = String(text || '').toLowerCase();
  const violations: PolicyViolation[] = [];

  for (const rule of rules) {
    if (!rule.active) continue;
    for (const kw of rule.keywords) {
      const cleanKw = kw.trim().toLowerCase();
      if (!cleanKw) continue;
      if (haystack.includes(cleanKw)) {
        violations.push({
          categoryId: rule.id,
          categoryName: rule.name,
          severity: rule.severity,
          matchedKeyword: cleanKw,
        });
        break;
      }
    }
  }
  return violations;
}

// ============================================================================
// 7. TRANSACTIONAL EMAIL DISPATCHER (DB OUTBOX + OPTIONAL WEBHOOK)
// ============================================================================
export function queueTransactionalEmail(
  db: DatabaseSync,
  params: { to: string; subject: string; bodyText: string; category?: string }
): string {
  const id = `eml_${crypto.randomUUID().slice(0, 12)}`;
  const webhookUrl = process.env.EMAIL_WEBHOOK_URL;
  const status = webhookUrl ? 'dispatched' : 'logged';

  db.prepare(
    `INSERT INTO email_outbox (id, recipient_email, subject, body_text, category, delivery_status, provider_response)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.to,
    params.subject,
    params.bodyText,
    params.category || 'transactional',
    status,
    webhookUrl ? 'Async dispatch queued' : 'Stored in transactional outbox (configure EMAIL_WEBHOOK_URL for live SMTP/API)'
  );

  if (webhookUrl) {
    fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.EMAIL_API_KEY ? { Authorization: `Bearer ${process.env.EMAIL_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'noreply@looma-ads.com',
        to: params.to,
        subject: params.subject,
        text: params.bodyText,
      }),
      signal: AbortSignal.timeout(6000),
    }).catch((err) => {
      console.error('Transactional email webhook dispatch failed:', err);
    });
  }

  return id;
}

// ============================================================================
// 8. MAGIC-BYTE MEDIA VALIDATION
// ============================================================================
export const ALLOWED_MEDIA_MIMES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

export function validateMediaMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 12) return false;
  if (mimeType === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  if (mimeType === 'image/webp') {
    return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (mimeType === 'video/mp4') {
    return buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  if (mimeType === 'video/webm') {
    return buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
  }
  return false;
}
