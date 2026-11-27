import React, { useEffect, useState } from 'react';
import { Menu, Moon, Sun } from 'lucide-react';
import {
  apiRequest,
  AuthUser,
  FxRateEntry,
  getAuthToken,
  setAuthToken,
  setDisplayCurrency,
  setFxRates,
  setUnauthorizedHandler,
  UserRole,
} from './lib/api';
import { PublicWebsite } from './components/PublicWebsite';
import { AuthModal } from './components/AuthModal';
import { AdvertiserWorkspace, AdvTab } from './components/AdvertiserWorkspace';
import { PublisherWorkspace, PubTab } from './components/PublisherWorkspace';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { AccountMenu, AccountSection } from './components/AccountMenu';
import { AccountModal } from './components/AccountModal';
import { SupportPrivacyModal, SupportPrivacyMode } from './components/SupportPrivacyModal';

function readStoredString(key: string): string | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStoredString(key: string, value: string | null) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors
  }
}

export const App: React.FC = () => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [restoringSession, setRestoringSession] = useState<boolean>(() => Boolean(getAuthToken()));
  const [isDark, setIsDark] = useState<boolean>(() => readStoredString('looma_ads_theme') === 'dark');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [advTab, setAdvTab] = useState<AdvTab>(() => (readStoredString('looma_ads_adv_tab') as AdvTab) || 'overview');
  const [pubTab, setPubTab] = useState<PubTab>(() => (readStoredString('looma_ads_pub_tab') as PubTab) || 'overview');
  const [accountModal, setAccountModal] = useState<{ open: boolean; section: AccountSection }>({
    open: false,
    section: 'profile',
  });
  const [supportModal, setSupportModal] = useState<{ open: boolean; mode: SupportPrivacyMode }>({
    open: false,
    mode: 'privacy',
  });
  const [authModal, setAuthModal] = useState<{
    open: boolean;
    mode: 'login' | 'register';
    role: 'advertiser' | 'publisher';
  }>({ open: false, mode: 'login', role: 'advertiser' });
  const [authError, setAuthError] = useState<string | null>(null);
  const [currencyVersion, setCurrencyVersion] = useState(0);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    writeStoredString('looma_ads_theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => {
    writeStoredString('looma_ads_adv_tab', advTab);
  }, [advTab]);

  useEffect(() => {
    writeStoredString('looma_ads_pub_tab', pubTab);
  }, [pubTab]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setAccountModal((prev) => ({ ...prev, open: false }));
      setSupportModal((prev) => ({ ...prev, open: false }));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setRestoringSession(false);
      return;
    }
    let cancelled = false;
    apiRequest<{ profile?: AuthUser; preferences?: { preferredCurrency?: string } }>('/api/auth/account')
      .then((acc) => {
        if (cancelled) return;
        if (!acc.profile || acc.profile.role === 'admin') {
          setAuthToken(null);
          setUser(null);
          return;
        }
        setUser({
          id: acc.profile.id,
          email: acc.profile.email,
          fullName: acc.profile.fullName,
          role: acc.profile.role,
        });
        if (acc.preferences?.preferredCurrency) {
          setDisplayCurrency(acc.preferences.preferredCurrency);
          setCurrencyVersion((v) => v + 1);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setAuthToken(null);
        setUser(null);
      })
      .finally(() => {
        if (!cancelled) setRestoringSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    apiRequest<{ rates: Record<string, FxRateEntry> }>('/api/public/fx-rates')
      .then((res) => {
        if (res.rates) {
          setFxRates(res.rates);
          setCurrencyVersion((v) => v + 1);
        }
      })
      .catch(() => {
        // Fallback default FX table already loaded
      });
  }, []);

  function handleAuthenticated(token: string, nextUser: AuthUser) {
    if (nextUser.role === 'admin') {
      setAuthToken(null);
      setAuthError('Administrator accounts must sign in via the standalone Looma Admin console.');
      return;
    }
    setAuthToken(token);
    setUser(nextUser);
    setAuthModal((prev) => ({ ...prev, open: false }));
    setAuthError(null);
    setMobileSidebarOpen(false);
    window.scrollTo({ top: 0 });
    apiRequest<{ preferences?: { preferredCurrency?: string } }>('/api/auth/account')
      .then((acc) => {
        if (acc.preferences?.preferredCurrency) {
          setDisplayCurrency(acc.preferences.preferredCurrency);
          setCurrencyVersion((v) => v + 1);
        }
      })
      .catch(() => {});
  }

  function handleQuickSandbox(role: Extract<UserRole, 'advertiser' | 'publisher'>) {
    setAuthError(null);
    setAuthModal({ open: true, mode: 'login', role });
  }

  function handleSignOut() {
    apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setAuthToken(null);
    setUser(null);
    setMobileSidebarOpen(false);
    setAccountModal((prev) => ({ ...prev, open: false }));
    setSupportModal((prev) => ({ ...prev, open: false }));
    window.scrollTo({ top: 0 });
  }

  if (!user && restoringSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-300">
        <div className="flex items-center gap-3 text-sm font-medium">
          <div className="w-5 h-5 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
          <span>Restoring your workspace…</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        {authError && (
          <div className="fixed bottom-4 right-4 z-50 max-w-sm p-3.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 text-xs text-red-700 dark:text-red-300 shadow-lg">
            {authError}
          </div>
        )}
        <PublicWebsite
          isDark={isDark}
          onToggleTheme={() => setIsDark((d) => !d)}
          onOpenAuth={(mode, role = 'advertiser') => setAuthModal({ open: true, mode, role })}
          onQuickSandbox={handleQuickSandbox}
        />
        <AuthModal
          open={authModal.open}
          initialMode={authModal.mode}
          initialRole={authModal.role}
          onClose={() => setAuthModal((prev) => ({ ...prev, open: false }))}
          onAuthenticated={handleAuthenticated}
        />
      </>
    );
  }

  return (
    <div className="min-h-screen flex overflow-x-clip bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <WorkspaceSidebar
        user={user}
        isDark={isDark}
        collapsed={sidebarCollapsed}
        mobileOpen={mobileSidebarOpen}
        advTab={advTab}
        pubTab={pubTab}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        onToggleTheme={() => setIsDark((d) => !d)}
        onSelectAdvTab={setAdvTab}
        onSelectPubTab={setPubTab}
        onOpenSupportPrivacy={(mode) => setSupportModal({ open: true, mode })}
        onSignOut={handleSignOut}
      />

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 px-4 sm:px-6 border-b border-slate-200/90 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md flex items-center justify-between gap-2 sm:gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-2 sm:gap-2.5 text-xs text-slate-500 dark:text-slate-400 min-w-0">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              aria-label="Open navigation sidebar"
              className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            >
              <Menu className="w-4 h-4" />
            </button>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className="hidden sm:block shrink-0 text-blue-700 dark:text-blue-500"
            >
              <rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor" />
              <path d="M8 7V17H16.5" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="13" y="7" width="3.5" height="3.5" rx="0.75" fill="white" fillOpacity="0.9" />
            </svg>
            <span className="hidden sm:inline font-display font-semibold text-slate-800 dark:text-slate-200 truncate">
              Looma Advertising
            </span>
            <span className="hidden sm:inline text-slate-300 dark:text-slate-700" aria-hidden="true">/</span>
            <span className="font-medium text-slate-900 dark:text-white truncate text-sm sm:text-xs">
              {user.role.charAt(0).toUpperCase() + user.role.slice(1)} Workspace
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setIsDark((d) => !d)}
              aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
              title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
              className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <AccountMenu
              user={user}
              onOpenSection={(section) => setAccountModal({ open: true, section })}
              onSignOut={handleSignOut}
            />
          </div>
        </header>

        <main key={currencyVersion} className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {user.role === 'advertiser' && <AdvertiserWorkspace activeTab={advTab} onTabChange={setAdvTab} />}
          {user.role === 'publisher' && <PublisherWorkspace activeTab={pubTab} onTabChange={setPubTab} />}
        </main>

        <footer className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 px-4 sm:px-6 lg:px-8 py-4">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-slate-700 dark:text-slate-300">Looma Advertising</span>
              <span aria-hidden="true">·</span>
              <span>© {new Date().getFullYear()} All rights reserved.</span>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => setSupportModal({ open: true, mode: 'privacy' })}
                className="hover:text-slate-900 dark:hover:text-white transition-colors"
              >
                Privacy &amp; Compliance
              </button>
              <button
                type="button"
                onClick={() => setSupportModal({ open: true, mode: 'support' })}
                className="hover:text-slate-900 dark:hover:text-white transition-colors"
              >
                Contact Support
              </button>
            </div>
          </div>
        </footer>
      </div>

      <AccountModal
        open={accountModal.open}
        initialSection={accountModal.section}
        isDark={isDark}
        onToggleTheme={() => setIsDark((d) => !d)}
        onClose={() => setAccountModal((prev) => ({ ...prev, open: false }))}
        onProfileUpdated={(fullName) => setUser((prev) => (prev ? { ...prev, fullName } : prev))}
        onCurrencyChanged={() => setCurrencyVersion((v) => v + 1)}
      />

      <SupportPrivacyModal
        open={supportModal.open}
        mode={supportModal.mode}
        user={user}
        onClose={() => setSupportModal((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
};

export default App;
