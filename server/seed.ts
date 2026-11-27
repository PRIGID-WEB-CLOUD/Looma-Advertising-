import crypto from 'node:crypto';
import { hashPassword } from './auth';
import { type DbClient, withTransaction } from './db/postgres';
import { seedFeatureFlagsIfMissing } from './modules/featureFlags';

async function batchInsert(
  db: DbClient,
  tableAndCols: string,
  colCount: number,
  rows: unknown[][],
  conflictClause = ''
): Promise<void> {
  if (rows.length === 0) return;
  const rowPlaceholder = `(${Array.from({ length: colCount }, () => '?').join(', ')})`;
  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const valuesSql = chunk.map(() => rowPlaceholder).join(', ');
    const flatParams = chunk.flat();
    await db.execute(`${tableAndCols} VALUES ${valuesSql}${conflictClause ? ` ${conflictClause}` : ''}`, flatParams);
  }
}

async function ensureLoomaFirstPartyPublisher(db: DbClient): Promise<void> {
  await seedFeatureFlagsIfMissing(db);
  const nowIso = new Date().toISOString();

  await db.execute(
    `INSERT INTO roles (id, name, description)
     VALUES ('role_advertiser', 'advertiser', 'Advertiser workspace access'),
            ('role_publisher', 'publisher', 'Publisher monetization workspace access'),
            ('role_admin', 'admin', 'Platform administrator ecosystem access')
     ON CONFLICT (id) DO NOTHING`
  );

  const loomaSecret = crypto.randomBytes(16).toString('hex');
  await db.execute(
    `INSERT INTO users (id, email, full_name, password_hash, role_id, status, email_verified)
     VALUES ('usr_pub_looma', 'feed-ops@looma.app', 'Looma Feed Operations', ?, 'role_publisher', 'active', 1)
     ON CONFLICT (id) DO NOTHING`,
    [hashPassword(loomaSecret)]
  );

  await db.execute(
    `INSERT INTO publisher_accounts
       (id, user_id, organization_name, publisher_type, country, currency, approval_status, traffic_quality_score, custom_revenue_share_bps, payout_method_type, payout_destination)
     VALUES ('pub_looma_1p', 'usr_pub_looma', 'Looma (First-Party Feed)', 'first_party', 'US', 'USD', 'approved', 99, 10000, 'internal_treasury', 'Looma First-Party Settlement Ledger')
     ON CONFLICT (id) DO NOTHING`
  );

  await db.execute(
    `INSERT INTO publisher_wallets
       (id, publisher_id, estimated_micros, available_micros, pending_micros, lifetime_earned_micros, invalid_deducted_micros, currency)
     VALUES ('wal_pub_looma_1p', 'pub_looma_1p', 124500000, 912400000, 0, 912400000, 0, 'USD')
     ON CONFLICT (id) DO NOTHING`
  );

  await db.execute(
    `INSERT INTO publisher_properties
       (id, publisher_id, property_type, name, domain_or_bundle, category, language, verification_status, approval_status, monthly_pageviews, gdpr_consent_required)
     VALUES ('prop_looma_feed', 'pub_looma_1p', 'web_app', 'Looma Primary Feed', 'looma.app', 'business_finance', 'en', 'verified', 'approved', 12500000, 1)
     ON CONFLICT (id) DO NOTHING`
  );

  await db.execute(
    `INSERT INTO domain_verifications (id, property_id, method, verification_token, verified_at, status)
     VALUES ('ver_looma_1p', 'prop_looma_feed', 'dns_txt', 'looma-first-party-adapter=verified', ?, 'verified')
     ON CONFLICT (id) DO NOTHING`,
    [nowIso]
  );

  await db.execute(
    `INSERT INTO ad_placements
       (id, property_id, publisher_id, name, format, dimensions, floor_cpm_micros, status, integration_verified)
     VALUES
       ('plc_looma_feed_native', 'prop_looma_feed', 'pub_looma_1p', 'Looma Home Feed — Native Slot', 'native', 'responsive', 1000000, 'active', 1),
       ('plc_looma_feed_infeed', 'prop_looma_feed', 'pub_looma_1p', 'Looma Discovery Feed — In-Feed Card', 'in_feed', 'responsive', 1100000, 'active', 1),
       ('plc_looma_discover_banner', 'prop_looma_feed', 'pub_looma_1p', 'Looma Explore — Responsive Banner', 'responsive', '728x90', 900000, 'active', 1)
     ON CONFLICT (id) DO NOTHING`
  );

  await db.execute("UPDATE publisher_accounts SET publisher_type = 'third_party' WHERE id IN ('pub_1', 'pub_2')");
}

