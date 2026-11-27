import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Menu, Moon, Sun, X } from 'lucide-react';
import type { FooterPageSlug } from '../lib/footerRoutes';

interface SiteHeaderProps {
  isDark: boolean;
  activePage: FooterPageSlug | null;
  onToggleTheme: () => void;
  onOpenAuth: (mode: 'login' | 'register', role?: 'advertiser' | 'publisher') => void;
  onOpenPrivacy: () => void;
  onNavigateHome: (sectionId?: string) => void;
  onNavigatePage: (slug: FooterPageSlug) => void;
}

const RESOURCE_LINKS: Array<{ slug: FooterPageSlug; label: string; description: string }> = [
  { slug: 'pricing-models', label: 'Pricing Models', description: 'Prepaid CPM, CPC, CPA, CPI & CPV billing' },
  { slug: 'ad-formats', label: 'Ad Formats', description: 'Banner, native, video, responsive & sponsored specs' },
  { slug: 'web-sdk', label: 'Web SDK Guide', description: 'Drop-in placement script & consent rules' },
  { slug: 'rest-api', label: 'REST Delivery API', description: 'Direct ad selection & signed tracking endpoints' },
  { slug: 'integration-contract', label: 'Integration Contract', description: 'First-party Looma feed SLA & schema' },
  { slug: 'faq', label: 'FAQ', description: 'Prepaid billing, fraud checks & delivery' },
  { slug: 'gdpr-data-requests', label: 'GDPR & Data Requests', description: 'Submit privacy export or deletion requests' },
  { slug: 'contact', label: 'Contact Engineering', description: 'Partnerships, onboarding & technical desk' },
];

