import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Menu, Moon, ShieldCheck, Sun, X } from 'lucide-react';
import type { UserRole } from '../lib/api';

import type { FooterPageSlug } from '../lib/footerRoutes';

interface SiteHeaderProps {
  isDark: boolean;
  activePage: FooterPageSlug | null;
  onToggleTheme: () => void;
  onOpenAuth: (mode: 'login' | 'register', role?: 'advertiser' | 'publisher') => void;
  onQuickSandbox: (role: Extract<UserRole, 'advertiser' | 'publisher'>) => void;
  onOpenPrivacy: () => void;
  onNavigateHome: (sectionId?: string) => void;
}

const NAV_ITEMS = [
  { id: 'platform', href: '#platform', label: 'Platform' },
  { id: 'formats', href: '#formats', label: 'Formats' },
  { id: 'pricing', href: '#pricing', label: 'Pricing' },
  { id: 'developers', href: '#developers', label: 'Developers' },
  { id: 'contact', href: '#contact', label: 'Contact' },
] as const;

export const SiteHeader: React.FC<SiteHeaderProps> = ({
  isDark,
  activePage,
  onToggleTheme,
  onOpenAuth,
  onQuickSandbox,
  onOpenPrivacy,
  onNavigateHome,
}) => {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [activeSection, setActiveSection] = useState<string>('');

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 12);
      if (window.scrollY < 160) {
        setActiveSection('');
      }
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (activePage) {
      setActiveSection('');
      return;
    }
    const sectionIds = NAV_ITEMS.map((item) => item.id);
    const elements = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => Boolean(el));

    if (elements.length === 0 || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]?.target?.id) {
          setActiveSection(visible[0].target.id);
        }
      },
      { rootMargin: '-25% 0px -60% 0px', threshold: [0.1, 0.25, 0.5] }
    );

    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [activePage]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileNavOpen]);

  return (
    <header
      className={`sticky top-0 z-40 border-b transition-[background-color,border-color,box-shadow] duration-200 ${
        scrolled
          ? 'bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-slate-200/90 dark:border-slate-800 shadow-[0_1px_12px_rgba(15,23,42,0.06)] dark:shadow-[0_1px_12px_rgba(0,0,0,0.35)]'
          : 'bg-white dark:bg-slate-950 border-slate-200/70 dark:border-slate-800/80'
      }`}
    >
      {/* Top Bar Contract: Zone 1 Brand Wordmark — Zone 2 5 single-line links — Zone 3 1 primary CTA */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4 sm:gap-8">
        {/* Zone 1: Brand Mark + Display Wordmark (single element, no subtitle or badge) */}
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            setMobileNavOpen(false);
            setActiveSection('');
            onNavigateHome();
          }}
          className="inline-flex items-center gap-2.5 font-display text-base sm:text-[17px] font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700 rounded-sm"
        >
          <svg
            width="24"
            height="24"
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

        {/* Zone 2: 5 concise single-line text links */}
        <nav
          aria-label="Primary Navigation"
          className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600 dark:text-slate-300"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = !activePage && activeSection === item.id;
            return (
              <a
                key={item.id}
                href={activePage ? `/${item.href}` : item.href}
                onClick={(e) => {
                  if (activePage) {
                    e.preventDefault();
                    onNavigateHome(item.id);
                  } else {
                    setActiveSection(item.id);
                  }
                }}
                className={`relative py-1 transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700 rounded-xs ${
                  isActive
                    ? 'text-slate-950 dark:text-white'
                    : 'hover:text-slate-950 dark:hover:text-white'
                }`}
              >
                {item.label}
                <span
                  aria-hidden="true"
                  className={`absolute inset-x-0 -bottom-0.5 h-[2px] bg-blue-700 dark:bg-blue-400 transition-opacity duration-150 ${
                    isActive ? 'opacity-100' : 'opacity-0'
                  }`}
                />
              </a>
            );
          })}
        </nav>

        {/* Zone 3: Single Primary Action (+ responsive mobile menu toggle on small screens) */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              setMobileNavOpen(false);
              onOpenAuth('login', 'advertiser');
            }}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs sm:text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 active:bg-blue-900 rounded-lg transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
          >
            <span>Open Console</span>
            <ArrowUpRight className="w-3.5 h-3.5 hidden sm:block" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => setMobileNavOpen((prev) => !prev)}
            aria-label={mobileNavOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={mobileNavOpen}
            className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors shrink-0"
          >
            {mobileNavOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Mobile Navigation Drawer */}
      {mobileNavOpen && (
        <nav
          aria-label="Mobile Navigation"
          className="md:hidden border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 px-4 py-4 space-y-4"
        >
          <div className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <a
                key={item.id}
                href={activePage ? `/${item.href}` : item.href}
                onClick={(e) => {
                  setMobileNavOpen(false);
                  if (activePage) {
                    e.preventDefault();
                    onNavigateHome(item.id);
                  } else {
                    setActiveSection(item.id);
                  }
                }}
                className={`block px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                  !activePage && activeSection === item.id
                    ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                    : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900'
                }`}
              >
                {item.label}
              </a>
            ))}
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setMobileNavOpen(false);
                onQuickSandbox('advertiser');
              }}
              className="px-3 py-2.5 text-xs font-medium text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-800 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900 text-center"
            >
              Advertiser Console
            </button>
            <button
              type="button"
              onClick={() => {
                setMobileNavOpen(false);
                onQuickSandbox('publisher');
              }}
              className="px-3 py-2.5 text-xs font-medium text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-800 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900 text-center"
            >
              Publisher Console
            </button>
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setMobileNavOpen(false);
                onOpenPrivacy();
              }}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>GDPR &amp; Privacy</span>
            </button>
            <button
              type="button"
              onClick={onToggleTheme}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200"
            >
              {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              <span>{isDark ? 'Light' : 'Dark'}</span>
            </button>
          </div>
        </nav>
      )}
    </header>
  );
};