export async function seedDatabaseIfEmpty(db: DbClient): Promise<void> {
  await withTransaction(db, async (tx) => {
    const nowIso = new Date().toISOString();

    await batchInsert(
      tx,
      'INSERT INTO prohibited_categories (id, name, keywords_json, severity, active)',
      5,
      [
        ['pol_counterfeit', 'Counterfeit & Replica Goods', JSON.stringify(['replica watch', 'counterfeit', 'fake luxury', 'knockoff designer']), 'block', 1],
        ['pol_malware', 'Malware & Phishing', JSON.stringify(['free password stealer', 'keylogger', 'phishing kit', 'trojan download']), 'block', 1],
        ['pol_gambling', 'Unlicensed Gambling', JSON.stringify(['unlicensed casino', 'offshore betting hack', 'guaranteed jackpot']), 'block', 1],
        ['pol_substances', 'Controlled Substances', JSON.stringify(['buy prescription without rx', 'illegal narcotics', 'unregulated steroids']), 'block', 1],
        ['pol_financial', 'Deceptive Financial Claims', JSON.stringify(['guaranteed 1000% return', 'risk-free crypto doubler', 'get rich overnight']), 'review', 1],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    const prodInitializedRow = await tx.queryOne<{ value_json: string }>(
      "SELECT value_json FROM platform_settings WHERE key = 'production_initialized'"
    );
    const isProductionInitialized = prodInitializedRow?.value_json === 'true';

    const existing = await tx.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM campaigns');
    if (isProductionInitialized || Number(existing?.count ?? 0) > 0) {
      await ensureLoomaFirstPartyPublisher(tx);
      const activeAdminRow = await tx.queryOne<{ count: number }>(
        "SELECT COUNT(*) AS count FROM users WHERE role_id = 'role_admin' AND status = 'active'"
      );
      if (Number(activeAdminRow?.count ?? 0) === 0) {
        const recoverySecret = crypto.randomBytes(16).toString('hex');
        await tx.execute(
          `INSERT INTO users (id, email, full_name, password_hash, role_id, status, email_verified)
           VALUES ('usr_admin_1', 'prigidwebcloud@gmail.com', 'Platform Administrator', ?, 'role_admin', 'active', 1)
           ON CONFLICT (id) DO UPDATE SET
             email = excluded.email,
             full_name = excluded.full_name,
             password_hash = excluded.password_hash,
             role_id = excluded.role_id,
             status = 'active',
             email_verified = 1`,
          [hashPassword(recoverySecret)]
        );
        await tx.execute("DELETE FROM platform_settings WHERE key = 'admin_claimed'");
      }
      await tx.execute(
        `UPDATE users SET email_verified = 1 WHERE id IN ('usr_adv_1', 'usr_adv_2', 'usr_pub_1', 'usr_pub_2', 'usr_pub_looma', 'usr_admin_1')`
      );
      return;
    }

    await ensureLoomaFirstPartyPublisher(tx);

    // Platform settings
    await batchInsert(
      tx,
      'INSERT INTO platform_settings (key, value_json)',
      2,
      [
        ['supported_currencies', JSON.stringify(['USD', 'EUR', 'GBP', 'NGN', 'KES'])],
        ['default_publisher_share_bps', JSON.stringify(7000)],
        ['minimum_publisher_payout_micros', JSON.stringify(50_000_000)],
        ['minimum_campaign_budget_micros', JSON.stringify(25_000_000)],
        ['prohibited_categories', JSON.stringify(['counterfeit_goods', 'malware', 'unlicensed_gambling', 'deceptive_claims'])],
        ['enabled_ad_formats', JSON.stringify(['image', 'banner', 'native', 'text', 'video', 'responsive', 'sponsored'])],
        ['require_advertiser_kyb', JSON.stringify(true)],
        ['gdpr_consent_enforcement', JSON.stringify(true)],
      ],
      'ON CONFLICT (key) DO NOTHING'
    );

    const demoSecret = crypto.randomBytes(16).toString('hex');
    const demoPassHash = hashPassword(demoSecret);
    await batchInsert(
      tx,
      'INSERT INTO users (id, email, full_name, password_hash, role_id, status, email_verified)',
      7,
      [
        ['usr_adv_1', 'maya.lin@atlascommerce.io', 'Maya Lin', demoPassHash, 'role_advertiser', 'active', 1],
        ['usr_adv_2', 'lucas.weber@nordiccloud.de', 'Lucas Weber', demoPassHash, 'role_advertiser', 'active', 1],
        ['usr_pub_1', 'kofi.mensah@meridiandigital.media', 'Kofi Mensah', demoPassHash, 'role_publisher', 'active', 1],
        ['usr_pub_2', 'sofia.rossi@finpulse.eu', 'Sofia Rossi', demoPassHash, 'role_publisher', 'active', 1],
        ['usr_admin_1', 'prigidwebcloud@gmail.com', 'Platform Administrator', demoPassHash, 'role_admin', 'active', 1],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO advertiser_accounts (id, user_id, company_name, country, currency, verification_status, account_status, billing_email)',
      8,
      [
        ['adv_1', 'usr_adv_1', 'Atlas Commerce Global', 'US', 'USD', 'verified', 'active', 'finance@atlascommerce.io'],
        ['adv_2', 'usr_adv_2', 'Nordic Cloud Systems GmbH', 'DE', 'USD', 'pending', 'active', 'ap@nordiccloud.de'],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO publisher_accounts (id, user_id, organization_name, publisher_type, country, currency, approval_status, traffic_quality_score, custom_revenue_share_bps, payout_method_type, payout_destination)',
      11,
      [
        ['pub_1', 'usr_pub_1', 'Meridian Digital Media', 'third_party', 'GB', 'USD', 'approved', 96, 7200, 'bank_transfer', 'IBAN •••• 4821 (Barclays UK)'],
        ['pub_2', 'usr_pub_2', 'FinPulse Europe S.r.l.', 'third_party', 'IT', 'USD', 'pending', 89, null, 'paystack', 'Meridian Treasury •••• 9104'],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await tx.execute(
      'INSERT INTO revenue_shares (id, publisher_id, publisher_bps, platform_bps, notes) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
      ['rev_1', 'pub_1', 7200, 2800, 'Preferred editorial partner rate (72% / 28%)']
    );

    await batchInsert(
      tx,
      'INSERT INTO advertiser_wallets (id, advertiser_id, available_micros, reserved_micros, lifetime_deposited_micros, lifetime_spent_micros, currency)',
      7,
      [
        ['wal_adv_1', 'adv_1', 6_361_400_000, 0, 6_500_000_000, 138_600_000, 'USD'],
        ['wal_adv_2', 'adv_2', 1_250_000_000, 0, 1_500_000_000, 250_000_000, 'USD'],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO publisher_wallets (id, publisher_id, estimated_micros, available_micros, pending_micros, lifetime_earned_micros, invalid_deducted_micros, currency)',
      8,
      [
        ['wal_pub_1', 'pub_1', 99_792_000, 642_840_000, 180_000_000, 822_840_000, 14_200_000, 'USD'],
        ['wal_pub_2', 'pub_2', 180_000_000, 42_000_000, 138_000_000, 180_000_000, 3_500_000, 'USD'],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO deposits (id, advertiser_id, provider, provider_ref, idempotency_key, amount_micros, currency, status)',
      8,
      [
        ['dep_1', 'adv_1', 'paystack', 'PSK-90418274', 'idem_dep_seed_1', 4_000_000_000, 'USD', 'completed'],
        ['dep_2', 'adv_1', 'stripe', 'pi_3Q9Looma8241', 'idem_dep_seed_2', 2_500_000_000, 'USD', 'completed'],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO invoices (id, advertiser_id, invoice_number, deposit_id, amount_micros, currency, status)',
      7,
      [
        ['inv_1', 'adv_1', 'LOOMA-INV-2026-0041', 'dep_1', 4_000_000_000, 'USD', 'paid'],
        ['inv_2', 'adv_1', 'LOOMA-INV-2026-0087', 'dep_2', 2_500_000_000, 'USD', 'paid'],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)',
      12,
      [
        ['led_1', 'idem_seed_led_1', 'advertiser_wallet', 'wal_adv_1', 'deposit', 'credit', 4_000_000_000, 4_000_000_000, 'USD', 'deposit', 'dep_1', 'Prepaid wallet deposit via Paystack (PSK-90418274)'],
        ['led_2', 'idem_seed_led_2', 'advertiser_wallet', 'wal_adv_1', 'deposit', 'credit', 2_500_000_000, 6_500_000_000, 'USD', 'deposit', 'dep_2', 'Prepaid wallet deposit via Stripe (pi_3Q9Looma8241)'],
        ['led_3', 'idem_seed_led_3', 'advertiser_wallet', 'wal_adv_1', 'ad_spend', 'debit', 138_600_000, 6_361_400_000, 'USD', 'campaign_batch', 'cmp_1', 'Verified ad delivery spend settlement (7-day cycle)'],
        ['led_4', 'idem_seed_led_4', 'publisher_wallet', 'wal_pub_1', 'publisher_earning', 'credit', 99_792_000, 642_840_000, 'USD', 'settlement', 'pub_1', 'Finalized publisher revenue share (72%)'],
        ['led_5', 'idem_seed_led_5', 'platform_revenue', 'looma_treasury', 'platform_commission', 'credit', 38_808_000, 38_808_000, 'USD', 'settlement', 'pub_1', 'Platform ad-serving commission'],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO withdrawals (id, publisher_id, amount_micros, currency, payout_method, payout_destination, status, notes)',
      8,
      [
        ['wdr_1', 'pub_1', 300_000_000, 'USD', 'bank_transfer', 'IBAN •••• 4821 (Barclays UK)', 'paid', 'October monthly settlement'],
        ['wdr_2', 'pub_1', 180_000_000, 'USD', 'bank_transfer', 'IBAN •••• 4821 (Barclays UK)', 'pending', 'November mid-cycle withdrawal request'],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO publisher_properties (id, publisher_id, property_type, name, domain_or_bundle, category, language, verification_status, approval_status, monthly_pageviews, gdpr_consent_required)',
      11,
      [
        ['prop_1', 'pub_1', 'website', 'Meridian Business Daily', 'meridiandaily.com', 'business_finance', 'en', 'verified', 'approved', 2_450_000, 1],
        ['prop_2', 'pub_1', 'ios_app', 'Meridian Reader iOS', 'com.meridianmedia.reader', 'news_technology', 'en', 'verified', 'approved', 890_000, 1],
        ['prop_3', 'pub_2', 'website', 'FinPulse Europe', 'finpulse.eu', 'fintech', 'en', 'verified', 'pending', 540_000, 1],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO domain_verifications (id, property_id, method, verification_token, verified_at, status)',
      6,
      [
        ['ver_1', 'prop_1', 'dns_txt', 'looma-verify=m94x81k2q', nowIso, 'verified'],
        ['ver_2', 'prop_3', 'ads_txt', 'looma-ads.com, pub_2, DIRECT, f81a9c2e', nowIso, 'verified'],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO ad_placements (id, property_id, publisher_id, name, format, dimensions, floor_cpm_micros, status, integration_verified)',
      9,
      [
        ['plc_meridian_native', 'prop_1', 'pub_1', 'Article In-Feed Native Unit', 'native', 'responsive', 1_200_000, 'active', 1],
        ['plc_meridian_banner', 'prop_1', 'pub_1', 'Top Leaderboard 728x90', 'banner', '728x90', 900_000, 'active', 1],
        ['plc_meridian_ios_interstitial', 'prop_2', 'pub_1', 'iOS Reader Interstitial', 'interstitial', '320x480', 2_500_000, 'active', 1],
        ['plc_finpulse_sidebar', 'prop_3', 'pub_2', 'Sidebar Responsive Unit', 'responsive', '300x250', 1_000_000, 'active', 0],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO campaigns (id, advertiser_id, name, objective, pricing_model, bidding_strategy, status, moderation_status, start_date, end_date, frequency_cap_per_session)',
      11,
      [
        ['cmp_1', 'adv_1', 'Atlas Titanium Corporate Card — Q4 Launch', 'sales_conversions', 'CPC', 'manual', 'active', 'approved', '2026-01-01', '2027-12-31', 5],
        ['cmp_2', 'adv_1', 'Atlas Cloud Workstation Awareness', 'brand_awareness', 'CPM', 'target_cpm', 'active', 'approved', '2026-01-01', '2027-12-31', 4],
        ['cmp_3', 'adv_1', 'Stride Lab Trail Runner Acquisition', 'website_traffic', 'CPA', 'target_cpa', 'active', 'approved', '2026-01-01', '2027-12-31', 3],
        ['cmp_4', 'adv_2', 'Nordic Cloud Enterprise DevOps', 'lead_generation', 'CPC', 'manual', 'pending_review', 'pending', '2026-01-01', '2027-12-31', 3],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO campaign_targeting (id, campaign_id, countries_json, regions_json, cities_json, languages_json, device_categories_json, operating_systems_json, browsers_json, interest_categories_json, contextual_categories_json, custom_segments_json, retargeting_enabled, consent_required)',
      14,
      [
        ['tgt_1', 'cmp_1', '["US","GB","DE","NG","CA","ALL"]', '[]', '[]', '["en","ALL"]', '["desktop","mobile","tablet"]', '["ALL"]', '["ALL"]', '["finance","b2b_saas"]', '["business_finance","fintech","news_technology","ALL"]', '["enterprise_buyers"]', 0, 1],
        ['tgt_2', 'cmp_2', '["ALL"]', '[]', '[]', '["ALL"]', '["desktop","mobile","tablet"]', '["ALL"]', '["ALL"]', '["technology","hardware"]', '["ALL"]', '[]', 0, 1],
        ['tgt_3', 'cmp_3', '["US","GB","DE","FR","ALL"]', '[]', '[]', '["en","ALL"]', '["desktop","mobile"]', '["ALL"]', '["ALL"]', '["retail","fitness"]', '["ALL"]', '[]', 1, 1],
        ['tgt_4', 'cmp_4', '["DE","GB","US"]', '[]', '[]', '["en","de"]', '["desktop"]', '["ALL"]', '["ALL"]', '["cloud","devops"]', '["news_technology","business_finance"]', '[]', 0, 1],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO campaign_budgets (id, campaign_id, daily_budget_micros, total_budget_micros, spent_today_micros, spent_total_micros, max_bid_micros, pacing_mode, currency)',
      9,
      [
        ['bdg_1', 'cmp_1', 350_000_000, 4_500_000_000, 14_500_000, 43_500_000, 1_450_000, 'standard', 'USD'],
        ['bdg_2', 'cmp_2', 200_000_000, 2_500_000_000, 13_600_000, 41_100_000, 6_800_000, 'standard', 'USD'],
        ['bdg_3', 'cmp_3', 180_000_000, 1_800_000_000, 18_000_000, 54_000_000, 18_000_000, 'accelerated', 'USD'],
        ['bdg_4', 'cmp_4', 250_000_000, 2_000_000_000, 0, 0, 2_100_000, 'standard', 'USD'],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO advertisements (id, campaign_id, advertiser_id, name, format, status)',
      6,
      [
        ['ad_1', 'cmp_1', 'adv_1', 'Titanium Card Native Showcase', 'native', 'active'],
        ['ad_2', 'cmp_2', 'adv_1', 'Workstation Display Banner', 'banner', 'active'],
        ['ad_3', 'cmp_3', 'adv_1', 'Trail Runner Responsive Feature', 'responsive', 'active'],
        ['ad_4', 'cmp_4', 'adv_2', 'Nordic Cloud Text Unit', 'text', 'active'],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    await batchInsert(
      tx,
      'INSERT INTO ad_creatives (id, advertisement_id, title, description, media_url, destination_url, cta_text, tracking_params, dimensions, approval_status)',
      10,
      [
        ['crt_1', 'ad_1', 'Atlas Titanium Treasury Card', 'Multi-currency corporate spend controls with automated real-time reconciliation for global finance teams.', '/src/assets/images/creative_fintech_card_1795552815861.jpg', 'https://atlascommerce.io/treasury-card', 'Request Card', 'utm_source=looma&utm_medium=native&utm_campaign=q4_treasury', 'responsive', 'approved'],
        ['crt_2', 'ad_2', 'Precision Aluminum Studio Display', '6K color-calibrated workstation engineered for distributed engineering and media teams.', '/src/assets/images/creative_cloud_hardware_1795552815294.jpg', 'https://atlascommerce.io/workstation', 'Explore Hardware', 'utm_source=looma&utm_medium=banner&utm_campaign=workstation_awareness', '728x90', 'approved'],
        ['crt_3', 'ad_3', 'Terra-01 Technical Trail Sneaker', 'Lightweight carbon-stabilized outsole built for long-distance endurance across wet stone and trail.', '/src/assets/images/creative_retail_sneaker_1795552816794.jpg', 'https://atlascommerce.io/terra-01', 'Shop Collection', 'utm_source=looma&utm_medium=responsive&utm_campaign=terra_launch', 'responsive', 'approved'],
        ['crt_4', 'ad_4', 'Sovereign Kubernetes Clusters in EU', 'Deploy ISO-27001 compliant clusters across Frankfurt and Stockholm with deterministic billing.', '', 'https://nordiccloud.de/enterprise', 'Start Trial', 'utm_source=looma&utm_medium=text&utm_campaign=eu_devops', 'responsive', 'pending'],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );

    const countries = ['US', 'GB', 'DE', 'NG', 'CA'];
    const devices = ['desktop', 'mobile', 'tablet'];
    const dailyVolumes = [24, 38, 31, 49, 42, 57, 44];
    const baseMs = Date.now();

    const reqRows: unknown[][] = [];
    const impRows: unknown[][] = [];
    const clkRows: unknown[][] = [];
    const cnvRows: unknown[][] = [];

    let seq = 0;
    for (let dIdx = 0; dIdx < dailyVolumes.length; dIdx++) {
      const daysAgo = 6 - dIdx;
      const eventIso = new Date(baseMs - daysAgo * 86_400_000).toISOString();
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

        reqRows.push([reqId, plcId, 'prop_1', 'pub_1', cmpId, crtId, country, device, 'macOS', 'Chrome', 'en', 'business_finance', 1, 1, ipHash, sessHash, eventIso]);

        const impBill = cmpId === 'cmp_2' ? 432_632 : 0;
        const impPub = Math.floor((impBill * 7200) / 10000);
        const impPlat = impBill - impPub;

        impRows.push([impId, reqId, cmpId, crtId, plcId, 'pub_1', 'adv_1', 1, 1, impBill, impPub, impPlat, country, device, ipHash, sessHash, eventIso]);

        if (i % 26 === 5) {
          const clkId = `clk_seed_${i}`;
          const isValid = i === 135 ? 0 : 1;
          const clkBill = isValid ? 1_450_000 : 0;
          const clkPub = Math.floor((clkBill * 7200) / 10000);
          const clkPlat = clkBill - clkPub;
          clkRows.push([clkId, impId, reqId, cmpId, crtId, plcId, 'pub_1', 'adv_1', isValid, isValid ? null : 'repeated_click_velocity', clkBill, clkPub, clkPlat, ipHash, sessHash, eventIso]);

          if (isValid && i % 78 === 5) {
            const cnvId = `cnv_seed_${i}`;
            const cnvBill = 18_000_000;
            const cnvPub = Math.floor((cnvBill * 7200) / 10000);
            const cnvPlat = cnvBill - cnvPub;
            cnvRows.push([cnvId, clkId, reqId, cmpId, 'adv_1', 'pub_1', 'signup_completed', 120_000_000, cnvBill, cnvPub, cnvPlat, 1, eventIso]);
          }
        }
      }
    }

    await batchInsert(
      tx,
      'INSERT INTO ad_requests (id, placement_id, property_id, publisher_id, winning_campaign_id, winning_creative_id, country, device_category, os, browser, language, category, consent_granted, filled, ip_hash, session_hash, created_at)',
      17,
      reqRows,
      'ON CONFLICT (id) DO NOTHING'
    );
    await batchInsert(
      tx,
      'INSERT INTO impressions (id, request_id, campaign_id, creative_id, placement_id, publisher_id, advertiser_id, viewable, is_valid, billed_micros, publisher_share_micros, platform_fee_micros, country, device_category, ip_hash, session_hash, created_at)',
      17,
      impRows,
      'ON CONFLICT (id) DO NOTHING'
    );
    await batchInsert(
      tx,
      'INSERT INTO clicks (id, impression_id, request_id, campaign_id, creative_id, placement_id, publisher_id, advertiser_id, is_valid, invalid_reason, billed_micros, publisher_share_micros, platform_fee_micros, ip_hash, session_hash, created_at)',
      16,
      clkRows,
      'ON CONFLICT (id) DO NOTHING'
    );
    await batchInsert(
      tx,
      'INSERT INTO conversions (id, click_id, request_id, campaign_id, advertiser_id, publisher_id, event_name, conversion_value_micros, billed_micros, publisher_share_micros, platform_fee_micros, is_valid, created_at)',
      13,
      cnvRows,
      'ON CONFLICT (id) DO NOTHING'
    );

    await tx.execute(
      `INSERT INTO fraud_alerts (id, publisher_id, campaign_id, signal_type, severity, description, evidence_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [
        'frd_1',
        'pub_2',
        'cmp_1',
        'abnormal_ctr_spike',
        'medium',
        'Placement plc_finpulse_sidebar recorded 14.2% CTR burst from concentrated AS-subnet within 18 minutes.',
        JSON.stringify({ observedCtr: 0.142, windowMinutes: 18, flaggedEvents: 19 }),
        'open',
      ]
    );

    await tx.execute(
      `INSERT INTO moderation_reviews (id, target_type, target_id, reviewer_id, decision, reason)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      ['mod_1', 'campaign', 'cmp_1', 'usr_admin_1', 'approved', 'Creative copy, destination URL, and financial disclosures verified.']
    );

    await batchInsert(
      tx,
      'INSERT INTO notifications (id, user_id, title, message, category)',
      5,
      [
        ['ntf_1', 'usr_adv_1', 'Campaign Approved', 'Atlas Titanium Corporate Card — Q4 Launch is approved and actively serving across eligible placements.', 'moderation'],
        ['ntf_2', 'usr_pub_1', 'Domain Verified', 'meridiandaily.com passed DNS TXT verification and is receiving live demand.', 'property'],
        ['ntf_3', 'usr_admin_1', 'Moderation Queue', '1 new campaign (Nordic Cloud Enterprise DevOps) and 1 publisher property (finpulse.eu) await review.', 'moderation'],
      ],
      'ON CONFLICT (id) DO NOTHING'
    );
  });
}
