import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, ChevronDown, Copy, ShieldCheck, X } from 'lucide-react';
import { apiRequest, extractFieldErrors, formatNumber, UserRole } from '../lib/api';
import { FieldErrors, validateContactInput, validatePrivacyRequestInput } from '../lib/validation';
import { FieldError, fieldBorderClass } from './FieldError';
import { SiteHeader } from './SiteHeader';
import { SiteFooter } from './SiteFooter';
import { FooterPageView } from './FooterPageView';
import { LiveAdPreview } from './LiveAdPreview';
import { AD_FORMAT_SPECS, type AdFormat } from '../lib/adFormats';
import {
  FooterPageSlug,
  getFooterPageFromPath,
  getFooterPageMeta,
  getPathForFooterPage,
} from '../lib/footerRoutes';

interface PublicOverview {
  stats: {
    active_campaigns: number;
    approved_properties: number;
    total_impressions: number;
    active_placements: number;
  };
  pricingModels: Array<{
    code: string;
    name: string;
    unit: string;
    minUsd: number;
  }>;
}

interface PublicWebsiteProps {
  isDark: boolean;
  onToggleTheme: () => void;
  onOpenAuth: (mode: 'login' | 'register', role?: 'advertiser' | 'publisher') => void;
  onQuickSandbox: (role: Extract<UserRole, 'advertiser' | 'publisher'>) => void;
}

const FORMAT_SAMPLES: Record<
  AdFormat,
  {
    title: string;
    description: string;
    ctaText: string;
    destinationUrl: string;
    mediaUrl: string;
    useCase: string;
    benchmarkNote: string;
  }
> = {
  native: {
    title: 'Multi-Currency Treasury Accounts Built for Global Teams',
    description:
      'Settle supplier invoices in 24 currencies with real-time FX tracking and transparent ledger reconciliation.',
    ctaText: 'Explore Treasury',
    destinationUrl: 'https://atlascommerce.io/treasury',
    mediaUrl: '/src/assets/images/creative_fintech_card_1795552815861.jpg',
    useCase: 'In-feed Looma streams and editorial recommendation placements',
    benchmarkNote: 'Matches host typography while preserving mandatory Sponsored disclosure.',
  },
  banner: {
    title: 'Dedicated Bare-Metal Compute Across 14 Regions',
    description:
      'Provision NVMe clusters in under 90 seconds with predictable bandwidth pricing and private peering.',
    ctaText: 'Compare Plans',
    destinationUrl: 'https://nordiccloud.de/bare-metal',
    mediaUrl: '/src/assets/images/creative_cloud_hardware_1795552815294.jpg',
    useCase: 'Standard IAB 728x90 leaderboards and 300x250 medium rectangles',
    benchmarkNote: 'Fixed aspect framing with viewability gating prior to impression billing.',
  },
  image: {
    title: 'Precision Footwear Engineered for Long-Distance Comfort',
    description:
      'Breathable knit upper paired with carbon-stabilized cushioning. Direct shipping across North America and Europe.',
    ctaText: 'Shop Collection',
    destinationUrl: 'https://meridianrun.example/collection',
    mediaUrl: '/src/assets/images/creative_retail_sneaker_1795552816794.jpg',
    useCase: 'High-impact square and 4:3 visual placements across web and mobile',
    benchmarkNote: 'Supports direct CDN image assets with automatic magic-byte verification.',
  },
  sponsored: {
    title: 'How Independent Media Houses Protect Direct Ad Yield',
    description:
      'A practical guide to first-price auctions, ads.txt verification, and eliminating hidden ad-tech intermediary fees.',
    ctaText: 'Read Editorial',
    destinationUrl: 'https://looma-ads.com/editorial-guide',
    mediaUrl: '/src/assets/images/publisher_editorial_desk_1795555659074.jpg',
    useCase: 'Long-form branded stories and partner spotlight modules',
    benchmarkNote: 'Displays explicit brand attribution alongside editorial context.',
  },
  text: {
    title: 'Automate Quarterly Tax Filings for Distributed Contractors',
    description:
      'Generate compliant 1099 and W-8BEN packets across 45 jurisdictions with zero spreadsheet reconciliation.',
    ctaText: 'Start Free Audit',
    destinationUrl: 'https://ledgerflow.example/tax',
    mediaUrl: '',
    useCase: 'Ultra-lightweight search, sidebar, and low-bandwidth publisher slots',
    benchmarkNote: 'Zero image payload overhead; sub-millisecond rendering footprint.',
  },
  video: {
    title: 'Inside the Next-Generation Electric Fleet Platform',
    description:
      'Watch a 15-second walkthrough of live route telemetry, predictive battery diagnostics, and depot scheduling.',
    ctaText: 'Watch Demo',
    destinationUrl: 'https://voltshift.example/demo',
    mediaUrl: '/src/assets/images/hero_looma_exchange_1795555655659.jpg',
    useCase: 'In-stream and out-stream 16:9 / 9:16 video slots with CPV tracking',
    benchmarkNote: 'Bills on verified completed views with quartile playback event signing.',
  },
  responsive: {
    title: 'Unified Inventory & Demand Forecasting for Modern Retail',
    description:
      'Connect ERP and storefront data to reduce stockouts and automate replenishment across every warehouse.',
    ctaText: 'Book Walkthrough',
    destinationUrl: 'https://atlascommerce.io/retail',
    mediaUrl: '/src/assets/images/hero_adtech_network_1795552814854.jpg',
    useCase: 'Fluid multi-device placements adapting seamlessly across desktop and mobile',
    benchmarkNote: 'Automatically scales framing to fit container width without layout shift.',
  },
};

const FAQ_ITEMS = [
  {
    q: 'How are advertiser funds protected from overspending?',
    a: 'Every eligible ad request places an atomic budget reservation against your prepaid wallet before returning a creative. Daily caps, lifetime budgets, and available wallet balances are checked inside database transactions using micro-USD minor units (1 USD = 1,000,000 micros), so delivery can never exceed funded balances.',
  },
  {
    q: 'Can publishers create accounts and start registering properties?',
    a: 'Yes. Publishers can register directly via Create Account by choosing the Publisher role, enter the Publisher Workspace immediately, register web or mobile properties, verify ownership via DNS TXT, ads.txt, or meta tags, and configure ad units while awaiting network approval.',
  },
  {
    q: 'Which prepaid payment methods are supported for advertisers?',
    a: 'Advertisers fund prepaid wallets through Paystack, Flutterwave, and bank transfer using idempotent webhook verification. Postpaid credit lines are disabled at launch so every campaign remains 100% funded upfront.',
  },
  {
    q: 'How does Looma prevent invalid click and impression fraud?',
    a: 'Every impression and click requires a server-signed HMAC-SHA256 tracking token tied to the original ad request. Incoming events pass duplicate suppression, hashed-IP velocity limits, and automated bot user-agent screening before any advertiser debit or publisher credit occurs.',
  },
  {
    q: 'Are estimated publisher earnings guaranteed?',
    a: 'No. Estimated earnings reflect real-time unadjusted delivery. Only finalized available balances after invalid-traffic validation are eligible for settlement once third-party payout thresholds are met.',
  },
];

