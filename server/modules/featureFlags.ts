import type { DbClient } from '../db/postgres';

export interface PlatformFeatureFlags {
  /** Looma is the exclusive active first-party publisher at initial launch. */
  looma_first_party_only_mode: boolean;
  /** External third-party publisher self-registration (enabled for publisher onboarding; accounts start pending admin approval). */
  external_publisher_registration_enabled: boolean;
  /** External third-party SDK distribution (disabled until expansion phase). */
  third_party_sdk_distribution_enabled: boolean;
  /** External third-party publisher revenue allocation (disabled until expansion phase). */
  third_party_revenue_allocation_enabled: boolean;
  /** External third-party publisher payout withdrawals (disabled until expansion phase). */
  third_party_publisher_payouts_enabled: boolean;
  /** Postpaid credit accounts remain disabled at initial launch (prepaid wallets only). */
  postpaid_advertiser_credit_enabled: boolean;
}

export const INITIAL_LAUNCH_FEATURE_FLAGS: PlatformFeatureFlags = {
  looma_first_party_only_mode: true,
  external_publisher_registration_enabled: true,
  third_party_sdk_distribution_enabled: false,
  third_party_revenue_allocation_enabled: false,
  third_party_publisher_payouts_enabled: false,
  postpaid_advertiser_credit_enabled: false,
};

export type FeatureFlagKey = keyof PlatformFeatureFlags;

export const FEATURE_FLAG_KEYS: FeatureFlagKey[] = Object.keys(
  INITIAL_LAUNCH_FEATURE_FLAGS
) as FeatureFlagKey[];

export async function seedFeatureFlagsIfMissing(db: DbClient): Promise<void> {
  const nowIso = new Date().toISOString();
  for (const key of FEATURE_FLAG_KEYS) {
    await db.execute(
      `INSERT INTO platform_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(INITIAL_LAUNCH_FEATURE_FLAGS[key]), nowIso]
    );
  }
}

export async function getFeatureFlags(db: DbClient): Promise<PlatformFeatureFlags> {
  const result: PlatformFeatureFlags = { ...INITIAL_LAUNCH_FEATURE_FLAGS };
  const rows = await db.query<{ key: string; value_json: string }>(
    `SELECT key, value_json FROM platform_settings
     WHERE key IN (${FEATURE_FLAG_KEYS.map(() => '?').join(', ')})`,
    FEATURE_FLAG_KEYS
  );

  for (const row of rows) {
    const key = row.key as FeatureFlagKey;
    if (key in result) {
      try {
        result[key] = Boolean(JSON.parse(row.value_json));
      } catch {
        // Keep safe launch default if setting JSON is malformed
      }
    }
  }
  return result;
}

export async function isPublisherEligibleForDelivery(
  db: DbClient,
  publisherType: string,
  approvalStatus: string
): Promise<{ eligible: boolean; reason?: string }> {
  if (approvalStatus !== 'approved') {
    return { eligible: false, reason: 'publisher_not_approved' };
  }
  const flags = await getFeatureFlags(db);
  if (publisherType === 'third_party' && flags.looma_first_party_only_mode && !flags.third_party_sdk_distribution_enabled) {
    return {
      eligible: false,
      reason: 'external_publishers_disabled_by_feature_flag',
    };
  }
  return { eligible: true };
}
