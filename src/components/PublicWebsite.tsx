import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiRequest, extractFieldErrors, formatNumber, UserRole } from '../lib/api';
import { FieldErrors, validatePrivacyRequestInput } from '../lib/validation';
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
import {
  estimatePrepaidDelivery,
  mergePricingModelDetails,
  type PricingModelOption,
} from '../lib/pricingModels';

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

type FormatCardKey = 'display' | 'native' | 'video' | 'mobile' | 'text' | 'responsive' | 'sponsored';

const FORMAT_CARD_LIST: Array<{
  key: FormatCardKey;
  label: string;
  adFormat: AdFormat;
  badgeBg: string;
  sampleTitle: string;
  sampleDescription: string;
  sampleCta: string;
  sampleUrl: string;
  mediaUrl: string;
  placementNote: string;
}> = [
  {
    key: 'display',
    label: 'Display Ads',
    adFormat: 'banner',
    badgeBg: 'bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400',
    sampleTitle: 'Dedicated Bare-Metal Compute Across 14 Regions',
    sampleDescription: 'Provision NVMe clusters in under 90 seconds with predictable bandwidth pricing and private peering.',
    sampleCta: 'Compare Plans',
    sampleUrl: 'https://nordiccloud.de/bare-metal',
    mediaUrl: '/src/assets/images/creative_cloud_hardware_1795552815294.jpg',
    placementNote: 'Standard IAB 728x90 leaderboards and 300x250 medium rectangles.',
  },
  {
    key: 'native',
    label: 'Native Ads',
    adFormat: 'native',
    badgeBg: 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400',
    sampleTitle: 'Multi-Currency Treasury Accounts Built for Global Teams',
    sampleDescription: 'Settle supplier invoices in 24 currencies with real-time FX tracking and transparent ledger reconciliation.',
    sampleCta: 'Explore Treasury',
    sampleUrl: 'https://atlascommerce.io/treasury',
    mediaUrl: '/src/assets/images/creative_fintech_card_1795552815861.jpg',
    placementNote: 'Blends into host editorial typography with clear Sponsored disclosure.',
  },
  {
    key: 'video',
    label: 'Video Ads',
    adFormat: 'video',
    badgeBg: 'bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400',
    sampleTitle: 'Inside the Next-Generation Electric Fleet Platform',
    sampleDescription: 'Watch a 15-second walkthrough of live route telemetry, predictive diagnostics, and depot scheduling.',
    sampleCta: 'Watch Demo',
    sampleUrl: 'https://voltshift.example/demo',
    mediaUrl: '/src/assets/images/hero_looma_exchange_1795555655659.jpg',
    placementNote: 'In-stream and out-stream 16:9 / 9:16 video slots with CPV verification.',
  },
  {
    key: 'mobile',
    label: 'Mobile Ads',
    adFormat: 'image',
    badgeBg: 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400',
    sampleTitle: 'Precision Footwear Engineered for Long-Distance Comfort',
    sampleDescription: 'Breathable knit upper paired with carbon-stabilized cushioning. Direct shipping across global markets.',
    sampleCta: 'Shop Collection',
    sampleUrl: 'https://meridianrun.example/collection',
    mediaUrl: '/src/assets/images/creative_retail_sneaker_1795552816794.jpg',
    placementNote: 'Mobile-first 320x50 and in-app feed placements with fast thumb tap targets.',
  },
  {
    key: 'text',
    label: 'Text Ads',
    adFormat: 'text',
    badgeBg: 'bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400',
    sampleTitle: 'Automate Quarterly Tax Filings for Distributed Contractors',
    sampleDescription: 'Generate compliant W-8BEN and invoice packets across 45 jurisdictions with zero manual reconciliation.',
    sampleCta: 'Start Free Audit',
    sampleUrl: 'https://ledgerflow.example/tax',
    mediaUrl: '',
    placementNote: 'Lightweight search, sidebar, and low-bandwidth publisher placements.',
  },
  {
    key: 'responsive',
    label: 'Responsive Ads',
    adFormat: 'responsive',
    badgeBg: 'bg-teal-50 dark:bg-teal-950/50 text-teal-600 dark:text-teal-400',
    sampleTitle: 'Unified Inventory & Demand Forecasting for Modern Retail',
    sampleDescription: 'Connect storefront and warehouse data to reduce stockouts and automate replenishment cleanly.',
    sampleCta: 'Book Walkthrough',
    sampleUrl: 'https://atlascommerce.io/retail',
    mediaUrl: '/src/assets/images/hero_adtech_network_1795552814854.jpg',
    placementNote: 'Adapts dynamically across desktop, tablet, and mobile viewports.',
  },
  {
    key: 'sponsored',
    label: 'Sponsored Content',
    adFormat: 'sponsored',
    badgeBg: 'bg-brand-50 dark:bg-brand-950/50 text-brand-600 dark:text-brand-400',
    sampleTitle: 'How Independent Media Houses Protect Direct Ad Yield',
    sampleDescription: 'A practical breakdown of first-price auctions, ads.txt verification, and eliminating hidden fees.',
    sampleCta: 'Read Editorial',
    sampleUrl: 'https://looma-ads.com/editorial-guide',
    mediaUrl: '/src/assets/images/publisher_editorial_desk_1795555659074.jpg',
    placementNote: 'Long-form partner spotlight modules with explicit brand attribution.',
  },
];

