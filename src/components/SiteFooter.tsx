import React from 'react';
import { ArrowUp, Moon, Sun } from 'lucide-react';
import { UserRole } from '../lib/api';
import { FooterPageSlug, getFooterPagesByCategory } from '../lib/footerRoutes';

interface SiteFooterProps {
  isDark: boolean;
  activePage: FooterPageSlug | null;
  onToggleTheme: () => void;
  onOpenAuth: (mode: 'login' | 'register', role?: 'advertiser' | 'publisher') => void;
  onQuickSandbox: (role: Extract<UserRole, 'advertiser' | 'publisher'>) => void;
  onNavigateHome: () => void;
  onNavigatePage: (slug: FooterPageSlug) => void;
}

export const SiteFooter: React.FC<SiteFooterProps> = ({
  isDark,
  activePage,
  onToggleTheme,
  onOpenAuth,
  onQuickSandbox,
  onNavigateHome,
  onNavigatePage,
}) => {
  const platformPages = getFooterPagesByCategory('Platform');
  const developerPages = getFooterPagesByCategory('Developers');
  const governancePages = getFooterPagesByCategory('Governance');

  function renderPageLink(slug: FooterPageSlug, path: string, label: string) {
    const isActive = activePage === slug;
    return (
      <li key={slug}>
        <a
          href={path}
          onClick={(e) => {
            e.preventDefault();
            onNavigatePage(slug);
          }}
          aria-current={isActive ? 'page' : undefined}
          className={`transition-colors ${
            isActive
              ? 'font-semibold text-blue-700 dark:text-blue-400'
              : 'hover:text-slate-950 dark:hover:text-white'
          }`}
        >
          {label}
        </a>
      </li>
    );
  }

  return (
    <footer className="border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-400">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-12 pb-8 sm:pt-16 sm:pb-10">
        {/* Primary Footer Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-8 pb-10 sm:pb-12 border-b border-slate-200 dark:border-slate-800">
          {/* Brand & Institutional Positioning */}
          <div className="lg:col-span-4 space-y-4">
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                onNavigateHome();
              }}
              className="inline-flex items-center gap-2.5 font-display text-base font-bold tracking-tight text-slate-900 dark:text-white"
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                className="shrink-0 text-blue-700 dark:text-blue-500"
              >
                <rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor" />
                <path d="M8 7V17H16.5" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                <rect x="13" y="7" width="3.5" height="3.5" rx="0.75" fill="white" fillOpacity="0.9" />
              </svg>
              <span>Looma Advertising</span>
            </a>

            <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400 max-w-sm">
              Independent advertising technology operating deterministic first-price auctions, atomic prepaid wallet
              settlement, and privacy-first delivery across Looma.
            </p>

            <div className="pt-1 space-y-1.5 text-xs text-slate-500 dark:text-slate-400">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>Prepaid Settlement</span>
                <span aria-hidden="true">·</span>
                <span>Paystack</span>
                <span aria-hidden="true">·</span>
                <span>Flutterwave</span>
                <span aria-hidden="true">·</span>
                <span>SWIFT / IBAN</span>
              </div>
              <div>Commercial &amp; Compliance Desk: response within 1 business day</div>
            </div>
          </div>

          {/* 4 Structured Navigation Columns */}
          <div className="lg:col-span-8 grid grid-cols-2 sm:grid-cols-4 gap-8 text-sm">
            {/* Column 1: Platform */}
            <div className="space-y-3">
              <h2 className="text-xs font-semibold text-slate-900 dark:text-white tracking-wide">Platform</h2>
              <ul className="space-y-2.5 text-xs sm:text-[13px]">
                {platformPages.map((p) => renderPageLink(p.slug, p.path, p.navLabel))}
              </ul>
            </div>

            {/* Column 2: Consoles */}
            <div className="space-y-3">
              <h2 className="text-xs font-semibold text-slate-900 dark:text-white tracking-wide">Consoles</h2>
              <ul className="space-y-2.5 text-xs sm:text-[13px]">
                <li>
                  <button
                    type="button"
                    onClick={() => onOpenAuth('login', 'advertiser')}
                    className="text-left hover:text-slate-950 dark:hover:text-white transition-colors"
                  >
                    Advertiser Sign In
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => onOpenAuth('register', 'advertiser')}
                    className="text-left hover:text-slate-950 dark:hover:text-white transition-colors"
                  >
                    Create Account
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => onQuickSandbox('advertiser')}
                    className="text-left hover:text-slate-950 dark:hover:text-white transition-colors"
                  >
                    Advertiser Console
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => onQuickSandbox('publisher')}
                    className="text-left hover:text-slate-950 dark:hover:text-white transition-colors"
                  >
                    Looma Publisher Console
                  </button>
                </li>
              </ul>
            </div>

            {/* Column 3: Developers */}
            <div className="space-y-3">
              <h2 className="text-xs font-semibold text-slate-900 dark:text-white tracking-wide">Developers</h2>
              <ul className="space-y-2.5 text-xs sm:text-[13px]">
                {developerPages.map((p) => renderPageLink(p.slug, p.path, p.navLabel))}
              </ul>
            </div>

            {/* Column 4: Governance */}
            <div className="space-y-3">
              <h2 className="text-xs font-semibold text-slate-900 dark:text-white tracking-wide">Governance</h2>
              <ul className="space-y-2.5 text-xs sm:text-[13px]">
                {governancePages.map((p) => renderPageLink(p.slug, p.path, p.navLabel))}
              </ul>
            </div>
          </div>
        </div>

        {/* Bottom Legal & Utility Row */}
        <div className="pt-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span>© {new Date().getFullYear()} Looma Advertising. All rights reserved.</span>
            <span aria-hidden="true">·</span>
            <span>Prepaid Minor-Unit Accounting</span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 transition-colors whitespace-nowrap"
            >
              {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              <span>{isDark ? 'Light Theme' : 'Dark Theme'}</span>
            </button>

            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 transition-colors whitespace-nowrap"
            >
              <ArrowUp className="w-3.5 h-3.5" />
              <span>Back to Top</span>
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
};

