import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy } from 'lucide-react';
import { apiRequest, formatMicros, UserRole } from '../lib/api';
import {
  FOOTER_PAGES,
  FooterPageCategory,
  FooterPageSlug,
  getFooterPageMeta,
  getFooterPagesByCategory,
} from '../lib/footerRoutes';

interface LoomaContractResponse {
  contractVersion: string;
  publisher: {
    id: string;
    organization_name: string;
    publisher_type: string;
    approval_status: string;
  } | null;
  placements: Array<{
    id: string;
    name: string;
    format: string;
    dimensions: string;
    floor_cpm_micros: number;
  }>;
  endpoints: Record<string, string>;
  sla: {
    recommendedClientTimeoutMs: number;
    fallbackBehavior: string;
    renderingOwnership: string;
    billingOwnership: string;
  };
}

interface PricingModelItem {
  code: string;
  name: string;
  unit: string;
  minUsd: number;
}

interface FooterPageViewProps {
  slug: FooterPageSlug;
  onNavigateHome: (sectionId?: string) => void;
  onNavigatePage: (slug: FooterPageSlug) => void;
  onOpenAuth: (mode: 'login' | 'register', role?: 'advertiser' | 'publisher') => void;
  onQuickSandbox: (role: Extract<UserRole, 'advertiser' | 'publisher'>) => void;
}

const CATEGORIES: FooterPageCategory[] = ['Platform', 'Developers', 'Governance'];

const DEFAULT_PRICING_MODELS: PricingModelItem[] = [
  { code: 'CPM', name: 'Cost Per Mille', unit: '1,000 verified impressions', minUsd: 0.5 },
  { code: 'CPC', name: 'Cost Per Click', unit: 'Verified user click', minUsd: 0.1 },
  { code: 'CPA', name: 'Cost Per Acquisition', unit: 'Attributed conversion', minUsd: 2.0 },
  { code: 'CPI', name: 'Cost Per Install', unit: 'Verified app install', minUsd: 1.5 },
  { code: 'CPV', name: 'Cost Per View', unit: 'Completed video view', minUsd: 0.05 },
  { code: 'FIXED', name: 'Fixed Sponsorship', unit: 'Guaranteed placement share', minUsd: 500.0 },
];

const WEB_SDK_SNIPPET = `<div id="looma-feed-slot-1"></div>
<script src="/sdk/looma-ads.js"></script>
<script>
  window.LoomaAds.renderPlacement({
    container: '#looma-feed-slot-1',
    placementId: 'plc_looma_feed_native',
    country: 'US',
    language: 'en',
    category: 'business_finance',
    consentGranted: true,
    timeoutMs: 450
  });
</script>`;

const REST_REQUEST_SNIPPET = `POST /api/v1/ad/request
Content-Type: application/json

{
  "placementId": "plc_looma_feed_native",
  "country": "US",
  "language": "en",
  "deviceCategory": "desktop",
  "category": "business_finance",
  "consentGranted": true
}`;

const REST_RESPONSE_SNIPPET = `{
  "filled": true,
  "requestId": "req_9f21b4c8e2a1",
  "reservationId": "res_84a1c92f",
  "creative": {
    "id": "crt_1",
    "format": "native",
    "title": "Atlas Titanium Corporate Card",
    "description": "Multi-currency treasury controls with real-time spend rules.",
    "ctaText": "Explore Offer",
    "destinationUrl": "https://atlascommerce.io/offer",
    "sponsoredLabel": "Sponsored"
  },
  "tracking": {
    "impressionUrl": "/api/v1/ad/impression?token=eyJ...",
    "clickUrl": "/api/v1/ad/click?token=eyJ...",
    "conversionUrl": "/api/v1/ad/conversion"
  }
}`;

const LOOMA_FEED_SNIPPET = `POST /api/v1/looma/feed/ads
Content-Type: application/json

{
  "placementIds": ["plc_looma_feed_native", "plc_looma_feed_infeed"],
  "country": "NG",
  "language": "en",
  "deviceCategory": "mobile",
  "category": "business_finance",
  "consentGranted": true
}`;

