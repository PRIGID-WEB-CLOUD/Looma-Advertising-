import { pgTable, text, bigint, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const roles = pgTable('roles', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  roleId: text('role_id').notNull().references(() => roles.id),
  status: text('status').notNull().default('active'),
  emailVerified: integer('email_verified').notNull().default(0),
  tokenValidAfter: bigint('token_valid_after', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const advertiserAccounts = pgTable('advertiser_accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => users.id),
  companyName: text('company_name').notNull(),
  country: text('country').notNull().default('US'),
  currency: text('currency').notNull().default('USD'),
  verificationStatus: text('verification_status').notNull().default('pending'),
  accountStatus: text('account_status').notNull().default('active'),
  billingEmail: text('billing_email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const publisherAccounts = pgTable('publisher_accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => users.id),
  organizationName: text('organization_name').notNull(),
  publisherType: text('publisher_type').notNull().default('third_party'),
  country: text('country').notNull().default('US'),
  currency: text('currency').notNull().default('USD'),
  approvalStatus: text('approval_status').notNull().default('pending'),
  trafficQualityScore: integer('traffic_quality_score').notNull().default(95),
  customRevenueShareBps: integer('custom_revenue_share_bps'),
  payoutMethodType: text('payout_method_type').notNull().default('bank_transfer'),
  payoutDestination: text('payout_destination').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const publisherProperties = pgTable('publisher_properties', {
  id: text('id').primaryKey(),
  publisherId: text('publisher_id').notNull().references(() => publisherAccounts.id),
  propertyType: text('property_type').notNull(),
  name: text('name').notNull(),
  domainOrBundle: text('domain_or_bundle').notNull(),
  category: text('category').notNull(),
  language: text('language').notNull().default('en'),
  verificationStatus: text('verification_status').notNull().default('pending'),
  approvalStatus: text('approval_status').notNull().default('pending'),
  monthlyPageviews: bigint('monthly_pageviews', { mode: 'number' }).notNull().default(0),
  gdprConsentRequired: integer('gdpr_consent_required').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const domainVerifications = pgTable('domain_verifications', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => publisherProperties.id),
  method: text('method').notNull(),
  verificationToken: text('verification_token').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const campaigns = pgTable(
  'campaigns',
  {
    id: text('id').primaryKey(),
    advertiserId: text('advertiser_id').notNull().references(() => advertiserAccounts.id),
    name: text('name').notNull(),
    objective: text('objective').notNull(),
    pricingModel: text('pricing_model').notNull(),
    biddingStrategy: text('bidding_strategy').notNull().default('manual'),
    status: text('status').notNull().default('pending_review'),
    moderationStatus: text('moderation_status').notNull().default('pending'),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    frequencyCapPerSession: integer('frequency_cap_per_session').notNull().default(3),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_campaigns_advertiser').on(table.advertiserId),
    index('idx_campaigns_status').on(table.status, table.moderationStatus),
  ]
);

export const campaignTargeting = pgTable('campaign_targeting', {
  id: text('id').primaryKey(),
  campaignId: text('campaign_id').notNull().unique().references(() => campaigns.id),
  countriesJson: text('countries_json').notNull().default('["ALL"]'),
  regionsJson: text('regions_json').notNull().default('[]'),
  citiesJson: text('cities_json').notNull().default('[]'),
  languagesJson: text('languages_json').notNull().default('["en"]'),
  deviceCategoriesJson: text('device_categories_json').notNull().default('["desktop","mobile","tablet"]'),
  operatingSystemsJson: text('operating_systems_json').notNull().default('["ALL"]'),
  browsersJson: text('browsers_json').notNull().default('["ALL"]'),
  interestCategoriesJson: text('interest_categories_json').notNull().default('[]'),
  contextualCategoriesJson: text('contextual_categories_json').notNull().default('[]'),
  customSegmentsJson: text('custom_segments_json').notNull().default('[]'),
  retargetingEnabled: integer('retargeting_enabled').notNull().default(0),
  consentRequired: integer('consent_required').notNull().default(1),
});

export const campaignBudgets = pgTable('campaign_budgets', {
  id: text('id').primaryKey(),
  campaignId: text('campaign_id').notNull().unique().references(() => campaigns.id),
  dailyBudgetMicros: bigint('daily_budget_micros', { mode: 'number' }).notNull(),
  totalBudgetMicros: bigint('total_budget_micros', { mode: 'number' }).notNull(),
  spentTodayMicros: bigint('spent_today_micros', { mode: 'number' }).notNull().default(0),
  spentTotalMicros: bigint('spent_total_micros', { mode: 'number' }).notNull().default(0),
  maxBidMicros: bigint('max_bid_micros', { mode: 'number' }).notNull(),
  pacingMode: text('pacing_mode').notNull().default('standard'),
  currency: text('currency').notNull().default('USD'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const advertisements = pgTable('advertisements', {
  id: text('id').primaryKey(),
  campaignId: text('campaign_id').notNull().references(() => campaigns.id),
  advertiserId: text('advertiser_id').notNull().references(() => advertiserAccounts.id),
  name: text('name').notNull(),
  format: text('format').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const adCreatives = pgTable('ad_creatives', {
  id: text('id').primaryKey(),
  advertisementId: text('advertisement_id').notNull().references(() => advertisements.id),
  title: text('title').notNull(),
  description: text('description').notNull(),
  mediaUrl: text('media_url').notNull().default(''),
  destinationUrl: text('destination_url').notNull(),
  ctaText: text('cta_text').notNull().default('Learn More'),
  trackingParams: text('tracking_params').notNull().default(''),
  dimensions: text('dimensions').notNull().default('responsive'),
  approvalStatus: text('approval_status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const adPlacements = pgTable('ad_placements', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => publisherProperties.id),
  publisherId: text('publisher_id').notNull().references(() => publisherAccounts.id),
  name: text('name').notNull(),
  format: text('format').notNull(),
  dimensions: text('dimensions').notNull().default('responsive'),
  floorCpmMicros: bigint('floor_cpm_micros', { mode: 'number' }).notNull().default(500000),
  status: text('status').notNull().default('active'),
  integrationVerified: integer('integration_verified').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const adRequests = pgTable('ad_requests', {
  id: text('id').primaryKey(),
  placementId: text('placement_id').notNull().references(() => adPlacements.id),
  propertyId: text('property_id').notNull().references(() => publisherProperties.id),
  publisherId: text('publisher_id').notNull().references(() => publisherAccounts.id),
  winningCampaignId: text('winning_campaign_id').references(() => campaigns.id),
  winningCreativeId: text('winning_creative_id').references(() => adCreatives.id),
  country: text('country').notNull().default('US'),
  deviceCategory: text('device_category').notNull().default('desktop'),
  os: text('os').notNull().default('Web'),
  browser: text('browser').notNull().default('Chrome'),
  language: text('language').notNull().default('en'),
  category: text('category').notNull().default('general'),
  consentGranted: integer('consent_granted').notNull().default(1),
  filled: integer('filled').notNull().default(0),
  ipHash: text('ip_hash').notNull(),
  sessionHash: text('session_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const impressions = pgTable(
  'impressions',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull().unique().references(() => adRequests.id),
    campaignId: text('campaign_id').notNull().references(() => campaigns.id),
    creativeId: text('creative_id').notNull().references(() => adCreatives.id),
    placementId: text('placement_id').notNull().references(() => adPlacements.id),
    publisherId: text('publisher_id').notNull().references(() => publisherAccounts.id),
    advertiserId: text('advertiser_id').notNull().references(() => advertiserAccounts.id),
    viewable: integer('viewable').notNull().default(1),
    isValid: integer('is_valid').notNull().default(1),
    billedMicros: bigint('billed_micros', { mode: 'number' }).notNull().default(0),
    publisherShareMicros: bigint('publisher_share_micros', { mode: 'number' }).notNull().default(0),
    platformFeeMicros: bigint('platform_fee_micros', { mode: 'number' }).notNull().default(0),
    country: text('country').notNull().default('US'),
    deviceCategory: text('device_category').notNull().default('desktop'),
    ipHash: text('ip_hash').notNull(),
    sessionHash: text('session_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_impressions_campaign').on(table.campaignId, table.createdAt),
    index('idx_impressions_publisher').on(table.publisherId, table.createdAt),
  ]
);

export const clicks = pgTable(
  'clicks',
  {
    id: text('id').primaryKey(),
    impressionId: text('impression_id').notNull().references(() => impressions.id),
    requestId: text('request_id').notNull().references(() => adRequests.id),
    campaignId: text('campaign_id').notNull().references(() => campaigns.id),
    creativeId: text('creative_id').notNull().references(() => adCreatives.id),
    placementId: text('placement_id').notNull().references(() => adPlacements.id),
    publisherId: text('publisher_id').notNull().references(() => publisherAccounts.id),
    advertiserId: text('advertiser_id').notNull().references(() => advertiserAccounts.id),
    isValid: integer('is_valid').notNull().default(1),
    invalidReason: text('invalid_reason'),
    billedMicros: bigint('billed_micros', { mode: 'number' }).notNull().default(0),
    publisherShareMicros: bigint('publisher_share_micros', { mode: 'number' }).notNull().default(0),
    platformFeeMicros: bigint('platform_fee_micros', { mode: 'number' }).notNull().default(0),
    ipHash: text('ip_hash').notNull(),
    sessionHash: text('session_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_clicks_campaign').on(table.campaignId, table.createdAt),
    index('idx_clicks_ip_time').on(table.ipHash, table.createdAt),
  ]
);

export const conversions = pgTable('conversions', {
  id: text('id').primaryKey(),
  clickId: text('click_id').references(() => clicks.id),
  requestId: text('request_id').references(() => adRequests.id),
  campaignId: text('campaign_id').notNull().references(() => campaigns.id),
  advertiserId: text('advertiser_id').notNull().references(() => advertiserAccounts.id),
  publisherId: text('publisher_id').notNull().references(() => publisherAccounts.id),
  eventName: text('event_name').notNull().default('purchase'),
  conversionValueMicros: bigint('conversion_value_micros', { mode: 'number' }).notNull().default(0),
  billedMicros: bigint('billed_micros', { mode: 'number' }).notNull().default(0),
  publisherShareMicros: bigint('publisher_share_micros', { mode: 'number' }).notNull().default(0),
  platformFeeMicros: bigint('platform_fee_micros', { mode: 'number' }).notNull().default(0),
  isValid: integer('is_valid').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const attributionRecords = pgTable('attribution_records', {
  id: text('id').primaryKey(),
  conversionId: text('conversion_id').notNull().unique().references(() => conversions.id),
  clickId: text('click_id').references(() => clicks.id),
  impressionId: text('impression_id').references(() => impressions.id),
  attributionModel: text('attribution_model').notNull().default('last_click'),
  windowHours: integer('window_hours').notNull().default(168),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const eventLogs = pgTable('event_logs', {
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  payloadJson: text('payload_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const fraudAlerts = pgTable('fraud_alerts', {
  id: text('id').primaryKey(),
  publisherId: text('publisher_id').references(() => publisherAccounts.id),
  campaignId: text('campaign_id').references(() => campaigns.id),
  signalType: text('signal_type').notNull(),
  severity: text('severity').notNull(),
  description: text('description').notNull(),
  evidenceJson: text('evidence_json').notNull().default('{}'),
  status: text('status').notNull().default('open'),
  reviewedBy: text('reviewed_by').references(() => users.id),
  resolutionNotes: text('resolution_notes'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
});

export const advertiserWallets = pgTable('advertiser_wallets', {
  id: text('id').primaryKey(),
  advertiserId: text('advertiser_id').notNull().unique().references(() => advertiserAccounts.id),
  availableMicros: bigint('available_micros', { mode: 'number' }).notNull().default(0),
  reservedMicros: bigint('reserved_micros', { mode: 'number' }).notNull().default(0),
  lifetimeDepositedMicros: bigint('lifetime_deposited_micros', { mode: 'number' }).notNull().default(0),
  lifetimeSpentMicros: bigint('lifetime_spent_micros', { mode: 'number' }).notNull().default(0),
  currency: text('currency').notNull().default('USD'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const publisherWallets = pgTable('publisher_wallets', {
  id: text('id').primaryKey(),
  publisherId: text('publisher_id').notNull().unique().references(() => publisherAccounts.id),
  estimatedMicros: bigint('estimated_micros', { mode: 'number' }).notNull().default(0),
  availableMicros: bigint('available_micros', { mode: 'number' }).notNull().default(0),
  pendingMicros: bigint('pending_micros', { mode: 'number' }).notNull().default(0),
  lifetimeEarnedMicros: bigint('lifetime_earned_micros', { mode: 'number' }).notNull().default(0),
  invalidDeductedMicros: bigint('invalid_deducted_micros', { mode: 'number' }).notNull().default(0),
  currency: text('currency').notNull().default('USD'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const financialLedger = pgTable(
  'financial_ledger',
  {
    id: text('id').primaryKey(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    accountType: text('account_type').notNull(),
    accountId: text('account_id').notNull(),
    entryType: text('entry_type').notNull(),
    direction: text('direction').notNull(),
    amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
    balanceAfterMicros: bigint('balance_after_micros', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('USD'),
    referenceType: text('reference_type').notNull(),
    referenceId: text('reference_id').notNull(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [index('idx_ledger_account').on(table.accountType, table.accountId, table.createdAt)]
);

export const budgetReservations = pgTable(
  'budget_reservations',
  {
    id: text('id').primaryKey(),
    advertiserId: text('advertiser_id').notNull().references(() => advertiserAccounts.id),
    walletId: text('wallet_id').notNull().references(() => advertiserWallets.id),
    campaignId: text('campaign_id').notNull().references(() => campaigns.id),
    requestId: text('request_id').notNull().unique(),
    amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
    capturedMicros: bigint('captured_micros', { mode: 'number' }).notNull().default(0),
    releasedMicros: bigint('released_micros', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_reservations_status_exp').on(table.status, table.expiresAt),
    index('idx_reservations_advertiser').on(table.advertiserId, table.createdAt),
  ]
);

export const loomaIdentityLinks = pgTable(
  'looma_identity_links',
  {
    id: text('id').primaryKey(),
    loomaUserId: text('looma_user_id').notNull(),
    loomaBusinessId: text('looma_business_id').notNull(),
    membershipRole: text('membership_role').notNull(),
    userId: text('user_id').notNull().references(() => users.id),
    advertiserId: text('advertiser_id').notNull().references(() => advertiserAccounts.id),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('looma_identity_links_user_biz_uniq').on(table.loomaUserId, table.loomaBusinessId),
    index('idx_looma_links_user').on(table.loomaUserId, table.loomaBusinessId),
  ]
);

export const loomaSsoNonces = pgTable('looma_sso_nonces', {
  jti: text('jti').primaryKey(),
  loomaUserId: text('looma_user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const deposits = pgTable('deposits', {
  id: text('id').primaryKey(),
  advertiserId: text('advertiser_id').notNull().references(() => advertiserAccounts.id),
  provider: text('provider').notNull(),
  providerRef: text('provider_ref').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
  currency: text('currency').notNull().default('USD'),
  status: text('status').notNull().default('completed'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const withdrawals = pgTable('withdrawals', {
  id: text('id').primaryKey(),
  publisherId: text('publisher_id').notNull().references(() => publisherAccounts.id),
  amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
  currency: text('currency').notNull().default('USD'),
  payoutMethod: text('payout_method').notNull(),
  payoutDestination: text('payout_destination').notNull(),
  status: text('status').notNull().default('pending'),
  reviewedBy: text('reviewed_by').references(() => users.id),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true, mode: 'string' }),
});

export const invoices = pgTable('invoices', {
  id: text('id').primaryKey(),
  advertiserId: text('advertiser_id').notNull().references(() => advertiserAccounts.id),
  invoiceNumber: text('invoice_number').notNull().unique(),
  depositId: text('deposit_id').references(() => deposits.id),
  amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
  currency: text('currency').notNull().default('USD'),
  status: text('status').notNull().default('paid'),
  issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const paymentTransactions = pgTable('payment_transactions', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  providerEventId: text('provider_event_id').notNull().unique(),
  transactionType: text('transaction_type').notNull(),
  amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
  currency: text('currency').notNull().default('USD'),
  status: text('status').notNull(),
  rawPayloadJson: text('raw_payload_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const revenueShares = pgTable('revenue_shares', {
  id: text('id').primaryKey(),
  publisherId: text('publisher_id').references(() => publisherAccounts.id),
  publisherBps: integer('publisher_bps').notNull(),
  platformBps: integer('platform_bps').notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  notes: text('notes').notNull().default(''),
});

export const notifications = pgTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  message: text('message').notNull(),
  category: text('category').notNull().default('system'),
  isRead: integer('is_read').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const moderationReviews = pgTable('moderation_reviews', {
  id: text('id').primaryKey(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  reviewerId: text('reviewer_id').references(() => users.id),
  decision: text('decision').notNull(),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const auditLogs = pgTable('audit_logs', {
  id: text('id').primaryKey(),
  actorUserId: text('actor_user_id').references(() => users.id),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id').notNull(),
  detailsJson: text('details_json').notNull().default('{}'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const privacyRequests = pgTable('privacy_requests', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  requestType: text('request_type').notNull(),
  jurisdiction: text('jurisdiction').notNull().default('GDPR'),
  details: text('details').notNull().default(''),
  status: text('status').notNull().default('received'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const contactInquiries = pgTable('contact_inquiries', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  company: text('company').notNull().default(''),
  interest: text('interest').notNull().default('advertising'),
  message: text('message').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const userPreferences = pgTable('user_preferences', {
  userId: text('user_id').primaryKey().references(() => users.id),
  timezone: text('timezone').notNull().default('UTC'),
  preferredCurrency: text('preferred_currency').notNull().default('USD'),
  compactDensity: integer('compact_density').notNull().default(0),
  emailAlerts: integer('email_alerts').notNull().default(1),
  fraudAlerts: integer('fraud_alerts').notNull().default(1),
  weeklyDigest: integer('weekly_digest').notNull().default(1),
  twoFactorEnabled: integer('two_factor_enabled').notNull().default(0),
  sessionTimeoutMinutes: integer('session_timeout_minutes').notNull().default(60),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const mediaAssets = pgTable('media_assets', {
  id: text('id').primaryKey(),
  advertiserId: text('advertiser_id').notNull().references(() => advertiserAccounts.id),
  originalName: text('original_name').notNull(),
  storedName: text('stored_name').notNull().unique(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const rateLimitBuckets = pgTable('rate_limit_buckets', {
  bucketKey: text('bucket_key').primaryKey(),
  count: integer('count').notNull().default(0),
  resetAtMs: bigint('reset_at_ms', { mode: 'number' }).notNull(),
});

export const scheduledJobRuns = pgTable('scheduled_job_runs', {
  id: text('id').primaryKey(),
  jobName: text('job_name').notNull(),
  status: text('status').notNull(),
  summary: text('summary').notNull(),
  affectedCount: integer('affected_count').notNull().default(0),
  triggeredBy: text('triggered_by').notNull().default('scheduler'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const authTokens = pgTable('auth_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  tokenType: text('token_type').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const totpSecrets = pgTable('totp_secrets', {
  userId: text('user_id').primaryKey().references(() => users.id),
  secretBase32: text('secret_base32').notNull(),
  verified: integer('verified').notNull().default(0),
  backupCodesHashJson: text('backup_codes_hash_json').notNull().default('[]'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const emailOutbox = pgTable('email_outbox', {
  id: text('id').primaryKey(),
  recipientEmail: text('recipient_email').notNull(),
  subject: text('subject').notNull(),
  bodyText: text('body_text').notNull(),
  category: text('category').notNull().default('transactional'),
  deliveryStatus: text('delivery_status').notNull().default('queued'),
  providerResponse: text('provider_response').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const videoEvents = pgTable(
  'video_events',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull().references(() => adRequests.id),
    campaignId: text('campaign_id').notNull().references(() => campaigns.id),
    creativeId: text('creative_id').notNull().references(() => adCreatives.id),
    placementId: text('placement_id').notNull().references(() => adPlacements.id),
    publisherId: text('publisher_id').notNull().references(() => publisherAccounts.id),
    advertiserId: text('advertiser_id').notNull().references(() => advertiserAccounts.id),
    eventName: text('event_name').notNull(),
    viewableMs: integer('viewable_ms').notNull().default(0),
    billedMicros: bigint('billed_micros', { mode: 'number' }).notNull().default(0),
    publisherShareMicros: bigint('publisher_share_micros', { mode: 'number' }).notNull().default(0),
    platformFeeMicros: bigint('platform_fee_micros', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [index('idx_video_events_request').on(table.requestId, table.eventName)]
);

export const appInstalls = pgTable('app_installs', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull().unique().references(() => adRequests.id),
  campaignId: text('campaign_id').notNull().references(() => campaigns.id),
  advertiserId: text('advertiser_id').notNull().references(() => advertiserAccounts.id),
  publisherId: text('publisher_id').notNull().references(() => publisherAccounts.id),
  appBundleId: text('app_bundle_id').notNull(),
  deviceOs: text('device_os').notNull().default('iOS'),
  billedMicros: bigint('billed_micros', { mode: 'number' }).notNull().default(0),
  publisherShareMicros: bigint('publisher_share_micros', { mode: 'number' }).notNull().default(0),
  platformFeeMicros: bigint('platform_fee_micros', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const campaignAppeals = pgTable(
  'campaign_appeals',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id').notNull().references(() => campaigns.id),
    advertiserId: text('advertiser_id').notNull().references(() => advertiserAccounts.id),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('open'),
    reviewerId: text('reviewer_id').references(() => users.id),
    resolutionNotes: text('resolution_notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [index('idx_appeals_status').on(table.status, table.createdAt)]
);

export const prohibitedCategories = pgTable('prohibited_categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  keywordsJson: text('keywords_json').notNull().default('[]'),
  severity: text('severity').notNull().default('block'),
  active: integer('active').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const revokedTokens = pgTable('revoked_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});
