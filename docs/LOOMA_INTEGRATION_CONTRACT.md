# LOOMA ADS — Looma Publisher Integration Contract (`2026-11-v1`)

## Architectural Boundary

- **Strict Repository & Identity Separation**: LOOMA ADS operates as an independent advertising technology service. Looma is treated as a dedicated **first-party publisher (`pub_looma_1p`)** communicating exclusively over versioned HTTP contracts.
- **No Account Duplication**: LOOMA ADS never duplicates Looma's canonical user or business profile tables. Approved Looma business members authenticate via signed HMAC-SHA256 SSO assertions and are linked via `looma_identity_links (looma_user_id, looma_business_id)`.
- **Rendering vs. Billing Ownership**:
  - **Looma** controls feed layout, native card styling, slot insertion cadence, and organic fallback rendering.
  - **LOOMA ADS** controls ad eligibility, targeting, first-price bidding with controlled rotation, frequency capping, atomic prepaid budget reservations, fraud validation, and immutable financial ledger billing.

---

## 1. Contract Discovery

`GET /api/v1/looma/contract`

Returns active first-party publisher metadata, active Looma feed placement IDs (`plc_looma_feed_native`, `plc_looma_feed_infeed`, `plc_looma_discover_banner`), active launch feature flags, endpoint URLs, and recommended fail-open client SLA (`recommendedClientTimeoutMs: 450`, `fallbackBehavior: 'skip_slot_continue_feed'`).

---

## 2. Looma SSO & Business Membership Verification

### Endpoint
`POST /api/v1/looma/sso/exchange`

### Signed Assertion Format
`<base64url(payloadJson)>.<base64url(hmacSha256(encodedPayload, LOOMA_SSO_SHARED_SECRET))>`

Required claims in `payloadJson`:
```json
{
  "iss": "looma-core",
  "aud": "looma-ads",
  "jti": "unique-single-use-nonce",
  "loomaUserId": "looma_usr_atlas_01",
  "email": "advertiser@looma-ads.com",
  "fullName": "Maya Lin",
  "businessId": "looma_biz_atlas_01",
  "businessName": "Atlas Commerce Global",
  "membershipRole": "owner",
  "verifiedMembership": true,
  "country": "US",
  "iat": 1764000000,
  "exp": 1764000180
}
```

### Server Enforcement
1. Verifies HMAC-SHA256 signature with constant-time comparison (`crypto.timingSafeEqual`).
2. Enforces `iss === 'looma-core'`, `aud === 'looma-ads'`, and non-expired `exp`.
3. Enforces `verifiedMembership === true` and `membershipRole IN ('owner', 'admin', 'ad_manager')` (`viewer` is rejected with HTTP `403`).
4. Records `jti` in `looma_sso_nonces` inside a database transaction to prevent replay attacks (`401 sso_assertion_replayed`).
5. Reuses the existing `looma_identity_links` mapping on repeat sign-ins so Looma profiles are never duplicated.

---

## 3. Multi-Slot Feed Ad Selection API

### Endpoint
`POST /api/v1/looma/feed/ads`

### Headers
- `Content-Type: application/json`
- `x-looma-adapter-key: <LOOMA_ADAPTER_KEY>` (enforced in production)

### Request Body
```json
{
  "slots": [
    { "slotIndex": 2, "placementId": "plc_looma_feed_native" },
    { "slotIndex": 6, "placementId": "plc_looma_feed_infeed" },
    { "slotIndex": 10, "placementId": "plc_looma_discover_banner" }
  ],
  "country": "US",
  "language": "en",
  "deviceCategory": "mobile",
  "os": "iOS",
  "browser": "LoomaApp",
  "feedCategory": "business_finance",
  "consentGranted": true,
  "sessionId": "looma_sess_98f1"
}
```

### Response Guarantees
- Returns **data-only creative payloads** (`title`, `description`, `mediaUrl`, `destinationUrl`, `ctaText`, `sponsoredLabel`) — zero HTML or scripts.
- Applies **first-price bidding with controlled rotation** (`rotationFactor`) and **multi-slot campaign deduplication** so the same advertiser campaign cannot monopolize consecutive feed slots.
- Atomically reserves prepaid advertiser funds into `budget_reservations` (`reservationId`, `reservedMicros`) before returning each filled slot so delivery can never overspend available wallet funds.
- Returns single-use signed HMAC tracking tokens (`impressionToken`, `clickToken`, `conversionToken`, `videoToken`, `installToken`).

---

## 4. Billable Event Verification & Budget Settlement

Looma fires verified telemetry back to:
- `POST /api/v1/ad/impression` — Captures CPM/FIXED reservations upon viewable render (`viewable: true`).
- `POST /api/v1/ad/click` — Evaluates traffic quality/bot signals; captures CPC reservation on valid clicks or releases the reservation immediately on invalid/bot clicks.
- `POST /api/v1/ad/conversion` — Attributes conversions (`last_click` or `view_through`) and captures CPA billing.

Unconsumed reservations automatically expire after 30 minutes and are returned to `advertiser_wallets.available_micros` by the `release_expired_reservations` scheduled job.

---

## 5. Fail-Open Client SLA (`src/lib/loomaFeedClient.ts`)

Normal Looma feed rendering **must never block or fail** if LOOMA ADS experiences latency or downtime:
1. Bound every ad selection fetch with `AbortController` (`timeoutMs <= 600ms`).
2. Maintain a lightweight client circuit breaker (opens for 15s after 3 consecutive failures).
3. On timeout, HTTP error, or open circuit, return `{ degraded: true, decisions: [] }` and render organic Looma feed items seamlessly without gaps.