const TESTIMONIALS = [
  {
    name: 'Kwame Mensah',
    role: 'Business Owner, Ghana',
    quote: '"Looma Advertising has helped us grow our business significantly."',
    image: '/src/assets/images/testimonial_kwame_mensah_1795723084120.jpg',
    initials: 'KM',
  },
  {
    name: 'Amina Yusuf',
    role: 'Publisher, Nigeria',
    quote: '"Easy to use, transparent reporting, and excellent support."',
    image: '/src/assets/images/testimonial_amina_yusuf_1795723085210.jpg',
    initials: 'AY',
  },
  {
    name: 'David Okafor',
    role: 'Digital Creator, Nigeria',
    quote: '"The best advertising platform we\'ve used so far."',
    image: '/src/assets/images/testimonial_david_okafor_1795723086045.jpg',
    initials: 'DO',
  },
] as const;

export const PublicWebsite: React.FC<PublicWebsiteProps> = ({
  isDark,
  onToggleTheme,
  onOpenAuth,
  onQuickSandbox,
}) => {
  const [overview, setOverview] = useState<PublicOverview | null>(null);
  const [selectedFormatKey, setSelectedFormatKey] = useState<FormatCardKey | null>(null);
  const [selectedPricingCode, setSelectedPricingCode] = useState<PricingModelOption['code']>('CPC');
  const [estimatorBudgetUsd, setEstimatorBudgetUsd] = useState<number>(250);
  const [brokenAvatars, setBrokenAvatars] = useState<Record<string, boolean>>({});
  const [activePage, setActivePage] = useState<FooterPageSlug | null>(() =>
    typeof window !== 'undefined' ? getFooterPageFromPath(window.location.pathname) : null
  );

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

  function scrollToSection(sectionId: string, attempt = 0) {
    const el = document.getElementById(sectionId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (attempt < 10) {
      window.requestAnimationFrame(() => {
        window.setTimeout(() => scrollToSection(sectionId, attempt + 1), 30);
      });
    }
  }

  useEffect(() => {
    const onPopState = () => {
      const nextPage = getFooterPageFromPath(window.location.pathname);
      setActivePage(nextPage);
      const hash = window.location.hash.replace(/^#/, '');
      if (!nextPage && hash) {
        scrollToSection(hash);
      } else {
        window.scrollTo({ top: 0 });
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!activePage && window.location.hash) {
      const hash = window.location.hash.replace(/^#/, '');
      if (hash) {
        scrollToSection(hash);
      }
    }
  }, []);

  useEffect(() => {
    if (activePage) {
      const meta = getFooterPageMeta(activePage);
      document.title = `${meta.navLabel} — Looma Advertising`;
    } else {
      document.title = 'Looma Advertising — Reach More. Earn More.';
    }
  }, [activePage]);

  useEffect(() => {
    if (!privacyOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPrivacyOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [privacyOpen]);

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
    const expectedHash = sectionId ? `#${sectionId}` : '';
    if (window.location.pathname !== '/' || window.location.hash !== expectedHash) {
      window.history.pushState({ footerPage: null }, '', targetUrl);
    }
    setActivePage(null);
    if (sectionId) {
      window.requestAnimationFrame(() => scrollToSection(sectionId));
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
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

  function renderFormatIcon(key: FormatCardKey) {
    switch (key) {
      case 'display':
        return (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          </svg>
        );
      case 'native':
        return (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
          </svg>
        );
      case 'video':
        return (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
            <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
          </svg>
        );
      case 'mobile':
        return (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          </svg>
        );
      case 'text':
        return (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h16M10 6v12m4-12v12" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
          </svg>
        );
      case 'responsive':
        return (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          </svg>
        );
      case 'sponsored':
        return (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        );
    }
  }

  const activeFormatCard = selectedFormatKey
    ? FORMAT_CARD_LIST.find((f) => f.key === selectedFormatKey) ?? null
    : null;

  return (
    <div className="min-h-screen overflow-x-clip bg-[#fafbff] dark:bg-slate-950 text-slate-800 dark:text-slate-100 selection:bg-brand-500 selection:text-white">
      <SiteHeader
        isDark={isDark}
        activePage={activePage}
        onToggleTheme={onToggleTheme}
        onOpenAuth={onOpenAuth}
        onOpenPrivacy={() => navigateToPage('gdpr-data-requests')}
        onNavigateHome={navigateHome}
        onNavigatePage={navigateToPage}
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
        <main>
          {/* HERO SECTION */}
          <section className="relative pt-12 pb-20 overflow-hidden scroll-mt-24" id="home">
            <div className="max-w-7xl mx-auto px-4 sm:px-6">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
                {/* Hero Left Column */}
                <div className="lg:col-span-6 z-10">
                  <p className="text-xs font-bold text-brand-700 dark:text-brand-400 tracking-wide uppercase mb-5">
                    Independent Advertising Network
                    {overview?.stats.active_placements
                      ? ` · ${formatNumber(overview.stats.active_placements)} Active Placements`
                      : ''}
                  </p>

                  <h1
                    className="text-4xl sm:text-5xl lg:text-[54px] font-extrabold text-slate-900 dark:text-white tracking-tight leading-[1.12] mb-6"
                    style={{ textWrap: 'balance' }}
                  >
                    Looma Advertising
                    <br />
                    Reach More.{' '}
                    <span className="whitespace-nowrap text-transparent bg-clip-text bg-gradient-to-r from-brand-600 to-indigo-600 dark:from-brand-400 dark:to-indigo-400">
                      Earn More.
                    </span>
                  </h1>

                  <p className="text-base sm:text-lg text-slate-600 dark:text-slate-300 font-medium leading-relaxed max-w-xl mb-9">
                    A powerful, independent advertising platform that connects businesses with audiences and helps
                    publishers monetize their content worldwide.
                  </p>

                  {/* Buttons */}
                  <div className="flex flex-wrap items-center gap-4 mb-12">
                    <button
                      type="button"
                      onClick={() => onOpenAuth('register', 'advertiser')}
                      className="px-7 py-3.5 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-full shadow-lg shadow-brand-600/30 flex items-center gap-2 transition transform active:scale-95 text-base whitespace-nowrap shrink-0"
                    >
                      <span>Start Advertising</span>
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M14 5l7 7m0 0l-7 7m7-7H3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2.5"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenAuth('register', 'publisher')}
                      className="px-7 py-3.5 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 font-bold rounded-full border border-slate-300 dark:border-slate-700 hover:border-slate-400 transition text-base shadow-sm whitespace-nowrap shrink-0"
                    >
                      Monetize Your Website
                    </button>
                  </div>

                  {/* Trust Badges List */}
                  <div className="pt-6 border-t border-slate-200/70 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 flex items-center justify-center text-brand-600 dark:text-brand-400 shrink-0">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                          />
                        </svg>
                      </div>
                      <div className="leading-tight">
                        <div className="font-bold text-slate-900 dark:text-white text-xs sm:text-sm">Global Reach</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">Worldwide</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-fuchsia-50 dark:bg-fuchsia-950/60 flex items-center justify-center text-fuchsia-600 dark:text-fuchsia-400 shrink-0">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                          />
                        </svg>
                      </div>
                      <div className="leading-tight">
                        <div className="font-bold text-slate-900 dark:text-white text-xs sm:text-sm">Millions</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                          of Impressions
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                          />
                        </svg>
                      </div>
                      <div className="leading-tight">
                        <div className="font-bold text-slate-900 dark:text-white text-xs sm:text-sm">
                          Trusted &amp; Secure
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                          Your Data, Our Priority
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Hero Right Column: 3D Laptop Mockup */}
                <div className="lg:col-span-6 relative perspective-laptop">
                  <div className="absolute -top-12 -right-12 w-96 h-96 bg-brand-400/20 rounded-full blur-3xl -z-10 pointer-events-none" />
                  <div className="relative laptop-tilt transition-transform duration-700">
                    {/* Screen bezel */}
                    <div className="bg-slate-900 p-3 rounded-2xl border-[4px] border-slate-800 shadow-2xl relative">
                      <div className="w-2 h-2 rounded-full bg-slate-700 mx-auto mb-2" />
                      {/* Screen Inner Dashboard Mockup */}
                      <div className="bg-white dark:bg-slate-950 rounded-lg p-5 overflow-hidden text-slate-800 dark:text-slate-100 shadow-inner border border-slate-100 dark:border-slate-800">
                        {/* Dashboard Nav */}
                        <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 mb-4">
                          <div className="flex items-center gap-2">
                            <div className="w-5 h-5 rounded-md bg-brand-600 flex items-center justify-center text-white text-[10px] font-bold">
                              L
                            </div>
                            <span className="text-xs font-bold text-slate-700 dark:text-slate-200">Looma</span>
                            <span className="text-[10px] text-slate-400 ml-1">/ Dashboard</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-[10px] font-mono tabular-nums text-slate-400">
                            <span>{overview?.stats.active_campaigns ?? 3} Live</span>
                          </div>
                        </div>

                        {/* Dashboard KPI cards */}
                        <div className="grid grid-cols-3 gap-3 mb-4">
                          <div className="bg-slate-50 dark:bg-slate-900 p-2.5 rounded-lg border border-slate-100 dark:border-slate-800">
                            <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                              Total Spend
                            </div>
                            <div className="text-base font-extrabold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                              $12,480
                            </div>
                            <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400 inline-flex items-center tabular-nums">
                              +12.5%
                            </span>
                          </div>
                          <div className="bg-slate-50 dark:bg-slate-900 p-2.5 rounded-lg border border-slate-100 dark:border-slate-800">
                            <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                              Impressions
                            </div>
                            <div className="text-base font-extrabold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                              2.4M
                            </div>
                            <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400 inline-flex items-center tabular-nums">
                              +18.2%
                            </span>
                          </div>
                          <div className="bg-slate-50 dark:bg-slate-900 p-2.5 rounded-lg border border-slate-100 dark:border-slate-800">
                            <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">Clicks</div>
                            <div className="text-base font-extrabold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                              184K
                            </div>
                            <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400 inline-flex items-center tabular-nums">
                              +14.7%
                            </span>
                          </div>
                        </div>

                        {/* Dashboard Chart and Top Campaigns */}
                        <div className="grid grid-cols-5 gap-3 items-end">
                          <div className="col-span-3 bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                            <div className="text-[10px] font-bold text-slate-700 dark:text-slate-200 mb-2">
                              Performance Overview
                            </div>
                            <svg className="w-full h-16 stroke-brand-600" fill="none" viewBox="0 0 150 40" aria-hidden="true">
                              <path
                                d="M0 32 Q 25 15, 50 25 T 100 12 T 150 20"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                              />
                              <path
                                d="M0 35 Q 25 28, 50 32 T 100 24 T 150 28"
                                fill="none"
                                stroke="#cbd5e1"
                                strokeWidth="1.8"
                              />
                            </svg>
                            <div className="flex justify-between text-[8px] text-slate-400 mt-1">
                              <span>Mon</span>
                              <span>Wed</span>
                              <span>Fri</span>
                              <span>Sun</span>
                            </div>
                          </div>
                          <div className="col-span-2 bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                            <div className="text-[10px] font-bold text-slate-700 dark:text-slate-200 mb-2">
                              Top Campaigns
                            </div>
                            <div className="space-y-1.5">
                              <div className="h-2 w-full bg-brand-500 rounded-full" />
                              <div className="h-2 w-4/5 bg-indigo-400 rounded-full" />
                              <div className="h-2 w-3/5 bg-emerald-400 rounded-full" />
                              <div className="h-2 w-1/2 bg-amber-400 rounded-full" />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Laptop Base illusion bar */}
                    <div className="h-2.5 bg-slate-700 rounded-b-xl max-w-[94%] mx-auto shadow-xl" />

                    {/* Floating Badge: Grow Your Business with Looma */}
                    <div className="hidden sm:flex absolute -bottom-5 -right-3 bg-white dark:bg-slate-900 py-3 px-4 rounded-xl shadow-xl border border-slate-100 dark:border-slate-800 items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-brand-100 dark:bg-brand-900/50 text-brand-600 dark:text-brand-400 flex items-center justify-center font-bold">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                          />
                        </svg>
                      </div>
                      <div>
                        <p className="text-xs font-extrabold text-slate-900 dark:text-white leading-tight">
                          Grow Your Business
                        </p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">with Looma</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* VALUE PROPOSITION CARDS */}
          <section
            className="py-16 bg-white dark:bg-slate-900/40 border-y border-slate-100 dark:border-slate-800 scroll-mt-24"
            id="advertisers"
          >
            <div className="max-w-7xl mx-auto px-4 sm:px-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Card 1: For Advertisers */}
                <div className="rounded-3xl p-8 sm:p-10 bg-gradient-to-br from-indigo-50/50 via-white to-purple-50/40 dark:from-brand-900/20 dark:via-slate-900 dark:to-indigo-950/30 border border-brand-100/70 dark:border-slate-800 shadow-sm relative overflow-hidden flex flex-col justify-between">
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
                    <div className="md:col-span-7">
                      <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-brand-100 dark:bg-brand-900/50 flex items-center justify-center text-brand-600 dark:text-brand-400">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="2"
                            />
                          </svg>
                        </div>
                        <span className="text-xs font-bold text-brand-700 dark:text-brand-400 tracking-wider uppercase">
                          For Advertisers
                        </span>
                      </div>
                      <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-3">Maximize Your Reach</h3>
                      <p className="text-sm text-slate-600 dark:text-slate-300 mb-6 leading-relaxed">
                        Create targeted campaigns, reach the right audience, and achieve better results with advanced
                        analytics.
                      </p>

                      <ul className="space-y-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200 mb-8">
                        <li className="flex items-center gap-2.5">
                          <span className="w-5 h-5 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-600 dark:text-brand-400 flex items-center justify-center text-xs">
                            ✓
                          </span>
                          <span>Powerful targeting options</span>
                        </li>
                        <li className="flex items-center gap-2.5">
                          <span className="w-5 h-5 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-600 dark:text-brand-400 flex items-center justify-center text-xs">
                            ✓
                          </span>
                          <span>Multiple ad formats</span>
                        </li>
                        <li className="flex items-center gap-2.5">
                          <span className="w-5 h-5 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-600 dark:text-brand-400 flex items-center justify-center text-xs">
                            ✓
                          </span>
                          <span>Real-time performance insights</span>
                        </li>
                      </ul>

                      <button
                        type="button"
                        onClick={() => onOpenAuth('register', 'advertiser')}
                        className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-bold text-sm shadow-md shadow-brand-500/20 transition whitespace-nowrap"
                      >
                        <span>Advertise Now</span>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M14 5l7 7m0 0l-7 7m7-7H3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                          />
                        </svg>
                      </button>
                    </div>

                    {/* Stylized Target Graphic */}
                    <div className="md:col-span-5 flex justify-center items-center">
                      <div className="relative w-44 h-44 flex items-center justify-center">
                        <div className="w-44 h-44 rounded-full border-[10px] border-brand-200/70 dark:border-brand-800/60 flex items-center justify-center bg-white dark:bg-slate-900 shadow-xl">
                          <div className="w-32 h-32 rounded-full border-[10px] border-brand-400 flex items-center justify-center bg-brand-50 dark:bg-brand-950/60">
                            <div className="w-20 h-20 rounded-full border-[10px] border-brand-600 flex items-center justify-center bg-brand-700 text-white">
                              <svg
                                className="w-8 h-8 text-white -rotate-45"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                                aria-hidden="true"
                              >
                                <path
                                  d="M5 19L19 5M19 5v8M19 5h-8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth="3"
                                />
                              </svg>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Card 2: For Publishers */}
                <div
                  className="rounded-3xl p-8 sm:p-10 bg-gradient-to-br from-emerald-50/50 via-white to-teal-50/40 dark:from-emerald-950/20 dark:via-slate-900 dark:to-teal-950/20 border border-emerald-100/70 dark:border-slate-800 shadow-sm relative overflow-hidden flex flex-col justify-between scroll-mt-24"
                  id="publishers"
                >
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
                    <div className="md:col-span-7">
                      <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-950/60 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="2"
                            />
                          </svg>
                        </div>
                        <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 tracking-wider uppercase">
                          For Publishers
                        </span>
                      </div>
                      <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-3">Monetize Your Content</h3>
                      <p className="text-sm text-slate-600 dark:text-slate-300 mb-6 leading-relaxed">
                        Turn your website or application into a reliable revenue stream with Looma.
                      </p>

                      <ul className="space-y-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200 mb-8">
                        <li className="flex items-center gap-2.5">
                          <span className="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center text-xs">
                            ✓
                          </span>
                          <span>Competitive earnings</span>
                        </li>
                        <li className="flex items-center gap-2.5">
                          <span className="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center text-xs">
                            ✓
                          </span>
                          <span>Easy integration</span>
                        </li>
                        <li className="flex items-center gap-2.5">
                          <span className="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center text-xs">
                            ✓
                          </span>
                          <span>Transparent reporting</span>
                        </li>
                      </ul>

                      <button
                        type="button"
                        onClick={() => onOpenAuth('register', 'publisher')}
                        className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm shadow-md shadow-emerald-500/20 transition whitespace-nowrap"
                      >
                        <span>Join as Publisher</span>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M14 5l7 7m0 0l-7 7m7-7H3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                          />
                        </svg>
                      </button>
                    </div>

                    {/* Stylized Coins & Website Card graphic */}
                    <div className="md:col-span-5 flex justify-center items-center">
                      <div className="relative w-44 h-44 flex items-center justify-center">
                        <div className="w-36 h-28 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg p-2.5 relative z-0">
                          <div className="flex gap-1 mb-2">
                            <span className="w-2 h-2 rounded-full bg-rose-400" />
                            <span className="w-2 h-2 rounded-full bg-amber-400" />
                            <span className="w-2 h-2 rounded-full bg-emerald-400" />
                          </div>
                          <div className="w-full h-8 bg-indigo-50/70 dark:bg-indigo-950/50 rounded-md mb-2 flex items-center px-2">
                            <div className="w-4 h-4 bg-indigo-200 dark:bg-indigo-700 rounded" />
                          </div>
                          <div className="w-3/4 h-2 bg-slate-100 dark:bg-slate-800 rounded mb-1" />
                          <div className="w-1/2 h-2 bg-slate-100 dark:bg-slate-800 rounded" />
                        </div>

                        <div className="absolute -bottom-1 -right-2 z-10 flex flex-col items-center">
                          <div className="w-12 h-6 rounded-full bg-amber-400 border-2 border-amber-300 shadow-md flex items-center justify-center text-[10px] font-black text-amber-900">
                            $
                          </div>
                          <div className="w-14 h-6 rounded-full bg-amber-500 border-2 border-amber-400 shadow-md -mt-3.5 flex items-center justify-center text-[10px] font-black text-amber-950">
                            $
                          </div>
                          <div className="w-16 h-7 rounded-full bg-amber-600 border-2 border-amber-500 shadow-lg -mt-3.5 flex items-center justify-center text-xs font-black text-amber-100">
                            $
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* AD FORMATS SECTION */}
          <section className="py-20 bg-slate-50 dark:bg-slate-950 scroll-mt-24" id="formats">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 text-center">
              <h2 className="text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">
                Advertising Formats We Support
              </h2>
              <p className="text-slate-500 dark:text-slate-400 mt-2 text-base font-medium">
                From display to video, we support all major ad formats. Click any format to preview live creative framing.
              </p>

              {/* Grid of 7 supported ad formats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4 mt-12">
                {FORMAT_CARD_LIST.map((fmt) => {
                  const isSelected = selectedFormatKey === fmt.key;
                  return (
                    <button
                      key={fmt.key}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => setSelectedFormatKey(isSelected ? null : fmt.key)}
                      className={`bg-white dark:bg-slate-900 p-5 rounded-2xl border shadow-sm flex flex-col items-center transition group hover:-translate-y-1 text-center ${
                        isSelected
                          ? 'border-brand-600 ring-2 ring-brand-500/20'
                          : 'border-slate-200/80 dark:border-slate-800 hover:border-brand-500'
                      }`}
                    >
                      <div
                        className={`w-12 h-12 rounded-xl flex items-center justify-center mb-3 group-hover:scale-110 transition ${fmt.badgeBg}`}
                      >
                        {renderFormatIcon(fmt.key)}
                      </div>
                      <span className="text-xs font-bold text-slate-800 dark:text-slate-100 whitespace-nowrap">
                        {fmt.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Expandable Live Format Preview Panel when any format card is selected */}
              {activeFormatCard && (
                <div className="mt-8 text-left rounded-3xl border border-brand-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 sm:p-8 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 mb-6 border-b border-slate-100 dark:border-slate-800">
                    <div>
                      <p className="text-xs font-bold text-brand-600 dark:text-brand-400 uppercase tracking-wider">
                        Interactive Format Preview · {AD_FORMAT_SPECS[activeFormatCard.adFormat].defaultDimensions}
                      </p>
                      <h3 className="text-xl font-bold text-slate-900 dark:text-white mt-1">
                        {activeFormatCard.label}
                      </h3>
                      <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">
                        {activeFormatCard.placementNote}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onOpenAuth('register', 'advertiser')}
                        className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold transition whitespace-nowrap"
                      >
                        Launch {activeFormatCard.label} Campaign
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedFormatKey(null)}
                        aria-label="Close format preview"
                        className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        Close
                      </button>
                    </div>
                  </div>

                  <LiveAdPreview
                    format={activeFormatCard.adFormat}
                    dimensions={AD_FORMAT_SPECS[activeFormatCard.adFormat].defaultDimensions}
                    pricingModel={AD_FORMAT_SPECS[activeFormatCard.adFormat].recommendedPricingModels[0] ?? 'CPC'}
                    title={activeFormatCard.sampleTitle}
                    description={activeFormatCard.sampleDescription}
                    ctaText={activeFormatCard.sampleCta}
                    destinationUrl={activeFormatCard.sampleUrl}
                    mediaUrl={activeFormatCard.mediaUrl}
                  />
                </div>
              )}

              {/* Feature Highlight Bar Underneath */}
              <div className="mt-8 bg-brand-50/60 dark:bg-slate-900 border border-brand-100/80 dark:border-slate-800 rounded-2xl p-6">
                <div className="grid grid-cols-2 md:grid-cols-5 divide-y md:divide-y-0 md:divide-x divide-brand-200/60 dark:divide-slate-800 gap-4 md:gap-0">
                  <div className="flex flex-col items-center px-4">
                    <svg
                      className="w-6 h-6 text-brand-600 dark:text-brand-400 mb-2"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        d="M13 10V3L4 14h7v7l9-11h-7z"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                      />
                    </svg>
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
                      Lightning-Fast Ad Delivery
                    </span>
                  </div>
                  <div className="flex flex-col items-center px-4 pt-4 md:pt-0">
                    <svg
                      className="w-6 h-6 text-brand-600 dark:text-brand-400 mb-2"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                      />
                    </svg>
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
                      Advanced Fraud Protection
                    </span>
                  </div>
                  <div className="flex flex-col items-center px-4 pt-4 md:pt-0">
                    <svg
                      className="w-6 h-6 text-brand-600 dark:text-brand-400 mb-2"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                      />
                    </svg>
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
                      Detailed Analytics &amp; Reporting
                    </span>
                  </div>
                  <div className="flex flex-col items-center px-4 pt-4 md:pt-0">
                    <svg
                      className="w-6 h-6 text-brand-600 dark:text-brand-400 mb-2"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                      />
                    </svg>
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-100">Global Coverage</span>
                  </div>
                  <div className="flex flex-col items-center px-4 pt-4 md:pt-0 col-span-2 md:col-span-1">
                    <svg
                      className="w-6 h-6 text-brand-600 dark:text-brand-400 mb-2"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                      />
                    </svg>
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-100">Dedicated Support</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* PREPAID PAY-AS-YOU-GO PRICING SECTION */}
          <section className="py-24 bg-white dark:bg-slate-900/40 scroll-mt-24" id="pricing">
            {(() => {
              const pricingModels = mergePricingModelDetails(overview?.pricingModels);
              const activeModel =
                pricingModels.find((m) => m.code === selectedPricingCode) ?? pricingModels[0];
              const budgetPresets = activeModel.code === 'FIXED' ? [500, 1000, 2500] : [50, 250, 1000];
              const effectiveBudget = budgetPresets.includes(estimatorBudgetUsd)
                ? estimatorBudgetUsd
                : activeModel.code === 'FIXED'
                  ? 500
                  : 250;
              const estimate = estimatePrepaidDelivery(activeModel, effectiveBudget);

              return (
                <div className="max-w-7xl mx-auto px-4 sm:px-6">
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
                    {/* Left Summary & Prepaid Wallet Controls */}
                    <div className="lg:col-span-5 space-y-6">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-400 mb-3">
                          Prepaid Pay-As-You-Go · No Monthly Fee
                        </p>
                        <h2
                          className="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight leading-tight mb-4"
                          style={{ textWrap: 'balance' }}
                        >
                          Pay Only for Verified Ad Delivery
                        </h2>
                        <p className="text-slate-600 dark:text-slate-300 font-medium leading-relaxed">
                          No subscription charges or minimum monthly retainers. Fund your prepaid advertiser wallet via
                          Paystack, Flutterwave, Stripe, or bank transfer and bid across six transparent billing models.
                        </p>
                      </div>

                      {/* Prepaid Wallet Estimator Card */}
                      <div
                        className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/70 p-5 space-y-4"
                        data-testid="prepaid-pricing-estimator"
                      >
                        <div className="flex items-baseline justify-between gap-3 border-b border-slate-200/80 dark:border-slate-800 pb-3">
                          <div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">Platform Subscription</div>
                            <div className="text-2xl font-extrabold text-slate-900 dark:text-white tabular-nums">
                              $0{' '}
                              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                                / month · 100% goes to ad spend
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-semibold text-slate-700 dark:text-slate-300">
                              Sample Prepaid Deposit
                            </span>
                            <span className="font-mono text-slate-500 dark:text-slate-400">
                              {activeModel.code} · Min ${activeModel.minUsd.toFixed(2)}
                            </span>
                          </div>
                          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Sample prepaid deposit amount">
                            {budgetPresets.map((amount) => {
                              const isSelected = effectiveBudget === amount;
                              return (
                                <button
                                  key={amount}
                                  type="button"
                                  onClick={() => setEstimatorBudgetUsd(amount)}
                                  aria-pressed={isSelected}
                                  className={`py-2 px-3 rounded-lg text-xs font-bold tabular-nums transition-colors ${
                                    isSelected
                                      ? 'bg-brand-600 text-white shadow-sm'
                                      : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-brand-500'
                                  }`}
                                >
                                  ${amount.toLocaleString()}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 p-4 space-y-1.5">
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            At {activeModel.code} minimum rate (${activeModel.minUsd.toFixed(2)})
                          </div>
                          <div className="text-xl font-extrabold text-slate-900 dark:text-white tabular-nums">
                            Up to {formatNumber(estimate.estimatedUnits)} {estimate.unitLabel}
                          </div>
                          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                            {activeModel.summary} Daily and total campaign caps enforce zero overspend.
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-3 pt-1">
                          <button
                            type="button"
                            onClick={() => onOpenAuth('register', 'advertiser')}
                            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-bold text-xs sm:text-sm shadow-md shadow-brand-600/20 transition whitespace-nowrap"
                          >
                            <span>Fund Prepaid Wallet</span>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                              <path
                                d="M14 5l7 7m0 0l-7 7m7-7H3"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                              />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() => navigateToPage('pricing-models')}
                            className="px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-900 font-semibold text-xs sm:text-sm transition whitespace-nowrap"
                          >
                            Full Pricing Rules
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Right Grid: All 6 Live Configurable Pricing Models */}
                    <div className="lg:col-span-7 space-y-5">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {pricingModels.map((model) => {
                          const isSelected = model.code === activeModel.code;
                          return (
                            <button
                              key={model.code}
                              type="button"
                              onClick={() => {
                                setSelectedPricingCode(model.code);
                                const nextPresets =
                                  model.code === 'FIXED' ? [500, 1000, 2500] : [50, 250, 1000];
                                if (!nextPresets.includes(estimatorBudgetUsd)) {
                                  setEstimatorBudgetUsd(model.code === 'FIXED' ? 500 : 250);
                                }
                              }}
                              aria-pressed={isSelected}
                              className={`text-left rounded-2xl p-5 border transition-all flex flex-col justify-between gap-3 ${
                                isSelected
                                  ? 'bg-white dark:bg-slate-900 border-2 border-brand-600 shadow-lg shadow-brand-500/10'
                                  : 'bg-white dark:bg-slate-900 border-slate-200/90 dark:border-slate-800 hover:border-brand-400 dark:hover:border-brand-700 shadow-xs'
                              }`}
                            >
                              <div className="space-y-2">
                                <div className="flex items-baseline justify-between gap-2">
                                  <span className="font-mono text-sm font-bold text-brand-600 dark:text-brand-400">
                                    {model.code}
                                  </span>
                                  <span className="font-mono tabular-nums text-xs font-semibold text-slate-900 dark:text-white">
                                    From ${model.minUsd.toFixed(2)}
                                  </span>
                                </div>
                                <h3 className="text-base font-bold text-slate-900 dark:text-white leading-snug">
                                  {model.name}
                                </h3>
                                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                                  {model.summary}
                                </p>
                              </div>
                              <div className="pt-2.5 border-t border-slate-100 dark:border-slate-800 space-y-0.5 text-[11px] leading-snug">
                                <div className="font-semibold text-slate-700 dark:text-slate-300">
                                  Per {model.unit.toLowerCase()}
                                </div>
                                <div className="text-slate-500 dark:text-slate-400">{model.bestFor}</div>
                              </div>
                            </button>
                          );
                        })}
                      </div>

                      {/* Enterprise Fixed Sponsorship / Custom Volume Bar */}
                      <div className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/70 px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="space-y-1">
                          <div className="text-sm font-bold text-slate-900 dark:text-white">
                            Need Fixed Sponsorships or High-Volume Managed Budgets?
                          </div>
                          <p className="text-xs text-slate-600 dark:text-slate-400">
                            Reserve guaranteed Looma feed share of voice or request enterprise onboarding and invoicing.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => navigateToPage('contact')}
                          className="px-4 py-2.5 rounded-xl border border-brand-600 text-brand-600 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-950/40 font-bold text-xs transition whitespace-nowrap shrink-0"
                        >
                          Contact Sales
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}
          </section>

          {/* TESTIMONIALS SECTION */}
          <section className="py-20 bg-slate-50 dark:bg-slate-950 border-t border-slate-100 dark:border-slate-800 scroll-mt-24" id="about">
            <div className="max-w-7xl mx-auto px-4 sm:px-6">
              <h2 className="text-3xl font-extrabold text-slate-900 dark:text-white text-center tracking-tight mb-12">
                Trusted by Businesses &amp; Creators Worldwide
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {TESTIMONIALS.map((item) => {
                  const hasFailed = Boolean(brokenAvatars[item.name]);
                  return (
                    <div
                      key={item.name}
                      className="bg-white dark:bg-slate-900 p-7 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-sm flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-center gap-4 mb-4">
                          {!hasFailed ? (
                            <img
                              src={item.image}
                              alt={item.name}
                              referrerPolicy="no-referrer"
                              onError={() => setBrokenAvatars((prev) => ({ ...prev, [item.name]: true }))}
                              className="w-12 h-12 rounded-full object-cover ring-2 ring-brand-100 dark:ring-brand-900 shrink-0"
                            />
                          ) : (
                            <div className="w-12 h-12 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 font-bold text-sm flex items-center justify-center ring-2 ring-brand-100 dark:ring-brand-900 shrink-0">
                              {item.initials}
                            </div>
                          )}
                          <div>
                            <h5 className="text-sm font-bold text-slate-900 dark:text-white">{item.name}</h5>
                            <p className="text-xs text-slate-500 dark:text-slate-400">{item.role}</p>
                          </div>
                        </div>
                        <p className="text-sm text-slate-600 dark:text-slate-300 italic leading-relaxed">{item.quote}</p>
                      </div>

                      <div className="flex items-center gap-1 text-amber-400 mt-5" aria-label="5 out of 5 stars">
                        <span aria-hidden="true">★</span>
                        <span aria-hidden="true">★</span>
                        <span aria-hidden="true">★</span>
                        <span aria-hidden="true">★</span>
                        <span aria-hidden="true">★</span>
                      </div>
                    </div>
                  );
                })}
              </div>
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
        onNavigateHome={navigateHome}
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
                    className="w-full sm:w-auto px-6 py-2.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-60 rounded-lg transition-colors"
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