const BUDGET_PRESETS = [500, 2500, 10000] as const;
const TRAFFIC_PRESETS = [100000, 500000, 2000000] as const;

export const PublicWebsite: React.FC<PublicWebsiteProps> = ({
  isDark,
  onToggleTheme,
  onOpenAuth,
  onQuickSandbox,
}) => {
  const [overview, setOverview] = useState<PublicOverview | null>(null);
  const [heroAudience, setHeroAudience] = useState<'advertiser' | 'publisher'>('advertiser');
  const [estimatorMode, setEstimatorMode] = useState<'advertiser' | 'publisher'>('advertiser');
  const [advBudget, setAdvBudget] = useState<number>(2500);
  const [advModel, setAdvModel] = useState<'CPM' | 'CPC' | 'CPA' | 'CPV'>('CPC');
  const [pubPageviews, setPubPageviews] = useState<number>(500000);
  const [pubEcpm, setPubEcpm] = useState<number>(3.8);
  const [selectedFormat, setSelectedFormat] = useState<AdFormat>('native');
  const [sdkTab, setSdkTab] = useState<'web' | 'rest' | 'looma'>('web');
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [openFaqIdx, setOpenFaqIdx] = useState<number | null>(0);
  const [activePage, setActivePage] = useState<FooterPageSlug | null>(() =>
    typeof window !== 'undefined' ? getFooterPageFromPath(window.location.pathname) : null
  );

  const [contactForm, setContactForm] = useState({
    name: '',
    email: '',
    company: '',
    interest: 'advertising',
    message: '',
  });
  const [contactStatus, setContactStatus] = useState<string | null>(null);
  const [contactError, setContactError] = useState<string | null>(null);
  const [contactFieldErrors, setContactFieldErrors] = useState<FieldErrors>({});
  const [contactSubmitting, setContactSubmitting] = useState(false);

  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [privacyForm, setPrivacyForm] = useState({
    email: '',
    requestType: 'data_export',
    jurisdiction: 'GDPR',
    details: '',
  });
  const [privacyStatus, setPrivacyStatus] = useState<string | null>(null);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const [privacyFieldErrors, setPrivacyFieldErrors] = useState<FieldErrors>({});
  const [privacySubmitting, setPrivacySubmitting] = useState(false);

  const clearContactError = (field: string) => {
    setContactFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const clearPrivacyError = (field: string) => {
    setPrivacyFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  useEffect(() => {
    apiRequest<PublicOverview>('/api/public/overview')
      .then(setOverview)
      .catch(() => {
        // Non-blocking overview fetch
      });
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setActivePage(getFooterPageFromPath(window.location.pathname));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (activePage) {
      const meta = getFooterPageMeta(activePage);
      document.title = `${meta.navLabel} — Looma Advertising`;
    } else {
      document.title = 'Looma Advertising — Independent Ad-Serving & Monetization Platform';
    }
  }, [activePage]);

  function navigateToPage(slug: FooterPageSlug) {
    const targetPath = getPathForFooterPage(slug);
    if (window.location.pathname !== targetPath) {
      window.history.pushState({ footerPage: slug }, '', targetPath);
    }
    setActivePage(slug);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function navigateHome(sectionId?: string) {
    const targetUrl = sectionId ? `/#${sectionId}` : '/';
    if (window.location.pathname !== '/' || (sectionId && window.location.hash !== `#${sectionId}`)) {
      window.history.pushState({ footerPage: null }, '', targetUrl);
    }
    setActivePage(null);
    if (sectionId) {
      window.requestAnimationFrame(() => {
        window.setTimeout(() => {
          const el = document.getElementById(sectionId);
          if (el) el.scrollIntoView({ behavior: 'smooth' });
        }, 40);
      });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  useEffect(() => {
    if (!privacyOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPrivacyOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [privacyOpen]);

  const estimatorMetrics = useMemo(() => {
    if (estimatorMode === 'advertiser') {
      if (advModel === 'CPM') {
        const cpm = 2.8;
        const impressions = Math.round((advBudget / cpm) * 1000);
        const clicks = Math.round(impressions * 0.014);
        return {
          primaryLabel: 'Projected Verified Impressions',
          primaryValue: formatNumber(impressions),
          secondaryLabel: 'Estimated Valid Clicks (1.4% CTR)',
          secondaryValue: formatNumber(clicks),
          rateLabel: 'Model Benchmark Rate',
          rateValue: `$${cpm.toFixed(2)} CPM`,
          guardLabel: 'Prepaid Overspend Cap',
          guardValue: `$${advBudget.toLocaleString('en-US')}.00`,
        };
      }
      if (advModel === 'CPC') {
        const cpc = 0.45;
        const clicks = Math.round(advBudget / cpc);
        const impressions = Math.round(clicks / 0.016);
        return {
          primaryLabel: 'Projected Valid Clicks',
          primaryValue: formatNumber(clicks),
          secondaryLabel: 'Estimated Verified Impressions',
          secondaryValue: formatNumber(impressions),
          rateLabel: 'Target Cost Per Click',
          rateValue: `$${cpc.toFixed(2)} CPC`,
          guardLabel: 'Prepaid Overspend Cap',
          guardValue: `$${advBudget.toLocaleString('en-US')}.00`,
        };
      }
      if (advModel === 'CPA') {
        const cpa = 12.5;
        const conversions = Math.round(advBudget / cpa);
        const clicks = Math.round(conversions * 18);
        return {
          primaryLabel: 'Attributed Conversions',
          primaryValue: formatNumber(conversions),
          secondaryLabel: 'Estimated Qualified Clicks',
          secondaryValue: formatNumber(clicks),
          rateLabel: 'Target Cost Per Acquisition',
          rateValue: `$${cpa.toFixed(2)} CPA`,
          guardLabel: 'Prepaid Overspend Cap',
          guardValue: `$${advBudget.toLocaleString('en-US')}.00`,
        };
      }
      const cpv = 0.08;
      const views = Math.round(advBudget / cpv);
      const clicks = Math.round(views * 0.022);
      return {
        primaryLabel: 'Completed Video Views',
        primaryValue: formatNumber(views),
        secondaryLabel: 'Estimated Viewer Clicks',
        secondaryValue: formatNumber(clicks),
        rateLabel: 'Target Cost Per View',
        rateValue: `$${cpv.toFixed(2)} CPV`,
        guardLabel: 'Prepaid Overspend Cap',
        guardValue: `$${advBudget.toLocaleString('en-US')}.00`,
      };
    }

    const fillRate = 0.88;
    const filledImpressions = Math.round(pubPageviews * 1.6 * fillRate);
    const grossRevenue = (filledImpressions / 1000) * pubEcpm;
    const netPublisher = grossRevenue * 0.7;
    return {
      primaryLabel: 'Estimated Monthly Net Share (70%)',
      primaryValue: `$${netPublisher.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      secondaryLabel: 'Filled Ad Impressions (88% Fill)',
      secondaryValue: formatNumber(filledImpressions),
      rateLabel: 'Gross Auction Value',
      rateValue: `$${grossRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      guardLabel: 'Configured Floor eCPM',
      guardValue: `$${pubEcpm.toFixed(2)}`,
    };
  }, [estimatorMode, advBudget, advModel, pubPageviews, pubEcpm]);

  const activeSnippet = useMemo(() => {
    if (sdkTab === 'web') {
      return `<div id="looma-slot-main"></div>
<script src="/sdk/looma-ads.js"></script>
<script>
  window.LoomaAds.renderPlacement({
    container: '#looma-slot-main',
    placementId: 'plc_meridian_native',
    country: 'US',
    category: 'business_finance',
    consentGranted: true
  });
</script>`;
    }
    if (sdkTab === 'rest') {
      return `POST /api/v1/ad/request
Content-Type: application/json

{
  "placementId": "plc_meridian_native",
  "country": "US",
  "language": "en",
  "deviceCategory": "desktop",
  "category": "business_finance",
  "consentGranted": true
}`;
    }
    return `POST /api/v1/looma/feed/ads
X-Looma-Adapter-Key: <adapter_secret>
Content-Type: application/json

{
  "slots": ["plc_looma_feed_native", "plc_looma_feed_banner"],
  "country": "US",
  "deviceCategory": "mobile",
  "category": "business_finance",
  "consentGranted": true
}`;
  }, [sdkTab]);

  async function handleCopySnippet() {
    try {
      await navigator.clipboard.writeText(activeSnippet);
      setCopiedSnippet(true);
      window.setTimeout(() => setCopiedSnippet(false), 1800);
    } catch {
      setCopiedSnippet(false);
    }
  }

  async function handleContactSubmit(e: React.FormEvent) {
    e.preventDefault();
    setContactError(null);
    setContactStatus(null);
    const check = validateContactInput(contactForm);
    if (!check.valid) {
      setContactFieldErrors(check.errors);
      return;
    }
    setContactFieldErrors({});
    setContactSubmitting(true);
    try {
      const res = await apiRequest<{ inquiryId: string }>('/api/public/contact', {
        method: 'POST',
        body: JSON.stringify(contactForm),
      });
      setContactStatus(`Inquiry ${res.inquiryId} received. Our commercial team will respond within 1 business day.`);
      setContactForm({ name: '', email: '', company: '', interest: 'advertising', message: '' });
    } catch (err) {
      const serverFields = extractFieldErrors(err);
      if (Object.keys(serverFields).length > 0) setContactFieldErrors(serverFields);
      setContactError(err instanceof Error ? err.message : 'Unable to submit inquiry');
    } finally {
      setContactSubmitting(false);
    }
  }

  async function handlePrivacySubmit(e: React.FormEvent) {
    e.preventDefault();
    setPrivacyStatus(null);
    setPrivacyError(null);
    const check = validatePrivacyRequestInput(privacyForm);
    if (!check.valid) {
      setPrivacyFieldErrors(check.errors);
      return;
    }
    setPrivacyFieldErrors({});
    setPrivacySubmitting(true);
    try {
      const res = await apiRequest<{ requestId: string }>('/api/public/privacy-request', {
        method: 'POST',
        body: JSON.stringify(privacyForm),
      });
      setPrivacyStatus(`Request ${res.requestId} logged under ${privacyForm.jurisdiction} compliance workflow.`);
      setPrivacyForm({ email: '', requestType: 'data_export', jurisdiction: 'GDPR', details: '' });
    } catch (err) {
      const serverFields = extractFieldErrors(err);
      if (Object.keys(serverFields).length > 0) setPrivacyFieldErrors(serverFields);
      setPrivacyError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setPrivacySubmitting(false);
    }
  }

  const currentFormatSpec = AD_FORMAT_SPECS[selectedFormat];
  const currentFormatSample = FORMAT_SAMPLES[selectedFormat];

  return (
    <div className="min-h-screen overflow-x-clip bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <SiteHeader
        isDark={isDark}
        activePage={activePage}
        onToggleTheme={onToggleTheme}
        onOpenAuth={onOpenAuth}
        onOpenPrivacy={() => navigateToPage('gdpr-data-requests')}
        onNavigateHome={navigateHome}
      />

      {activePage ? (
        <FooterPageView
          slug={activePage}
          onNavigateHome={navigateHome}
          onNavigatePage={navigateToPage}
          onOpenAuth={onOpenAuth}
          onQuickSandbox={onQuickSandbox}
        />
      ) : (
        <main id="top">
          {/* 1. HERO PROPOSITION WITH DYNAMIC ROLE PERSPECTIVE */}
          <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-10 pb-14 sm:pt-14 sm:pb-18 lg:pt-20 lg:pb-24">
            <div className="grid lg:grid-cols-12 gap-8 lg:gap-12 items-stretch">
              <div className="lg:col-span-6 min-w-0 flex flex-col justify-center">
                {/* Interactive Perspective Selector */}
                <div className="inline-flex self-start items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-lg mb-6">
                  <button
                    type="button"
                    onClick={() => setHeroAudience('advertiser')}
                    className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                      heroAudience === 'advertiser'
                        ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    For Advertisers
                  </button>
                  <button
                    type="button"
                    onClick={() => setHeroAudience('publisher')}
                    className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                      heroAudience === 'publisher'
                        ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    For Publishers
                  </button>
                </div>

                <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>Independent Ad Infrastructure</span>
                  <span aria-hidden="true">·</span>
                  <span>First-Price Auction</span>
                  <span aria-hidden="true">·</span>
                  <span>Prepaid Minor-Unit Ledger</span>
                </div>

                <h1
                  className="font-display font-bold tracking-tight text-slate-900 dark:text-white leading-[1.08] max-w-2xl"
                  style={{ fontSize: 'clamp(2.15rem, 4.4vw, 3.65rem)', textWrap: 'balance' }}
                >
                  {heroAudience === 'advertiser'
                    ? 'Direct campaign delivery with verifiable prepaid accounting.'
                    : 'Monetize verified sites and apps with transparent yield reporting.'}
                </h1>

                <p className="mt-5 text-sm sm:text-base leading-relaxed text-slate-600 dark:text-slate-300 max-w-xl">
                  {heroAudience === 'advertiser'
                    ? 'Looma Advertising runs its own auction engine, signed event verification, invalid-traffic guardrails, and immutable prepaid ledger so every impression and click settles directly without ad-tech middlemen.'
                    : 'Verify domain ownership with DNS TXT or ads.txt, deploy lightweight web or REST placements across native, banner, and video slots, and track finalized earnings separate from unadjusted estimates.'}
                </p>

                <div className="mt-7 sm:mt-8 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onOpenAuth('register', heroAudience)}
                    className="inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 w-full sm:w-auto"
                  >
                    <span>{heroAudience === 'advertiser' ? 'Start Advertising' : 'Create Publisher Account'}</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onOpenAuth('register', heroAudience === 'advertiser' ? 'publisher' : 'advertiser')
                    }
                    className="px-5 py-3 text-sm font-medium text-slate-800 dark:text-slate-100 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900 rounded-lg transition-colors whitespace-nowrap shrink-0 w-full sm:w-auto text-center"
                  >
                    {heroAudience === 'advertiser' ? 'Join as Publisher' : 'Register as Advertiser'}
                  </button>
                </div>

                <div className="mt-8 pt-6 border-t border-slate-200 dark:border-slate-800 grid grid-cols-3 gap-4 text-xs">
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-white">Prepaid Only</div>
                    <div className="text-slate-500 dark:text-slate-400 mt-0.5">Atomic budget holds</div>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-white">HMAC-SHA256</div>
                    <div className="text-slate-500 dark:text-slate-400 mt-0.5">Signed event tokens</div>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-white">7 Ad Formats</div>
                    <div className="text-slate-500 dark:text-slate-400 mt-0.5">Native, display &amp; video</div>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-6 min-w-0">
                <div className="relative h-full min-h-[300px] sm:min-h-[420px] rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-900">
                  <img
                    src={
                      heroAudience === 'advertiser'
                        ? '/src/assets/images/hero_looma_exchange_1795555655659.jpg'
                        : '/src/assets/images/publisher_editorial_desk_1795555659074.jpg'
                    }
                    alt={
                      heroAudience === 'advertiser'
                        ? 'Looma Advertising media trading and campaign operations desk'
                        : 'Independent digital publisher editorial and monetization desk'
                    }
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover transition-opacity duration-200"
                  />
                  <div className="absolute inset-x-0 bottom-0 p-5 sm:p-6 bg-gradient-to-t from-slate-950/92 via-slate-950/55 to-transparent text-white">
                    <div className="text-[11px] sm:text-xs font-mono text-slate-300">
                      {heroAudience === 'advertiser'
                        ? 'Direct Ad Exchange · Atomic Prepaid Settlement'
                        : 'Publisher Supply Infrastructure · Verified Yield'}
                    </div>
                    <div className="mt-1 text-xs sm:text-sm font-medium text-white max-w-md leading-relaxed">
                      {heroAudience === 'advertiser'
                        ? 'Every impression, click, and conversion reconciles against funded prepaid wallet balances in real time.'
                        : 'Control floor CPMs, verify ownership with DNS TXT or ads.txt, and inspect every billed delivery event.'}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 4-column quantitative proof strip directly beneath hero */}
            <div className="mt-10 sm:mt-12 grid grid-cols-2 lg:grid-cols-4 gap-px bg-slate-200 dark:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="p-4 sm:p-6 bg-slate-50 dark:bg-slate-900">
                <div className="text-xs text-slate-500 dark:text-slate-400">Active Approved Campaigns</div>
                <div className="mt-1.5 font-mono tabular-nums text-xl sm:text-2xl font-semibold text-slate-900 dark:text-white">
                  {formatNumber(overview?.stats.active_campaigns ?? 3)}
                </div>
              </div>
              <div className="p-4 sm:p-6 bg-slate-50 dark:bg-slate-900">
                <div className="text-xs text-slate-500 dark:text-slate-400">Verified Publisher Properties</div>
                <div className="mt-1.5 font-mono tabular-nums text-xl sm:text-2xl font-semibold text-slate-900 dark:text-white">
                  {formatNumber(overview?.stats.approved_properties ?? 2)}
                </div>
              </div>
              <div className="p-4 sm:p-6 bg-slate-50 dark:bg-slate-900">
                <div className="text-xs text-slate-500 dark:text-slate-400">Active Ad Placements</div>
                <div className="mt-1.5 font-mono tabular-nums text-xl sm:text-2xl font-semibold text-slate-900 dark:text-white">
                  {formatNumber(overview?.stats.active_placements ?? 3)}
                </div>
              </div>
              <div className="p-4 sm:p-6 bg-slate-50 dark:bg-slate-900">
                <div className="text-xs text-slate-500 dark:text-slate-400">Verified Impressions Logged</div>
                <div className="mt-1.5 font-mono tabular-nums text-xl sm:text-2xl font-semibold text-slate-900 dark:text-white">
                  {formatNumber(overview?.stats.total_impressions ?? 42)}
                </div>
              </div>
            </div>
          </section>

          {/* 2. INTERACTIVE REACH & YIELD SIMULATOR + PLATFORM ARCHITECTURE BENTO */}
          <section
            id="platform"
            className="border-t border-slate-200 dark:border-slate-800 py-14 sm:py-20 bg-slate-50/50 dark:bg-slate-900/30"
          >
            <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-14">
              {/* Interactive Campaign & Yield Estimator */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                <div className="p-5 sm:p-8 border-b border-slate-200 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="max-w-xl">
                    <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
                      Interactive Delivery &amp; Settlement Estimator
                    </div>
                    <h2 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white [text-wrap:balance]">
                      Model your campaign spend or monthly publisher yield
                    </h2>
                  </div>

                  <div className="inline-flex self-start md:self-auto items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg shrink-0">
                    <button
                      type="button"
                      onClick={() => setEstimatorMode('advertiser')}
                      className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                        estimatorMode === 'advertiser'
                          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      Advertiser Spend
                    </button>
                    <button
                      type="button"
                      onClick={() => setEstimatorMode('publisher')}
                      className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                        estimatorMode === 'publisher'
                          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      Publisher Yield
                    </button>
                  </div>
                </div>

                <div className="grid lg:grid-cols-12">
                  {/* Controls side */}
                  <div className="lg:col-span-6 p-5 sm:p-8 space-y-6 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800">
                    {estimatorMode === 'advertiser' ? (
                      <>
                        <div>
                          <div className="flex items-center justify-between text-xs mb-2">
                            <label htmlFor="est-budget" className="font-medium text-slate-700 dark:text-slate-300">
                              Prepaid Wallet Budget (USD)
                            </label>
                            <span className="font-mono tabular-nums text-sm font-semibold text-slate-900 dark:text-white">
                              ${advBudget.toLocaleString('en-US')}
                            </span>
                          </div>
                          <input
                            id="est-budget"
                            type="range"
                            min={100}
                            max={25000}
                            step={100}
                            value={advBudget}
                            onChange={(e) => setAdvBudget(Number(e.target.value))}
                            className="w-full accent-blue-700 cursor-pointer"
                          />
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            {BUDGET_PRESETS.map((preset) => (
                              <button
                                key={preset}
                                type="button"
                                onClick={() => setAdvBudget(preset)}
                                className={`px-3 py-1 text-xs font-mono tabular-nums rounded-md border transition-colors ${
                                  advBudget === preset
                                    ? 'border-blue-700 bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200 font-semibold'
                                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                                }`}
                              >
                                ${preset.toLocaleString('en-US')}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div>
                          <div className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
                            Billing &amp; Auction Model
                          </div>
                          <div className="grid grid-cols-4 gap-2">
                            {(['CPC', 'CPM', 'CPA', 'CPV'] as const).map((model) => (
                              <button
                                key={model}
                                type="button"
                                onClick={() => setAdvModel(model)}
                                className={`py-2 text-xs font-mono font-semibold rounded-lg border transition-colors ${
                                  advModel === model
                                    ? 'border-blue-700 bg-blue-700 text-white'
                                    : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                                }`}
                              >
                                {model}
                              </button>
                            ))}
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <div className="flex items-center justify-between text-xs mb-2">
                            <label htmlFor="est-pageviews" className="font-medium text-slate-700 dark:text-slate-300">
                              Monthly Eligible Pageviews
                            </label>
                            <span className="font-mono tabular-nums text-sm font-semibold text-slate-900 dark:text-white">
                              {formatNumber(pubPageviews)}
                            </span>
                          </div>
                          <input
                            id="est-pageviews"
                            type="range"
                            min={25000}
                            max={5000000}
                            step={25000}
                            value={pubPageviews}
                            onChange={(e) => setPubPageviews(Number(e.target.value))}
                            className="w-full accent-blue-700 cursor-pointer"
                          />
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            {TRAFFIC_PRESETS.map((preset) => (
                              <button
                                key={preset}
                                type="button"
                                onClick={() => setPubPageviews(preset)}
                                className={`px-3 py-1 text-xs font-mono tabular-nums rounded-md border transition-colors ${
                                  pubPageviews === preset
                                    ? 'border-blue-700 bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200 font-semibold'
                                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                                }`}
                              >
                                {formatNumber(preset)}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div>
                          <div className="flex items-center justify-between text-xs mb-2">
                            <label htmlFor="est-ecpm" className="font-medium text-slate-700 dark:text-slate-300">
                              Target Blended eCPM (USD)
                            </label>
                            <span className="font-mono tabular-nums text-sm font-semibold text-slate-900 dark:text-white">
                              ${pubEcpm.toFixed(2)}
                            </span>
                          </div>
                          <input
                            id="est-ecpm"
                            type="range"
                            min={0.8}
                            max={12}
                            step={0.2}
                            value={pubEcpm}
                            onChange={(e) => setPubEcpm(Number(e.target.value))}
                            className="w-full accent-blue-700 cursor-pointer"
                          />
                        </div>
                      </>
                    )}
                  </div>

                  {/* Live Output side */}
                  <div className="lg:col-span-6 p-5 sm:p-8 bg-slate-950 text-white flex flex-col justify-between gap-6">
                    <div className="grid sm:grid-cols-2 gap-6">
                      <div>
                        <div className="text-xs text-slate-400">{estimatorMetrics.primaryLabel}</div>
                        <div className="mt-1.5 font-mono tabular-nums text-2xl sm:text-3xl font-bold text-white">
                          {estimatorMetrics.primaryValue}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-400">{estimatorMetrics.secondaryLabel}</div>
                        <div className="mt-1.5 font-mono tabular-nums text-2xl sm:text-3xl font-bold text-blue-400">
                          {estimatorMetrics.secondaryValue}
                        </div>
                      </div>
                    </div>

                    <div className="pt-5 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
                        <div>
                          <span className="text-slate-400">{estimatorMetrics.rateLabel}: </span>
                          <span className="font-mono tabular-nums font-semibold text-white">
                            {estimatorMetrics.rateValue}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400">{estimatorMetrics.guardLabel}: </span>
                          <span className="font-mono tabular-nums font-semibold text-white">
                            {estimatorMetrics.guardValue}
                          </span>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => onOpenAuth('register', estimatorMode)}
                        className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-white hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0"
                      >
                        <span>
                          {estimatorMode === 'advertiser' ? 'Create Advertiser Account' : 'Create Publisher Account'}
                        </span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Asymmetric Platform Architecture Bento */}
              <div>
                <div className="max-w-2xl mb-8 sm:mb-10">
                  <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white [text-wrap:balance]">
                    Built as a closed-loop advertising infrastructure
                  </h2>
                  <p className="mt-3 text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
                    From campaign creation to impression delivery and publisher reconciliation, every step executes
                    inside Looma&apos;s own deterministic infrastructure.
                  </p>
                </div>

                <div className="grid lg:grid-cols-12 gap-5 sm:gap-6">
                  <div className="lg:col-span-7 min-w-0 p-5 sm:p-8 rounded-xl border border-slate-800 bg-slate-900 text-white flex flex-col justify-between gap-6 sm:gap-8">
                    <div>
                      <div className="text-xs font-mono text-slate-400 mb-3">01. Real-Time Auction &amp; Signing</div>
                      <h3 className="font-display text-xl sm:text-2xl font-semibold text-white">
                        Deterministic first-price auction ranking
                      </h3>
                      <p className="mt-3 text-sm leading-relaxed text-slate-300 max-w-xl">
                        Every incoming placement request evaluates campaign moderation status, daily and lifetime budget
                        headroom, pacing mode, frequency caps, and privacy consent before returning a signed creative
                        payload.
                      </p>
                    </div>
                    <div className="grid sm:grid-cols-3 gap-4 pt-5 sm:pt-6 border-t border-slate-800 text-xs">
                      <div>
                        <div className="font-mono text-slate-400">Token Integrity</div>
                        <div className="mt-1 font-semibold text-white">HMAC-SHA256 Signed</div>
                      </div>
                      <div>
                        <div className="font-mono text-slate-400">Budget Guard</div>
                        <div className="mt-1 font-semibold text-white">Atomic Spend Locks</div>
                      </div>
                      <div>
                        <div className="font-mono text-slate-400">Click Validation</div>
                        <div className="mt-1 font-semibold text-white">Deduplicated Pre-Bill</div>
                      </div>
                    </div>
                  </div>

                  <div className="lg:col-span-5 min-w-0 p-5 sm:p-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between">
                    <div>
                      <div className="text-xs font-mono text-slate-500 dark:text-slate-400 mb-3">
                        02. Prepaid Billing &amp; Ledger
                      </div>
                      <h3 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                        Immutable minor-unit settlement
                      </h3>
                      <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                        Advertisers fund prepaid wallets via Paystack, Flutterwave, or bank transfer. Verified billable
                        events debit advertiser balances and split net revenue shares into publisher wallets in
                        transactional micro-USD units.
                      </p>
                    </div>
                    <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-mono tabular-nums">1 USD = 1,000,000 micros</span>
                      <span className="font-mono font-semibold text-slate-900 dark:text-white">Idempotent Ledger</span>
                    </div>
                  </div>

                  <div className="lg:col-span-5 min-w-0 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden flex flex-col">
                    <div className="aspect-[16/10] bg-slate-100 dark:bg-slate-800">
                      <img
                        src="/src/assets/images/publisher_editorial_desk_1795555659074.jpg"
                        alt="Independent digital publisher editorial team workspace"
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="p-6 flex-1 flex flex-col justify-between">
                      <div>
                        <div className="text-xs font-mono text-slate-500 dark:text-slate-400 mb-2">
                          03. Publisher Operations
                        </div>
                        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                          Verified domains &amp; mobile placements
                        </h3>
                        <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                          Publishers register properties, verify ownership through DNS TXT or ads.txt records, configure
                          placement floor CPMs, and separate finalized revenue from real-time estimates.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="lg:col-span-7 min-w-0 p-5 sm:p-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between gap-6">
                    <div>
                      <div className="text-xs font-mono text-slate-500 dark:text-slate-400 mb-3">
                        04. Privacy-Safe Targeting &amp; Fraud Protection
                      </div>
                      <h3 className="font-display text-xl sm:text-2xl font-semibold text-slate-900 dark:text-white">
                        Contextual precision without invasive browser fingerprinting
                      </h3>
                      <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                        Target international campaigns by country, language, device class, operating system, browser,
                        and editorial category while enforcing GDPR and regional consent checks prior to personalized
                        delivery.
                      </p>
                    </div>

                    <div className="grid sm:grid-cols-2 gap-4 pt-5 border-t border-slate-200 dark:border-slate-800 text-sm">
                      <div className="flex items-start gap-2.5">
                        <Check className="w-4 h-4 text-blue-700 dark:text-blue-400 mt-0.5 shrink-0" />
                        <span className="text-slate-700 dark:text-slate-300">
                          Automated duplicate-click and bot user-agent filtering prior to billing
                        </span>
                      </div>
                      <div className="flex items-start gap-2.5">
                        <Check className="w-4 h-4 text-blue-700 dark:text-blue-400 mt-0.5 shrink-0" />
                        <span className="text-slate-700 dark:text-slate-300">
                          Hashed IP rate controls and attribution windows with explicit consent flags
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* 3. INTERACTIVE 7-FORMAT LIVE AD SHOWCASE */}
          <section id="formats" className="border-t border-slate-200 dark:border-slate-800 py-14 sm:py-20">
            <div className="max-w-7xl mx-auto px-4 sm:px-6">
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
                <div className="max-w-2xl">
                  <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                    Interactive ad format preview
                  </h2>
                  <p className="mt-2.5 text-sm sm:text-base text-slate-600 dark:text-slate-300">
                    Inspect how Looma renders each supported unit across feeds, banners, editorial modules, and video
                    placements before launching a campaign.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenAuth('register', 'advertiser')}
                  className="text-sm font-semibold text-blue-700 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0 self-start md:self-auto"
                >
                  Build in Creative Studio &rarr;
                </button>
              </div>

              {/* Interactive Format Switcher Tabs */}
              <div className="flex flex-wrap items-center gap-1.5 p-1.5 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl mb-6">
                {(Object.keys(AD_FORMAT_SPECS) as AdFormat[]).map((key) => {
                  const spec = AD_FORMAT_SPECS[key];
                  const active = selectedFormat === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedFormat(key)}
                      className={`px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {spec.label}
                    </button>
                  );
                })}
              </div>

              {/* Live Rendered Preview + Format Specification */}
              <div className="grid lg:grid-cols-12 gap-6 items-stretch">
                <div className="lg:col-span-7 min-w-0 flex flex-col justify-center">
                  <LiveAdPreview
                    format={selectedFormat}
                    dimensions={currentFormatSpec.defaultDimensions}
                    pricingModel={currentFormatSpec.recommendedPricingModels[0] ?? 'CPC'}
                    title={currentFormatSample.title}
                    description={currentFormatSample.description}
                    ctaText={currentFormatSample.ctaText}
                    destinationUrl={currentFormatSample.destinationUrl}
                    mediaUrl={currentFormatSample.mediaUrl}
                  />
                </div>

                <div className="lg:col-span-5 min-w-0 p-5 sm:p-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between gap-6">
                  <div className="space-y-4">
                    <div className="text-xs font-mono text-blue-700 dark:text-blue-400">
                      Format Specification · {currentFormatSpec.defaultDimensions}
                    </div>
                    <h3 className="font-display text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">
                      {currentFormatSpec.label}
                    </h3>
                    <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                      {currentFormatSpec.summary}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      {currentFormatSample.benchmarkNote}
                    </p>

                    <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3 text-xs">
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-slate-500 dark:text-slate-400">Primary Placement</span>
                        <span className="text-right font-medium text-slate-900 dark:text-white">
                          {currentFormatSample.useCase}
                        </span>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-slate-500 dark:text-slate-400">Dimension Options</span>
                        <span className="text-right font-mono text-slate-900 dark:text-white">
                          {currentFormatSpec.dimensionsOptions.map((o) => o.value).join(' · ')}
                        </span>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-slate-500 dark:text-slate-400">Supported Billing</span>
                        <span className="text-right font-mono font-semibold text-slate-900 dark:text-white">
                          {currentFormatSpec.recommendedPricingModels.join(' · ')}
                        </span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenAuth('register', 'advertiser')}
                    className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors"
                  >
                    Create a {currentFormatSpec.label} Campaign
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* 4. PRICING MODELS */}
          <section
            id="pricing"
            className="border-t border-slate-200 dark:border-slate-800 py-14 sm:py-20 bg-slate-50/50 dark:bg-slate-900/30"
          >
            <div className="max-w-7xl mx-auto px-4 sm:px-6">
              <div className="max-w-2xl mb-8 sm:mb-12">
                <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                  Transparent bidding and monetization models
                </h2>
                <p className="mt-3 text-sm sm:text-base text-slate-600 dark:text-slate-300">
                  Every campaign selects a single billing rule enforced identically across auction scoring, delivery
                  validation, and financial ledger entries.
                </p>
              </div>

              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {(
                  overview?.pricingModels ?? [
                    { code: 'CPM', name: 'Cost Per Mille', unit: '1,000 verified impressions', minUsd: 0.5 },
                    { code: 'CPC', name: 'Cost Per Click', unit: 'Verified user click', minUsd: 0.1 },
                    { code: 'CPA', name: 'Cost Per Acquisition', unit: 'Attributed conversion', minUsd: 2.0 },
                    { code: 'CPI', name: 'Cost Per Install', unit: 'Verified app install', minUsd: 1.5 },
                    { code: 'CPV', name: 'Cost Per View', unit: 'Completed video view', minUsd: 0.05 },
                    { code: 'FIXED', name: 'Fixed Sponsorship', unit: 'Guaranteed placement share', minUsd: 500.0 },
                  ]
                ).map((m) => (
                  <div
                    key={m.code}
                    className="p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-sm font-semibold text-blue-700 dark:text-blue-400">
                          {m.code}
                        </span>
                        <span className="font-mono tabular-nums text-xs text-slate-500 dark:text-slate-400">
                          Min ${m.minUsd.toFixed(2)}
                        </span>
                      </div>
                      <h3 className="mt-2.5 text-base font-semibold text-slate-900 dark:text-white">{m.name}</h3>
                      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Billed per {m.unit}.</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* 5. DEVELOPER & PUBLISHER INTEGRATION */}
          <section id="developers" className="border-t border-slate-200 dark:border-slate-800 py-14 sm:py-20">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 grid lg:grid-cols-12 gap-8 lg:gap-10 items-start">
              <div className="lg:col-span-6 min-w-0">
                <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                  Lightweight publisher SDK and REST delivery endpoints
                </h2>
                <p className="mt-3 text-sm sm:text-base text-slate-600 dark:text-slate-300">
                  Verify your domain via DNS TXT or ads.txt, generate placement IDs, and embed Looma&apos;s script or
                  call our REST delivery API directly from web, iOS, or Android clients.
                </p>

                <ul className="mt-6 space-y-3 text-sm text-slate-700 dark:text-slate-300">
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-blue-700 dark:text-blue-400 mt-0.5 shrink-0" />
                    <span>An ad request does not count as an impression until rendered viewability is confirmed.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-blue-700 dark:text-blue-400 mt-0.5 shrink-0" />
                    <span>GDPR &amp; US state privacy consent flags enforced prior to personalized ad eligibility.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-blue-700 dark:text-blue-400 mt-0.5 shrink-0" />
                    <span>Graceful fallback ensures host feeds continue unaffected if ad delivery is unavailable.</span>
                  </li>
                </ul>

                <div className="mt-7 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onOpenAuth('register', 'publisher')}
                    className="px-4 py-2.5 text-sm font-semibold text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap shrink-0 w-full sm:w-auto text-center"
                  >
                    Create Publisher Account
                  </button>
                  <button
                    type="button"
                    onClick={() => setPrivacyOpen(true)}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900 whitespace-nowrap shrink-0 w-full sm:w-auto"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    <span>Privacy &amp; Data Requests</span>
                  </button>
                </div>
              </div>

              <div className="lg:col-span-6 min-w-0 w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 text-slate-100 overflow-hidden">
                <div className="px-4 sm:px-5 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg shrink-0">
                    <button
                      type="button"
                      onClick={() => setSdkTab('web')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        sdkTab === 'web' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Web SDK
                    </button>
                    <button
                      type="button"
                      onClick={() => setSdkTab('rest')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        sdkTab === 'rest' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      REST API
                    </button>
                    <button
                      type="button"
                      onClick={() => setSdkTab('looma')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        sdkTab === 'looma' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Looma Adapter
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={handleCopySnippet}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-300 hover:text-white border border-slate-800 hover:border-slate-700 rounded-md transition-colors whitespace-nowrap"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>{copiedSnippet ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <pre className="p-4 sm:p-6 text-xs font-mono leading-relaxed text-slate-200 overflow-x-auto max-w-full">
                  {activeSnippet}
                </pre>
              </div>
            </div>
          </section>

          {/* 6. INTERACTIVE FAQ ACCORDION */}
          <section
            id="faq"
            className="border-t border-slate-200 dark:border-slate-800 py-14 sm:py-18 bg-slate-50/50 dark:bg-slate-900/30"
          >
            <div className="max-w-7xl mx-auto px-4 sm:px-6 grid lg:grid-cols-12 gap-8 lg:gap-12 items-start">
              <div className="lg:col-span-4">
                <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                  Frequently asked questions
                </h2>
                <p className="mt-3 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  Core answers on prepaid billing safeguards, publisher onboarding, and anti-fraud delivery checks.
                </p>
              </div>

              <div className="lg:col-span-8 divide-y divide-slate-200 dark:divide-slate-800 border-t border-b border-slate-200 dark:border-slate-800">
                {FAQ_ITEMS.map((item, idx) => {
                  const isOpen = openFaqIdx === idx;
                  return (
                    <div key={item.q}>
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() => setOpenFaqIdx(isOpen ? null : idx)}
                        className="w-full py-5 flex items-center justify-between gap-4 text-left"
                      >
                        <span className="text-sm sm:text-base font-semibold text-slate-900 dark:text-white">
                          {item.q}
                        </span>
                        <ChevronDown
                          className={`w-4 h-4 text-slate-500 shrink-0 transition-transform duration-150 ${
                            isOpen ? 'rotate-180' : ''
                          }`}
                        />
                      </button>
                      {isOpen && (
                        <p className="pb-5 text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-w-2xl">
                          {item.a}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {/* 7. LEAD CAPTURE CONTACT SECTION */}
          <section id="contact" className="border-t border-slate-200 dark:border-slate-800 py-14 sm:py-20">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 grid lg:grid-cols-12 gap-8 lg:gap-10 items-start">
              <div className="lg:col-span-4 min-w-0 space-y-4">
                <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                  Contact Looma Advertising
                </h2>
                <p className="text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
                  Speak with our advertiser partnerships, publisher onboarding, billing reconciliation, or privacy
                  compliance team.
                </p>
                <div className="pt-4 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 space-y-2">
                  <div>Response window: within 1 business day</div>
                  <div>Supported funding rails: Paystack, Flutterwave, SWIFT / IBAN</div>
                </div>
              </div>

              <form
                onSubmit={handleContactSubmit}
                noValidate
                className="lg:col-span-8 min-w-0 p-4 sm:p-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4"
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
                    <label
                      htmlFor="contact-name"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                    >
                      Full Name
                    </label>
                    <input
                      id="contact-name"
                      type="text"
                      required
                      value={contactForm.name}
                      onChange={(e) => {
                        setContactForm({ ...contactForm, name: e.target.value });
                        clearContactError('name');
                      }}
                      aria-invalid={Boolean(contactFieldErrors.name)}
                      aria-describedby={contactFieldErrors.name ? 'contact-name-err' : undefined}
                      placeholder="Amara Okafor"
                      className={`w-full px-3.5 py-2.5 text-sm rounded-lg border bg-white dark:bg-slate-950 ${fieldBorderClass(Boolean(contactFieldErrors.name))}`}
                    />
                    <FieldError id="contact-name-err" message={contactFieldErrors.name} />
                  </div>
                  <div>
                    <label
                      htmlFor="contact-email"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                    >
                      Business Email
                    </label>
                    <input
                      id="contact-email"
                      type="email"
                      required
                      value={contactForm.email}
                      onChange={(e) => {
                        setContactForm({ ...contactForm, email: e.target.value });
                        clearContactError('email');
                      }}
                      aria-invalid={Boolean(contactFieldErrors.email)}
                      aria-describedby={contactFieldErrors.email ? 'contact-email-err' : undefined}
                      placeholder="amara@company.com"
                      className={`w-full px-3.5 py-2.5 text-sm rounded-lg border bg-white dark:bg-slate-950 ${fieldBorderClass(Boolean(contactFieldErrors.email))}`}
                    />
                    <FieldError id="contact-email-err" message={contactFieldErrors.email} />
                  </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="contact-company"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                    >
                      Company / Publication
                    </label>
                    <input
                      id="contact-company"
                      type="text"
                      value={contactForm.company}
                      onChange={(e) => {
                        setContactForm({ ...contactForm, company: e.target.value });
                        clearContactError('company');
                      }}
                      aria-invalid={Boolean(contactFieldErrors.company)}
                      aria-describedby={contactFieldErrors.company ? 'contact-company-err' : undefined}
                      placeholder="Meridian Digital"
                      className={`w-full px-3.5 py-2.5 text-sm rounded-lg border bg-white dark:bg-slate-950 ${fieldBorderClass(Boolean(contactFieldErrors.company))}`}
                    />
                    <FieldError id="contact-company-err" message={contactFieldErrors.company} />
                  </div>
                  <div>
                    <label
                      htmlFor="contact-interest"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                    >
                      Inquiry Focus
                    </label>
                    <select
                      id="contact-interest"
                      value={contactForm.interest}
                      onChange={(e) => {
                        setContactForm({ ...contactForm, interest: e.target.value });
                        clearContactError('interest');
                      }}
                      className={`w-full px-3.5 py-2.5 text-sm rounded-lg border bg-white dark:bg-slate-950 ${fieldBorderClass(Boolean(contactFieldErrors.interest))}`}
                    >
                      <option value="advertising">Enterprise Advertising</option>
                      <option value="publisher">Publisher Monetization</option>
                      <option value="compliance">Privacy &amp; Compliance</option>
                      <option value="billing">Billing &amp; Settlements</option>
                    </select>
                    <FieldError message={contactFieldErrors.interest} />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="contact-message"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                  >
                    Message
                  </label>
                  <textarea
                    id="contact-message"
                    rows={4}
                    required
                    value={contactForm.message}
                    onChange={(e) => {
                      setContactForm({ ...contactForm, message: e.target.value });
                      clearContactError('message');
                    }}
                    aria-invalid={Boolean(contactFieldErrors.message)}
                    aria-describedby={contactFieldErrors.message ? 'contact-message-err' : undefined}
                    placeholder="Share your campaign goals, monthly traffic volume, or integration questions."
                    className={`w-full px-3.5 py-2.5 text-sm rounded-lg border bg-white dark:bg-slate-950 ${fieldBorderClass(Boolean(contactFieldErrors.message))}`}
                  />
                  <FieldError id="contact-message-err" message={contactFieldErrors.message} />
                </div>

                <div className="pt-1 flex justify-end">
                  <button
                    type="submit"
                    disabled={contactSubmitting}
                    className="w-full sm:w-auto px-6 py-2.5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap"
                  >
                    {contactSubmitting ? 'Sending...' : 'Send Inquiry'}
                  </button>
                </div>
              </form>
            </div>
          </section>
        </main>
      )}

      <SiteFooter
        isDark={isDark}
        activePage={activePage}
        onToggleTheme={onToggleTheme}
        onOpenAuth={onOpenAuth}
        onQuickSandbox={onQuickSandbox}
        onNavigateHome={() => navigateHome()}
        onNavigatePage={navigateToPage}
      />

      {/* Full-Screen Privacy & Compliance Request Form */}
      {privacyOpen && (
        <div
          className="fixed inset-0 z-50 w-full h-full overflow-y-auto overflow-x-clip bg-white dark:bg-slate-950 flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-labelledby="public-privacy-title"
        >
          <header className="h-16 px-4 sm:px-10 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 flex items-center justify-between gap-3 sticky top-0 z-10 shrink-0">
            <div className="min-w-0">
              <h2
                id="public-privacy-title"
                className="font-display text-base sm:text-lg font-semibold text-slate-900 dark:text-white truncate"
              >
                Privacy &amp; Data Rights Request
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                Submit a GDPR or US state privacy request for data export, deletion, or consent withdrawal.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPrivacyOpen(false)}
              aria-label="Close privacy request form"
              className="inline-flex items-center gap-1.5 sm:gap-2 px-3 sm:px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-900 rounded-lg shrink-0"
            >
              <X className="w-4 h-4" />
              <span>Close</span>
            </button>
          </header>

          <div className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-10 py-6 sm:py-10">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-8 space-y-5">
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
              <form onSubmit={handlePrivacySubmit} noValidate className="space-y-4">
                <div>
                  <label htmlFor="pub-prv-email" className="block text-xs font-medium mb-1.5">
                    Email
                  </label>
                  <input
                    id="pub-prv-email"
                    type="email"
                    required
                    value={privacyForm.email}
                    onChange={(e) => {
                      setPrivacyForm({ ...privacyForm, email: e.target.value });
                      clearPrivacyError('email');
                    }}
                    aria-invalid={Boolean(privacyFieldErrors.email)}
                    aria-describedby={privacyFieldErrors.email ? 'pub-prv-email-err' : undefined}
                    placeholder="name@company.com"
                    className={`w-full px-3.5 py-2.5 text-sm rounded-lg border bg-white dark:bg-slate-950 ${fieldBorderClass(Boolean(privacyFieldErrors.email))}`}
                  />
                  <FieldError id="pub-prv-email-err" message={privacyFieldErrors.email} />
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="pub-prv-type" className="block text-xs font-medium mb-1.5">
                      Request Type
                    </label>
                    <select
                      id="pub-prv-type"
                      value={privacyForm.requestType}
                      onChange={(e) => {
                        setPrivacyForm({ ...privacyForm, requestType: e.target.value });
                        clearPrivacyError('requestType');
                      }}
                      className={`w-full px-3.5 py-2.5 text-sm rounded-lg border bg-white dark:bg-slate-950 ${fieldBorderClass(Boolean(privacyFieldErrors.requestType))}`}
                    >
                      <option value="data_export">Data Export</option>
                      <option value="data_deletion">Data Deletion</option>
                      <option value="consent_withdrawal">Consent Withdrawal</option>
                    </select>
                    <FieldError message={privacyFieldErrors.requestType} />
                  </div>
                  <div>
                    <label htmlFor="pub-prv-jur" className="block text-xs font-medium mb-1.5">
                      Jurisdiction
                    </label>
                    <select
                      id="pub-prv-jur"
                      value={privacyForm.jurisdiction}
                      onChange={(e) => {
                        setPrivacyForm({ ...privacyForm, jurisdiction: e.target.value });
                        clearPrivacyError('jurisdiction');
                      }}
                      className={`w-full px-3.5 py-2.5 text-sm rounded-lg border bg-white dark:bg-slate-950 ${fieldBorderClass(Boolean(privacyFieldErrors.jurisdiction))}`}
                    >
                      <option value="GDPR">EU / UK GDPR</option>
                      <option value="CCPA">US State Privacy</option>
                      <option value="OTHER">International</option>
                    </select>
                    <FieldError message={privacyFieldErrors.jurisdiction} />
                  </div>
                </div>
                <div>
                  <label htmlFor="pub-prv-details" className="block text-xs font-medium mb-1.5">
                    Details (Optional)
                  </label>
                  <textarea
                    id="pub-prv-details"
                    rows={4}
                    value={privacyForm.details}
                    onChange={(e) => {
                      setPrivacyForm({ ...privacyForm, details: e.target.value });
                      clearPrivacyError('details');
                    }}
                    aria-invalid={Boolean(privacyFieldErrors.details)}
                    aria-describedby={privacyFieldErrors.details ? 'pub-prv-details-err' : undefined}
                    placeholder="Specify account, domain, or scope details"
                    className={`w-full px-3.5 py-2.5 text-sm rounded-lg border bg-white dark:bg-slate-950 ${fieldBorderClass(Boolean(privacyFieldErrors.details))}`}
                  />
                  <FieldError id="pub-prv-details-err" message={privacyFieldErrors.details} />
                </div>
                <div className="pt-2 flex justify-end">
                  <button
                    type="submit"
                    disabled={privacySubmitting}
                    className="w-full sm:w-auto px-6 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors"
                  >
                    {privacySubmitting ? 'Submitting...' : 'Submit Compliance Request'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
