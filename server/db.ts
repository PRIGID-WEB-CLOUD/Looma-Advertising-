import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let sharedDb: DatabaseSync | null = null;

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role_id TEXT NOT NULL REFERENCES roles(id),
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS advertiser_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
      company_name TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'US',
      currency TEXT NOT NULL DEFAULT 'USD',
      verification_status TEXT NOT NULL DEFAULT 'pending',
      account_status TEXT NOT NULL DEFAULT 'active',
      billing_email TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS publisher_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
      organization_name TEXT NOT NULL,
      publisher_type TEXT NOT NULL DEFAULT 'third_party' CHECK (publisher_type IN ('first_party', 'third_party')),
      country TEXT NOT NULL DEFAULT 'US',
      currency TEXT NOT NULL DEFAULT 'USD',
      approval_status TEXT NOT NULL DEFAULT 'pending',
      traffic_quality_score INTEGER NOT NULL DEFAULT 95,
      custom_revenue_share_bps INTEGER,
      payout_method_type TEXT NOT NULL DEFAULT 'bank_transfer',
      payout_destination TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS publisher_properties (
      id TEXT PRIMARY KEY,
      publisher_id TEXT NOT NULL REFERENCES publisher_accounts(id),
      property_type TEXT NOT NULL CHECK (property_type IN ('website', 'ios_app', 'android_app', 'web_app')),
      name TEXT NOT NULL,
      domain_or_bundle TEXT NOT NULL,
      category TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      verification_status TEXT NOT NULL DEFAULT 'pending',
      approval_status TEXT NOT NULL DEFAULT 'pending',
      monthly_pageviews INTEGER NOT NULL DEFAULT 0,
      gdpr_consent_required INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS domain_verifications (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES publisher_properties(id),
      method TEXT NOT NULL CHECK (method IN ('dns_txt', 'meta_tag', 'ads_txt')),
      verification_token TEXT NOT NULL,
      verified_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
      name TEXT NOT NULL,
      objective TEXT NOT NULL,
      pricing_model TEXT NOT NULL CHECK (pricing_model IN ('CPM', 'CPC', 'CPA', 'CPI', 'CPV', 'FIXED')),
      bidding_strategy TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('draft', 'pending_review', 'active', 'paused', 'rejected', 'archived', 'suspended')),
      moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'suspended')),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      frequency_cap_per_session INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS campaign_targeting (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL UNIQUE REFERENCES campaigns(id),
      countries_json TEXT NOT NULL DEFAULT '["ALL"]',
      regions_json TEXT NOT NULL DEFAULT '[]',
      cities_json TEXT NOT NULL DEFAULT '[]',
      languages_json TEXT NOT NULL DEFAULT '["en"]',
      device_categories_json TEXT NOT NULL DEFAULT '["desktop","mobile","tablet"]',
      operating_systems_json TEXT NOT NULL DEFAULT '["ALL"]',
      browsers_json TEXT NOT NULL DEFAULT '["ALL"]',
      interest_categories_json TEXT NOT NULL DEFAULT '[]',
      contextual_categories_json TEXT NOT NULL DEFAULT '[]',
      custom_segments_json TEXT NOT NULL DEFAULT '[]',
      retargeting_enabled INTEGER NOT NULL DEFAULT 0,
      consent_required INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS campaign_budgets (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL UNIQUE REFERENCES campaigns(id),
      daily_budget_micros INTEGER NOT NULL,
      total_budget_micros INTEGER NOT NULL,
      spent_today_micros INTEGER NOT NULL DEFAULT 0,
      spent_total_micros INTEGER NOT NULL DEFAULT 0,
      max_bid_micros INTEGER NOT NULL,
      pacing_mode TEXT NOT NULL DEFAULT 'standard' CHECK (pacing_mode IN ('standard', 'accelerated')),
      currency TEXT NOT NULL DEFAULT 'USD',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS advertisements (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
      name TEXT NOT NULL,
      format TEXT NOT NULL CHECK (format IN ('image', 'banner', 'native', 'text', 'video', 'responsive', 'sponsored')),
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ad_creatives (
      id TEXT PRIMARY KEY,
      advertisement_id TEXT NOT NULL REFERENCES advertisements(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      media_url TEXT NOT NULL DEFAULT '',
      destination_url TEXT NOT NULL,
      cta_text TEXT NOT NULL DEFAULT 'Learn More',
      tracking_params TEXT NOT NULL DEFAULT '',
      dimensions TEXT NOT NULL DEFAULT 'responsive',
      approval_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ad_placements (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES publisher_properties(id),
      publisher_id TEXT NOT NULL REFERENCES publisher_accounts(id),
      name TEXT NOT NULL,
      format TEXT NOT NULL CHECK (format IN ('banner', 'responsive', 'native', 'video', 'in_feed', 'interstitial')),
      dimensions TEXT NOT NULL DEFAULT 'responsive',
      floor_cpm_micros INTEGER NOT NULL DEFAULT 500000,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
      integration_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ad_requests (
      id TEXT PRIMARY KEY,
      placement_id TEXT NOT NULL REFERENCES ad_placements(id),
      property_id TEXT NOT NULL REFERENCES publisher_properties(id),
      publisher_id TEXT NOT NULL REFERENCES publisher_accounts(id),
      winning_campaign_id TEXT REFERENCES campaigns(id),
      winning_creative_id TEXT REFERENCES ad_creatives(id),
      country TEXT NOT NULL DEFAULT 'US',
      device_category TEXT NOT NULL DEFAULT 'desktop',
      os TEXT NOT NULL DEFAULT 'Web',
      browser TEXT NOT NULL DEFAULT 'Chrome',
      language TEXT NOT NULL DEFAULT 'en',
      category TEXT NOT NULL DEFAULT 'general',
      consent_granted INTEGER NOT NULL DEFAULT 1,
      filled INTEGER NOT NULL DEFAULT 0,
      ip_hash TEXT NOT NULL,
      session_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS impressions (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE REFERENCES ad_requests(id),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      creative_id TEXT NOT NULL REFERENCES ad_creatives(id),
      placement_id TEXT NOT NULL REFERENCES ad_placements(id),
      publisher_id TEXT NOT NULL REFERENCES publisher_accounts(id),
      advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
      viewable INTEGER NOT NULL DEFAULT 1,
      is_valid INTEGER NOT NULL DEFAULT 1,
      billed_micros INTEGER NOT NULL DEFAULT 0,
      publisher_share_micros INTEGER NOT NULL DEFAULT 0,
      platform_fee_micros INTEGER NOT NULL DEFAULT 0,
      country TEXT NOT NULL DEFAULT 'US',
      device_category TEXT NOT NULL DEFAULT 'desktop',
      ip_hash TEXT NOT NULL,
      session_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clicks (
      id TEXT PRIMARY KEY,
      impression_id TEXT NOT NULL REFERENCES impressions(id),
      request_id TEXT NOT NULL REFERENCES ad_requests(id),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      creative_id TEXT NOT NULL REFERENCES ad_creatives(id),
      placement_id TEXT NOT NULL REFERENCES ad_placements(id),
      publisher_id TEXT NOT NULL REFERENCES publisher_accounts(id),
      advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
      is_valid INTEGER NOT NULL DEFAULT 1,
      invalid_reason TEXT,
      billed_micros INTEGER NOT NULL DEFAULT 0,
      publisher_share_micros INTEGER NOT NULL DEFAULT 0,
      platform_fee_micros INTEGER NOT NULL DEFAULT 0,
      ip_hash TEXT NOT NULL,
      session_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversions (
      id TEXT PRIMARY KEY,
      click_id TEXT REFERENCES clicks(id),
      request_id TEXT REFERENCES ad_requests(id),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
      publisher_id TEXT NOT NULL REFERENCES publisher_accounts(id),
      event_name TEXT NOT NULL DEFAULT 'purchase',
      conversion_value_micros INTEGER NOT NULL DEFAULT 0,
      billed_micros INTEGER NOT NULL DEFAULT 0,
      publisher_share_micros INTEGER NOT NULL DEFAULT 0,
      platform_fee_micros INTEGER NOT NULL DEFAULT 0,
      is_valid INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attribution_records (
      id TEXT PRIMARY KEY,
      conversion_id TEXT NOT NULL UNIQUE REFERENCES conversions(id),
      click_id TEXT REFERENCES clicks(id),
      impression_id TEXT REFERENCES impressions(id),
      attribution_model TEXT NOT NULL DEFAULT 'last_click',
      window_hours INTEGER NOT NULL DEFAULT 168,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS event_logs (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fraud_alerts (
      id TEXT PRIMARY KEY,
      publisher_id TEXT REFERENCES publisher_accounts(id),
      campaign_id TEXT REFERENCES campaigns(id),
      signal_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
      description TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'confirmed_ivt', 'dismissed')),
      reviewed_by TEXT REFERENCES users(id),
      resolution_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS advertiser_wallets (
      id TEXT PRIMARY KEY,
      advertiser_id TEXT NOT NULL UNIQUE REFERENCES advertiser_accounts(id),
      available_micros INTEGER NOT NULL DEFAULT 0 CHECK (available_micros >= 0),
      reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
      lifetime_deposited_micros INTEGER NOT NULL DEFAULT 0,
      lifetime_spent_micros INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS publisher_wallets (
      id TEXT PRIMARY KEY,
      publisher_id TEXT NOT NULL UNIQUE REFERENCES publisher_accounts(id),
      estimated_micros INTEGER NOT NULL DEFAULT 0,
      available_micros INTEGER NOT NULL DEFAULT 0 CHECK (available_micros >= 0),
      pending_micros INTEGER NOT NULL DEFAULT 0 CHECK (pending_micros >= 0),
      lifetime_earned_micros INTEGER NOT NULL DEFAULT 0,
      invalid_deducted_micros INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS financial_ledger (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      account_type TEXT NOT NULL CHECK (account_type IN ('advertiser_wallet', 'publisher_wallet', 'platform_revenue')),
      account_id TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('deposit', 'ad_spend', 'budget_reserve', 'budget_release', 'publisher_earning', 'platform_commission', 'ivt_deduction', 'withdrawal', 'refund')),
      direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
      amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
      balance_after_micros INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS budget_reservations (
      id TEXT PRIMARY KEY,
      advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
      wallet_id TEXT NOT NULL REFERENCES advertiser_wallets(id),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      request_id TEXT NOT NULL UNIQUE,
      amount_micros INTEGER NOT NULL CHECK (amount_micros > 0),
      captured_micros INTEGER NOT NULL DEFAULT 0 CHECK (captured_micros >= 0),
      released_micros INTEGER NOT NULL DEFAULT 0 CHECK (released_micros >= 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'captured', 'released', 'expired')),
      expires_at TEXT NOT NULL,
      settled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS looma_identity_links (
      id TEXT PRIMARY KEY,
      looma_user_id TEXT NOT NULL,
      looma_business_id TEXT NOT NULL,
      membership_role TEXT NOT NULL CHECK (membership_role IN ('owner', 'admin', 'ad_manager', 'viewer')),
      user_id TEXT NOT NULL REFERENCES users(id),
      advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
      last_verified_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (looma_user_id, looma_business_id)
    );

    CREATE TABLE IF NOT EXISTS looma_sso_nonces (
      jti TEXT PRIMARY KEY,
      looma_user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id TEXT PRIMARY KEY,
      advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
      provider TEXT NOT NULL CHECK (provider IN ('paystack', 'flutterwave', 'stripe', 'bank_transfer')),
      provider_ref TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      amount_micros INTEGER NOT NULL CHECK (amount_micros > 0),
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY,
      publisher_id TEXT NOT NULL REFERENCES publisher_accounts(id),
      amount_micros INTEGER NOT NULL CHECK (amount_micros > 0),
      currency TEXT NOT NULL DEFAULT 'USD',
      payout_method TEXT NOT NULL,
      payout_destination TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
      reviewed_by TEXT REFERENCES users(id),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
      invoice_number TEXT NOT NULL UNIQUE,
      deposit_id TEXT REFERENCES deposits(id),
      amount_micros INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'paid',
      issued_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payment_transactions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL UNIQUE,
      transaction_type TEXT NOT NULL,
      amount_micros INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS revenue_shares (
      id TEXT PRIMARY KEY,
      publisher_id TEXT REFERENCES publisher_accounts(id),
      publisher_bps INTEGER NOT NULL,
      platform_bps INTEGER NOT NULL,
      effective_from TEXT NOT NULL DEFAULT (datetime('now')),
      notes TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'system',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS moderation_reviews (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL CHECK (target_type IN ('campaign', 'creative', 'property', 'advertiser', 'publisher')),
      target_id TEXT NOT NULL,
      reviewer_id TEXT REFERENCES users(id),
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'suspended', 'appeal_submitted', 'policy_flagged')),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id),
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS privacy_requests (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      request_type TEXT NOT NULL CHECK (request_type IN ('data_export', 'data_deletion', 'consent_withdrawal')),
      jurisdiction TEXT NOT NULL DEFAULT 'GDPR',
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'received',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contact_inquiries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      interest TEXT NOT NULL DEFAULT 'advertising',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      timezone TEXT NOT NULL DEFAULT 'UTC',
      preferred_currency TEXT NOT NULL DEFAULT 'USD',
      compact_density INTEGER NOT NULL DEFAULT 0,
      email_alerts INTEGER NOT NULL DEFAULT 1,
      fraud_alerts INTEGER NOT NULL DEFAULT 1,
      weekly_digest INTEGER NOT NULL DEFAULT 1,
      two_factor_enabled INTEGER NOT NULL DEFAULT 0,
      session_timeout_minutes INTEGER NOT NULL DEFAULT 60,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rate_limit_buckets (
      bucket_key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      reset_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_job_runs (
      id TEXT PRIMARY KEY,
      job_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
      summary TEXT NOT NULL,
      affected_count INTEGER NOT NULL DEFAULT 0,
      triggered_by TEXT NOT NULL DEFAULT 'scheduler',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token_type TEXT NOT NULL CHECK (token_type IN ('email_verify', 'password_reset')),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS totp_secrets (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      secret_base32 TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      backup_codes_hash_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_outbox (
      id TEXT PRIMARY KEY,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'transactional',
      delivery_status TEXT NOT NULL DEFAULT 'queued',
      provider_response TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS video_events (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES ad_requests(id),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      creative_id TEXT NOT NULL REFERENCES ad_creatives(id),
      placement_id TEXT NOT NULL REFERENCES ad_placements(id),
      publisher_id TEXT NOT NULL REFERENCES publisher_accounts(id),
      advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
      event_name TEXT NOT NULL CHECK (event_name IN ('start', 'first_quartile', 'midpoint', 'third_quartile', 'complete', 'mute', 'unmute')),
      viewable_ms INTEGER NOT NULL DEFAULT 0,
      billed_micros INTEGER NOT NULL DEFAULT 0,
      publisher_share_micros INTEGER NOT NULL DEFAULT 0,
      platform_fee_micros INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_installs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE REFERENCES ad_requests(id),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
      publisher_id TEXT NOT NULL REFERENCES publisher_accounts(id),
      app_bundle_id TEXT NOT NULL,
      device_os TEXT NOT NULL DEFAULT 'iOS',
      billed_micros INTEGER NOT NULL DEFAULT 0,
      publisher_share_micros INTEGER NOT NULL DEFAULT 0,
      platform_fee_micros INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS campaign_appeals (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      advertiser_id TEXT NOT NULL REFERENCES advertiser_accounts(id),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected')),
      reviewer_id TEXT REFERENCES users(id),
      resolution_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS prohibited_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      keywords_json TEXT NOT NULL DEFAULT '[]',
      severity TEXT NOT NULL DEFAULT 'block' CHECK (severity IN ('block', 'review')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS revoked_tokens (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_campaigns_advertiser ON campaigns(advertiser_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status, moderation_status);
    CREATE INDEX IF NOT EXISTS idx_impressions_campaign ON impressions(campaign_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_impressions_publisher ON impressions(publisher_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_clicks_campaign ON clicks(campaign_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_clicks_ip_time ON clicks(ip_hash, created_at);
    CREATE INDEX IF NOT EXISTS idx_ledger_account ON financial_ledger(account_type, account_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_video_events_request ON video_events(request_id, event_name);
    CREATE INDEX IF NOT EXISTS idx_appeals_status ON campaign_appeals(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_reservations_status_exp ON budget_reservations(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_reservations_advertiser ON budget_reservations(advertiser_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_looma_links_user ON looma_identity_links(looma_user_id, looma_business_id);
  `);

  // Safe migrations for existing SQLite databases
  const userCols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!userCols.some((c) => c.name === 'email_verified')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  }
  if (!userCols.some((c) => c.name === 'token_valid_after')) {
    db.exec('ALTER TABLE users ADD COLUMN token_valid_after INTEGER NOT NULL DEFAULT 0');
  }

  const pubCols = db.prepare('PRAGMA table_info(publisher_accounts)').all() as Array<{ name: string }>;
  if (!pubCols.some((c) => c.name === 'publisher_type')) {
    db.exec("ALTER TABLE publisher_accounts ADD COLUMN publisher_type TEXT NOT NULL DEFAULT 'third_party'");
  }

  // Upgrade legacy financial_ledger table if CHECK constraint lacks budget_reserve / budget_release
  const ledgerSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'financial_ledger'")
    .get() as { sql: string } | undefined;
  if (ledgerSqlRow?.sql && !ledgerSqlRow.sql.includes('budget_reserve')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE financial_ledger_v2 (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          account_type TEXT NOT NULL CHECK (account_type IN ('advertiser_wallet', 'publisher_wallet', 'platform_revenue')),
          account_id TEXT NOT NULL,
          entry_type TEXT NOT NULL CHECK (entry_type IN ('deposit', 'ad_spend', 'budget_reserve', 'budget_release', 'publisher_earning', 'platform_commission', 'ivt_deduction', 'withdrawal', 'refund')),
          direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
          amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
          balance_after_micros INTEGER NOT NULL,
          currency TEXT NOT NULL DEFAULT 'USD',
          reference_type TEXT NOT NULL,
          reference_id TEXT NOT NULL,
          description TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO financial_ledger_v2 SELECT * FROM financial_ledger;
        DROP TABLE financial_ledger;
        ALTER TABLE financial_ledger_v2 RENAME TO financial_ledger;
        CREATE INDEX IF NOT EXISTS idx_ledger_account ON financial_ledger(account_type, account_id, created_at);
        COMMIT;
      `);
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // ignore rollback error
      }
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  // Upgrade legacy moderation_reviews table if CHECK constraint lacks 'policy_flagged'
  const modSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'moderation_reviews'")
    .get() as { sql: string } | undefined;
  if (modSqlRow?.sql && !modSqlRow.sql.includes('policy_flagged')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE moderation_reviews_v2 (
          id TEXT PRIMARY KEY,
          target_type TEXT NOT NULL CHECK (target_type IN ('campaign', 'creative', 'property', 'advertiser', 'publisher')),
          target_id TEXT NOT NULL,
          reviewer_id TEXT REFERENCES users(id),
          decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'suspended', 'appeal_submitted', 'policy_flagged')),
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO moderation_reviews_v2 SELECT * FROM moderation_reviews;
        DROP TABLE moderation_reviews;
        ALTER TABLE moderation_reviews_v2 RENAME TO moderation_reviews;
        COMMIT;
      `);
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // ignore rollback error
      }
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }
}

export function getDb(customPath?: string): DatabaseSync {
  if (customPath) {
    const db = new DatabaseSync(customPath);
    initSchema(db);
    return db;
  }
  if (!sharedDb) {
    const dataDir = path.resolve(process.cwd(), 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const dbFile = path.join(dataDir, 'looma-ads.db');
    sharedDb = new DatabaseSync(dbFile);
    initSchema(sharedDb);
  }
  return sharedDb;
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback failure when transaction already aborted
    }
    throw error;
  }
}
