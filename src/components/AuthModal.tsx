import React, { useEffect, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, KeyRound, ShieldCheck, X } from 'lucide-react';
import { apiRequest, AuthUser, extractFieldErrors } from '../lib/api';
import {
  FieldErrors,
  validateForgotPasswordInput,
  validateLoginInput,
  validateRegisterInput,
  validateResetPasswordInput,
} from '../lib/validation';
import { FieldError, fieldBorderClass } from './FieldError';
import { PasswordInput } from './PasswordInput';

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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [externalPubRegEnabled, setExternalPubRegEnabled] = useState(true);
  const [ssoOpen, setSsoOpen] = useState(false);
  const [ssoAssertion, setSsoAssertion] = useState('');

  const clearFieldError = (field: string) => {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

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
    setFieldErrors({});
    setSsoOpen(false);
    apiRequest<{ featureFlags?: { external_publisher_registration_enabled?: boolean } }>('/api/public/overview')
      .then((res) => {
        if (typeof res.featureFlags?.external_publisher_registration_enabled === 'boolean') {
          setExternalPubRegEnabled(res.featureFlags.external_publisher_registration_enabled);
        }
      })
      .catch(() => {
        setExternalPubRegEnabled(true);
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

    if (mode === 'login') {
      const check = validateLoginInput({
        email,
        password,
        totpCode: totpRequired ? totpCode : undefined,
        requireTotp: totpRequired,
      });
      if (!check.valid) {
        setFieldErrors(check.errors);
        return;
      }
    } else if (mode === 'register') {
      const check = validateRegisterInput({
        email,
        fullName,
        password,
        role,
        organizationName,
        country,
      });
      if (!check.valid) {
        setFieldErrors(check.errors);
        return;
      }
    } else if (mode === 'forgot') {
      const check =
        resetStep === 'request'
          ? validateForgotPasswordInput({ email })
          : validateResetPasswordInput({ email, token: resetToken, newPassword: resetNewPassword });
      if (!check.valid) {
        setFieldErrors(check.errors);
        return;
      }
    }

    setFieldErrors({});
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
            email: email.trim(),
            password,
            ...(totpRequired ? { totpCode: totpCode.trim() } : {}),
          }),
        });
        if (res.requiresTwoFactor) {
          setTotpRequired(true);
          setStatusMsg(res.message || 'Enter your 6-digit authenticator code to continue.');
          return;
        }
        if (res.token && res.user) {
          if (res.user.role === 'admin') {
            setError('Administrator accounts must sign in through the standalone Looma Admin console (/admin).');
            return;
          }
          onAuthenticated(res.token, res.user);
        }
      } else if (mode === 'register') {
        const res = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            email: email.trim(),
            fullName: fullName.trim(),
            password,
            role,
            organizationName: organizationName.trim(),
            country,
          }),
        });
        onAuthenticated(res.token, res.user);
      } else if (mode === 'forgot') {
        if (resetStep === 'request') {
          const res = await apiRequest<{ requested: boolean; message: string }>('/api/auth/forgot-password', {
            method: 'POST',
            body: JSON.stringify({ email: email.trim() }),
          });
          setResetStep('confirm');
          setStatusMsg(res.message);
        } else {
          await apiRequest('/api/auth/reset-password', {
            method: 'POST',
            body: JSON.stringify({
              email: email.trim(),
              token: resetToken.trim(),
              newPassword: resetNewPassword,
            }),
          });
          setMode('login');
          setResetStep('request');
          setResetToken('');
          setResetNewPassword('');
          setStatusMsg('Password updated. Sign in with your new credentials.');
        }
      }
    } catch (err) {
      const serverFields = extractFieldErrors(err);
      if (Object.keys(serverFields).length > 0) {
        setFieldErrors(serverFields);
      }
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleLoomaSsoExchange(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = ssoAssertion.trim();
    if (!trimmed) {
      setFieldErrors((prev) => ({ ...prev, ssoAssertion: 'Paste a signed Looma SSO assertion token from Looma Core.' }));
      return;
    }
    if (trimmed.length < 16) {
      setFieldErrors((prev) => ({ ...prev, ssoAssertion: 'Signed Looma SSO assertion token appears incomplete.' }));
      return;
    }
    clearFieldError('ssoAssertion');
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
      const serverFields = extractFieldErrors(err);
      if (serverFields.assertion) {
        setFieldErrors((prev) => ({ ...prev, ssoAssertion: serverFields.assertion }));
      }
      setError(err instanceof Error ? err.message : 'Looma SSO verification failed');
    } finally {
      setLoading(false);
    }
  }

  const brandHeadline =
    mode === 'forgot'
      ? 'Restore verified access to your advertising workspace.'
      : mode === 'register' && role === 'publisher'
        ? 'Monetize verified properties with transparent yield reporting.'
        : mode === 'register'
          ? 'Launch campaigns with auditable prepaid billing.'
          : 'Independent ad infrastructure, built for clarity.';

  const brandSubcopy =
    mode === 'register' && role === 'publisher'
      ? 'Register your websites or apps, configure native, banner, and video placements, and track verified impressions in real time.'
      : 'Manage campaigns, creative formats, audience targeting, and atomic prepaid ledger controls from a single platform.';

  const inputBase =
    'w-full h-11 px-3.5 text-sm rounded-lg border bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 dark:focus:border-blue-500 transition-colors';

  const publisherBlocked = mode === 'register' && role === 'publisher' && !externalPubRegEnabled;

  return (
    <div
      className="fixed inset-0 z-50 w-full h-full overflow-y-auto overflow-x-clip bg-white dark:bg-slate-950"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      <div className="min-h-screen w-full grid lg:grid-cols-12">
        {/* Left Brand & Trust Column */}
        <aside className="hidden lg:flex lg:col-span-5 flex-col justify-between bg-slate-950 text-slate-100 px-12 xl:px-14 py-12 relative overflow-hidden border-r border-slate-800/80">
          {/* Subtle architectural hairline grid */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.07]"
            style={{
              backgroundImage:
                'linear-gradient(to right, rgba(148,163,184,0.5) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.5) 1px, transparent 1px)',
              backgroundSize: '48px 48px',
            }}
          />

          <div className="relative z-10 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M5 5v14h14" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M10 14l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap">
              Looma Advertising
            </span>
          </div>

          <div className="relative z-10 max-w-md space-y-8 my-12">
            <div className="space-y-4">
              <h1 className="font-display text-3xl xl:text-[34px] font-bold tracking-tight leading-[1.16] text-white [text-wrap:balance]">
                {brandHeadline}
              </h1>
              <p className="text-sm text-slate-400 leading-relaxed">
                {brandSubcopy}
              </p>
            </div>

            <div className="divide-y divide-slate-800/90 border-t border-b border-slate-800/90">
              <div className="py-4">
                <div className="text-xs font-semibold text-slate-100">Prepaid Ledger Protection</div>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  Atomic per-request budget holds guarantee campaigns never overspend available wallet funds.
                </p>
              </div>
              <div className="py-4">
                <div className="text-xs font-semibold text-slate-100">Advertiser & Publisher Workspaces</div>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  Create an advertiser account to launch campaigns or a publisher account to register inventory and track earnings.
                </p>
              </div>
              <div className="py-4">
                <div className="text-xs font-semibold text-slate-100">Verified Security Controls</div>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  Protected with salted scrypt password hashing, TOTP two-factor authentication, and signed Looma Business SSO.
                </p>
              </div>
            </div>
          </div>

          <div className="relative z-10 flex items-center gap-2 text-xs text-slate-500">
            <span>Looma Advertising</span>
            <span aria-hidden="true">·</span>
            <span>Prepaid Ad-Serving Infrastructure</span>
          </div>
        </aside>

        {/* Right Focused Authentication Canvas */}
        <div className="lg:col-span-7 flex flex-col min-h-screen bg-white dark:bg-slate-950">
          <header className="h-16 px-4 sm:px-8 lg:px-10 flex items-center justify-between border-b border-slate-200/80 dark:border-slate-800/80 lg:border-b-0 shrink-0">
            <div className="flex items-center gap-2.5 lg:invisible">
              <div className="w-7 h-7 rounded-md bg-blue-700 flex items-center justify-center shrink-0">
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" strokeWidth="2.4">
                  <path d="M5 5v14h14" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M10 14l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <span className="font-display text-base font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap">
                Looma Advertising
              </span>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close authentication modal"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-900 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <X className="w-4 h-4" />
              <span>Close</span>
            </button>
          </header>

          <main className="flex-1 flex items-center justify-center px-4 sm:px-8 py-8 sm:py-10">
            <div className="w-full max-w-[440px]">
              {/* Title & Subtitle */}
              <div className="mb-6">
                {mode === 'forgot' && (
                  <button
                    type="button"
                    onClick={() => {
                      setMode('login');
                      setResetStep('request');
                      setError(null);
                      setFieldErrors({});
                      setStatusMsg(null);
                    }}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white mb-4 transition-colors"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Back to Sign In</span>
                  </button>
                )}

                <h2
                  id="auth-modal-title"
                  className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white [text-wrap:balance]"
                >
                  {mode === 'login'
                    ? 'Sign in to your account'
                    : mode === 'register'
                      ? 'Create your Looma account'
                      : 'Reset your password'}
                </h2>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5">
                  {mode === 'login'
                    ? 'Enter your credentials to access your advertiser or publisher workspace.'
                    : mode === 'register'
                      ? 'Choose your workspace role to get started immediately.'
                      : 'Enter your account email to receive a one-time recovery code.'}
                </p>
              </div>

              {/* Clean 2-Tab Mode Switcher (Sign In / Create Account) */}
              {mode !== 'forgot' && (
                <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-lg mb-6">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('login');
                      setTotpRequired(false);
                      setError(null);
                      setFieldErrors({});
                      setStatusMsg(null);
                    }}
                    className={`py-2 px-3 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                      mode === 'login'
                        ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
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
                      setFieldErrors({});
                      setStatusMsg(null);
                    }}
                    className={`py-2 px-3 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                      mode === 'register'
                        ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    Create Account
                  </button>
                </div>
              )}

              {/* Feedback Banners */}
              {error && (
                <div className="mb-5 p-3.5 rounded-lg border border-red-200 dark:border-red-900/80 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 space-y-2">
                  <div className="font-medium">{error}</div>
                  {mode === 'login' && /invalid email or password/i.test(error) && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-red-700/90 dark:text-red-200/90">
                      <span>Verify your password with the eye icon, or:</span>
                      <button
                        type="button"
                        onClick={() => {
                          setMode('register');
                          setError(null);
                          setStatusMsg(null);
                        }}
                        className="font-semibold underline hover:text-red-900 dark:hover:text-white"
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

              {/* Primary Authentication Form */}
              <form onSubmit={handleSubmit} noValidate className="space-y-4">
                {mode === 'register' && (
                  <>
                    <div>
                      <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
                        Account Role
                      </span>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            setRole('advertiser');
                            setError(null);
                            clearFieldError('role');
                          }}
                          className={`p-3 rounded-lg border text-left transition-colors ${
                            role === 'advertiser'
                              ? 'border-blue-700 dark:border-blue-500 bg-blue-50/70 dark:bg-blue-950/40 ring-1 ring-blue-700/20'
                              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700'
                          }`}
                        >
                          <div className="text-xs font-semibold text-slate-900 dark:text-white">Advertiser</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
                            Launch campaigns & fund prepaid wallets
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRole('publisher');
                            setError(null);
                            clearFieldError('role');
                          }}
                          className={`p-3 rounded-lg border text-left transition-colors ${
                            role === 'publisher'
                              ? 'border-blue-700 dark:border-blue-500 bg-blue-50/70 dark:bg-blue-950/40 ring-1 ring-blue-700/20'
                              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700'
                          }`}
                        >
                          <div className="text-xs font-semibold text-slate-900 dark:text-white">Publisher</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
                            Register sites or apps & monetize slots
                          </div>
                        </button>
                      </div>
                      <FieldError id="auth-role-err" message={fieldErrors.role} />
                      {publisherBlocked && (
                        <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">
                          External publisher registration is currently paused by platform administration.
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
                        autoComplete="name"
                        value={fullName}
                        onChange={(e) => {
                          setFullName(e.target.value);
                          clearFieldError('fullName');
                        }}
                        aria-invalid={Boolean(fieldErrors.fullName)}
                        aria-describedby={fieldErrors.fullName ? 'auth-fullname-err' : undefined}
                        placeholder="Jordan Rivera"
                        className={`${inputBase} ${fieldBorderClass(Boolean(fieldErrors.fullName))}`}
                      />
                      <FieldError id="auth-fullname-err" message={fieldErrors.fullName} />
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-2">
                        <label htmlFor="auth-org" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          {role === 'publisher' ? 'Publication / Media Name' : 'Company / Organization'}
                        </label>
                        <input
                          id="auth-org"
                          type="text"
                          required
                          autoComplete="organization"
                          value={organizationName}
                          onChange={(e) => {
                            setOrganizationName(e.target.value);
                            clearFieldError('organizationName');
                          }}
                          aria-invalid={Boolean(fieldErrors.organizationName)}
                          aria-describedby={fieldErrors.organizationName ? 'auth-org-err' : undefined}
                          placeholder={role === 'publisher' ? 'Meridian Digital Media' : 'Atlas Commerce Inc.'}
                          className={`${inputBase} ${fieldBorderClass(Boolean(fieldErrors.organizationName))}`}
                        />
                        <FieldError id="auth-org-err" message={fieldErrors.organizationName} />
                      </div>
                      <div>
                        <label htmlFor="auth-country" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Country
                        </label>
                        <select
                          id="auth-country"
                          value={country}
                          onChange={(e) => {
                            setCountry(e.target.value);
                            clearFieldError('country');
                          }}
                          aria-invalid={Boolean(fieldErrors.country)}
                          aria-describedby={fieldErrors.country ? 'auth-country-err' : undefined}
                          className={`${inputBase} ${fieldBorderClass(Boolean(fieldErrors.country))}`}
                        >
                          <option value="US">US</option>
                          <option value="GB">GB</option>
                          <option value="DE">DE</option>
                          <option value="NG">NG</option>
                          <option value="CA">CA</option>
                        </select>
                        <FieldError id="auth-country-err" message={fieldErrors.country} />
                      </div>
                    </div>
                  </>
                )}

                {mode === 'forgot' ? (
                  <div className="space-y-4">
                    <div>
                      <label htmlFor="auth-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        Work Email
                      </label>
                      <input
                        id="auth-email"
                        type="email"
                        required
                        autoComplete="email"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          clearFieldError('email');
                        }}
                        aria-invalid={Boolean(fieldErrors.email)}
                        aria-describedby={fieldErrors.email ? 'auth-email-err' : undefined}
                        placeholder="name@company.com"
                        className={`${inputBase} ${fieldBorderClass(Boolean(fieldErrors.email))}`}
                      />
                      <FieldError id="auth-email-err" message={fieldErrors.email} />
                    </div>
                    {resetStep === 'confirm' && (
                      <>
                        <div>
                          <label htmlFor="auth-reset-code" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                            Reset Code
                          </label>
                          <input
                            id="auth-reset-code"
                            type="text"
                            required
                            value={resetToken}
                            onChange={(e) => {
                              setResetToken(e.target.value);
                              clearFieldError('token');
                            }}
                            aria-invalid={Boolean(fieldErrors.token)}
                            aria-describedby={fieldErrors.token ? 'auth-reset-code-err' : undefined}
                            placeholder="8-character code"
                            className={`${inputBase} font-mono uppercase ${fieldBorderClass(Boolean(fieldErrors.token))}`}
                          />
                          <FieldError id="auth-reset-code-err" message={fieldErrors.token} />
                        </div>
                        <div>
                          <label htmlFor="auth-reset-newpw" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                            New Password
                          </label>
                          <PasswordInput
                            id="auth-reset-newpw"
                            required
                            minLength={8}
                            autoComplete="new-password"
                            value={resetNewPassword}
                            onChange={(e) => {
                              setResetNewPassword(e.target.value);
                              clearFieldError('newPassword');
                            }}
                            aria-invalid={Boolean(fieldErrors.newPassword)}
                            aria-describedby={fieldErrors.newPassword ? 'auth-reset-newpw-err' : undefined}
                            placeholder="Minimum 8 characters"
                            className={`${inputBase} ${fieldBorderClass(Boolean(fieldErrors.newPassword))}`}
                          />
                          <FieldError id="auth-reset-newpw-err" message={fieldErrors.newPassword} />
                        </div>
                      </>
                    )}
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full h-11 px-5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors"
                    >
                      {loading
                        ? 'Processing...'
                        : resetStep === 'request'
                          ? 'Send Reset Code'
                          : 'Update Password'}
                    </button>
                  </div>
                ) : (
                  <>
                    <div>
                      <label htmlFor="auth-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        Work Email
                      </label>
                      <input
                        id="auth-email"
                        type="email"
                        required
                        autoComplete="email"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          clearFieldError('email');
                        }}
                        aria-invalid={Boolean(fieldErrors.email)}
                        aria-describedby={fieldErrors.email ? 'auth-email-err' : undefined}
                        placeholder="name@company.com"
                        className={`${inputBase} ${fieldBorderClass(Boolean(fieldErrors.email))}`}
                      />
                      <FieldError id="auth-email-err" message={fieldErrors.email} />
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label htmlFor="auth-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                          Password
                        </label>
                        {mode === 'login' && (
                          <button
                            type="button"
                            onClick={() => {
                              setMode('forgot');
                              setResetStep('request');
                              setError(null);
                              setFieldErrors({});
                              setStatusMsg(null);
                            }}
                            className="text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline"
                          >
                            Forgot password?
                          </button>
                        )}
                      </div>
                      <PasswordInput
                        id="auth-password"
                        required
                        minLength={8}
                        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          clearFieldError('password');
                        }}
                        aria-invalid={Boolean(fieldErrors.password)}
                        aria-describedby={fieldErrors.password ? 'auth-password-err' : undefined}
                        placeholder={mode === 'register' ? 'Create a password (min. 8 characters)' : 'Enter your password'}
                        className={`${inputBase} ${fieldBorderClass(Boolean(fieldErrors.password))}`}
                      />
                      <FieldError id="auth-password-err" message={fieldErrors.password} />
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
                          onChange={(e) => {
                            setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                            clearFieldError('totpCode');
                          }}
                          aria-invalid={Boolean(fieldErrors.totpCode)}
                          aria-describedby={fieldErrors.totpCode ? 'auth-totp-err' : undefined}
                          placeholder="000000"
                          className={`${inputBase} font-mono tracking-widest ${fieldBorderClass(Boolean(fieldErrors.totpCode))}`}
                        />
                        <FieldError id="auth-totp-err" message={fieldErrors.totpCode} />
                      </div>
                    )}

                    <div className="pt-1">
                      <button
                        type="submit"
                        disabled={loading || publisherBlocked}
                        className="w-full h-11 px-5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg transition-colors"
                      >
                        {loading
                          ? mode === 'register'
                            ? 'Creating Account...'
                            : 'Signing In...'
                          : mode === 'login'
                            ? totpRequired
                              ? 'Verify 2FA & Sign In'
                              : 'Sign In'
                            : role === 'publisher'
                              ? 'Create Publisher Account'
                              : 'Create Advertiser Account'}
                      </button>
                    </div>
                  </>
                )}
              </form>

              {/* Secondary Enterprise SSO Divider & Collapsible Panel */}
              {mode !== 'forgot' && (
                <div className="mt-7">
                  <div className="relative flex items-center justify-center mb-4">
                    <div className="w-full border-t border-slate-200 dark:border-slate-800" />
                    <span className="px-3 bg-white dark:bg-slate-950 text-[11px] font-medium text-slate-400 whitespace-nowrap shrink-0">
                      Enterprise Access
                    </span>
                    <div className="w-full border-t border-slate-200 dark:border-slate-800" />
                  </div>

                  <button
                    type="button"
                    onClick={() => setSsoOpen((prev) => !prev)}
                    aria-expanded={ssoOpen}
                    className="w-full h-10 px-4 inline-flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900 rounded-lg transition-colors"
                  >
                    <span className="inline-flex items-center gap-2">
                      <KeyRound className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                      <span>Sign in with Looma Business SSO</span>
                    </span>
                    {ssoOpen ? (
                      <ChevronUp className="w-4 h-4 text-slate-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-400" />
                    )}
                  </button>

                  {ssoOpen && (
                    <form
                      onSubmit={handleLoomaSsoExchange}
                      noValidate
                      className="mt-3 p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/70 space-y-3"
                    >
                      <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white">
                        <ShieldCheck className="w-4 h-4 text-blue-700 dark:text-blue-400 shrink-0" />
                        <span>Looma Business SSO Exchange</span>
                      </div>
                      <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                        Paste a cryptographically signed assertion issued by Looma Core after verifying your business
                        membership.
                      </p>
                      <div>
                        <label htmlFor="looma-sso-assertion" className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Signed Looma Assertion Token
                        </label>
                        <textarea
                          id="looma-sso-assertion"
                          rows={3}
                          value={ssoAssertion}
                          onChange={(e) => {
                            setSsoAssertion(e.target.value);
                            clearFieldError('ssoAssertion');
                          }}
                          aria-invalid={Boolean(fieldErrors.ssoAssertion)}
                          aria-describedby={fieldErrors.ssoAssertion ? 'looma-sso-assertion-err' : undefined}
                          placeholder="Paste signed assertion from Looma Core..."
                          className={`w-full px-3 py-2 text-xs font-mono rounded-lg border bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 ${fieldBorderClass(Boolean(fieldErrors.ssoAssertion))}`}
                        />
                        <FieldError id="looma-sso-assertion-err" message={fieldErrors.ssoAssertion} />
                      </div>
                      <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-2 px-4 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 dark:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 rounded-lg transition-colors"
                      >
                        Verify Looma SSO Assertion
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
};
