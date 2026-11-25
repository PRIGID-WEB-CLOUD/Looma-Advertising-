import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './auth';
import { seedFeatureFlagsIfMissing } from './modules/featureFlags';

function ensureLoomaFirstPartyPublisher(db: DatabaseSync): void {
  seedFeatureFlagsIfMissing(db);

  // Ensure roles exist before linking Looma 1P publisher user
  db.prepare("INSERT OR IGNORE INTO roles (id, name, description) VALUES ('role_advertiser', 'advertiser', 'Advertiser workspace access')").run();
  db.prepare("INSERT OR IGNORE INTO roles (id, name, description) VALUES ('role_publisher', 'publisher', 'Publisher monetization workspace access')").run();
  db.prepare("INSERT OR IGNORE INTO roles (id, name, description) VALUES ('role_admin', 'admin', 'Platform administrator ecosystem access')").run();

  const loomaSecret = crypto.randomBytes(16).toString('hex');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, email, full_name, password_hash, role_id, status, email_verified)
     VALUES ('usr_pub_looma', 'feed-ops@looma.app', 'Looma Feed Operations', ?, 'role_publisher', 'active', 1)`
  ).run(hashPassword(loomaSecret));

  db.prepare(
    `INSERT OR IGNORE INTO publisher_accounts
       (id, user_id, organization_name, publisher_type, country, currency, approval_status, traffic_quality_score, custom_revenue_share_bps, payout_method_type, payout_destination)
     VALUES ('pub_looma_1p', 'usr_pub_looma', 'Looma (First-Party Feed)', 'first_party', 'US', 'USD', 'approved', 99, 10000, 'internal_treasury', 'Looma First-Party Settlement Ledger')`
  ).run();

  db.prepare(
    `INSERT OR IGNORE INTO publisher_wallets
       (id, publisher_id, estimated_micros, available_micros, pending_micros, lifetime_earned_micros, invalid_deducted_micros, currency)
     VALUES ('wal_pub_looma_1p', 'pub_looma_1p', 124_500_000, 912_400_000, 0, 912_400_000, 0, 'USD')`
  ).run();

  db.prepare(
    `INSERT OR IGNORE INTO publisher_properties
       (id, publisher_id, property_type, name, domain_or_bundle, category, language, verification_status, approval_status, monthly_pageviews, gdpr_consent_required)
     VALUES ('prop_looma_feed', 'pub_looma_1p', 'web_app', 'Looma Primary Feed', 'looma.app', 'business_finance', 'en', 'verified', 'approved', 12_500_000, 1)`
  ).run();

  db.prepare(
    `INSERT OR IGNORE INTO domain_verifications (id, property_id, method, verification_token, verified_at, status)
     VALUES ('ver_looma_1p', 'prop_looma_feed', 'dns_txt', 'looma-first-party-adapter=verified', datetime('now'), 'verified')`
  ).run();

  db.prepare(
    `INSERT OR IGNORE INTO ad_placements
       (id, property_id, publisher_id, name, format, dimensions, floor_cpm_micros, status, integration_verified)
     VALUES ('plc_looma_feed_native', 'prop_looma_feed', 'pub_looma_1p', 'Looma Home Feed — Native Slot', 'native', 'responsive', 1_000_000, 'active', 1)`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO ad_placements
       (id, property_id, publisher_id, name, format, dimensions, floor_cpm_micros, status, integration_verified)
     VALUES ('plc_looma_feed_infeed', 'prop_looma_feed', 'pub_looma_1p', 'Looma Discovery Feed — In-Feed Card', 'in_feed', 'responsive', 1_100_000, 'active', 1)`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO ad_placements
       (id, property_id, publisher_id, name, format, dimensions, floor_cpm_micros, status, integration_verified)
     VALUES ('plc_looma_discover_banner', 'prop_looma_feed', 'pub_looma_1p', 'Looma Explore — Responsive Banner', 'responsive', '728x90', 900_000, 'active', 1)`
  ).run();

  // Ensure existing seeded third-party publishers remain explicitly typed as third_party
  db.prepare("UPDATE publisher_accounts SET publisher_type = 'third_party' WHERE id IN ('pub_1', 'pub_2')").run();
}

export function seedDatabaseIfEmpty(db: DatabaseSync): void {
  // Always ensure default prohibited policy categories exist (idempotent for existing DBs)
  const insertPolicy = db.prepare(
    `INSERT OR IGNORE INTO prohibited_categories (id, name, keywords_json, severity, active)
     VALUES (?, ?, ?, ?, 1)`
  );
  insertPolicy.run(
    'pol_counterfeit',
    'Counterfeit & Replica Goods',
    JSON.stringify(['replica watch', 'counterfeit', 'fake luxury', 'knockoff designer']),
    'block'
  );
  insertPolicy.run(
    'pol_malware',
    'Malware & Phishing',
    JSON.stringify(['free password stealer', 'keylogger', 'phishing kit', 'trojan download']),
    'block'
  );
  insertPolicy.run(
    'pol_gambling',
    'Unlicensed Gambling',
    JSON.stringify(['unlicensed casino', 'offshore betting hack', 'guaranteed jackpot']),
    'block'
  );
  insertPolicy.run(
    'pol_substances',
    'Controlled Substances',
    JSON.stringify(['buy prescription without rx', 'illegal narcotics', 'unregulated steroids']),
    'block'
  );
  insertPolicy.run(
    'pol_financial',
    'Deceptive Financial Claims',
    JSON.stringify(['guaranteed 1000% return', 'risk-free crypto doubler', 'get rich overnight']),
    'review'
  );

  const existing = db.prepare('SELECT COUNT(*) AS count FROM roles').get() as { count: number };
  if (existing.count > 0) {
    ensureLoomaFirstPartyPublisher(db);
    db.prepare(
      `UPDATE users SET email_verified = 1 WHERE id IN ('usr_adv_1', 'usr_adv_2', 'usr_pub_1', 'usr_pub_2', 'usr_pub_looma', 'usr_admin_1')`
    ).run();
    return;
  }

  ensureLoomaFirstPartyPublisher(db);

  // Platform settings
  const insertSetting = db.prepare(
    'INSERT INTO platform_settings (key, value_json) VALUES (?, ?)'
  );
  insertSetting.run('supported_currencies', JSON.stringify(['USD', 'EUR', 'GBP', 'NGN', 'KES']));
  insertSetting.run('default_publisher_share_bps', JSON.stringify(7000)); // 70%
  insertSetting.run('minimum_publisher_payout_micros', JSON.stringify(50_000_000)); // $50.00
  insertSetting.run('minimum_campaign_budget_micros', JSON.stringify(25_000_000)); // $25.00
  insertSetting.run('prohibited_categories', JSON.stringify(['counterfeit_goods', 'malware', 'unlicensed_gambling', 'deceptive_claims']));
  insertSetting.run('enabled_ad_formats', JSON.stringify(['image', 'banner', 'native', 'text', 'video', 'responsive', 'sponsored']));
  insertSetting.run('require_advertiser_kyb', JSON.stringify(true));
  insertSetting.run('gdpr_consent_enforcement', JSON.stringify(true));

  // Demo users (passwords hashed via scrypt with random salt; demo quick-entry uses dedicated sandbox route)
  const demoSecret = crypto.randomBytes(16).toString('hex');
  const insertUser = db.prepare(
    'INSERT INTO users (id, email, full_name, password_hash, role_id, status, email_verified) VALUES (?, ?, ?, ?, ?, ?, 1)'
  );
  insertUser.run('usr_adv_1', 'maya.lin@atlascommerce.io', 'Maya Lin', hashPassword(demoSecret), 'role_advertiser', 'active');
  insertUser.run('usr_adv_2', 'lucas.weber@nordiccloud.de', 'Lucas Weber', hashPassword(demoSecret), 'role_advertiser', 'active');
  insertUser.run('usr_pub_1', 'kofi.mensah@meridiandigital.media', 'Kofi Mensah', hashPassword(demoSecret), 'role_publisher', 'active');
  insertUser.run('usr_pub_2', 'sofia.rossi@finpulse.eu', 'Sofia Rossi', hashPassword(demoSecret), 'role_publisher', 'active');
  insertUser.run('usr_admin_1', 'elena.vance@looma-ads.com', 'Elena Vance', hashPassword(demoSecret), 'role_admin', 'active');

  // Advertisers
  const insertAdv = db.prepare(
    `INSERT INTO advertiser_accounts (id, user_id, company_name, country, currency, verification_status, account_status, billing_email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertAdv.run('adv_1', 'usr_adv_1', 'Atlas Commerce Global', 'US', 'USD', 'verified', 'active', 'finance@atlascommerce.io');
  insertAdv.run('adv_2', 'usr_adv_2', 'Nordic Cloud Systems GmbH', 'DE', 'USD', 'pending', 'active', 'ap@nordiccloud.de');

  // External Publishers (architecturally supported, disabled by feature flags at launch)
  const insertPub = db.prepare(
    `INSERT INTO publisher_accounts (id, user_id, organization_name, publisher_type, country, currency, approval_status, traffic_quality_score, custom_revenue_share_bps, payout_method_type, payout_destination)
     VALUES (?, ?, ?, 'third_party', ?, ?, ?, ?, ?, ?, ?)`
  );
  insertPub.run('pub_1', 'usr_pub_1', 'Meridian Digital Media', 'GB', 'USD', 'approved', 96, 7200, 'bank_transfer', 'IBAN •••• 4821 (Barclays UK)');
  insertPub.run('pub_2', 'usr_pub_2', 'FinPulse Europe S.r.l.', 'IT', 'USD', 'pending', 89, null, 'paystack', 'Meridian Treasury •••• 9104');

  // Revenue shares
  db.prepare(
    'INSERT INTO revenue_shares (id, publisher_id, publisher_bps, platform_bps, notes) VALUES (?, ?, ?, ?, ?)'
  ).run('rev_1', 'pub_1', 7200, 2800, 'Preferred editorial partner rate (72% / 28%)');

  // Wallets
  db.prepare(
    `INSERT INTO advertiser_wallets (id, advertiser_id, available_micros, reserved_micros, lifetime_deposited_micros, lifetime_spent_micros, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('wal_adv_1', 'adv_1', 6_361_400_000, 0, 6_500_000_000, 138_600_000, 'USD');
  db.prepare(
    `INSERT INTO advertiser_wallets (id, advertiser_id, available_micros, reserved_micros, lifetime_deposited_micros, lifetime_spent_micros, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('wal_adv_2', 'adv_2', 1_250_000_000, 0, 1_500_000_000, 250_000_000, 'USD');

  db.prepare(
    `INSERT INTO publisher_wallets (id, publisher_id, estimated_micros, available_micros, pending_micros, lifetime_earned_micros, invalid_deducted_micros, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('wal_pub_1', 'pub_1', 99_792_000, 642_840_000, 180_000_000, 822_840_000, 14_200_000, 'USD');
  db.prepare(
    `INSERT INTO publisher_wallets (id, publisher_id, estimated_micros, available_micros, pending_micros, lifetime_earned_micros, invalid_deducted_micros, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('wal_pub_2', 'pub_2', 180_000_000, 42_000_000, 138_000_000, 180_000_000, 3_500_000, 'USD');

  // Deposits & Invoices & Ledger
  db.prepare(
    `INSERT INTO deposits (id, advertiser_id, provider, provider_ref, idempotency_key, amount_micros, currency, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('dep_1', 'adv_1', 'paystack', 'PSK-90418274', 'idem_dep_seed_1', 4_000_000_000, 'USD', 'completed');
  db.prepare(
    `INSERT INTO deposits (id, advertiser_id, provider, provider_ref, idempotency_key, amount_micros, currency, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('dep_2', 'adv_1', 'stripe', 'pi_3Q9Looma8241', 'idem_dep_seed_2', 2_500_000_000, 'USD', 'completed');

  db.prepare(
    `INSERT INTO invoices (id, advertiser_id, invoice_number, deposit_id, amount_micros, currency, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('inv_1', 'adv_1', 'LOOMA-INV-2026-0041', 'dep_1', 4_000_000_000, 'USD', 'paid');
  db.prepare(
    `INSERT INTO invoices (id, advertiser_id, invoice_number, deposit_id, amount_micros, currency, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('inv_2', 'adv_1', 'LOOMA-INV-2026-0087', 'dep_2', 2_500_000_000, 'USD', 'paid');

  const insertLedger = db.prepare(
    `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertLedger.run('led_1', 'idem_seed_led_1', 'advertiser_wallet', 'wal_adv_1', 'deposit', 'credit', 4_000_000_000, 4_000_000_000, 'USD', 'deposit', 'dep_1', 'Prepaid wallet deposit via Paystack (PSK-90418274)');
  insertLedger.run('led_2', 'idem_seed_led_2', 'advertiser_wallet', 'wal_adv_1', 'deposit', 'credit', 2_500_000_000, 6_500_000_000, 'USD', 'deposit', 'dep_2', 'Prepaid wallet deposit via Stripe (pi_3Q9Looma8241)');
  insertLedger.run('led_3', 'idem_seed_led_3', 'advertiser_wallet', 'wal_adv_1', 'ad_spend', 'debit', 138_600_000, 6_361_400_000, 'USD', 'campaign_batch', 'cmp_1', 'Verified ad delivery spend settlement (7-day cycle)');
  insertLedger.run('led_4', 'idem_seed_led_4', 'publisher_wallet', 'wal_pub_1', 'publisher_earning', 'credit', 99_792_000, 642_840_000, 'USD', 'settlement', 'pub_1', 'Finalized publisher revenue share (72%)');
  insertLedger.run('led_5', 'idem_seed_led_5', 'platform_revenue', 'looma_treasury', 'platform_commission', 'credit', 38_808_000, 38_808_000, 'USD', 'settlement', 'pub_1', 'Platform ad-serving commission');

  // Withdrawals
  db.prepare(
    `INSERT INTO withdrawals (id, publisher_id, amount_micros, currency, payout_method, payout_destination, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('wdr_1', 'pub_1', 300_000_000, 'USD', 'bank_transfer', 'IBAN •••• 4821 (Barclays UK)', 'paid', 'October monthly settlement');
  db.prepare(
    `INSERT INTO withdrawals (id, publisher_id, amount_micros, currency, payout_method, payout_destination, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('wdr_2', 'pub_1', 180_000_000, 'USD', 'bank_transfer', 'IBAN •••• 4821 (Barclays UK)', 'pending', 'November mid-cycle withdrawal request');

  // Publisher Properties & Verifications
  const insertProp = db.prepare(
    `INSERT INTO publisher_properties (id, publisher_id, property_type, name, domain_or_bundle, category, language, verification_status, approval_status, monthly_pageviews, gdpr_consent_required)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertProp.run('prop_1', 'pub_1', 'website', 'Meridian Business Daily', 'meridiandaily.com', 'business_finance', 'en', 'verified', 'approved', 2_450_000, 1);
  insertProp.run('prop_2', 'pub_1', 'ios_app', 'Meridian Reader iOS', 'com.meridianmedia.reader', 'news_technology', 'en', 'verified', 'approved', 890_000, 1);
  insertProp.run('prop_3', 'pub_2', 'website', 'FinPulse Europe', 'finpulse.eu', 'fintech', 'en', 'verified', 'pending', 540_000, 1);

  db.prepare(
    `INSERT INTO domain_verifications (id, property_id, method, verification_token, verified_at, status)
     VALUES (?, ?, ?, ?, datetime('now'), ?)`
  ).run('ver_1', 'prop_1', 'dns_txt', 'looma-verify=m94x81k2q', 'verified');
  db.prepare(
    `INSERT INTO domain_verifications (id, property_id, method, verification_token, verified_at, status)
     VALUES (?, ?, ?, ?, datetime('now'), ?)`
  ).run('ver_2', 'prop_3', 'ads_txt', 'looma-ads.com, pub_2, DIRECT, f81a9c2e', 'verified');

  // Ad Placements
  const insertPlace = db.prepare(
    `INSERT INTO ad_placements (id, property_id, publisher_id, name, format, dimensions, floor_cpm_micros, status, integration_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertPlace.run('plc_meridian_native', 'prop_1', 'pub_1', 'Article In-Feed Native Unit', 'native', 'responsive', 1_200_000, 'active', 1);
  insertPlace.run('plc_meridian_banner', 'prop_1', 'pub_1', 'Top Leaderboard 728x90', 'banner', '728x90', 900_000, 'active', 1);
  insertPlace.run('plc_meridian_ios_interstitial', 'prop_2', 'pub_1', 'iOS Reader Interstitial', 'interstitial', '320x480', 2_500_000, 'active', 1);
  insertPlace.run('plc_finpulse_sidebar', 'prop_3', 'pub_2', 'Sidebar Responsive Unit', 'responsive', '300x250', 1_000_000, 'active', 0);

  // Campaigns
  const insertCamp = db.prepare(
    `INSERT INTO campaigns (id, advertiser_id, name, objective, pricing_model, bidding_strategy, status, moderation_status, start_date, end_date, frequency_cap_per_session)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertCamp.run('cmp_1', 'adv_1', 'Atlas Titanium Corporate Card — Q4 Launch', 'sales_conversions', 'CPC', 'manual', 'active', 'approved', '2026-01-01', '2027-12-31', 5);
  insertCamp.run('cmp_2', 'adv_1', 'Atlas Cloud Workstation Awareness', 'brand_awareness', 'CPM', 'target_cpm', 'active', 'approved', '2026-01-01', '2027-12-31', 4);
  insertCamp.run('cmp_3', 'adv_1', 'Stride Lab Trail Runner Acquisition', 'website_traffic', 'CPA', 'target_cpa', 'active', 'approved', '2026-01-01', '2027-12-31', 3);
  insertCamp.run('cmp_4', 'adv_2', 'Nordic Cloud Enterprise DevOps', 'lead_generation', 'CPC', 'manual', 'pending_review', 'pending', '2026-01-01', '2027-12-31', 3);

  // Targeting
  const insertTarget = db.prepare(
    `INSERT INTO campaign_targeting (id, campaign_id, countries_json, regions_json, cities_json, languages_json, device_categories_json, operating_systems_json, browsers_json, interest_categories_json, contextual_categories_json, custom_segments_json, retargeting_enabled, consent_required)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertTarget.run('tgt_1', 'cmp_1', '["US","GB","DE","NG","CA","ALL"]', '[]', '[]', '["en","ALL"]', '["desktop","mobile","tablet"]', '["ALL"]', '["ALL"]', '["finance","b2b_saas"]', '["business_finance","fintech","news_technology","ALL"]', '["enterprise_buyers"]', 0, 1);
  insertTarget.run('tgt_2', 'cmp_2', '["ALL"]', '[]', '[]', '["ALL"]', '["desktop","mobile","tablet"]', '["ALL"]', '["ALL"]', '["technology","hardware"]', '["ALL"]', '[]', 0, 1);
  insertTarget.run('tgt_3', 'cmp_3', '["US","GB","DE","FR","ALL"]', '[]', '[]', '["en","ALL"]', '["desktop","mobile"]', '["ALL"]', '["ALL"]', '["retail","fitness"]', '["ALL"]', '[]', 1, 1);
  insertTarget.run('tgt_4', 'cmp_4', '["DE","GB","US"]', '[]', '[]', '["en","de"]', '["desktop"]', '["ALL"]', '["ALL"]', '["cloud","devops"]', '["news_technology","business_finance"]', '[]', 0, 1);

  // Budgets
  const insertBudget = db.prepare(
    `INSERT INTO campaign_budgets (id, campaign_id, daily_budget_micros, total_budget_micros, spent_today_micros, spent_total_micros, max_bid_micros, pacing_mode, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertBudget.run('bdg_1', 'cmp_1', 350_000_000, 4_500_000_000, 14_500_000, 43_500_000, 1_450_000, 'standard', 'USD'); // $1.45 max CPC
  insertBudget.run('bdg_2', 'cmp_2', 200_000_000, 2_500_000_000, 13_600_000, 41_100_000, 6_800_000, 'standard', 'USD'); // $6.80 CPM
  insertBudget.run('bdg_3', 'cmp_3', 180_000_000, 1_800_000_000, 18_000_000, 54_000_000, 18_000_000, 'accelerated', 'USD'); // $18.00 CPA
  insertBudget.run('bdg_4', 'cmp_4', 250_000_000, 2_000_000_000, 0, 0, 2_100_000, 'standard', 'USD'); // $2.10 CPC

  // Advertisements & Creatives (referencing generated studio photography)
  const insertAd = db.prepare(
    'INSERT INTO advertisements (id, campaign_id, advertiser_id, name, format, status) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertAd.run('ad_1', 'cmp_1', 'adv_1', 'Titanium Card Native Showcase', 'native', 'active');
  insertAd.run('ad_2', 'cmp_2', 'adv_1', 'Workstation Display Banner', 'banner', 'active');
  insertAd.run('ad_3', 'cmp_3', 'adv_1', 'Trail Runner Responsive Feature', 'responsive', 'active');
  insertAd.run('ad_4', 'cmp_4', 'adv_2', 'Nordic Cloud Text Unit', 'text', 'active');

  const insertCreative = db.prepare(
    `INSERT INTO ad_creatives (id, advertisement_id, title, description, media_url, destination_url, cta_text, tracking_params, dimensions, approval_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertCreative.run(
    'crt_1',
    'ad_1',
    'Atlas Titanium Treasury Card',
    'Multi-currency corporate spend controls with automated real-time reconciliation for global finance teams.',
    '/src/assets/images/creative_fintech_card_1795552815861.jpg',
    'https://atlascommerce.io/treasury-card',
    'Request Card',
    'utm_source=looma&utm_medium=native&utm_campaign=q4_treasury',
    'responsive',
    'approved'
  );
  insertCreative.run(
    'crt_2',
    'ad_2',
    'Precision Aluminum Studio Display',
    '6K color-calibrated workstation engineered for distributed engineering and media teams.',
    '/src/assets/images/creative_cloud_hardware_1795552815294.jpg',
    'https://atlascommerce.io/workstation',
    'Explore Hardware',
    'utm_source=looma&utm_medium=banner&utm_campaign=workstation_awareness',
    '728x90',
    'approved'
  );
  insertCreative.run(
    'crt_3',
    'ad_3',
    'Terra-01 Technical Trail Sneaker',
    'Lightweight carbon-stabilized outsole built for long-distance endurance across wet stone and trail.',
    '/src/assets/images/creative_retail_sneaker_1795552816794.jpg',
    'https://atlascommerce.io/terra-01',
    'Shop Collection',
    'utm_source=looma&utm_medium=responsive&utm_campaign=terra_launch',
    'responsive',
    'approved'
  );
  insertCreative.run(
    'crt_4',
    'ad_4',
    'Sovereign Kubernetes Clusters in EU',
    'Deploy ISO-27001 compliant clusters across Frankfurt and Stockholm with deterministic billing.',
    '',
    'https://nordiccloud.de/enterprise',
    'Start Trial',
    'utm_source=looma&utm_medium=text&utm_campaign=eu_devops',
    'responsive',
    'pending'
  );

  // Historical Ad Requests, Impressions, Clicks, Conversions across last 7 days with realistic varied volume
  const insertReq = db.prepare(
    `INSERT INTO ad_requests (id, placement_id, property_id, publisher_id, winning_campaign_id, winning_creative_id, country, device_category, os, browser, language, category, consent_granted, filled, ip_hash, session_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
  );
  const insertImp = db.prepare(
    `INSERT INTO impressions (id, request_id, campaign_id, creative_id, placement_id, publisher_id, advertiser_id, viewable, is_valid, billed_micros, publisher_share_micros, platform_fee_micros, country, device_category, ip_hash, session_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
  );
  const insertClk = db.prepare(
    `INSERT INTO clicks (id, impression_id, request_id, campaign_id, creative_id, placement_id, publisher_id, advertiser_id, is_valid, invalid_reason, billed_micros, publisher_share_micros, platform_fee_micros, ip_hash, session_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
  );
  const insertCnv = db.prepare(
    `INSERT INTO conversions (id, click_id, request_id, campaign_id, advertiser_id, publisher_id, event_name, conversion_value_micros, billed_micros, publisher_share_micros, platform_fee_micros, is_valid, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
  );

  const countries = ['US', 'GB', 'DE', 'NG', 'CA'];
  const devices = ['desktop', 'mobile', 'tablet'];
  const dailyVolumes = [24, 38, 31, 49, 42, 57, 44]; // 285 varied events over 7 days

  let seq = 0;
  for (let dIdx = 0; dIdx < dailyVolumes.length; dIdx++) {
    const dayOffset = `-${6 - dIdx} days`;
    const countForDay = dailyVolumes[dIdx];
    for (let j = 0; j < countForDay; j++) {
      const i = seq++;
      const campIdx = i % 3;
      const cmpId = campIdx === 0 ? 'cmp_1' : campIdx === 1 ? 'cmp_2' : 'cmp_3';
      const crtId = campIdx === 0 ? 'crt_1' : campIdx === 1 ? 'crt_2' : 'crt_3';
      const plcId = campIdx === 1 ? 'plc_meridian_banner' : 'plc_meridian_native';
      const country = countries[i % countries.length];
      const device = devices[i % devices.length];
      const reqId = `req_seed_${i}`;
      const impId = `imp_seed_${i}`;
      const ipHash = `ip_seed_${i % 29}`;
      const sessHash = `sess_seed_${i}`;

      insertReq.run(reqId, plcId, 'prop_1', 'pub_1', cmpId, crtId, country, device, 'macOS', 'Chrome', 'en', 'business_finance', 1, 1, ipHash, sessHash, dayOffset);

      const impBill = cmpId === 'cmp_2' ? 432_632 : 0; // CPM micro-settlement summing cleanly with clicks/conversions
      const impPub = Math.floor((impBill * 7200) / 10000);
      const impPlat = impBill - impPub;

      insertImp.run(impId, reqId, cmpId, crtId, plcId, 'pub_1', 'adv_1', 1, 1, impBill, impPub, impPlat, country, device, ipHash, sessHash, dayOffset);

      // ~3.5% CTR (10 valid clicks + 1 invalid click across 285 impressions)
      if (i % 26 === 5) {
        const clkId = `clk_seed_${i}`;
        const isValid = i === 135 ? 0 : 1;
        const clkBill = isValid ? 1_450_000 : 0;
        const clkPub = Math.floor((clkBill * 7200) / 10000);
        const clkPlat = clkBill - clkPub;
        insertClk.run(clkId, impId, reqId, cmpId, crtId, plcId, 'pub_1', 'adv_1', isValid, isValid ? null : 'repeated_click_velocity', clkBill, clkPub, clkPlat, ipHash, sessHash, dayOffset);

        if (isValid && i % 78 === 5) {
          const cnvId = `cnv_seed_${i}`;
          const cnvBill = 18_000_000;
          const cnvPub = Math.floor((cnvBill * 7200) / 10000);
          const cnvPlat = cnvBill - cnvPub;
          insertCnv.run(cnvId, clkId, reqId, cmpId, 'adv_1', 'pub_1', 'signup_completed', 120_000_000, cnvBill, cnvPub, cnvPlat, 1, dayOffset);
        }
      }
    }
  }

  // Fraud alert
  db.prepare(
    `INSERT INTO fraud_alerts (id, publisher_id, campaign_id, signal_type, severity, description, evidence_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'frd_1',
    'pub_2',
    'cmp_1',
    'abnormal_ctr_spike',
    'medium',
    'Placement plc_finpulse_sidebar recorded 14.2% CTR burst from concentrated AS-subnet within 18 minutes.',
    JSON.stringify({ observedCtr: 0.142, windowMinutes: 18, flaggedEvents: 19 }),
    'open'
  );

  // Moderation reviews
  db.prepare(
    `INSERT INTO moderation_reviews (id, target_type, target_id, reviewer_id, decision, reason)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('mod_1', 'campaign', 'cmp_1', 'usr_admin_1', 'approved', 'Creative copy, destination URL, and financial disclosures verified.');

  // Notifications
  const insertNotif = db.prepare(
    'INSERT INTO notifications (id, user_id, title, message, category) VALUES (?, ?, ?, ?, ?)'
  );
  insertNotif.run('ntf_1', 'usr_adv_1', 'Campaign Approved', 'Atlas Titanium Corporate Card — Q4 Launch is approved and actively serving across eligible placements.', 'moderation');
  insertNotif.run('ntf_2', 'usr_pub_1', 'Domain Verified', 'meridiandaily.com passed DNS TXT verification and is receiving live demand.', 'property');
  insertNotif.run('ntf_3', 'usr_admin_1', 'Moderation Queue', '1 new campaign (Nordic Cloud Enterprise DevOps) and 1 publisher property (finpulse.eu) await review.', 'moderation');
}
