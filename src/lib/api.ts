export type UserRole = 'advertiser' | 'publisher' | 'admin';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
}

const TOKEN_STORAGE_KEY = 'looma_ads_auth_token';

function readStoredToken(): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

let inMemoryToken: string | null = readStoredToken();
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

export function setAuthToken(token: string | null) {
  inMemoryToken = token;
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (token) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage access errors in restricted contexts
  }
}

export function getAuthToken(): string | null {
  if (!inMemoryToken) {
    inMemoryToken = readStoredToken();
  }
  return inMemoryToken;
}

export class ApiError extends Error {
  status: number;
  fieldErrors?: Record<string, string>;

  constructor(message: string, status: number, fieldErrors?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export function extractFieldErrors(err: unknown): Record<string, string> {
  if (err instanceof ApiError && err.fieldErrors) {
    return err.fieldErrors;
  }
  return {};
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (inMemoryToken) {
    headers.set('Authorization', `Bearer ${inMemoryToken}`);
  }

  const response = await fetch(path, {
    ...options,
    headers,
  });

  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();

  const tryParseJson = (): Record<string, unknown> | null => {
    if (!rawText) return null;
    try {
      return JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  if (!response.ok) {
    if (
      response.status === 401 &&
      inMemoryToken &&
      !path.startsWith('/api/auth/login') &&
      !path.startsWith('/api/auth/register') &&
      !path.startsWith('/api/auth/reset-password')
    ) {
      setAuthToken(null);
      unauthorizedHandler?.();
    }
    let errorMessage = `Request failed (${response.status})`;
    let fieldErrors: Record<string, string> | undefined;
    const errData = tryParseJson();
    if (errData && typeof errData.error === 'string') {
      errorMessage = errData.error;
    }
    if (errData && typeof errData.fieldErrors === 'object' && errData.fieldErrors !== null && !Array.isArray(errData.fieldErrors)) {
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(errData.fieldErrors as Record<string, unknown>)) {
        if (typeof v === 'string') cleaned[k] = v;
      }
      if (Object.keys(cleaned).length > 0) fieldErrors = cleaned;
    }
    throw new ApiError(errorMessage, response.status, fieldErrors);
  }

  if (contentType.includes('text/csv')) {
    return rawText as unknown as T;
  }

  if (!rawText) {
    return {} as T;
  }

  const parsed = tryParseJson();
  if (parsed === null) {
    throw new Error('Unexpected non-JSON response received from server. Please refresh and try again.');
  }

  return parsed as T;
}

export interface FxRateEntry {
  rate: number;
  symbol: string;
  name: string;
}

let activeDisplayCurrency = 'USD';
let fxRates: Record<string, FxRateEntry> = {
  USD: { rate: 1, symbol: '$', name: 'US Dollar' },
  EUR: { rate: 0.92, symbol: '€', name: 'Euro' },
  GBP: { rate: 0.79, symbol: '£', name: 'British Pound' },
  CAD: { rate: 1.38, symbol: 'CA$', name: 'Canadian Dollar' },
  NGN: { rate: 1580, symbol: '₦', name: 'Nigerian Naira' },
  KES: { rate: 129, symbol: 'KSh', name: 'Kenyan Shilling' },
};

export function setFxRates(next: Record<string, FxRateEntry>) {
  fxRates = { ...fxRates, ...next };
}

export function getFxRates(): Record<string, FxRateEntry> {
  return fxRates;
}

export function setDisplayCurrency(currency: string) {
  const code = String(currency || 'USD').toUpperCase();
  if (fxRates[code]) {
    activeDisplayCurrency = code;
  }
}

export function getDisplayCurrency(): string {
  return activeDisplayCurrency;
}

export function formatMicros(micros: number | null | undefined, maximumFractionDigits = 2): string {
  const entry = fxRates[activeDisplayCurrency] ?? fxRates.USD;
  const val = ((Number(micros) || 0) / 1_000_000) * entry.rate;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: activeDisplayCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits,
    }).format(val);
  } catch {
    return `${entry.symbol}${val.toFixed(maximumFractionDigits)}`;
  }
}

export function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}

export function formatPct(ratio: number | null | undefined): string {
  const pct = (Number(ratio) || 0) * 100;
  return `${pct.toFixed(2)}%`;
}
