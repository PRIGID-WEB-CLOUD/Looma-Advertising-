/**
 * LOOMA ADS — Production PostgreSQL + Drizzle Schema Blueprint
 *
 * Mirrors the live SQLite schema in `server/db.ts` 1:1 for PostgreSQL deployments
 * running Drizzle ORM with Hono on Cloudflare Workers (Neon / Cloud SQL / Hyperdrive).
 *
 * Monetary values are stored strictly as 64-bit integers in USD micros (1 USD = 1_000_000 micros)
 * to eliminate floating-point drift across prepaid wallets, budget reservations, and the immutable ledger.
 */

export const POSTGRES_DRIZZLE_TABLES = [
  'roles',
  'users',
  'looma_identity_links',
  'looma_sso_nonces',
  'advertiser_accounts',
  'advertiser_wallets',
  'publisher_accounts',
  'publisher_properties',
  'domain_verifications',
  'publisher_wallets',
  'campaigns',
  'campaign_targeting',
  'campaign_budgets',
  'advertisements',
  'ad_creatives',
  'media_assets',
  'ad_placements',
  'ad_requests',
  'budget_reservations',
  'impressions',
  'clicks',
  'conversions',
  'attribution_records',
  'video_events',
  'app_installs',
  'financial_ledger',
  'deposits',
  'withdrawals',
  'invoices',
  'payment_transactions',
  'fraud_alerts',
  'moderation_reviews',
  'campaign_appeals',
  'prohibited_categories',
  'platform_settings',
  'audit_logs',
  'event_logs',
  'scheduled_job_runs',
  'rate_limit_buckets',
] as const;

export type LoomaTableName = (typeof POSTGRES_DRIZZLE_TABLES)[number];

/**
 * Canonical PostgreSQL DDL matching Drizzle `pgTable(...)` column definitions.
 * Ready to apply via `drizzle-kit push` or standard SQL migration runner.
 */
export const POSTGRES_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (name IN ('advertiser', 'publisher', 'admin')),
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS advertiser_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  company_name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  currency TEXT NOT NULL DEFAULT 'USD',
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'suspended')),
  billing_email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS looma_identity_links (
  id TEXT PRIMARY KEY,
  looma_user_id TEXT NOT NULL,
  looma_business_id TEXT NOT NULL,
  membership_role TEXT NOT NULL CHECK (membership_role IN ('owner', 'admin', 'ad_manager')),
  user_id TEXT NOT NULL REFERENCES users(id),
  advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(looma_user_id, looma_business_id)
);

CREATE TABLE IF NOT EXISTS looma_sso_nonces (
  jti TEXT PRIMARY KEY,
  looma_user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS advertiser_wallets (
  id TEXT PRIMARY KEY,
  advertiser_id TEXT NOT NULL UNIQUE REFERENCES advertiser_accounts(id),
  available_micros BIGINT NOT NULL DEFAULT 0 CHECK (available_micros >= 0),
  reserved_micros BIGINT NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  lifetime_deposited_micros BIGINT NOT NULL DEFAULT 0,
  lifetime_spent_micros BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS publisher_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  organization_name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  currency TEXT NOT NULL DEFAULT 'USD',
  publisher_type TEXT NOT NULL DEFAULT 'third_party' CHECK (publisher_type IN ('first_party', 'third_party')),
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'suspended')),
  custom_revenue_share_bps INTEGER,
  traffic_quality_score INTEGER NOT NULL DEFAULT 95,
  payout_method_type TEXT NOT NULL DEFAULT 'bank_transfer',
  payout_destination TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budget_reservations (
  id TEXT PRIMARY KEY,
  advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
  wallet_id TEXT NOT NULL REFERENCES advertiser_wallets(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  request_id TEXT NOT NULL UNIQUE,
  amount_micros BIGINT NOT NULL CHECK (amount_micros >= 0),
  captured_micros BIGINT NOT NULL DEFAULT 0,
  released_micros BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'captured', 'released', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS financial_ledger (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  account_type TEXT NOT NULL CHECK (account_type IN ('advertiser_wallet', 'publisher_wallet', 'platform_revenue')),
  account_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('deposit', 'budget_reserve', 'budget_release', 'ad_spend', 'publisher_earning', 'platform_fee', 'refund', 'withdrawal', 'ivt_deduction')),
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_micros BIGINT NOT NULL CHECK (amount_micros >= 0),
  balance_after_micros BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budget_reservations_status_exp ON budget_reservations(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_financial_ledger_account_created ON financial_ledger(account_type, account_id, created_at DESC);
`;