export const FooterPageView: React.FC<FooterPageViewProps> = ({
  slug,
  onNavigateHome,
  onNavigatePage,
  onOpenAuth,
  onQuickSandbox,
}) => {
  const meta = getFooterPageMeta(slug);

  const [contractData, setContractData] = useState<LoomaContractResponse | null>(null);
  const [contractLoading, setContractLoading] = useState(false);
  const [contractError, setContractError] = useState<string | null>(null);

  const [pricingModels, setPricingModels] = useState<PricingModelItem[]>(DEFAULT_PRICING_MODELS);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Live GDPR / Data Rights form state
  const [privacyForm, setPrivacyForm] = useState({
    email: '',
    requestType: 'data_export',
    jurisdiction: 'GDPR',
    details: '',
  });
  const [privacyStatus, setPrivacyStatus] = useState<string | null>(null);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const [privacySubmitting, setPrivacySubmitting] = useState(false);

  // Live Contact Engineering & Commercial form state
  const [contactForm, setContactForm] = useState({
    name: '',
    email: '',
    company: '',
    interest: 'advertising',
    message: '',
  });
  const [contactStatus, setContactStatus] = useState<string | null>(null);
  const [contactError, setContactError] = useState<string | null>(null);
  const [contactSubmitting, setContactSubmitting] = useState(false);

  useEffect(() => {
    if (slug === 'integration-contract' && !contractData) {
      setContractLoading(true);
      setContractError(null);
      apiRequest<LoomaContractResponse>('/api/v1/looma/contract')
        .then(setContractData)
        .catch((err) => {
          setContractError(err instanceof Error ? err.message : 'Unable to load contract specification');
        })
        .finally(() => setContractLoading(false));
    }

    if (slug === 'pricing-models') {
      apiRequest<{ pricingModels?: PricingModelItem[] }>('/api/public/overview')
        .then((res) => {
          if (res.pricingModels && res.pricingModels.length > 0) {
            setPricingModels(res.pricingModels);
          }
        })
        .catch(() => {
          // Keep defaults if offline
        });
    }
  }, [slug, contractData]);

  function handleCopy(id: string, text: string) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    setCopiedId(id);
    window.setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 1800);
  }

  async function handlePrivacySubmit(e: React.FormEvent) {
    e.preventDefault();
    setPrivacyStatus(null);
    setPrivacyError(null);
    setPrivacySubmitting(true);
    try {
      const res = await apiRequest<{ requestId: string }>('/api/public/privacy-request', {
        method: 'POST',
        body: JSON.stringify(privacyForm),
      });
      setPrivacyStatus(
        `Request ${res.requestId} logged under ${privacyForm.jurisdiction} compliance workflow. Confirmation details have been recorded.`
      );
      setPrivacyForm({ email: '', requestType: 'data_export', jurisdiction: 'GDPR', details: '' });
    } catch (err) {
      setPrivacyError(err instanceof Error ? err.message : 'Unable to submit privacy request');
    } finally {
      setPrivacySubmitting(false);
    }
  }

  async function handleContactSubmit(e: React.FormEvent) {
    e.preventDefault();
    setContactError(null);
    setContactStatus(null);
    setContactSubmitting(true);
    try {
      const res = await apiRequest<{ inquiryId: string }>('/api/public/contact', {
        method: 'POST',
        body: JSON.stringify(contactForm),
      });
      setContactStatus(
        `Inquiry ${res.inquiryId} received. Our engineering and commercial desk will respond within 1 business day.`
      );
      setContactForm({ name: '', email: '', company: '', interest: 'advertising', message: '' });
    } catch (err) {
      setContactError(err instanceof Error ? err.message : 'Unable to submit inquiry');
    } finally {
      setContactSubmitting(false);
    }
  }

  const currentIdx = FOOTER_PAGES.findIndex((p) => p.slug === slug);
  const prevPage = currentIdx > 0 ? FOOTER_PAGES[currentIdx - 1] : null;
  const nextPage = currentIdx >= 0 && currentIdx < FOOTER_PAGES.length - 1 ? FOOTER_PAGES[currentIdx + 1] : null;

  return (
    <main id="top" className="bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Page Header Band */}
      <section className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/35">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
          <nav
            aria-label="Breadcrumb"
            className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-4"
          >
            <button
              type="button"
              onClick={() => onNavigateHome()}
              className="inline-flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-300 hover:text-blue-700 dark:hover:text-blue-400 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Home</span>
            </button>
            <span aria-hidden="true">/</span>
            <span>{meta.category}</span>
            <span aria-hidden="true">/</span>
            <span className="text-slate-900 dark:text-slate-100 font-medium">{meta.navLabel}</span>
          </nav>

          <div className="max-w-3xl space-y-3">
            <div className="text-xs font-mono text-slate-500 dark:text-slate-400">{meta.effectiveLabel}</div>
            <h1
              className="font-display font-bold tracking-tight text-slate-900 dark:text-white leading-[1.12]"
              style={{ fontSize: 'clamp(1.75rem, 3.4vw, 2.75rem)', textWrap: 'balance' }}
            >
              {meta.title}
            </h1>
            <p className="text-sm sm:text-base leading-relaxed text-slate-600 dark:text-slate-300 max-w-2xl">
              {meta.subtitle}
            </p>
          </div>
        </div>
      </section>

      {/* Main Documentation & Interactive Body */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12 grid lg:grid-cols-12 gap-8 lg:gap-12 items-start">
        {/* Mobile Page Switcher */}
        <div className="lg:hidden">
          <label
            htmlFor="mobile-footer-page-select"
            className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5"
          >
            Jump to Documentation Page
          </label>
          <select
            id="mobile-footer-page-select"
            value={slug}
            onChange={(e) => onNavigatePage(e.target.value as FooterPageSlug)}
            className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
          >
            {CATEGORIES.map((category) => (
              <optgroup key={category} label={category}>
                {getFooterPagesByCategory(category).map((page) => (
                  <option key={page.slug} value={page.slug}>
                    {page.navLabel}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* Desktop Left Navigation Rail */}
        <aside className="hidden lg:block lg:col-span-3 sticky top-24 space-y-6">
          {CATEGORIES.map((category) => (
            <div key={category} className="space-y-2">
              <div className="text-xs font-semibold text-slate-900 dark:text-white tracking-wide px-2">
                {category}
              </div>
              <ul className="space-y-0.5 text-sm">
                {getFooterPagesByCategory(category).map((page) => {
                  const active = page.slug === slug;
                  return (
                    <li key={page.slug}>
                      <a
                        href={page.path}
                        onClick={(e) => {
                          e.preventDefault();
                          onNavigatePage(page.slug);
                        }}
                        aria-current={active ? 'page' : undefined}
                        className={`block px-2.5 py-2 rounded-lg text-[13px] transition-colors ${
                          active
                            ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100/70 dark:hover:bg-slate-900'
                        }`}
                      >
                        {page.navLabel}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </aside>

        {/* Main Page Content */}
        <article className="lg:col-span-9 min-w-0 space-y-8 text-sm sm:text-[15px] leading-relaxed text-slate-700 dark:text-slate-300">
          {/* 1. AUCTION ENGINE */}
          {slug === 'auction-engine' && (
            <>
              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  01. Eligibility &amp; Pre-Auction Filtering
                </h2>
                <p>
                  Every incoming ad slot request runs through Looma Advertising&apos;s deterministic auction pipeline
                  before a single creative is returned. Candidates must pass six mandatory gates simultaneously:
                  approved campaign and creative moderation status, active date schedule, matching geo/language/device
                  and contextual targeting, GDPR/regional consent compliance, frequency cap headroom, and sufficient
                  unreserved prepaid wallet funds.
                </p>
              </section>

              <div className="grid sm:grid-cols-3 gap-4">
                <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Auction Mechanism</div>
                  <div className="mt-1 font-semibold text-slate-900 dark:text-white">First-Price Normalized eCPM</div>
                  <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                    CPC, CPA, CPI, CPV, and Fixed bids normalize into micro-USD eCPM using quality and predicted CTR.
                  </p>
                </div>
                <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Rotation &amp; Diversity</div>
                  <div className="mt-1 font-semibold text-slate-900 dark:text-white">Controlled Multi-Slot Rotation</div>
                  <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                    Multi-slot feeds deduplicate campaigns across positions and dampen recently served ads.
                  </p>
                </div>
                <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Spend Protection</div>
                  <div className="mt-1 font-semibold text-slate-900 dark:text-white">Atomic Budget Reservations</div>
                  <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                    Funds lock at ad selection so concurrent delivery can never overspend available prepaid balance.
                  </p>
                </div>
              </div>

              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  02. Cryptographic Event Settlement
                </h2>
                <p>
                  Winning creatives receive HMAC-SHA256 signed impression and click tokens bound to the exact request
                  ID, placement ID, campaign ID, and reservation ID. An ad request never bills by itself; charges settle
                  strictly on verified billable events after duplicate, bot, and IP-velocity checks pass.
                </p>
              </section>

              <div className="pt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => onQuickSandbox('advertiser')}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors"
                >
                  <span>Open Advertiser Console</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onNavigatePage('integration-contract')}
                  className="px-4 py-2.5 text-xs sm:text-sm font-medium border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors"
                >
                  Inspect Looma Integration Contract
                </button>
              </div>
            </>
          )}

          {/* 2. AD FORMATS */}
          {slug === 'ad-formats' && (
            <>
              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  01. Format Matrix &amp; Slot Compatibility
                </h2>
                <p>
                  Looma Advertising renders native, display, video, and sponsored formats designed to preserve feed
                  typography while maintaining unambiguous sponsorship disclosure on every unit.
                </p>
              </section>

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs sm:text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-950/60 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 whitespace-nowrap">
                      <tr>
                        <th className="py-3 px-4 font-medium">Format</th>
                        <th className="py-3 px-4 font-medium">Dimensions / Ratio</th>
                        <th className="py-3 px-4 font-medium">Supported Media</th>
                        <th className="py-3 px-4 font-medium">Primary Billing</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {[
                        ['Native In-Feed', 'Fluid (16:9 or 4:3)', 'JPEG, PNG, WEBP + Headline/CTA', 'CPC / CPM / CPA'],
                        ['Display Banner', '728×90, 300×250, 320×50', 'JPEG, PNG, WEBP', 'CPM / CPC'],
                        ['Responsive Unit', 'Adaptive container width', 'JPEG, PNG, WEBP + Text', 'CPC / CPM'],
                        ['Sponsored Content', 'Editorial card layout', 'Image + Long-form description', 'FIXED / CPM'],
                        ['Video Ad', '16:9 or 9:16 (up to 10 MB)', 'MP4, WEBM (magic-byte verified)', 'CPV / CPM'],
                        ['Text Ad', 'Fluid text block', 'Headline + Copy + Destination URL', 'CPC'],
                      ].map(([format, dims, media, billing]) => (
                        <tr key={format}>
                          <td className="py-3 px-4 font-medium text-slate-900 dark:text-white whitespace-nowrap">{format}</td>
                          <td className="py-3 px-4 font-mono text-xs text-slate-600 dark:text-slate-300">{dims}</td>
                          <td className="py-3 px-4 text-slate-600 dark:text-slate-300">{media}</td>
                          <td className="py-3 px-4 font-mono text-xs text-slate-700 dark:text-slate-200 whitespace-nowrap">{billing}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  02. Media Validation &amp; Moderation Controls
                </h2>
                <p>
                  Uploaded assets are inspected against binary magic-byte signatures prior to storage to block spoofed
                  file extensions, oversized payloads, or active scripts. Destination URLs undergo SSRF and private-IP
                  screening before entering moderation review.
                </p>
              </section>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => onQuickSandbox('advertiser')}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors"
                >
                  <span>Build a Creative in Advertiser Studio</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </>
          )}

          {/* 3. PRICING MODELS */}
          {slug === 'pricing-models' && (
            <>
              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  01. Configurable Campaign Billing Rules
                </h2>
                <p>
                  Every campaign chooses a single pricing model enforced consistently across auction scoring, budget
                  reservations, and immutable financial ledger debits. All figures settle in micro-USD integer units
                  (1 USD = 1,000,000 micros) to prevent floating-point drift.
                </p>
              </section>

              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {pricingModels.map((m) => (
                  <div
                    key={m.code}
                    className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-sm font-semibold text-blue-700 dark:text-blue-400">
                        {m.code}
                      </span>
                      <span className="font-mono tabular-nums text-xs text-slate-500 dark:text-slate-400">
                        Min ${m.minUsd.toFixed(2)}
                      </span>
                    </div>
                    <h3 className="mt-2 font-semibold text-slate-900 dark:text-white">{m.name}</h3>
                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">Billed per {m.unit}.</p>
                  </div>
                ))}
              </div>

              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  02. Exclusively Prepaid Launch Accounting
                </h2>
                <p>
                  At initial launch, Looma Advertising operates exclusively on prepaid advertiser wallets funded via
                  Paystack, Flutterwave, Stripe, or international bank transfer with idempotent verified webhooks.
                  Postpaid credit accounts are disabled so advertisers maintain strict spending certainty.
                </p>
              </section>

              <div className="pt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => onOpenAuth('register', 'advertiser')}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors"
                >
                  <span>Create Prepaid Advertiser Account</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onNavigatePage('advertiser-terms')}
                  className="px-4 py-2.5 text-xs sm:text-sm font-medium border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors"
                >
                  Read Advertiser Terms
                </button>
              </div>
            </>
          )}

          {/* 4. FAQ */}
          {slug === 'faq' && (
            <div className="space-y-4">
              {[
                {
                  q: 'How are advertiser wallets protected from overspending?',
                  a: 'Before an ad is returned, Looma Advertising checks available prepaid balance plus daily and lifetime campaign caps, then places an atomic budget reservation inside a database transaction. Unbilled or expired holds automatically return to available balance.',
                },
                {
                  q: 'Does Looma Advertising use Google Ads or Meta Ads underneath?',
                  a: 'No. Looma Advertising runs its own independent campaign management, targeting, first-price auction ranking, signed ad-delivery tracking, prepaid billing ledger, moderation, and analytics infrastructure.',
                },
                {
                  q: 'Which publishers are active at initial launch?',
                  a: 'Looma is the exclusive active first-party publisher at initial launch. External third-party publisher registration, SDK distribution, and payout onboarding are built architecturally but remain disabled via feature flags until the dedicated expansion phase.',
                },
                {
                  q: 'What happens to the Looma feed if the ad service is temporarily unreachable?',
                  a: 'Looma controls organic feed rendering while LOOMA ADS controls ad selection and billing. The integration contract enforces a 450 ms client timeout with fail-open behavior so normal feed rendering continues without interruption.',
                },
                {
                  q: 'Which payment providers are supported for funding prepaid wallets?',
                  a: 'Advertisers can deposit funds through Paystack, Flutterwave, Stripe, or bank transfer. All webhook notifications are verified cryptographically with HMAC signatures and processed idempotently.',
                },
                {
                  q: 'How are duplicate clicks and automated bots handled?',
                  a: 'Every click requires a valid HMAC-SHA256 impression token and passes duplicate-click, IP-velocity, and bot user-agent evaluation prior to billing. Invalid traffic is logged for auditing and never charged to advertisers.',
                },
              ].map((item, idx) => (
                <section
                  key={item.q}
                  className="p-5 sm:p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2"
                >
                  <h2 className="font-semibold text-base text-slate-900 dark:text-white">
                    {String(idx + 1).padStart(2, '0')}. {item.q}
                  </h2>
                  <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">{item.a}</p>
                </section>
              ))}
            </div>
          )}

          {/* 5. WEB SDK GUIDE */}
          {slug === 'web-sdk' && (
            <>
              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  01. Quick-Start Script Integration
                </h2>
                <p>
                  Load the lightweight Looma Web SDK script and bind any placement container. The SDK automatically
                  respects explicit privacy consent flags, enforces fail-open timeouts, and fires verified impression
                  beacons only when the creative renders into view.
                </p>
              </section>

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 text-slate-100 overflow-hidden">
                <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono text-slate-400">HTML / JavaScript Snippet</span>
                  <button
                    type="button"
                    onClick={() => handleCopy('web-sdk', WEB_SDK_SNIPPET)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-700 text-slate-200 hover:bg-slate-800 transition-colors"
                  >
                    {copiedId === 'web-sdk' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedId === 'web-sdk' ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <pre className="p-4 sm:p-5 text-xs font-mono leading-relaxed overflow-x-auto text-slate-200">
                  {WEB_SDK_SNIPPET}
                </pre>
              </div>

              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  02. Launch Mode &amp; First-Party Enforcement
                </h2>
                <p>
                  During initial launch, external third-party SDK distribution is disabled by feature flag. The SDK
                  exclusively serves verified Looma first-party placements while preserving full forward compatibility
                  for future third-party publisher expansion.
                </p>
              </section>

              <div className="pt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => onQuickSandbox('publisher')}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors"
                >
                  <span>Test in Looma Feed Sandbox</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onNavigatePage('rest-api')}
                  className="px-4 py-2.5 text-xs sm:text-sm font-medium border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors"
                >
                  View REST Delivery API
                </button>
              </div>
            </>
          )}

          {/* 6. REST DELIVERY API */}
          {slug === 'rest-api' && (
            <>
              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  01. Requesting an Eligible Ad Unit
                </h2>
                <p>
                  Call <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800">POST /api/v1/ad/request</code> for
                  single-slot delivery or <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800">POST /api/v1/looma/feed/ads</code> for
                  deduplicated multi-slot Looma feed insertion.
                </p>
              </section>

              <div className="grid gap-4">
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 text-slate-100 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between text-xs">
                    <span className="font-mono text-slate-400">Single-Slot Delivery Request</span>
                    <button
                      type="button"
                      onClick={() => handleCopy('rest-req', REST_REQUEST_SNIPPET)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-700 text-slate-200 hover:bg-slate-800 transition-colors"
                    >
                      {copiedId === 'rest-req' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedId === 'rest-req' ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <pre className="p-4 text-xs font-mono leading-relaxed overflow-x-auto text-slate-200">
                    {REST_REQUEST_SNIPPET}
                  </pre>
                </div>

                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 text-slate-100 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between text-xs">
                    <span className="font-mono text-slate-400">Signed Creative Response Payload</span>
                    <button
                      type="button"
                      onClick={() => handleCopy('rest-res', REST_RESPONSE_SNIPPET)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-700 text-slate-200 hover:bg-slate-800 transition-colors"
                    >
                      {copiedId === 'rest-res' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedId === 'rest-res' ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <pre className="p-4 text-xs font-mono leading-relaxed overflow-x-auto text-slate-200">
                    {REST_RESPONSE_SNIPPET}
                  </pre>
                </div>

                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 text-slate-100 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between text-xs">
                    <span className="font-mono text-slate-400">Looma Multi-Slot Feed Adapter Request</span>
                    <button
                      type="button"
                      onClick={() => handleCopy('feed-req', LOOMA_FEED_SNIPPET)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-700 text-slate-200 hover:bg-slate-800 transition-colors"
                    >
                      {copiedId === 'feed-req' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedId === 'feed-req' ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <pre className="p-4 text-xs font-mono leading-relaxed overflow-x-auto text-slate-200">
                    {LOOMA_FEED_SNIPPET}
                  </pre>
                </div>
              </div>
            </>
          )}

          {/* 7. INTEGRATION CONTRACT (LIVE API DATA) */}
          {slug === 'integration-contract' && (
            <>
              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  01. Separation of Responsibilities
                </h2>
                <p>
                  Looma is integrated as an independent first-party publisher over a dedicated contract adapter without
                  merging codebases or duplicating Looma user accounts. Looma controls feed layout and rendering, while
                  LOOMA ADS controls auction ranking, eligibility checks, atomic prepaid reservations, and event billing.
                </p>
              </section>

              {contractLoading && (
                <div className="p-6 rounded-xl border border-slate-200 dark:border-slate-800 text-xs text-slate-500">
                  Loading live contract specification from /api/v1/looma/contract...
                </div>
              )}

              {contractError && (
                <div className="p-4 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300">
                  {contractError}
                </div>
              )}

              {contractData && (
                <div className="space-y-6">
                  <div className="grid sm:grid-cols-2 gap-4 text-xs">
                    <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
                      <div className="text-slate-500 dark:text-slate-400">Contract Version</div>
                      <div className="mt-1 font-mono font-semibold text-slate-900 dark:text-white">
                        {contractData.contractVersion}
                      </div>
                    </div>
                    <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
                      <div className="text-slate-500 dark:text-slate-400">Active First-Party Publisher</div>
                      <div className="mt-1 font-mono font-semibold text-slate-900 dark:text-white">
                        {contractData.publisher?.organization_name} ({contractData.publisher?.id})
                      </div>
                    </div>
                    <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
                      <div className="text-slate-500 dark:text-slate-400">Recommended Client Timeout</div>
                      <div className="mt-1 font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                        {contractData.sla.recommendedClientTimeoutMs} ms ({contractData.sla.fallbackBehavior})
                      </div>
                    </div>
                    <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
                      <div className="text-slate-500 dark:text-slate-400">Ownership Split</div>
                      <div className="mt-1 font-medium text-slate-900 dark:text-white">
                        Rendering: {contractData.sla.renderingOwnership} · Billing: {contractData.sla.billingOwnership}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900">
                    <div className="px-4 py-3 bg-slate-50 dark:bg-slate-950/60 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-900 dark:text-white">
                      Registered First-Party Placements ({contractData.placements.length})
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 whitespace-nowrap">
                          <tr>
                            <th className="py-2.5 px-4 font-medium">Placement ID</th>
                            <th className="py-2.5 px-4 font-medium">Name</th>
                            <th className="py-2.5 px-4 font-medium">Format</th>
                            <th className="py-2.5 px-4 font-medium">Dimensions</th>
                            <th className="py-2.5 px-4 font-medium text-right">Floor CPM</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                          {contractData.placements.map((p) => (
                            <tr key={p.id}>
                              <td className="py-2.5 px-4 font-mono text-slate-900 dark:text-slate-100 whitespace-nowrap">{p.id}</td>
                              <td className="py-2.5 px-4 font-medium text-slate-900 dark:text-white">{p.name}</td>
                              <td className="py-2.5 px-4 capitalize text-slate-600 dark:text-slate-300">{p.format}</td>
                              <td className="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-300 whitespace-nowrap">{p.dimensions}</td>
                              <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-900 dark:text-white whitespace-nowrap">
                                {formatMicros(p.floor_cpm_micros)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900">
                    <div className="px-4 py-3 bg-slate-50 dark:bg-slate-950/60 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-900 dark:text-white">
                      Contract Endpoints
                    </div>
                    <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs font-mono">
                      {Object.entries(contractData.endpoints).map(([name, endpointPath]) => (
                        <div key={name} className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-slate-500 dark:text-slate-400">{name}</span>
                          <span className="text-slate-900 dark:text-slate-100 break-all">{endpointPath}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* 8. CONTACT ENGINEERING */}
          {slug === 'contact' && (
            <div className="space-y-6">
              <div className="grid sm:grid-cols-3 gap-4 text-xs">
                <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
                  <div className="text-slate-500 dark:text-slate-400">Response Window</div>
                  <div className="mt-1 font-semibold text-slate-900 dark:text-white">Within 1 Business Day</div>
                </div>
                <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
                  <div className="text-slate-500 dark:text-slate-400">Payment Settlement Rails</div>
                  <div className="mt-1 font-semibold text-slate-900 dark:text-white">Paystack, Flutterwave, SWIFT</div>
                </div>
                <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
                  <div className="text-slate-500 dark:text-slate-400">Data Rights Requests</div>
                  <button
                    type="button"
                    onClick={() => onNavigatePage('gdpr-data-requests')}
                    className="mt-1 font-semibold text-blue-700 dark:text-blue-400 hover:underline text-left"
                  >
                    Open GDPR Portal →
                  </button>
                </div>
              </div>

              <form
                onSubmit={handleContactSubmit}
                className="p-5 sm:p-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4"
              >
                {contactStatus && (
                  <div className="p-3.5 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-sm text-emerald-800 dark:text-emerald-200">
                    {contactStatus}
                  </div>
                )}
                {contactError && (
                  <div className="p-3.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300">
                    {contactError}
                  </div>
                )}

                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="fp-contact-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Full Name
                    </label>
                    <input
                      id="fp-contact-name"
                      type="text"
                      required
                      value={contactForm.name}
                      onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })}
                      placeholder="Amara Okafor"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label htmlFor="fp-contact-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Business Email
                    </label>
                    <input
                      id="fp-contact-email"
                      type="email"
                      required
                      value={contactForm.email}
                      onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
                      placeholder="amara@company.com"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="fp-contact-company" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Company / Organization
                    </label>
                    <input
                      id="fp-contact-company"
                      type="text"
                      value={contactForm.company}
                      onChange={(e) => setContactForm({ ...contactForm, company: e.target.value })}
                      placeholder="Atlas Commerce Global"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label htmlFor="fp-contact-interest" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Inquiry Focus
                    </label>
                    <select
                      id="fp-contact-interest"
                      value={contactForm.interest}
                      onChange={(e) => setContactForm({ ...contactForm, interest: e.target.value })}
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="advertising">Enterprise Advertising</option>
                      <option value="engineering">SDK &amp; Integration Engineering</option>
                      <option value="compliance">Privacy &amp; Compliance</option>
                      <option value="billing">Prepaid Billing &amp; Settlements</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label htmlFor="fp-contact-message" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Message
                  </label>
                  <textarea
                    id="fp-contact-message"
                    rows={4}
                    required
                    value={contactForm.message}
                    onChange={(e) => setContactForm({ ...contactForm, message: e.target.value })}
                    placeholder="Share integration requirements, campaign volume, or billing reconciliation questions."
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>

                <div className="pt-1 flex justify-end">
                  <button
                    type="submit"
                    disabled={contactSubmitting}
                    className="w-full sm:w-auto px-6 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors"
                  >
                    {contactSubmitting ? 'Sending...' : 'Send Inquiry'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* 9. GDPR & DATA REQUESTS */}
          {slug === 'gdpr-data-requests' && (
            <div className="space-y-6">
              <p>
                Every privacy request submitted below is written directly to Looma Advertising&apos;s compliance audit
                queue and processed under the statutory deadline for your jurisdiction (30 days under GDPR / UK GDPR, 45
                days under CCPA / CPRA).
              </p>

              <form
                onSubmit={handlePrivacySubmit}
                className="p-5 sm:p-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4"
              >
                {privacyError && (
                  <div className="p-3.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300">
                    {privacyError}
                  </div>
                )}
                {privacyStatus && (
                  <div className="p-3.5 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-xs text-emerald-800 dark:text-emerald-200">
                    {privacyStatus}
                  </div>
                )}

                <div>
                  <label htmlFor="fp-prv-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Account or Contact Email
                  </label>
                  <input
                    id="fp-prv-email"
                    type="email"
                    required
                    value={privacyForm.email}
                    onChange={(e) => setPrivacyForm({ ...privacyForm, email: e.target.value })}
                    placeholder="name@company.com"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="fp-prv-type" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Request Type
                    </label>
                    <select
                      id="fp-prv-type"
                      value={privacyForm.requestType}
                      onChange={(e) => setPrivacyForm({ ...privacyForm, requestType: e.target.value })}
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="data_export">Data Export (Access / Portability)</option>
                      <option value="data_deletion">Data Deletion (Erasure)</option>
                      <option value="consent_withdrawal">Consent Withdrawal</option>
                      <option value="rectification">Data Rectification</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="fp-prv-jurisdiction" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Jurisdiction
                    </label>
                    <select
                      id="fp-prv-jurisdiction"
                      value={privacyForm.jurisdiction}
                      onChange={(e) => setPrivacyForm({ ...privacyForm, jurisdiction: e.target.value })}
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="GDPR">EU / EEA (GDPR)</option>
                      <option value="UK_GDPR">United Kingdom (UK GDPR)</option>
                      <option value="CCPA">California (CCPA / CPRA)</option>
                      <option value="NDPA">Nigeria (NDPA)</option>
                      <option value="OTHER">Other Jurisdiction</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label htmlFor="fp-prv-details" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Additional Verification Details (Optional)
                  </label>
                  <textarea
                    id="fp-prv-details"
                    rows={3}
                    value={privacyForm.details}
                    onChange={(e) => setPrivacyForm({ ...privacyForm, details: e.target.value })}
                    placeholder="Specify advertiser account ID, date range, or specific records."
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>

                <div className="pt-1 flex justify-end">
                  <button
                    type="submit"
                    disabled={privacySubmitting}
                    className="w-full sm:w-auto px-6 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors"
                  >
                    {privacySubmitting ? 'Submitting...' : 'Submit Data Rights Request'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* 10. PRIVACY POLICY */}
          {slug === 'privacy-policy' && (
            <>
              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  01. Consent-First Ad Delivery
                </h2>
                <p>
                  Looma Advertising enforces GDPR, UK GDPR, NDPA, and US state privacy consent flags prior to evaluating
                  personalized or retargeted campaign rules. When consent is absent or withdrawn, the auction engine
                  evaluates strictly contextual and non-personalized campaigns only.
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  02. Data Minimization &amp; Zero Invasive Fingerprinting
                </h2>
                <p>
                  We do not collect invasive browser canvas fingerprints, hardware serial identifiers, or cross-site
                  third-party cookie tracking graphs. IP addresses processed for invalid-traffic rate limiting and
                  click-fraud prevention are salted and cryptographically hashed with short operational retention.
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  03. Federated Looma SSO Identity Boundary
                </h2>
                <p>
                  Looma Advertising verifies business membership through signed single sign-on assertions from Looma
                  rather than duplicating Looma social profiles or credentials. Financial ledger records are retained as
                  required by statutory tax and accounting regulations.
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  04. Exercising Your Data Rights
                </h2>
                <p>
                  Any individual or organization may request data export, deletion, rectification, or consent withdrawal
                  at any time through our compliance portal.
                </p>
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => onNavigatePage('gdpr-data-requests')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors"
                  >
                    <span>Open GDPR &amp; Data Rights Portal</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </section>
            </>
          )}

          {/* 11. ADVERTISER TERMS */}
          {slug === 'advertiser-terms' && (
            <>
              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  01. Prepaid Wallet Requirement
                </h2>
                <p>
                  All campaigns on Looma Advertising operate exclusively on prepaid funds deposited in advance through
                  Paystack, Flutterwave, Stripe, or bank transfer. Postpaid credit lines and invoiced net terms are not
                  offered in the initial launch release.
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  02. Atomic Budget Reservations &amp; Verified Billable Events
                </h2>
                <p>
                  When a campaign wins an eligible auction, Looma Advertising atomically reserves the maximum
                  single-event charge from the advertiser&apos;s available wallet balance. Funds convert into finalized
                  advertising charges only upon verified billable events (rendered impression, validated click, or
                  attributed conversion). Unused or expired reservations automatically release back to available balance.
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  03. Immutable Financial Ledger &amp; Auditability
                </h2>
                <p>
                  Every wallet credit, reservation, release, advertising charge, and refund creates an append-only
                  ledger entry with running balance verification and idempotency keys. Advertisers may inspect their
                  complete ledger and invoices anytime inside the Wallet &amp; Ledger tab.
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  04. Unused Balance Refunds
                </h2>
                <p>
                  Advertisers may request refunds of available, unreserved prepaid funds directly from the Advertiser
                  workspace. Approved refunds debit the wallet ledger atomically and settle back to the original
                  funding rail subject to standard compliance verification.
                </p>
              </section>
            </>
          )}

          {/* 12. AD QUALITY POLICY */}
          {slug === 'ad-quality-policy' && (
            <>
              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  01. Mandatory Pre-Delivery Moderation
                </h2>
                <p>
                  No campaign or creative enters live auction eligibility until it passes automated prohibited-content
                  scanning, landing-page URL safety checks, and operator moderation approval. All rendered ad units must
                  preserve clear sponsorship disclosure.
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  02. Prohibited Content Categories
                </h2>
                <ul className="space-y-2 list-disc pl-5 text-slate-600 dark:text-slate-300">
                  <li>Counterfeit goods, trademark infringement, or deceptive brand impersonation.</li>
                  <li>Malware distribution, credential phishing, cloaked redirects, or private-network URL targets.</li>
                  <li>Unlicensed gambling, controlled substances, weapons, or fraudulent financial return guarantees.</li>
                  <li>Misleading system alerts, fake close buttons, or non-consensual auto-downloading creatives.</li>
                </ul>
              </section>

              <section className="space-y-3">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                  03. Invalid Traffic &amp; Appeals Workflow
                </h2>
                <p>
                  Duplicate clicks, automated bot user agents, and tampered HMAC tokens are rejected before billing and
                  logged for fraud review. Advertisers whose campaigns are rejected or suspended may submit a documented
                  policy appeal directly from the Campaigns workspace for operator re-review.
                </p>
              </section>
            </>
          )}

          {/* Previous / Next Footer Page Pagination */}
          <div className="pt-8 mt-8 border-t border-slate-200 dark:border-slate-800 grid sm:grid-cols-2 gap-4">
            {prevPage ? (
              <a
                href={prevPage.path}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigatePage(prevPage.slug);
                }}
                className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-slate-400 dark:hover:border-slate-600 transition-colors"
              >
                <div className="text-xs text-slate-500 dark:text-slate-400">Previous · {prevPage.category}</div>
                <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
                  ← {prevPage.navLabel}
                </div>
              </a>
            ) : (
              <div />
            )}
            {nextPage && (
              <a
                href={nextPage.path}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigatePage(nextPage.slug);
                }}
                className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-slate-400 dark:hover:border-slate-600 transition-colors sm:text-right"
              >
                <div className="text-xs text-slate-500 dark:text-slate-400">Next · {nextPage.category}</div>
                <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
                  {nextPage.navLabel} →
                </div>
              </a>
            )}
          </div>
        </article>
      </div>
    </main>
  );
};
