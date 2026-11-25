# LOOMA ADS — Modular Architecture & Operations Guide

## 1. Confirmed Business Model & Initial Launch Flags

LOOMA ADS is an independent, modular advertising technology platform supporting both first-party and third-party network operations:

| Feature Flag (`platform_settings`) | Initial Launch Default | Purpose |
| --- | --- | --- |
| `looma_first_party_only_mode` | `true` | Restricts live ad serving to Looma (`pub_looma_1p`) at initial launch |
| `external_publisher_registration_enabled` | `false` | Blocks external third-party publisher self-registration (`HTTP 403`) |
| `third_party_sdk_distribution_enabled` | `false` | Keeps third-party SDK delivery & external placements gated until expansion |
| `third_party_revenue_allocation_enabled` | `false` | Disables third-party revenue share credits until expansion phase |
| `third_party_publisher_payouts_enabled` | `false` | Blocks third-party withdrawal requests (`HTTP 403`) until expansion phase |
| `postpaid_advertiser_credit_enabled` | `false` | Enforces strictly prepaid advertiser wallets at initial launch |

All flags are persisted in `platform_settings`, enforced server-side across auth, delivery, billing, and payout routes, and auditable/toggleable in the standalone Admin application (`/admin` -> **Platform Settings**).

---

## 2. Independent Module Map (16 ADR Domains)

1. **Identity & Authentication**: `server/auth.ts`, `server/routes/publicAndAuth.ts`, `server/security.ts` (PBKDF2 password hashing, HMAC session tokens, RFC 6238 TOTP 2FA, email verification, password reset).
2. **Looma Integration & SSO Adapter**: `server/modules/loomaAdapter.ts`, `server/routes/loomaIntegration.ts`, `src/lib/loomaFeedClient.ts`.
3. **Advertiser Management**: `server/routes/advertiser.ts`, `src/components/AdvertiserWorkspace.tsx`.
4. **Publisher Management**: `server/routes/publisher.ts`, `src/components/PublisherWorkspace.tsx`.
5. **Campaign Management**: `server/routes/advertiser.ts` (`campaigns`, `campaign_budgets`, `campaign_targeting`).
6. **Creative Management & Media Storage**: `server/routes/advertiser.ts` (`/api/advertiser/media` magic-byte validation, `/api/media/:filename` confined static serving; maps 1:1 to Cloudflare R2 in edge deployment).
7. **Targeting**: `server/engine.ts` (`isCandidateEligible` — geo, language, device, OS, browser, contextual category, GDPR/regional consent, frequency caps).
8. **Placement Management**: `server/routes/publisher.ts` (`ad_placements`, `publisher_properties`, live DNS TXT / `ads.txt` / meta verification).
9. **Ad Delivery**: `server/routes/adDelivery.ts`, `server/modules/loomaAdapter.ts`.
10. **Ranking & Bidding**: `server/engine.ts` (`computeEffectiveCpmMicros`, `computeRotationFactor`, `selectWinningAds` — first-price bidding with controlled ranking & rotation diversity damping).
11. **Budget Reservations**: `server/modules/budgetReservations.ts` (`reserveBudgetForRequest`, `captureReservationInTx`, `releaseReservationInTx`, `releaseExpiredReservationsInTx`).
12. **Prepaid Billing & Immutable Ledger**: `server/routes/advertiser.ts`, `server/routes/publicAndAuth.ts` (`/api/webhooks/payments/:provider` — Paystack & Flutterwave HMAC verification, idempotency keys, integer USD micros).
13. **Analytics & Reporting**: `server/routes/advertiser.ts` (`/reporting`, `/reporting/csv`), `server/routes/publisher.ts`.
14. **Conversion Attribution**: `server/routes/adDelivery.ts` (`/conversion`, `/video-event`, `/install`, `attribution_records`).
15. **Moderation & Policy Engine**: `server/routes/admin.ts`, `server/security.ts` (`scanProhibitedContent`, `prohibited_categories`, `campaign_appeals`, `moderation_reviews`).
16. **Fraud Prevention, Monitoring & Administration**: `server/engine.ts` (`evaluateTrafficQuality`), `server/modules/monitoring.ts`, `server/jobs.ts`, standalone `/admin` React application (`admin/`).

---

## 3. Strict Application Separation

- **Advertiser & First-Party Publisher Web App (`/`)**: Port `3000`. Administrator login is explicitly blocked in the main UI.
- **Standalone Platform Administration (`/admin`)**: Separate Vite/React project in `/admin` (Port `3001`, explicit CORS allowlist in `server.ts`, strict `requireRole('admin')` enforcement).
- **Delivery Infrastructure (`/api/v1/ad/*` & `/api/v1/looma/*`)**: Isolated stateless request/event verification routes with persistent rate limiting and cross-origin support.

---

## 4. Financial & Overspend Invariants

- All balances and charges use 64-bit integer **USD micros** (`$1.00 = 1,000,000 micros`).
- Every filled ad decision atomically moves `estimatedBillableMicros` from `advertiser_wallets.available_micros` to `reserved_micros`, creates a `budget_reservations` row, and appends a `'budget_reserve'` entry to `financial_ledger`.
- Only verified billable events (`impression`, `click`, `conversion`, `video_view`, `app_install`) capture funds (`'ad_spend'`); any unused surplus or bot-rejected reservation is returned via `'budget_release'`.
- Expired reservations are automatically released every 5 minutes by `release_expired_reservations` (`server/jobs.ts`).

---

## 5. Production Edge Deployment Mapping (Cloudflare + PostgreSQL/Drizzle)

The current sandbox runs natively on Node.js + Express + SQLite for zero-config execution and instant local verification, while maintaining a clean production migration path:
- **Database & ORM**: Apply `server/db/drizzle-schema.ts` to PostgreSQL (Neon / Cloud SQL / Hyperdrive) using Drizzle ORM.
- **Backend Runtime**: Port route handlers (`server/routes/*`) onto **Hono** on **Cloudflare Workers** (pure TypeScript modules in `server/engine.ts` and `server/modules/*` have zero Express coupling).
- **Media Storage**: Map `/api/advertiser/media` and `/api/media/:filename` directly to a **Cloudflare R2** bucket.
- **Background Jobs & Scheduling**: Trigger `server/jobs.ts` tasks (`release_expired_reservations`, `daily_budget_reset`, `publisher_earnings_settlement`, `expired_token_cleanup`) via **Cloudflare Cron Triggers** and asynchronous event fan-out via **Cloudflare Queues**.