export const SiteHeader: React.FC<SiteHeaderProps> = ({
  isDark,
  activePage,
  onToggleTheme,
  onOpenAuth,
  onOpenPrivacy,
  onNavigateHome,
  onNavigatePage,
}) => {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<string>('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const manualNavLockUntilRef = useRef<number>(0);

  useEffect(() => {
    if (activePage) {
      setActiveSection('');
      return;
    }

    const syncFromScroll = () => {
      if (Date.now() < manualNavLockUntilRef.current) return;
      if (window.scrollY < 80) {
        setActiveSection('');
        return;
      }
      const candidates = [
        { id: 'about', el: document.getElementById('about') },
        { id: 'pricing', el: document.getElementById('pricing') },
        { id: 'formats', el: document.getElementById('formats') },
        { id: 'advertisers', el: document.getElementById('advertisers') },
        { id: 'home', el: document.getElementById('home') },
      ];
      for (const item of candidates) {
        if (!item.el) continue;
        const rect = item.el.getBoundingClientRect();
        if (rect.top <= 180 && rect.bottom > 120) {
          setActiveSection(item.id === 'pricing' || item.id === 'advertisers' ? item.id : '');
          return;
        }
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80) {
        setActiveSection('');
      }
    };

    const hash = window.location.hash.replace(/^#/, '');
    if (['advertisers', 'publishers', 'pricing'].includes(hash)) {
      setActiveSection(hash);
    } else {
      syncFromScroll();
    }

    window.addEventListener('scroll', syncFromScroll, { passive: true });
    return () => window.removeEventListener('scroll', syncFromScroll);
  }, [activePage]);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setResourcesOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setResourcesOpen(false);
        setMobileNavOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  function handleSectionLink(e: React.MouseEvent, sectionId: string) {
    e.preventDefault();
    setMobileNavOpen(false);
    setResourcesOpen(false);
    manualNavLockUntilRef.current = Date.now() + 900;
    setActiveSection(['advertisers', 'publishers', 'pricing'].includes(sectionId) ? sectionId : '');
    onNavigateHome(sectionId);
  }

  return (
    <header className="w-full bg-white/90 dark:bg-slate-950/90 backdrop-blur-md sticky top-0 z-40 border-b border-slate-100 dark:border-slate-800/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-20 flex items-center justify-between gap-4 lg:gap-6">
        {/* Brand Mark (Home) */}
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            setMobileNavOpen(false);
            setResourcesOpen(false);
            manualNavLockUntilRef.current = Date.now() + 900;
            setActiveSection('');
            onNavigateHome();
          }}
          className="inline-flex items-center gap-2.5 font-display text-base sm:text-[17px] font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-600 rounded-sm"
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

        {/* Desktop Navigation Links */}
        <nav
          aria-label="Primary Navigation"
          className="hidden md:flex items-center gap-4 lg:gap-7 xl:gap-8 text-sm lg:text-[15px] font-semibold text-slate-600 dark:text-slate-300"
        >
          <a
            href="#advertisers"
            onClick={(e) => handleSectionLink(e, 'advertisers')}
            className={`whitespace-nowrap shrink-0 transition-colors ${
              !activePage && activeSection === 'advertisers'
                ? 'text-brand-600 dark:text-brand-400'
                : 'hover:text-brand-600 dark:hover:text-brand-400'
            }`}
          >
            Advertise
          </a>
          <a
            href="#publishers"
            onClick={(e) => handleSectionLink(e, 'publishers')}
            className={`whitespace-nowrap shrink-0 transition-colors ${
              !activePage && activeSection === 'publishers'
                ? 'text-brand-600 dark:text-brand-400'
                : 'hover:text-brand-600 dark:hover:text-brand-400'
            }`}
          >
            Monetize
          </a>
          <a
            href="#pricing"
            onClick={(e) => handleSectionLink(e, 'pricing')}
            className={`whitespace-nowrap shrink-0 transition-colors ${
              !activePage && activeSection === 'pricing'
                ? 'text-brand-600 dark:text-brand-400'
                : 'hover:text-brand-600 dark:hover:text-brand-400'
            }`}
          >
            Pricing
          </a>

          {/* Interactive Resources Dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              type="button"
              onClick={() => setResourcesOpen((prev) => !prev)}
              aria-expanded={resourcesOpen}
              aria-haspopup="menu"
              className={`inline-flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors ${
                activePage || resourcesOpen
                  ? 'text-brand-600 dark:text-brand-400'
                  : 'hover:text-brand-600 dark:hover:text-brand-400'
              }`}
            >
              <span>Resources</span>
              <ChevronDown
                className={`w-4 h-4 text-slate-400 transition-transform duration-150 ${
                  resourcesOpen ? 'rotate-180 text-brand-600 dark:text-brand-400' : ''
                }`}
              />
            </button>

            {resourcesOpen && (
              <div
                role="menu"
                aria-label="Resources menu"
                className="absolute left-0 mt-3 w-80 max-h-[75vh] overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl shadow-slate-900/10 p-2 z-50"
              >
                {RESOURCE_LINKS.map((item) => (
                  <button
                    key={item.slug}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setResourcesOpen(false);
                      onNavigatePage(item.slug);
                    }}
                    className={`w-full text-left px-3.5 py-2 rounded-xl transition-colors block ${
                      activePage === item.slug
                        ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/80 text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    <div className="text-xs font-bold">{item.label}</div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{item.description}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>

        {/* Auth Actions */}
        <div className="flex items-center space-x-2 sm:space-x-3 shrink-0">
          <button
            type="button"
            onClick={() => {
              setMobileNavOpen(false);
              setResourcesOpen(false);
              onOpenAuth('login', 'advertiser');
            }}
            className="hidden sm:inline-flex px-3 lg:px-4 py-2 text-sm font-bold text-slate-700 dark:text-slate-200 hover:text-brand-600 dark:hover:text-brand-400 transition-colors whitespace-nowrap shrink-0"
          >
            Login
          </button>
          <button
            type="button"
            onClick={() => {
              setMobileNavOpen(false);
              setResourcesOpen(false);
              onOpenAuth('register', 'advertiser');
            }}
            className="px-4 lg:px-5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-sm font-semibold shadow-md shadow-brand-600/25 transition-all transform active:scale-95 whitespace-nowrap shrink-0"
          >
            Sign Up
          </button>

          <button
            type="button"
            onClick={() => setMobileNavOpen((prev) => !prev)}
            aria-label={mobileNavOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={mobileNavOpen}
            className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-xl border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors shrink-0"
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
            {[
              { id: 'advertisers', label: 'Advertise' },
              { id: 'publishers', label: 'Monetize' },
              { id: 'formats', label: 'Ad Formats' },
              { id: 'pricing', label: 'Pricing' },
            ].map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                onClick={(e) => handleSectionLink(e, item.id)}
                className="block px-3 py-2.5 text-sm font-semibold rounded-xl text-slate-700 dark:text-slate-200 hover:bg-brand-50 dark:hover:bg-slate-900 hover:text-brand-600"
              >
                {item.label}
              </a>
            ))}
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-1">
            <div className="px-3 pb-1 text-xs font-bold text-slate-400 uppercase tracking-wider">Resources</div>
            <div className="grid grid-cols-2 gap-1.5">
              {RESOURCE_LINKS.map((item) => (
                <button
                  key={item.slug}
                  type="button"
                  onClick={() => {
                    setMobileNavOpen(false);
                    onNavigatePage(item.slug);
                  }}
                  className="text-left px-3 py-2 text-xs font-semibold rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setMobileNavOpen(false);
                onOpenAuth('login', 'advertiser');
              }}
              className="px-3 py-2.5 text-xs font-bold text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-800 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-900 text-center"
            >
              Login
            </button>
            <button
              type="button"
              onClick={() => {
                setMobileNavOpen(false);
                onOpenAuth('register', 'publisher');
              }}
              className="px-3 py-2.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl text-center"
            >
              Join as Publisher
            </button>
          </div>

          <div className="pt-2 flex items-center justify-between text-xs text-slate-500">
            <button
              type="button"
              onClick={() => {
                setMobileNavOpen(false);
                onOpenPrivacy();
              }}
              className="font-semibold hover:text-slate-900 dark:hover:text-white"
            >
              Privacy &amp; Compliance
            </button>
            <button
              type="button"
              onClick={onToggleTheme}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200"
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
