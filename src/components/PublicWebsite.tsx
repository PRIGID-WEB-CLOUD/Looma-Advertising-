import React, { useEffect, useState } from 'react';
import { ArrowRight, Check, ShieldCheck, X } from 'lucide-react';
import { apiRequest, formatNumber, UserRole } from '../lib/api';
import { SiteHeader } from './SiteHeader';
import { SiteFooter } from './SiteFooter';
import { FooterPageView } from './FooterPageView';
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

export const PublicWebsite: React.FC<PublicWebsiteProps> = ({
  isDark,
  onToggleTheme,
  onOpenAuth,
  onQuickSandbox,
}) => {
  const [overview, setOverview] = useState<PublicOverview | null>(null);
  const [sdkTab, setSdkTab] = useState<'web' | 'rest'>('web');
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
  const [privacySubmitting, setPrivacySubmitting] = useState(false);

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
      setContactStatus(`Inquiry ${res.inquiryId} received. Our commercial team will respond within 1 business day.`);
      setContactForm({ name: '', email: '', company: '', interest: 'advertising', message: '' });
    } catch (err) {
      setContactError(err instanceof Error ? err.message : 'Unable to submit inquiry');
    } finally {
      setContactSubmitting(false);
    }
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
      setPrivacyStatus(`Request ${res.requestId} logged under ${privacyForm.jurisdiction} compliance workflow.`);
      setPrivacyForm({ email: '', requestType: 'data_export', jurisdiction: 'GDPR', details: '' });
    } catch (err) {
      setPrivacyError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setPrivacySubmitting(false);
    }
  }

  return (
    <div className="min-h-screen overflow-x-clip bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <SiteHeader
        isDark={isDark}
        activePage={activePage}
        onToggleTheme={onToggleTheme}
        onOpenAuth={onOpenAuth}
        onQuickSandbox={onQuickSandbox}
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
        {/* Hero Proposition */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-10 pb-12 sm:pt-14 sm:pb-16 lg:pt-20 lg:pb-24">
          <div className="grid lg:grid-cols-12 gap-8 lg:gap-12 items-stretch">
            <div className="lg:col-span-6 min-w-0 flex flex-col justify-center">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-3 sm:mb-4 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>Independent Ad Infrastructure</span>
                <span aria-hidden="true">·</span>
                <span>First-Price Auction Engine</span>
                <span aria-hidden="true">·</span>
                <span>Minor-Unit Ledger</span>
              </div>

              <h1
                className="font-display font-bold tracking-tight text-slate-900 dark:text-white leading-[1.1] max-w-2xl"
                style={{ fontSize: 'clamp(1.85rem, 6vw, 3.65rem)', textWrap: 'balance' }}
              >
                Direct campaign delivery and publisher monetization with verifiable accounting.
              </h1>

              <p className="mt-4 sm:mt-5 text-sm sm:text-base leading-relaxed text-slate-600 dark:text-slate-300 max-w-xl">
                Looma Advertising runs its own ad-serving auction, signed event verification, invalid-traffic guardrails,
                and prepaid financial ledger so global advertisers and independent publishers settle directly without
                intermediary fees.
              </p>

              <div className="mt-6 sm:mt-8 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3">
                <button
                  type="button"
                  onClick={() => onOpenAuth('register', 'advertiser')}
                  className="inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 w-full sm:w-auto"
                >
                  <span>Start Advertising</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onOpenAuth('register', 'publisher')}
                  className="px-5 py-3 text-sm font-medium text-slate-800 dark:text-slate-100 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900 rounded-lg transition-colors whitespace-nowrap shrink-0 w-full sm:w-auto text-center"
                >
                  Monetize Your Website
                </button>
              </div>

              <div className="mt-7 sm:mt-9 pt-5 sm:pt-6 border-t border-slate-200 dark:border-slate-800">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-3">
                  Authorized Workspace Sign-In
                </div>
                <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onQuickSandbox('advertiser')}
                    className="px-3.5 py-2.5 sm:py-2 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-800 hover:border-slate-400 dark:hover:border-slate-600 rounded-md transition-colors whitespace-nowrap shrink-0 w-full sm:w-auto text-center"
                  >
                    Launch Advertiser Console
                  </button>
                  <button
                    type="button"
                    onClick={() => onQuickSandbox('publisher')}
                    className="px-3.5 py-2.5 sm:py-2 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-800 hover:border-slate-400 dark:hover:border-slate-600 rounded-md transition-colors whitespace-nowrap shrink-0 w-full sm:w-auto text-center"
                  >
                    Launch Publisher Console
                  </button>
                </div>
              </div>
            </div>

            <div className="lg:col-span-6 min-w-0">
              <div className="relative h-full min-h-[260px] sm:min-h-[380px] rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-900">
                <img
                  src="/src/assets/images/hero_looma_exchange_1795555655659.jpg"
                  alt="Looma Advertising international media trading and operations studio"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6 bg-gradient-to-t from-slate-950/90 via-slate-950/45 to-transparent text-white">
                  <div className="text-[11px] sm:text-xs font-mono text-slate-300">
                    Direct Ad Exchange · Verified Event Settlement
                  </div>
                  <div className="mt-1 text-xs sm:text-sm font-medium text-white max-w-md">
                    Every impression, click, and conversion reconciles against prepaid wallet balances in real time.
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

        {/* Mechanism & Capabilities (Asymmetric Bento Architecture) */}
        <section id="platform" className="border-t border-slate-200 dark:border-slate-800 py-14 sm:py-20 bg-slate-50/50 dark:bg-slate-900/30">
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <div className="max-w-2xl mb-8 sm:mb-12">
              <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                Built as a closed-loop advertising infrastructure
              </h2>
              <p className="mt-3 text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
                From campaign creation to impression delivery and publisher payout reconciliation, every step executes
                inside Looma&apos;s own deterministic infrastructure.
              </p>
            </div>

            <div className="grid lg:grid-cols-12 gap-5 sm:gap-6">
              <div className="lg:col-span-7 min-w-0 p-5 sm:p-8 rounded-xl border border-slate-800 bg-slate-900 text-white flex flex-col justify-between gap-6 sm:gap-8">
                <div>
                  <div className="text-xs font-mono text-slate-400 mb-3">01. Real-Time Auction & Signing</div>
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
                  <div className="text-xs font-mono text-slate-500 dark:text-slate-400 mb-3">02. Prepaid Billing & Ledger</div>
                  <h3 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                    Immutable minor-unit settlement
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                    Advertisers fund prepaid wallets via Paystack, Flutterwave, Stripe, or bank transfer. Verified
                    billable events debit advertiser balances and split net revenue shares into publisher wallets in
                    transactional micro-USD units.
                  </p>
                </div>
                <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <span>Precision: 1 USD = 1,000,000 micros</span>
                  <span className="font-mono font-semibold text-slate-900 dark:text-white">Idempotent</span>
                </div>
              </div>

              <div className="lg:col-span-5 min-w-0 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden flex flex-col">
                <div className="aspect-[4/3] bg-slate-100 dark:bg-slate-800">
                  <img
                    src="/src/assets/images/publisher_editorial_desk_1795555659074.jpg"
                    alt="Independent digital publisher editorial team workspace"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="p-6 flex-1 flex flex-col justify-between">
                  <div>
                    <div className="text-xs font-mono text-slate-500 dark:text-slate-400 mb-2">03. Publisher Operations</div>
                    <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                      Verified domains & mobile placements
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                      Publishers verify ownership through DNS TXT or ads.txt records, configure placement floor CPMs,
                      and track finalized revenue separated from unadjusted estimates.
                    </p>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-7 min-w-0 p-5 sm:p-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between gap-6">
                <div>
                  <div className="text-xs font-mono text-slate-500 dark:text-slate-400 mb-3">
                    04. Privacy-Safe Targeting & Fraud Protection
                  </div>
                  <h3 className="font-display text-xl sm:text-2xl font-semibold text-slate-900 dark:text-white">
                    Contextual precision without invasive browser fingerprinting
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                    Target international campaigns by country, language, device class, operating system, browser, and
                    editorial category while enforcing GDPR and regional consent checks prior to personalized delivery.
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
        </section>

        {/* Ad Formats Showcase */}
        <section id="formats" className="border-t border-slate-200 dark:border-slate-800 py-14 sm:py-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-4 mb-8 sm:mb-12">
              <div className="max-w-2xl">
                <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                  Supported advertising formats
                </h2>
                <p className="mt-3 text-base text-slate-600 dark:text-slate-300">
                  Build image, banner, native, text, video, responsive, and sponsored content units with live preview
                  validation prior to moderation.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onQuickSandbox('advertiser')}
                className="text-sm font-medium text-blue-700 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
              >
                Open Creative Studio →
              </button>
            </div>

            <div className="grid md:grid-cols-3 gap-6">
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900">
                <div className="aspect-[4/3] bg-slate-100 dark:bg-slate-800">
                  <img
                    src="/src/assets/images/creative_fintech_card_1795552815861.jpg"
                    alt="Native and sponsored editorial placement preview"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="p-6">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Native · In-Feed · Sponsored Content</div>
                  <h3 className="mt-1.5 text-base font-semibold text-slate-900 dark:text-white">Editorial Native Cards</h3>
                  <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-300">
                    Matches publisher typography while preserving explicit sponsorship labeling and click tracking.
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900">
                <div className="aspect-[4/3] bg-slate-100 dark:bg-slate-800">
                  <img
                    src="/src/assets/images/creative_cloud_hardware_1795552815294.jpg"
                    alt="IAB display banner and responsive unit preview"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="p-6">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Display Banner · 728x90 · 300x250</div>
                  <h3 className="mt-1.5 text-base font-semibold text-slate-900 dark:text-white">Standard & Responsive Display</h3>
                  <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-300">
                    High-viewability web and desktop slots with configurable floor CPMs and adaptive framing.
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900">
                <div className="aspect-[4/3] bg-slate-100 dark:bg-slate-800">
                  <img
                    src="/src/assets/images/creative_retail_sneaker_1795552816794.jpg"
                    alt="Mobile interstitial and video format preview"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="p-6">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Video · Interstitial · App Install</div>
                  <h3 className="mt-1.5 text-base font-semibold text-slate-900 dark:text-white">Mobile App & Video Units</h3>
                  <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-300">
                    Built for iOS and Android SDK integrations with CPV viewability and CPI attribution windows.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Pricing Models */}
        <section id="pricing" className="border-t border-slate-200 dark:border-slate-800 py-14 sm:py-20 bg-slate-50/50 dark:bg-slate-900/30">
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <div className="max-w-2xl mb-8 sm:mb-12">
              <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                Transparent bidding and monetization models
              </h2>
              <p className="mt-3 text-base text-slate-600 dark:text-slate-300">
                Every campaign selects a single billing rule enforced identically across auction scoring, delivery
                validation, and financial ledger entries.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {(overview?.pricingModels ?? [
                { code: 'CPM', name: 'Cost Per Mille', unit: '1,000 verified impressions', minUsd: 0.5 },
                { code: 'CPC', name: 'Cost Per Click', unit: 'Verified user click', minUsd: 0.1 },
                { code: 'CPA', name: 'Cost Per Acquisition', unit: 'Attributed conversion', minUsd: 2.0 },
                { code: 'CPI', name: 'Cost Per Install', unit: 'Verified app install', minUsd: 1.5 },
                { code: 'CPV', name: 'Cost Per View', unit: 'Completed video view', minUsd: 0.05 },
                { code: 'FIXED', name: 'Fixed Sponsorship', unit: 'Guaranteed placement share', minUsd: 500.0 },
              ]).map((m) => (
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

        {/* Developer & Publisher Integration */}
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
                  <span>No invasive browser fingerprinting; IP addresses are hashed with short retention windows.</span>
                </li>
              </ul>

              <div className="mt-7 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3">
                <button
                  type="button"
                  onClick={() => onQuickSandbox('publisher')}
                  className="px-4 py-2.5 text-sm font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap shrink-0 w-full sm:w-auto text-center"
                >
                  Open Publisher Delivery Console
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
                <span className="text-xs font-mono text-slate-400">Publisher Delivery Integration</span>
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
                </div>
              </div>
              <pre className="p-4 sm:p-6 text-xs font-mono leading-relaxed text-slate-200 overflow-x-auto max-w-full">
                {sdkTab === 'web'
                  ? `<div id="looma-slot-main"></div>
<script src="/sdk/looma-ads.js"></script>
<script>
  window.LoomaAds.renderPlacement({
    container: '#looma-slot-main',
    placementId: 'plc_meridian_native',
    country: 'US',
    category: 'business_finance',
    consentGranted: true
  });
</script>`
                  : `POST /api/v1/ad/request
Content-Type: application/json

{
  "placementId": "plc_meridian_native",
  "country": "US",
  "language": "en",
  "deviceCategory": "desktop",
  "category": "business_finance",
  "consentGranted": true
}`}
              </pre>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="border-t border-slate-200 dark:border-slate-800 py-14 sm:py-16 bg-slate-50/50 dark:bg-slate-900/30">
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white mb-6 sm:mb-8">
              Frequently asked questions
            </h2>
            <div className="grid md:grid-cols-2 gap-4 sm:gap-6 text-sm">
              <div className="p-5 sm:p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                <h3 className="font-semibold text-slate-900 dark:text-white">How are advertiser funds protected from overspending?</h3>
                <p className="mt-2 text-slate-600 dark:text-slate-300 leading-relaxed">
                  Auction eligibility checks wallet balance and daily/lifetime budgets before returning an ad, and billing
                  transactions verify available balances atomically inside database locks using integer minor units.
                </p>
              </div>
              <div className="p-5 sm:p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                <h3 className="font-semibold text-slate-900 dark:text-white">Are estimated publisher earnings guaranteed?</h3>
                <p className="mt-2 text-slate-600 dark:text-slate-300 leading-relaxed">
                  No. Estimated earnings reflect real-time unadjusted delivery. Only finalized available balances after
                  invalid-traffic review are eligible for payout withdrawals above the configured threshold.
                </p>
              </div>
              <div className="p-5 sm:p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                <h3 className="font-semibold text-slate-900 dark:text-white">Which payment providers are supported?</h3>
                <p className="mt-2 text-slate-600 dark:text-slate-300 leading-relaxed">
                  Advertiser prepaid funding supports Paystack, Flutterwave, Stripe, and international bank transfers
                  through idempotent webhook adapters without storing raw payment card numbers.
                </p>
              </div>
              <div className="p-5 sm:p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                <h3 className="font-semibold text-slate-900 dark:text-white">How does Looma prevent invalid click fraud?</h3>
                <p className="mt-2 text-slate-600 dark:text-slate-300 leading-relaxed">
                  Every click requires a verified, signed impression token, passes duplicate and IP-velocity rate checks,
                  and excludes automated bot user agents before billing or publisher crediting occurs.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Full-Width Lead Capture Contact Section */}
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
                <div>Supported rails: Paystack, Flutterwave, Stripe, SWIFT / IBAN</div>
              </div>
            </div>

            <form
              onSubmit={handleContactSubmit}
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
                  <label htmlFor="contact-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Full Name
                  </label>
                  <input
                    id="contact-name"
                    type="text"
                    required
                    value={contactForm.name}
                    onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })}
                    placeholder="Amara Okafor"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="contact-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Business Email
                  </label>
                  <input
                    id="contact-email"
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
                  <label htmlFor="contact-company" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Company / Publication
                  </label>
                  <input
                    id="contact-company"
                    type="text"
                    value={contactForm.company}
                    onChange={(e) => setContactForm({ ...contactForm, company: e.target.value })}
                    placeholder="Meridian Digital"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="contact-interest" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Inquiry Focus
                  </label>
                  <select
                    id="contact-interest"
                    value={contactForm.interest}
                    onChange={(e) => setContactForm({ ...contactForm, interest: e.target.value })}
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="advertising">Enterprise Advertising</option>
                    <option value="publisher">Publisher Monetization</option>
                    <option value="compliance">Privacy &amp; Compliance</option>
                    <option value="billing">Billing &amp; Settlements</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="contact-message" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Message
                </label>
                <textarea
                  id="contact-message"
                  rows={4}
                  required
                  value={contactForm.message}
                  onChange={(e) => setContactForm({ ...contactForm, message: e.target.value })}
                  placeholder="Share your campaign goals, monthly traffic volume, or integration questions."
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>

              <div className="pt-1 flex justify-end">
                <button
                  type="submit"
                  disabled={contactSubmitting}
                  className="w-full sm:w-auto px-6 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap"
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
              <h2 id="public-privacy-title" className="font-display text-base sm:text-lg font-semibold text-slate-900 dark:text-white truncate">
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
              <form onSubmit={handlePrivacySubmit} className="space-y-4">
                <div>
                  <label htmlFor="pub-prv-email" className="block text-xs font-medium mb-1.5">
                    Email
                  </label>
                  <input
                    id="pub-prv-email"
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
                    <label htmlFor="pub-prv-type" className="block text-xs font-medium mb-1.5">
                      Request Type
                    </label>
                    <select
                      id="pub-prv-type"
                      value={privacyForm.requestType}
                      onChange={(e) => setPrivacyForm({ ...privacyForm, requestType: e.target.value })}
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="data_export">Data Export</option>
                      <option value="data_deletion">Data Deletion</option>
                      <option value="consent_withdrawal">Consent Withdrawal</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="pub-prv-jur" className="block text-xs font-medium mb-1.5">
                      Jurisdiction
                    </label>
                    <select
                      id="pub-prv-jur"
                      value={privacyForm.jurisdiction}
                      onChange={(e) => setPrivacyForm({ ...privacyForm, jurisdiction: e.target.value })}
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="GDPR">EU / UK GDPR</option>
                      <option value="CCPA">US State Privacy</option>
                      <option value="OTHER">International</option>
                    </select>
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
                    onChange={(e) => setPrivacyForm({ ...privacyForm, details: e.target.value })}
                    placeholder="Specify account, domain, or scope details"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
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
