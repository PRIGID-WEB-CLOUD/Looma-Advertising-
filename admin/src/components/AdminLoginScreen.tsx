import React, { useEffect, useState } from 'react';
import { ArrowLeft, Eye, EyeOff, Moon, Sun } from 'lucide-react';
import { apiRequest, AuthUser, extractFieldErrors } from '../lib/api';
import { FieldError, fieldBorderClass } from './FieldError';
import {
  type FieldErrors,
  validateAdminClaimInput,
  validateForgotPasswordInput,
  validateLoginInput,
  validateResetPasswordInput,
} from '../lib/validation';

const AdminPasswordInput: React.FC<
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>
> = ({ className = '', ...props }) => {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        className={`${className} pr-10`}
      />
      <button
        type="button"
        onClick={() => setVisible((prev) => !prev)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-r-lg transition-colors"
      >
        {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
};

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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const clearFieldError = (key: string) =>
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

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
    setFieldErrors({});

    const normalizedEmail = email.trim();
    if (mode === 'claim') {
      const check = validateAdminClaimInput({
        email: normalizedEmail,
        fullName: fullName.trim(),
        password,
        confirmPassword,
      });
      if (!check.valid) {
        setFieldErrors(check.errors);
        return;
      }
    } else if (mode === 'forgot') {
      if (resetStep === 'request') {
        const check = validateForgotPasswordInput({ email: normalizedEmail });
        if (!check.valid) {
          setFieldErrors(check.errors);
          return;
        }
      } else {
        const check = validateResetPasswordInput({
          email: normalizedEmail,
          token: resetToken,
          newPassword: resetNewPassword,
        });
        if (!check.valid) {
          setFieldErrors(check.errors);
          return;
        }
      }
    } else {
      const check = validateLoginInput({
        email: normalizedEmail,
        password,
        totpCode: totpRequired ? totpCode : undefined,
        requireTotp: totpRequired,
      });
      if (!check.valid) {
        setFieldErrors(check.errors);
        return;
      }
    }

    setLoading(true);
    try {
      if (mode === 'claim') {
        const res = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/admin-claim', {
          method: 'POST',
          body: JSON.stringify({ email: normalizedEmail, fullName: fullName.trim(), password }),
        });
        setSetupStatus({ adminClaimed: true, envPasscodeConfigured: false });
        onAuthenticated(res.token, res.user);
        return;
      }

      if (mode === 'forgot') {
        if (resetStep === 'request') {
          const res = await apiRequest<{ message: string }>('/api/auth/forgot-password', {
            method: 'POST',
            body: JSON.stringify({ email: normalizedEmail }),
          });
          setResetStep('confirm');
          setStatusMsg(res.message);
        } else {
          await apiRequest('/api/auth/reset-password', {
            method: 'POST',
            body: JSON.stringify({
              email: normalizedEmail,
              token: resetToken.trim(),
              newPassword: resetNewPassword,
            }),
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
          body: JSON.stringify({
            email: normalizedEmail,
            password,
            totpCode: totpRequired ? totpCode.trim() : undefined,
          }),
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
      const fe = extractFieldErrors(err);
      if (Object.keys(fe).length > 0) setFieldErrors(fe);
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  const inputClass = (hasErr: boolean) =>
    `w-full h-11 px-3.5 text-sm rounded-lg border ${fieldBorderClass(hasErr)} bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 dark:focus:border-blue-500 transition-colors`;

  return (
    <div className="min-h-screen w-full overflow-x-clip bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 grid lg:grid-cols-12">
      {/* Left Brand & Security Column */}
      <aside className="hidden lg:flex lg:col-span-5 flex-col justify-between bg-slate-950 text-slate-100 px-12 xl:px-14 py-12 relative overflow-hidden border-r border-slate-800/80">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(148,163,184,0.5) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.5) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />

        <div className="relative z-10 flex items-center gap-2.5">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="shrink-0 text-blue-500"
          >
            <rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor" />
            <path d="M8 7V17H16.5" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="13" y="7" width="3.5" height="3.5" rx="0.75" fill="white" fillOpacity="0.9" />
          </svg>
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap">
              Looma Admin
            </span>
            <span className="text-slate-600" aria-hidden="true">·</span>
            <span className="text-xs text-slate-400 truncate">Operations</span>
          </div>
        </div>

        <div className="relative z-10 max-w-md space-y-8 my-12">
          <div className="space-y-4">
            <h1 className="font-display text-3xl xl:text-[34px] font-bold tracking-tight leading-[1.16] text-white [text-wrap:balance]">
              Isolated platform governance and financial oversight.
            </h1>
            <p className="text-sm text-slate-400 leading-relaxed">
              Manage campaign moderation, publisher approval queues, invalid traffic audits, and immutable ledger
              reconciliation from a dedicated administrative console.
            </p>
          </div>

          <div className="divide-y divide-slate-800/90 border-t border-b border-slate-800/90">
            <div className="py-4">
              <div className="text-xs font-semibold text-slate-100">Strict Environment Separation</div>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                Separated from the advertiser and publisher portal with role-locked server session verification.
              </p>
            </div>
            <div className="py-4">
              <div className="text-xs font-semibold text-slate-100">Audit Trail & 2FA Ready</div>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                Every moderation decision, publisher status change, and financial action is logged with operator
                attribution.
              </p>
            </div>
            <div className="py-4">
              <div className="text-xs font-semibold text-slate-100">Prepaid Financial Controls</div>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                Verify wallet ledger transactions, review refund requests, and enforce atomic budget integrity across
                all active campaigns.
              </p>
            </div>
          </div>
        </div>

        <div className="relative z-10 flex items-center gap-2 text-xs text-slate-500">
          <span>Looma Advertising</span>
          <span aria-hidden="true">·</span>
          <span>Platform Administration</span>
        </div>
      </aside>

      {/* Right Focused Operator Auth Column */}
      <div className="lg:col-span-7 flex flex-col min-h-screen bg-white dark:bg-slate-950">
        <header className="h-16 px-4 sm:px-8 lg:px-10 flex items-center justify-between border-b border-slate-200/80 dark:border-slate-800/80 lg:border-b-0 shrink-0">
          <div className="flex items-center gap-2.5 lg:invisible">
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
            <span className="font-display text-base font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap">
              Looma Admin
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

        <main className="flex-1 flex items-center justify-center px-4 sm:px-8 py-8 sm:py-10">
          <div className="w-full max-w-[440px]">
            <div className="mb-6">
              {mode === 'forgot' && (
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setResetStep('request');
                    setError(null);
                    setStatusMsg(null);
                    setFieldErrors({});
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white mb-4 transition-colors"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back to Sign In</span>
                </button>
              )}

              <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white [text-wrap:balance]">
                {mode === 'claim'
                  ? 'Initial administrator setup'
                  : mode === 'login'
                    ? 'Administrator sign in'
                    : 'Reset operator password'}
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5">
                {mode === 'claim'
                  ? 'Claim ownership of this environment by setting your operator email and password once.'
                  : mode === 'login'
                    ? 'Authorized Looma Advertising platform operators only.'
                    : 'Request a one-time reset code to restore operator access.'}
              </p>
            </div>

            {canClaimAdmin && mode !== 'forgot' && (
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-lg mb-6">
                <button
                  type="button"
                  onClick={() => {
                    setMode('claim');
                    setError(null);
                    setStatusMsg(null);
                    setFieldErrors({});
                  }}
                  className={`py-2 px-3 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    mode === 'claim'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  Initial Setup
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setTotpRequired(false);
                    setError(null);
                    setStatusMsg(null);
                    setFieldErrors({});
                  }}
                  className={`py-2 px-3 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    mode === 'login'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  Sign In
                </button>
              </div>
            )}

            {mode === 'login' && setupStatus && !setupStatus.envPasscodeConfigured && setupStatus.adminClaimed && (
              <div className="mb-5 p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Administrator credentials have already been claimed for this environment. Sign in with your operator
                email and password, or use <span className="font-medium">Forgot password?</span> to reset access.
              </div>
            )}

            {error && (
              <div className="mb-5 p-3.5 rounded-lg border border-red-200 dark:border-red-900/80 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 space-y-2">
                <div className="font-medium">{error}</div>
                {mode === 'login' && /invalid email or password/i.test(error) && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-red-700/90 dark:text-red-200/90">
                    <span>Verify your password with the eye icon or</span>
                    <button
                      type="button"
                      onClick={() => {
                        setMode('forgot');
                        setResetStep('request');
                        setError(null);
                        setStatusMsg(null);
                      }}
                      className="font-semibold underline hover:text-red-900 dark:hover:text-white"
                    >
                      Reset Password
                    </button>
                  </div>
                )}
              </div>
            )}
            {statusMsg && (
              <div className="mb-5 p-3.5 rounded-lg border border-emerald-200 dark:border-emerald-900/80 bg-emerald-50 dark:bg-emerald-950/40 text-xs text-emerald-800 dark:text-emerald-200">
                {statusMsg}
              </div>
            )}

            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              {mode === 'claim' ? (
                <>
                  <div>
                    <label htmlFor="admin-claim-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Operator Name
                    </label>
                    <input
                      id="admin-claim-name"
                      type="text"
                      required
                      value={fullName}
                      onChange={(e) => {
                        setFullName(e.target.value);
                        clearFieldError('fullName');
                      }}
                      aria-invalid={Boolean(fieldErrors.fullName)}
                      aria-describedby={fieldErrors.fullName ? 'admin-claim-name-err' : undefined}
                      className={inputClass(Boolean(fieldErrors.fullName))}
                    />
                    <FieldError id="admin-claim-name-err" message={fieldErrors.fullName} />
                  </div>
                  <div>
                    <label htmlFor="admin-claim-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Operator Email
                    </label>
                    <input
                      id="admin-claim-email"
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        clearFieldError('email');
                      }}
                      aria-invalid={Boolean(fieldErrors.email)}
                      aria-describedby={fieldErrors.email ? 'admin-claim-email-err' : undefined}
                      placeholder="admin@company.com"
                      className={inputClass(Boolean(fieldErrors.email))}
                    />
                    <FieldError id="admin-claim-email-err" message={fieldErrors.email} />
                  </div>
                  <div>
                    <label htmlFor="admin-claim-pw" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Password (min. 10 characters)
                    </label>
                    <AdminPasswordInput
                      id="admin-claim-pw"
                      required
                      minLength={10}
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        clearFieldError('password');
                        clearFieldError('confirmPassword');
                      }}
                      aria-invalid={Boolean(fieldErrors.password)}
                      aria-describedby={fieldErrors.password ? 'admin-claim-pw-err' : undefined}
                      placeholder="Choose a strong password"
                      className={inputClass(Boolean(fieldErrors.password))}
                    />
                    <FieldError id="admin-claim-pw-err" message={fieldErrors.password} />
                  </div>
                  <div>
                    <label htmlFor="admin-claim-confirm" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Confirm Password
                    </label>
                    <AdminPasswordInput
                      id="admin-claim-confirm"
                      required
                      minLength={10}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => {
                        setConfirmPassword(e.target.value);
                        clearFieldError('confirmPassword');
                      }}
                      aria-invalid={Boolean(fieldErrors.confirmPassword)}
                      aria-describedby={fieldErrors.confirmPassword ? 'admin-claim-confirm-err' : undefined}
                      placeholder="Re-enter password"
                      className={inputClass(Boolean(fieldErrors.confirmPassword))}
                    />
                    <FieldError id="admin-claim-confirm-err" message={fieldErrors.confirmPassword} />
                  </div>
                  <div className="pt-1">
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full h-11 px-5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors"
                    >
                      {loading ? 'Securing Admin Account...' : 'Claim Administrator Access'}
                    </button>
                  </div>
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
                      autoComplete="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        clearFieldError('email');
                      }}
                      aria-invalid={Boolean(fieldErrors.email)}
                      aria-describedby={fieldErrors.email ? 'admin-email-err' : undefined}
                      placeholder="admin@looma-ads.com"
                      className={inputClass(Boolean(fieldErrors.email))}
                    />
                    <FieldError id="admin-email-err" message={fieldErrors.email} />
                  </div>
                  {resetStep === 'confirm' && (
                    <>
                      <div>
                        <label htmlFor="admin-reset-code" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Reset Code
                        </label>
                        <input
                          id="admin-reset-code"
                          type="text"
                          required
                          value={resetToken}
                          onChange={(e) => {
                            setResetToken(e.target.value);
                            clearFieldError('token');
                          }}
                          aria-invalid={Boolean(fieldErrors.token)}
                          aria-describedby={fieldErrors.token ? 'admin-reset-code-err' : undefined}
                          placeholder="8-character code"
                          className={`${inputClass(Boolean(fieldErrors.token))} font-mono uppercase`}
                        />
                        <FieldError id="admin-reset-code-err" message={fieldErrors.token} />
                      </div>
                      <div>
                        <label htmlFor="admin-reset-pw" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          New Password (min. 8 characters)
                        </label>
                        <AdminPasswordInput
                          id="admin-reset-pw"
                          required
                          minLength={8}
                          autoComplete="new-password"
                          value={resetNewPassword}
                          onChange={(e) => {
                            setResetNewPassword(e.target.value);
                            clearFieldError('newPassword');
                          }}
                          aria-invalid={Boolean(fieldErrors.newPassword)}
                          aria-describedby={fieldErrors.newPassword ? 'admin-reset-pw-err' : undefined}
                          placeholder="Minimum 8 characters"
                          className={inputClass(Boolean(fieldErrors.newPassword))}
                        />
                        <FieldError id="admin-reset-pw-err" message={fieldErrors.newPassword} />
                      </div>
                    </>
                  )}
                  <div className="pt-1">
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full h-11 px-5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors"
                    >
                      {loading ? 'Processing...' : resetStep === 'request' ? 'Send Reset Code' : 'Update Password'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label htmlFor="admin-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Operator Email
                    </label>
                    <input
                      id="admin-email"
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        clearFieldError('email');
                      }}
                      aria-invalid={Boolean(fieldErrors.email)}
                      aria-describedby={fieldErrors.email ? 'admin-email-err' : undefined}
                      placeholder="admin@looma-ads.com"
                      className={inputClass(Boolean(fieldErrors.email))}
                    />
                    <FieldError id="admin-email-err" message={fieldErrors.email} />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label htmlFor="admin-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                        {setupStatus?.envPasscodeConfigured ? 'Admin Passcode' : 'Password'}
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          setMode('forgot');
                          setResetStep('request');
                          setError(null);
                          setStatusMsg(null);
                          setFieldErrors({});
                        }}
                        className="text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline"
                      >
                        Forgot password?
                      </button>
                    </div>
                    <AdminPasswordInput
                      id="admin-password"
                      required
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        clearFieldError('password');
                      }}
                      aria-invalid={Boolean(fieldErrors.password)}
                      aria-describedby={fieldErrors.password ? 'admin-password-err' : undefined}
                      placeholder="Enter your password"
                      className={inputClass(Boolean(fieldErrors.password))}
                    />
                    <FieldError id="admin-password-err" message={fieldErrors.password} />
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
                        onChange={(e) => {
                          setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                          clearFieldError('totpCode');
                        }}
                        aria-invalid={Boolean(fieldErrors.totpCode)}
                        aria-describedby={fieldErrors.totpCode ? 'admin-totp-err' : undefined}
                        placeholder="000000"
                        className={`${inputClass(Boolean(fieldErrors.totpCode))} font-mono tracking-widest`}
                      />
                      <FieldError id="admin-totp-err" message={fieldErrors.totpCode} />
                    </div>
                  )}

                  <div className="pt-1">
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full h-11 px-5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors"
                    >
                      {loading ? 'Authenticating...' : totpRequired ? 'Verify 2FA & Sign In' : 'Sign In to Admin Operations'}
                    </button>
                  </div>
                </>
              )}
            </form>
          </div>
        </main>
      </div>
    </div>
  );
};
