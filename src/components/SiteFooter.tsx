import React, { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { apiRequest, UserRole } from '../lib/api';
import { validateEmail } from '../lib/validation';
import { FooterPageSlug } from '../lib/footerRoutes';

interface SiteFooterProps {
  isDark: boolean;
  activePage: FooterPageSlug | null;
  onToggleTheme: () => void;
  onOpenAuth: (mode: 'login' | 'register', role?: 'advertiser' | 'publisher') => void;
  onQuickSandbox: (role: Extract<UserRole, 'advertiser' | 'publisher'>) => void;
  onNavigateHome: (sectionId?: string) => void;
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
  const [subscribeEmail, setSubscribeEmail] = useState('');
  const [subscribeSubmitting, setSubscribeSubmitting] = useState(false);
  const [subscribeMessage, setSubscribeMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  async function handleSubscribe(e: React.FormEvent) {
    e.preventDefault();
    setSubscribeMessage(null);
    const emailErr = validateEmail(subscribeEmail, 'Email');
    if (emailErr) {
      setSubscribeMessage({ type: 'err', text: emailErr });
      return;
    }

    setSubscribeSubmitting(true);
    try {
      await apiRequest('/api/public/contact', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Newsletter Subscriber',
          email: subscribeEmail.trim(),
          company: '',
          interest: 'advertising',
          message: 'Subscribed to Looma Advertising product and network updates from landing footer.',
        }),
      });
      setSubscribeEmail('');
      setSubscribeMessage({ type: 'ok', text: 'Subscribed! Updates will arrive in your inbox.' });
    } catch (err) {
      setSubscribeMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Unable to subscribe right now.',
      });
    } finally {
      setSubscribeSubmitting(false);
    }
  }

  function renderPageLink(slug: FooterPageSlug, label: string) {
    const isActive = activePage === slug;
    return (
      <a
        href={`/${slug}`}
        onClick={(e) => {
          e.preventDefault();
          onNavigatePage(slug);
        }}
        className={`transition ${isActive ? 'text-white font-semibold' : 'hover:text-white'}`}
      >
        {label}
      </a>
    );
  }

  return (
    <footer className="bg-darknavy text-slate-400 pt-16 pb-12 border-t border-slate-800/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-10 pb-12 border-b border-slate-800">
          {/* Col 1: Brand & Tagline */}
          <div className="md:col-span-4 space-y-4">
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                onNavigateHome();
              }}
              className="inline-flex items-center gap-2.5 font-display text-base font-bold tracking-tight text-white"
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                className="shrink-0 text-blue-500"
              >
                <rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor" />
                <path d="M8 7V17H16.5" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                <rect x="13" y="7" width="3.5" height="3.5" rx="0.75" fill="white" fillOpacity="0.9" />
              </svg>
              <span>Looma Advertising</span>
            </a>
            <p className="text-sm font-semibold text-slate-300">Reach More. Earn More.</p>
            <div className="pt-1 flex flex-wrap items-center gap-3 text-xs">
              <button
                type="button"
                onClick={onToggleTheme}
                aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900/80 text-slate-300 hover:border-slate-700 hover:text-white transition-colors"
              >
                {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                <span>{isDark ? 'Light Mode' : 'Dark Mode'}</span>
              </button>
            </div>
          </div>

          {/* Col 2: Product Links */}
          <div className="md:col-span-2">
            <h5 className="text-white text-xs font-bold uppercase tracking-wider mb-4">Product</h5>
            <ul className="space-y-2.5 text-xs font-medium">
              <li>
                <button
                  type="button"
                  onClick={() => onOpenAuth('register', 'advertiser')}
                  className="hover:text-white transition text-left"
                >
                  Advertise
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onQuickSandbox('publisher')}
                  className="hover:text-white transition text-left"
                >
                  Monetize
                </button>
              </li>
              <li>{renderPageLink('auction-engine', 'Analytics & Auction')}</li>
              <li>
                <a
                  href="#pricing"
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigateHome('pricing');
                  }}
                  className="hover:text-white transition"
                >
                  Pricing
                </a>
              </li>
            </ul>
          </div>

          {/* Col 3: Resources Links */}
          <div className="md:col-span-2">
            <h5 className="text-white text-xs font-bold uppercase tracking-wider mb-4">Resources</h5>
            <ul className="space-y-2.5 text-xs font-medium">
              <li>{renderPageLink('web-sdk', 'Documentation')}</li>
              <li>{renderPageLink('rest-api', 'REST Delivery API')}</li>
              <li>{renderPageLink('faq', 'FAQ')}</li>
              <li>{renderPageLink('contact', 'Support')}</li>
            </ul>
          </div>

          {/* Col 4: Company Links */}
          <div className="md:col-span-2">
            <h5 className="text-white text-xs font-bold uppercase tracking-wider mb-4">Company</h5>
            <ul className="space-y-2.5 text-xs font-medium">
              <li>{renderPageLink('integration-contract', 'Looma Contract')}</li>
              <li>{renderPageLink('ad-quality-policy', 'Ad Quality Policy')}</li>
              <li>{renderPageLink('privacy-policy', 'Privacy Policy')}</li>
              <li>{renderPageLink('advertiser-terms', 'Terms of Service')}</li>
            </ul>
          </div>

          {/* Col 5: Stay Updated Form */}
          <div className="md:col-span-2">
            <h5 className="text-white text-xs font-bold uppercase tracking-wider mb-2">Stay Updated</h5>
            <p className="text-xs text-slate-400 mb-3">Get the latest insights and updates.</p>
            <form className="space-y-2" onSubmit={handleSubscribe} noValidate>
              <label htmlFor="footer-subscribe-email" className="sr-only">
                Email address for updates
              </label>
              <input
                id="footer-subscribe-email"
                className="w-full text-xs bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
                placeholder="Enter your email"
                type="email"
                value={subscribeEmail}
                onChange={(e) => {
                  setSubscribeEmail(e.target.value);
                  if (subscribeMessage) setSubscribeMessage(null);
                }}
              />
              <button
                className="w-full py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-bold text-xs rounded-lg transition"
                type="submit"
                disabled={subscribeSubmitting}
              >
                {subscribeSubmitting ? 'Subscribing...' : 'Subscribe'}
              </button>
              {subscribeMessage && (
                <p
                  className={`text-[11px] leading-snug ${
                    subscribeMessage.type === 'ok' ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {subscribeMessage.text}
                </p>
              )}
            </form>
          </div>
        </div>

        {/* Footer Bottom */}
        <div className="pt-8 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>© {new Date().getFullYear()} Looma Advertising. All rights reserved.</span>
            <span aria-hidden="true">·</span>
            {renderPageLink('gdpr-data-requests', 'GDPR & Data Requests')}
          </div>

          {/* Quick Links / Social Icons */}
          <div className="flex items-center space-x-4">
            <a
              href="/web-sdk"
              aria-label="Developer Documentation"
              onClick={(e) => {
                e.preventDefault();
                onNavigatePage('web-sdk');
              }}
              className="hover:text-slate-300 transition"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
            <a
              href="/integration-contract"
              aria-label="Looma Integration Contract"
              onClick={(e) => {
                e.preventDefault();
                onNavigatePage('integration-contract');
              }}
              className="hover:text-slate-300 transition"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
              </svg>
            </a>
            <a
              href="/ad-formats"
              aria-label="Advertising Formats"
              onClick={(e) => {
                e.preventDefault();
                onNavigatePage('ad-formats');
              }}
              className="hover:text-slate-300 transition"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
              </svg>
            </a>
            <a
              href="/pricing-models"
              aria-label="Global Pricing Models"
              onClick={(e) => {
                e.preventDefault();
                onNavigatePage('pricing-models');
              }}
              className="hover:text-slate-300 transition"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
              </svg>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};
