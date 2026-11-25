import React, { useEffect, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { apiRequest, AuthUser } from '../lib/api';

interface AuthModalProps {
  open: boolean;
  initialMode?: 'login' | 'register';
  initialRole?: 'advertiser' | 'publisher';
  onClose: () => void;
  onAuthenticated: (token: string, user: AuthUser) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  open,
  initialMode = 'login',
  initialRole = 'advertiser',
  onClose,
  onAuthenticated,
}) => {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>(initialMode);
  const [role, setRole] = useState<'advertiser' | 'publisher'>(initialRole);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetStep, setResetStep] = useState<'request' | 'confirm'>('request');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [fullName, setFullName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [country, setCountry] = useState('US');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externalPubRegEnabled, setExternalPubRegEnabled] = useState(false);
  const [ssoAssertion, setSsoAssertion] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setRole(initialRole);
    setTotpRequired(false);
    setTotpCode('');
    setResetStep('request');
    setResetToken('');
    setResetNewPassword('');
    setStatusMsg(null);
    setError(null);
    apiRequest<{ featureFlags?: { external_publisher_registration_enabled?: boolean } }>('/api/public/overview')
      .then((res) => {
        setExternalPubRegEnabled(Boolean(res.featureFlags?.external_publisher_registration_enabled));
      })
      .catch(() => {
        setExternalPubRegEnabled(false);
      });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, initialMode, initialRole, onClose]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatusMsg(null);
    setLoading(true);
    try {
      if (mode === 'login') {
        const res = await apiRequest<{
          token?: string;
          user?: AuthUser;
          requiresTwoFactor?: boolean;
          message?: string;
        }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            email,
            password,
            ...(totpRequired ? { totpCode } : {}),
          }),
        });
        if (res.requiresTwoFactor) {
          setTotpRequired(true);
          setStatusMsg(res.message || 'Enter your 6-digit authenticator code to continue.');
          return;
        }
        if (res.token && res.user) {
          if (res.user.role === 'admin') {
            setError('Administrator accounts must sign in through the standalone Looma Admin project (/admin).');
            return;
          }
          onAuthenticated(res.token, res.user);
        }
      } else if (mode === 'register') {
        const res = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, fullName, password, role, organizationName, country }),
        });
        onAuthenticated(res.token, res.user);
      } else if (mode === 'forgot') {
        if (resetStep === 'request') {
          const res = await apiRequest<{ requested: boolean; message: string }>('/api/auth/forgot-password', {
            method: 'POST',
            body: JSON.stringify({ email }),
          });
          setResetStep('confirm');
          setStatusMsg(res.message);
        } else {
          await apiRequest('/api/auth/reset-password', {
            method: 'POST',
            body: JSON.stringify({ email, token: resetToken, newPassword: resetNewPassword }),
          });
          setMode('login');
          setResetStep('request');
          setResetToken('');
          setResetNewPassword('');
          setStatusMsg('Password updated. Sign in with your new password.');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleLoomaSsoExchange(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = ssoAssertion.trim();
    if (!trimmed) {
      setError('Paste a signed Looma SSO assertion token from Looma Core.');
      return;
    }
    setError(null);
    setStatusMsg(null);
    setLoading(true);
    try {
      const exchanged = await apiRequest<{ token: string; user: AuthUser }>('/api/v1/looma/sso/exchange', {
        method: 'POST',
        body: JSON.stringify({ assertion: trimmed }),
      });
      setSsoAssertion('');
      onAuthenticated(exchanged.token, exchanged.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Looma SSO verification failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 w-full h-full overflow-y-auto overflow-x-clip bg-white dark:bg-slate-950 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      <header className="h-16 px-4 sm:px-10 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 flex items-center justify-between gap-3 shrink-0 sticky top-0 z-10">
        <span className="font-display text-base sm:text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap truncate">
          Looma Advertising
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close authentication modal"
          className="inline-flex items-center gap-1.5 sm:gap-2 px-3 sm:px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-900 rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          <X className="w-4 h-4" />
          <span>Close</span>
        </button>
      </header>

      <div className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-10 py-6 sm:py-10 lg:py-14 grid lg:grid-cols-12 gap-6 lg:gap-10 items-start">
        <div className="lg:col-span-7 min-w-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-8">
          <div className="mb-5 sm:mb-6">
            <h2 id="auth-modal-title" className="font-display text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-100">
              {mode === 'login'
                ? 'Sign in to Looma Advertising'
                : mode === 'register'
                  ? 'Create your Looma account'
                  : 'Reset your password'}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              {mode === 'forgot'
                ? 'Request a one-time reset code to restore access to your workspace'
                : 'Access your advertiser or publisher workspace'}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg mb-6">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setTotpRequired(false);
                setError(null);
                setStatusMsg(null);
              }}
              className={`py-2.5 px-1.5 text-[11px] sm:text-xs font-medium rounded-md transition-colors text-center truncate ${
                mode === 'login'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register');
                setTotpRequired(false);
                setError(null);
                setStatusMsg(null);
              }}
              className={`py-2.5 px-1.5 text-[11px] sm:text-xs font-medium rounded-md transition-colors text-center truncate ${
                mode === 'register'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Create Account
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('forgot');
                setResetStep('request');
                setError(null);
                setStatusMsg(null);
              }}
              className={`py-2.5 px-1.5 text-[11px] sm:text-xs font-medium rounded-md transition-colors text-center truncate ${
                mode === 'forgot'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Reset Password
            </button>
          </div>

          {error && (
            <div className="mb-5 p-3.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/50 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
          {statusMsg && (
            <div className="mb-5 p-3.5 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-xs text-emerald-800 dark:text-emerald-200">
              {statusMsg}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Account Type
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setRole('advertiser')}
                      className={`py-2.5 px-4 text-xs font-medium rounded-lg border text-left transition-colors ${
                        role === 'advertiser'
                          ? 'border-blue-700 bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200'
                          : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      Advertiser
                    </button>
                    <button
                      type="button"
                      onClick={() => setRole('publisher')}
                      className={`py-2.5 px-4 text-xs font-medium rounded-lg border text-left transition-colors ${
                        role === 'publisher'
                          ? 'border-blue-700 bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200'
                          : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      Publisher {!externalPubRegEnabled && '(Expansion Phase)'}
                    </button>
                  </div>
                  {role === 'publisher' && !externalPubRegEnabled && (
                    <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">
                      External publisher self-registration is currently disabled by feature flag. Looma operates as the exclusive first-party publisher at initial launch.
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="auth-fullname" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Full Name
                  </label>
                  <input
                    id="auth-fullname"
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Jordan Rivera"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="grid sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <label htmlFor="auth-org" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Organization
                    </label>
                    <input
                      id="auth-org"
                      type="text"
                      required
                      value={organizationName}
                      onChange={(e) => setOrganizationName(e.target.value)}
                      placeholder="Meridian Media Ltd"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label htmlFor="auth-country" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Country
                    </label>
                    <select
                      id="auth-country"
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                      className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    >
                      <option value="US">US</option>
                      <option value="GB">GB</option>
                      <option value="DE">DE</option>
                      <option value="NG">NG</option>
                      <option value="CA">CA</option>
                    </select>
                  </div>
                </div>
              </>
            )}

            {mode === 'forgot' ? (
              <div className="space-y-4">
                <div>
                  <label htmlFor="auth-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Account Email
                  </label>
                  <input
                    id="auth-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@company.com"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
                {resetStep === 'confirm' && (
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="auth-reset-code" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        Reset Code
                      </label>
                      <input
                        id="auth-reset-code"
                        type="text"
                        required
                        value={resetToken}
                        onChange={(e) => setResetToken(e.target.value)}
                        placeholder="8-character code"
                        className="w-full px-3.5 py-2.5 text-sm font-mono uppercase rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                      />
                    </div>
                    <div>
                      <label htmlFor="auth-reset-newpw" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        New Password (min 8 chars)
                      </label>
                      <input
                        id="auth-reset-newpw"
                        type="password"
                        required
                        minLength={8}
                        value={resetNewPassword}
                        onChange={(e) => setResetNewPassword(e.target.value)}
                        placeholder="Minimum 8 characters"
                        className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                      />
                    </div>
                  </div>
                )}
                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3 px-5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors"
                  >
                    {loading
                      ? 'Processing...'
                      : resetStep === 'request'
                        ? 'Send Reset Code'
                        : 'Update Password'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="auth-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Work Email
                    </label>
                    <input
                      id="auth-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@company.com"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    />
                  </div>

                  <div>
                    <label htmlFor="auth-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Password
                    </label>
                    <input
                      id="auth-password"
                      type="password"
                      required
                      minLength={8}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Minimum 8 characters"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </div>

                {mode === 'login' && totpRequired && (
                  <div className="p-4 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/70 dark:bg-blue-950/30 space-y-2">
                    <label htmlFor="auth-totp" className="block text-xs font-semibold text-slate-900 dark:text-white">
                      Authenticator App Code (6-Digit 2FA)
                    </label>
                    <input
                      id="auth-totp"
                      type="text"
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      required
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      className="w-full px-3.5 py-2.5 text-sm font-mono tracking-widest rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    />
                  </div>
                )}

                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3 px-5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors"
                  >
                    {loading
                      ? 'Authenticating...'
                      : mode === 'login'
                        ? totpRequired
                          ? 'Verify 2FA & Sign In'
                          : 'Sign In'
                        : 'Create Account'}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>

        <aside className="lg:col-span-5 min-w-0 space-y-5 sm:space-y-6">
          <form
            onSubmit={handleLoomaSsoExchange}
            className="border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 bg-slate-50/70 dark:bg-slate-900/60 space-y-4"
          >
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white">
              <ShieldCheck className="w-4 h-4 text-blue-700 dark:text-blue-400" />
              <span>Looma Business SSO Exchange</span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Sign in with a cryptographically signed SSO assertion issued by Looma Core after verifying your business
              membership.
            </p>
            <div>
              <label htmlFor="looma-sso-assertion" className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Signed Looma Assertion Token
              </label>
              <textarea
                id="looma-sso-assertion"
                rows={3}
                value={ssoAssertion}
                onChange={(e) => setSsoAssertion(e.target.value)}
                placeholder="Paste signed assertion from Looma Core..."
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !ssoAssertion.trim()}
              className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg transition-colors"
            >
              Verify Looma SSO Assertion
            </button>
          </form>

          <div className="border border-slate-200 dark:border-slate-800 rounded-xl p-6 bg-white dark:bg-slate-900 space-y-2.5 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            <div className="font-semibold text-slate-900 dark:text-white">Protected Workspace Access</div>
            <p>
              All workspaces require verified credentials or a signed Looma Core SSO assertion. New advertisers can
              register directly using the Create Account tab and enable 2FA in Account Settings.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
};
