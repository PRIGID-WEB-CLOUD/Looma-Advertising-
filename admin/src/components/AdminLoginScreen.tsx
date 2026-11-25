import React, { useEffect, useState } from 'react';
import { Moon, ShieldCheck, Sun } from 'lucide-react';
import { apiRequest, AuthUser } from '../lib/api';

interface AdminLoginScreenProps {
  isDark: boolean;
  onToggleTheme: () => void;
  onAuthenticated: (token: string, user: AuthUser) => void;
}

export const AdminLoginScreen: React.FC<AdminLoginScreenProps> = ({
  isDark,
  onToggleTheme,
  onAuthenticated,
}) => {
  const [mode, setMode] = useState<'login' | 'forgot' | 'claim'>('login');
  const [setupStatus, setSetupStatus] = useState<{ adminClaimed: boolean; envPasscodeConfigured: boolean } | null>(
    null
  );
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('Platform Administrator');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [resetStep, setResetStep] = useState<'request' | 'confirm'>('request');
  const [resetToken, setResetToken] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<{ adminClaimed: boolean; envPasscodeConfigured: boolean }>('/api/auth/admin-setup-status')
      .then((res) => {
        setSetupStatus(res);
        if (!res.adminClaimed && !res.envPasscodeConfigured) {
          setMode('claim');
        }
      })
      .catch(() => {
        setSetupStatus({ adminClaimed: true, envPasscodeConfigured: false });
      });
  }, []);

  const canClaimAdmin = Boolean(setupStatus && !setupStatus.adminClaimed && !setupStatus.envPasscodeConfigured);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatusMsg(null);
    setLoading(true);
    try {
      if (mode === 'claim') {
        if (password.length < 10) {
          throw new Error('Administrator password must be at least 10 characters.');
        }
        if (password !== confirmPassword) {
          throw new Error('Password confirmation does not match.');
        }
        const res = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/admin-claim', {
          method: 'POST',
          body: JSON.stringify({ email, fullName, password }),
        });
        setSetupStatus({ adminClaimed: true, envPasscodeConfigured: false });
        onAuthenticated(res.token, res.user);
        return;
      }

      if (mode === 'forgot') {
        if (resetStep === 'request') {
          const res = await apiRequest<{ message: string }>('/api/auth/forgot-password', {
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
          setStatusMsg('Password updated. Sign in with your new credentials.');
          setMode('login');
          setResetStep('request');
          setResetToken('');
          setResetNewPassword('');
        }
        return;
      }

      const res = await apiRequest<{ token?: string; user?: AuthUser; requiresTwoFactor?: boolean; message?: string }>(
        '/api/auth/login',
        {
          method: 'POST',
          body: JSON.stringify({ email, password, totpCode: totpRequired ? totpCode : undefined }),
        }
      );

      if (res.requiresTwoFactor) {
        setTotpRequired(true);
        setStatusMsg(res.message || 'Enter the 6-digit code from your authenticator app.');
        return;
      }

      if (!res.token || !res.user) {
        throw new Error('Authentication response was incomplete.');
      }
      if (res.user.role !== 'admin') {
        throw new Error('Access restricted: only platform administrator accounts may sign in to Looma Admin.');
      }

      onAuthenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen w-full overflow-x-clip bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
      <header className="h-16 px-4 sm:px-10 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 flex items-center justify-between gap-3 shrink-0 sticky top-0 z-10">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="font-display text-base sm:text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap">
            Looma Admin
          </span>
          <span className="hidden sm:inline text-xs text-slate-400">·</span>
          <span className="hidden sm:inline text-xs text-slate-500 dark:text-slate-400 truncate">
            Platform Operations Console
          </span>
        </div>
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors shrink-0"
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-10 py-6 sm:py-10 lg:py-16 grid lg:grid-cols-12 gap-6 lg:gap-10 items-start">
        <div className="lg:col-span-7 min-w-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-8">
          <div className="mb-5 sm:mb-6">
            <h1 className="font-display text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">
              {mode === 'claim'
                ? 'Initial Administrator Setup'
                : mode === 'login'
                  ? 'Administrator Sign In'
                  : 'Reset Administrator Password'}
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              {mode === 'claim'
                ? 'Claim ownership of this environment by setting your operator email and password once.'
                : mode === 'login'
                  ? 'Authorized Looma Advertising platform operators only.'
                  : 'Request a one-time reset code to restore operator access.'}
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg mb-6">
            {canClaimAdmin && (
              <button
                type="button"
                onClick={() => {
                  setMode('claim');
                  setError(null);
                  setStatusMsg(null);
                }}
                className={`flex-1 py-2.5 text-xs font-medium rounded-md transition-colors ${
                  mode === 'claim'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Initial Setup
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setTotpRequired(false);
                setError(null);
                setStatusMsg(null);
              }}
              className={`flex-1 py-2.5 text-xs font-medium rounded-md transition-colors ${
                mode === 'login'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('forgot');
                setResetStep('request');
                setError(null);
                setStatusMsg(null);
              }}
              className={`flex-1 py-2.5 text-xs font-medium rounded-md transition-colors ${
                mode === 'forgot'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
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
            {mode === 'claim' ? (
              <>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="admin-claim-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Operator Name
                    </label>
                    <input
                      id="admin-claim-name"
                      type="text"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label htmlFor="admin-claim-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Operator Email
                    </label>
                    <input
                      id="admin-claim-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="admin@company.com"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="admin-claim-pw" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Password (min 10 chars)
                    </label>
                    <input
                      id="admin-claim-pw"
                      type="password"
                      required
                      minLength={10}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Choose a strong password"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label htmlFor="admin-claim-confirm" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Confirm Password
                    </label>
                    <input
                      id="admin-claim-confirm"
                      type="password"
                      required
                      minLength={10}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter password"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 px-5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors"
                >
                  {loading ? 'Securing Admin Account...' : 'Claim Administrator Access'}
                </button>
              </>
            ) : mode === 'forgot' ? (
              <>
                <div>
                  <label htmlFor="admin-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Operator Email
                  </label>
                  <input
                    id="admin-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@looma-ads.com"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                {resetStep === 'confirm' && (
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="admin-reset-code" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        Reset Code
                      </label>
                      <input
                        id="admin-reset-code"
                        type="text"
                        required
                        value={resetToken}
                        onChange={(e) => setResetToken(e.target.value)}
                        className="w-full px-3.5 py-2.5 text-sm font-mono uppercase rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label htmlFor="admin-reset-pw" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        New Password (min 8 chars)
                      </label>
                      <input
                        id="admin-reset-pw"
                        type="password"
                        required
                        minLength={8}
                        value={resetNewPassword}
                        onChange={(e) => setResetNewPassword(e.target.value)}
                        className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>
                  </div>
                )}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 px-5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors"
                >
                  {loading ? 'Processing...' : resetStep === 'request' ? 'Send Reset Code' : 'Update Password'}
                </button>
              </>
            ) : (
              <>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="admin-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Operator Email
                    </label>
                    <input
                      id="admin-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="admin@looma-ads.com"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label htmlFor="admin-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      {setupStatus?.envPasscodeConfigured ? 'Admin Passcode' : 'Password'}
                    </label>
                    <input
                      id="admin-password"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                </div>

                {totpRequired && (
                  <div className="p-4 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/70 dark:bg-blue-950/30 space-y-2">
                    <label htmlFor="admin-totp" className="block text-xs font-semibold text-slate-900 dark:text-white">
                      Authenticator App Code (6-Digit 2FA)
                    </label>
                    <input
                      id="admin-totp"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      required
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      className="w-full px-3.5 py-2.5 text-sm font-mono tracking-widest rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 px-5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors"
                >
                  {loading ? 'Authenticating...' : totpRequired ? 'Verify 2FA & Sign In' : 'Sign In to Admin Operations'}
                </button>
              </>
            )}
          </form>
        </div>

        <aside className="lg:col-span-5 min-w-0 space-y-6">
          <div className="border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 bg-slate-50/70 dark:bg-slate-900/60 space-y-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white">
              <ShieldCheck className="w-4 h-4 text-blue-700 dark:text-blue-400" />
              <span>Isolated Administration Environment</span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              This standalone operations application is isolated from the advertiser and publisher portal. Access is
              strictly limited to verified platform administrators with active server-side session checks and 2FA
              support.
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
              Before deploying or sharing this environment, configure <code className="font-mono">ADMIN_PASSCODE</code>{' '}
              and your webhook/adapter secrets in Settings &rarr; Secrets.
            </p>
          </div>
        </aside>
      </main>
    </div>
  );
};
