import React, { useEffect, useState } from 'react';
import { CheckCircle2, ShieldCheck, X } from 'lucide-react';
import { apiRequest, extractFieldErrors, setAuthToken, setDisplayCurrency } from '../lib/api';
import {
  FieldErrors,
  validatePreferencesInput,
  validateProfileUpdateInput,
  validateSecuritySettingsInput,
  validateSixDigitCode,
} from '../lib/validation';
import type { AccountSection } from './AccountMenu';
import { FieldError, fieldBorderClass } from './FieldError';
import { PasswordInput } from './PasswordInput';

interface AccountModalProps {
  open: boolean;
  initialSection: AccountSection;
  isDark: boolean;
  onToggleTheme: () => void;
  onClose: () => void;
  onProfileUpdated: (fullName: string) => void;
  onCurrencyChanged?: (currency: string) => void;
}

interface AccountResponse {
  profile: {
    id: string;
    email: string;
    fullName: string;
    role: string;
    organizationName: string;
    country: string;
    contactEmail: string;
    status: string;
    emailVerified?: boolean;
    createdAt: string;
  };
  settings: {
    twoFactorEnabled: boolean;
    totpConfigured?: boolean;
    sessionTimeoutMinutes: number;
  };
  preferences: {
    timezone: string;
    preferredCurrency: string;
    compactDensity: boolean;
    emailAlerts: boolean;
    fraudAlerts: boolean;
    weeklyDigest: boolean;
  };
}

export const AccountModal: React.FC<AccountModalProps> = ({
  open,
  initialSection,
  isDark,
  onToggleTheme,
  onClose,
  onProfileUpdated,
  onCurrencyChanged,
}) => {
  const section = initialSection;
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const clearFieldError = (field: string) => {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const [profileForm, setProfileForm] = useState({
    fullName: '',
    email: '',
    role: '',
    organizationName: '',
    country: 'US',
    contactEmail: '',
    emailVerified: false,
  });
  const [verifyCodeInput, setVerifyCodeInput] = useState('');
  const [verifyCodeSent, setVerifyCodeSent] = useState(false);

  const [settingsForm, setSettingsForm] = useState({
    twoFactorEnabled: false,
    totpConfigured: false,
    sessionTimeoutMinutes: 60,
    currentPassword: '',
    newPassword: '',
  });
  const [totpSetup, setTotpSetup] = useState<{ secretBase32: string; otpAuthUri: string } | null>(null);
  const [totpVerifyCode, setTotpVerifyCode] = useState('');

  const [prefsForm, setPrefsForm] = useState({
    timezone: 'UTC',
    preferredCurrency: 'USD',
    compactDensity: false,
    emailAlerts: true,
    fraudAlerts: true,
    weeklyDigest: true,
  });

  const sectionMeta: Record<AccountSection, { title: string; subtitle: string }> = {
    profile: {
      title: 'Profile',
      subtitle: profileForm.email || 'Personal and organization details',
    },
    settings: {
      title: 'Settings',
      subtitle: 'Account security, session timeout, and password',
    },
    preferences: {
      title: 'Preferences',
      subtitle: 'Timezone, display currency, appearance, and notifications',
    },
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFieldErrors({});
    setStatusMsg(null);
    setLoading(true);
    apiRequest<AccountResponse>('/api/auth/account')
      .then((res) => {
        setProfileForm({
          fullName: res.profile.fullName,
          email: res.profile.email,
          role: res.profile.role,
          organizationName: res.profile.organizationName,
          country: res.profile.country,
          contactEmail: res.profile.contactEmail,
          emailVerified: Boolean(res.profile.emailVerified),
        });
        setSettingsForm({
          twoFactorEnabled: res.settings.twoFactorEnabled,
          totpConfigured: Boolean(res.settings.totpConfigured),
          sessionTimeoutMinutes: res.settings.sessionTimeoutMinutes,
          currentPassword: '',
          newPassword: '',
        });
        setTotpSetup(null);
        setTotpVerifyCode('');
        setVerifyCodeSent(false);
        setVerifyCodeInput('');
        setPrefsForm(res.preferences);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Unable to load account details');
      })
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatusMsg(null);
    const check = validateProfileUpdateInput({
      fullName: profileForm.fullName,
      organizationName: profileForm.organizationName,
      country: profileForm.country,
      contactEmail: profileForm.contactEmail,
    });
    if (!check.valid) {
      setFieldErrors(check.errors);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      const res = await apiRequest<{ updated: boolean; fullName: string }>('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify(profileForm),
      });
      onProfileUpdated(res.fullName);
      setStatusMsg('Profile details saved.');
    } catch (err) {
      const serverFields = extractFieldErrors(err);
      if (Object.keys(serverFields).length > 0) setFieldErrors(serverFields);
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatusMsg(null);
    const check = validateSecuritySettingsInput(settingsForm);
    if (!check.valid) {
      setFieldErrors(check.errors);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      const res = await apiRequest<{ updated: boolean; passwordChanged?: boolean; token?: string }>(
        '/api/auth/settings',
        {
          method: 'PATCH',
          body: JSON.stringify(settingsForm),
        }
      );
      if (res.token) {
        setAuthToken(res.token);
      }
      setSettingsForm((prev) => ({ ...prev, currentPassword: '', newPassword: '' }));
      setStatusMsg(
        res.passwordChanged
          ? 'Password updated and prior sessions invalidated.'
          : 'Account security settings saved.'
      );
    } catch (err) {
      const serverFields = extractFieldErrors(err);
      if (Object.keys(serverFields).length > 0) setFieldErrors(serverFields);
      setError(err instanceof Error ? err.message : 'Failed to update settings');
    } finally {
      setSaving(false);
    }
  }

  async function handleRequestEmailVerification() {
    setError(null);
    setStatusMsg(null);
    try {
      const res = await apiRequest<{ sent: boolean; alreadyVerified?: boolean }>(
        '/api/auth/request-email-verification',
        { method: 'POST' }
      );
      if (res.alreadyVerified) {
        setProfileForm((prev) => ({ ...prev, emailVerified: true }));
        setStatusMsg('Email address is already verified.');
        return;
      }
      setVerifyCodeSent(true);
      setStatusMsg('Verification code dispatched to your email.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send verification code');
    }
  }

  async function handleConfirmEmailVerification() {
    setError(null);
    setStatusMsg(null);
    const codeErr = validateSixDigitCode(verifyCodeInput, 'Email verification code');
    if (codeErr) {
      setFieldErrors((prev) => ({ ...prev, verifyCode: codeErr }));
      return;
    }
    clearFieldError('verifyCode');
    try {
      await apiRequest('/api/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ code: verifyCodeInput.trim() }),
      });
      setProfileForm((prev) => ({ ...prev, emailVerified: true }));
      setVerifyCodeSent(false);
      setVerifyCodeInput('');
      setStatusMsg('Email address verified.');
    } catch (err) {
      const serverFields = extractFieldErrors(err);
      if (serverFields.code) setFieldErrors((prev) => ({ ...prev, verifyCode: serverFields.code }));
      setError(err instanceof Error ? err.message : 'Email verification failed');
    }
  }

  async function handleStart2faSetup() {
    setError(null);
    setStatusMsg(null);
    try {
      const res = await apiRequest<{ secretBase32: string; otpAuthUri: string }>('/api/auth/2fa/setup', {
        method: 'POST',
      });
      setTotpSetup(res);
      setStatusMsg('Add the setup key below to your authenticator app, then enter the 6-digit code to enable 2FA.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to initialize 2FA');
    }
  }

  async function handleVerify2fa() {
    setError(null);
    setStatusMsg(null);
    const codeErr = validateSixDigitCode(totpVerifyCode, 'Authenticator code');
    if (codeErr) {
      setFieldErrors((prev) => ({ ...prev, totpVerifyCode: codeErr }));
      return;
    }
    clearFieldError('totpVerifyCode');
    try {
      await apiRequest('/api/auth/2fa/verify', {
        method: 'POST',
        body: JSON.stringify({ code: totpVerifyCode.trim() }),
      });
      setSettingsForm((prev) => ({ ...prev, twoFactorEnabled: true, totpConfigured: true }));
      setTotpSetup(null);
      setTotpVerifyCode('');
      setStatusMsg('Authenticator 2FA is now active on your account.');
    } catch (err) {
      const serverFields = extractFieldErrors(err);
      if (serverFields.code) setFieldErrors((prev) => ({ ...prev, totpVerifyCode: serverFields.code }));
      setError(err instanceof Error ? err.message : 'Invalid 2FA verification code');
    }
  }

  async function handleDisable2fa() {
    setError(null);
    setStatusMsg(null);
    try {
      await apiRequest('/api/auth/2fa/disable', { method: 'POST' });
      setSettingsForm((prev) => ({ ...prev, twoFactorEnabled: false, totpConfigured: false }));
      setTotpSetup(null);
      setStatusMsg('Authenticator 2FA has been disabled.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to disable 2FA');
    }
  }

  async function handleSavePreferences(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatusMsg(null);
    const check = validatePreferencesInput(prefsForm);
    if (!check.valid) {
      setFieldErrors(check.errors);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      await apiRequest('/api/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify(prefsForm),
      });
      setDisplayCurrency(prefsForm.preferredCurrency);
      onCurrencyChanged?.(prefsForm.preferredCurrency);
      setStatusMsg(`Workspace preferences saved (Display currency: ${prefsForm.preferredCurrency}).`);
    } catch (err) {
      const serverFields = extractFieldErrors(err);
      if (Object.keys(serverFields).length > 0) setFieldErrors(serverFields);
      setError(err instanceof Error ? err.message : 'Failed to update preferences');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 w-full h-full overflow-y-auto overflow-x-clip bg-white dark:bg-slate-950 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-modal-title"
    >
      <header className="flex items-center justify-between gap-3 px-4 sm:px-10 h-16 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 sticky top-0 z-10 shrink-0">
        <div className="min-w-0">
          <h2 id="account-modal-title" className="font-display text-base sm:text-lg font-semibold text-slate-900 dark:text-white truncate">
            {sectionMeta[section].title}
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
            {sectionMeta[section].subtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close modal"
          className="inline-flex items-center gap-1.5 sm:gap-2 px-3 sm:px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900 shrink-0"
        >
          <X className="w-4 h-4" />
          <span>Close</span>
        </button>
      </header>

      <div className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-10 py-6 sm:py-10">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-8 space-y-5">
          {error && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
          {statusMsg && (
            <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-800 dark:text-emerald-200">
              {statusMsg}
            </div>
          )}

          {loading ? (
            <div className="h-44 rounded-lg bg-slate-100 dark:bg-slate-800 animate-pulse" />
          ) : (
            <>
              {section === 'profile' && (
                <form onSubmit={handleSaveProfile} noValidate className="space-y-4">
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="profile-fullname" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Full Name
                      </label>
                      <input
                        id="profile-fullname"
                        type="text"
                        required
                        value={profileForm.fullName}
                        onChange={(e) => {
                          setProfileForm({ ...profileForm, fullName: e.target.value });
                          clearFieldError('fullName');
                        }}
                        aria-invalid={Boolean(fieldErrors.fullName)}
                        aria-describedby={fieldErrors.fullName ? 'profile-fullname-err' : undefined}
                        className={`w-full px-3 py-2 text-sm rounded-lg border bg-white dark:bg-slate-950 text-slate-900 dark:text-white ${fieldBorderClass(Boolean(fieldErrors.fullName))}`}
                      />
                      <FieldError id="profile-fullname-err" message={fieldErrors.fullName} />
                    </div>
                    <div>
                      <label htmlFor="profile-role" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Account Role
                      </label>
                      <input
                        id="profile-role"
                        type="text"
                        disabled
                        value={profileForm.role}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-slate-500 capitalize"
                      />
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="profile-org" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Organization Name
                      </label>
                      <input
                        id="profile-org"
                        type="text"
                        value={profileForm.organizationName}
                        onChange={(e) => {
                          setProfileForm({ ...profileForm, organizationName: e.target.value });
                          clearFieldError('organizationName');
                        }}
                        aria-invalid={Boolean(fieldErrors.organizationName)}
                        aria-describedby={fieldErrors.organizationName ? 'profile-org-err' : undefined}
                        className={`w-full px-3 py-2 text-sm rounded-lg border bg-white dark:bg-slate-950 text-slate-900 dark:text-white ${fieldBorderClass(Boolean(fieldErrors.organizationName))}`}
                      />
                      <FieldError id="profile-org-err" message={fieldErrors.organizationName} />
                    </div>
                    <div>
                      <label htmlFor="profile-country" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Country Code
                      </label>
                      <input
                        id="profile-country"
                        type="text"
                        maxLength={2}
                        value={profileForm.country}
                        onChange={(e) => {
                          setProfileForm({ ...profileForm, country: e.target.value.toUpperCase() });
                          clearFieldError('country');
                        }}
                        aria-invalid={Boolean(fieldErrors.country)}
                        aria-describedby={fieldErrors.country ? 'profile-country-err' : undefined}
                        className={`w-full px-3 py-2 text-sm rounded-lg border bg-white dark:bg-slate-950 text-slate-900 dark:text-white uppercase ${fieldBorderClass(Boolean(fieldErrors.country))}`}
                      />
                      <FieldError id="profile-country-err" message={fieldErrors.country} />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="profile-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Billing / Contact Email
                    </label>
                    <input
                      id="profile-email"
                      type="email"
                      value={profileForm.contactEmail}
                      onChange={(e) => {
                        setProfileForm({ ...profileForm, contactEmail: e.target.value });
                        clearFieldError('contactEmail');
                      }}
                      aria-invalid={Boolean(fieldErrors.contactEmail)}
                      aria-describedby={fieldErrors.contactEmail ? 'profile-email-err' : undefined}
                      className={`w-full px-3 py-2 text-sm rounded-lg border bg-white dark:bg-slate-950 text-slate-900 dark:text-white ${fieldBorderClass(Boolean(fieldErrors.contactEmail))}`}
                    />
                    <FieldError id="profile-email-err" message={fieldErrors.contactEmail} />
                  </div>

                  <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-semibold text-slate-900 dark:text-white">Email Verification Status</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {profileForm.email}
                        </div>
                      </div>
                      {profileForm.emailVerified ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                          <CheckCircle2 className="w-4 h-4" />
                          <span>Verified</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={handleRequestEmailVerification}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-lg"
                        >
                          Send Verification Code
                        </button>
                      )}
                    </div>
                    {!profileForm.emailVerified && verifyCodeSent && (
                      <div className="space-y-1">
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            inputMode="numeric"
                            maxLength={6}
                            value={verifyCodeInput}
                            onChange={(e) => {
                              setVerifyCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6));
                              clearFieldError('verifyCode');
                            }}
                            aria-invalid={Boolean(fieldErrors.verifyCode)}
                            aria-describedby={fieldErrors.verifyCode ? 'profile-verify-err' : undefined}
                            placeholder="Enter 6-digit verification code"
                            className={`flex-1 min-w-0 px-3 py-2 text-xs font-mono rounded-lg border bg-white dark:bg-slate-950 ${fieldBorderClass(Boolean(fieldErrors.verifyCode))}`}
                          />
                          <button
                            type="button"
                            onClick={handleConfirmEmailVerification}
                            className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg shrink-0"
                          >
                            Verify Email
                          </button>
                        </div>
                        <FieldError id="profile-verify-err" message={fieldErrors.verifyCode} />
                      </div>
                    )}
                  </div>

                  <div className="pt-2 flex justify-end">
                    <button
                      type="submit"
                      disabled={saving}
                      className="w-full sm:w-auto px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors disabled:opacity-60"
                    >
                      {saving ? 'Saving…' : 'Save Profile'}
                    </button>
                  </div>
                </form>
              )}

              {section === 'settings' && (
                <form onSubmit={handleSaveSettings} noValidate className="space-y-4">
                  <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900 dark:text-white">
                          <ShieldCheck className="w-4 h-4 text-blue-700 dark:text-blue-400" />
                          <span>Authenticator App Two-Factor Authentication (TOTP 2FA)</span>
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          {settingsForm.totpConfigured && settingsForm.twoFactorEnabled
                            ? 'Active — 6-digit authenticator code required on sign-in.'
                            : 'Protect your account with time-based one-time passwords (Google Authenticator, 1Password, Authy).'}
                        </div>
                      </div>
                      {settingsForm.totpConfigured && settingsForm.twoFactorEnabled ? (
                        <button
                          type="button"
                          onClick={handleDisable2fa}
                          className="px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40"
                        >
                          Disable 2FA
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handleStart2faSetup}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-lg"
                        >
                          Generate 2FA Secret
                        </button>
                      )}
                    </div>

                    {totpSetup && (
                      <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
                        <div className="grid sm:grid-cols-2 gap-3 text-xs">
                          <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                            <div className="text-[11px] text-slate-500 mb-1">Manual Setup Secret (Base32)</div>
                            <div className="font-mono font-semibold break-all text-slate-900 dark:text-white">
                              {totpSetup.secretBase32}
                            </div>
                          </div>
                          <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                            <div className="text-[11px] text-slate-500 mb-1">Authenticator URI</div>
                            <div className="font-mono text-[11px] break-all text-slate-600 dark:text-slate-300">
                              {totpSetup.otpAuthUri}
                            </div>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="flex flex-col sm:flex-row gap-2">
                            <input
                              type="text"
                              inputMode="numeric"
                              maxLength={6}
                              value={totpVerifyCode}
                              onChange={(e) => {
                                setTotpVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                                clearFieldError('totpVerifyCode');
                              }}
                              aria-invalid={Boolean(fieldErrors.totpVerifyCode)}
                              aria-describedby={fieldErrors.totpVerifyCode ? 'settings-totp-err' : undefined}
                              placeholder="Enter 6-digit code from app"
                              className={`flex-1 min-w-0 px-3 py-2 text-xs font-mono tracking-widest rounded-lg border bg-white dark:bg-slate-950 ${fieldBorderClass(Boolean(fieldErrors.totpVerifyCode))}`}
                            />
                            <button
                              type="button"
                              onClick={handleVerify2fa}
                              className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg shrink-0"
                            >
                              Verify & Enable 2FA
                            </button>
                          </div>
                          <FieldError id="settings-totp-err" message={fieldErrors.totpVerifyCode} />
                        </div>
                      </div>
                    )}
                  </div>

                  <div>
                    <label htmlFor="settings-timeout" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Session Timeout (minutes)
                    </label>
                    <select
                      id="settings-timeout"
                      value={settingsForm.sessionTimeoutMinutes}
                      onChange={(e) => {
                        setSettingsForm({ ...settingsForm, sessionTimeoutMinutes: Number(e.target.value) });
                        clearFieldError('sessionTimeoutMinutes');
                      }}
                      aria-invalid={Boolean(fieldErrors.sessionTimeoutMinutes)}
                      aria-describedby={fieldErrors.sessionTimeoutMinutes ? 'settings-timeout-err' : undefined}
                      className={`w-full px-3 py-2 text-sm rounded-lg border bg-white dark:bg-slate-950 text-slate-900 dark:text-white ${fieldBorderClass(Boolean(fieldErrors.sessionTimeoutMinutes))}`}
                    >
                      <option value={30}>30 minutes</option>
                      <option value={60}>60 minutes</option>
                      <option value={240}>4 hours</option>
                      <option value={480}>8 hours</option>
                    </select>
                    <FieldError id="settings-timeout-err" message={fieldErrors.sessionTimeoutMinutes} />
                  </div>

                  <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
                    <div className="text-xs font-semibold text-slate-900 dark:text-white">Change Password (Optional)</div>
                    <div className="grid sm:grid-cols-2 gap-3">
                      <div>
                        <label htmlFor="settings-cur-pw" className="block text-xs text-slate-600 dark:text-slate-400 mb-1">
                          Current Password
                        </label>
                        <PasswordInput
                          id="settings-cur-pw"
                          autoComplete="current-password"
                          value={settingsForm.currentPassword}
                          onChange={(e) => {
                            setSettingsForm({ ...settingsForm, currentPassword: e.target.value });
                            clearFieldError('currentPassword');
                          }}
                          aria-invalid={Boolean(fieldErrors.currentPassword)}
                          aria-describedby={fieldErrors.currentPassword ? 'settings-cur-pw-err' : undefined}
                          className={`w-full px-3 py-2 text-sm rounded-lg border bg-white dark:bg-slate-950 ${fieldBorderClass(Boolean(fieldErrors.currentPassword))}`}
                        />
                        <FieldError id="settings-cur-pw-err" message={fieldErrors.currentPassword} />
                      </div>
                      <div>
                        <label htmlFor="settings-new-pw" className="block text-xs text-slate-600 dark:text-slate-400 mb-1">
                          New Password (min 8 chars)
                        </label>
                        <PasswordInput
                          id="settings-new-pw"
                          autoComplete="new-password"
                          value={settingsForm.newPassword}
                          onChange={(e) => {
                            setSettingsForm({ ...settingsForm, newPassword: e.target.value });
                            clearFieldError('newPassword');
                          }}
                          aria-invalid={Boolean(fieldErrors.newPassword)}
                          aria-describedby={fieldErrors.newPassword ? 'settings-new-pw-err' : undefined}
                          className={`w-full px-3 py-2 text-sm rounded-lg border bg-white dark:bg-slate-950 ${fieldBorderClass(Boolean(fieldErrors.newPassword))}`}
                        />
                        <FieldError id="settings-new-pw-err" message={fieldErrors.newPassword} />
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 flex justify-end">
                    <button
                      type="submit"
                      disabled={saving}
                      className="w-full sm:w-auto px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors disabled:opacity-60"
                    >
                      {saving ? 'Saving…' : 'Save Settings'}
                    </button>
                  </div>
                </form>
              )}

              {section === 'preferences' && (
                <form onSubmit={handleSavePreferences} noValidate className="space-y-4">
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="prefs-tz" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Reporting Timezone
                      </label>
                      <select
                        id="prefs-tz"
                        value={prefsForm.timezone}
                        onChange={(e) => {
                          setPrefsForm({ ...prefsForm, timezone: e.target.value });
                          clearFieldError('timezone');
                        }}
                        aria-invalid={Boolean(fieldErrors.timezone)}
                        aria-describedby={fieldErrors.timezone ? 'prefs-tz-err' : undefined}
                        className={`w-full px-3 py-2 text-sm rounded-lg border bg-white dark:bg-slate-950 text-slate-900 dark:text-white ${fieldBorderClass(Boolean(fieldErrors.timezone))}`}
                      >
                        <option value="UTC">UTC (Coordinated Universal Time)</option>
                        <option value="America/New_York">America/New_York (EST/EDT)</option>
                        <option value="Europe/London">Europe/London (GMT/BST)</option>
                        <option value="Europe/Berlin">Europe/Berlin (CET/CEST)</option>
                        <option value="Africa/Lagos">Africa/Lagos (WAT)</option>
                      </select>
                      <FieldError id="prefs-tz-err" message={fieldErrors.timezone} />
                    </div>
                    <div>
                      <label htmlFor="prefs-curr" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Display Currency
                      </label>
                      <select
                        id="prefs-curr"
                        value={prefsForm.preferredCurrency}
                        onChange={(e) => {
                          setPrefsForm({ ...prefsForm, preferredCurrency: e.target.value });
                          clearFieldError('preferredCurrency');
                        }}
                        aria-invalid={Boolean(fieldErrors.preferredCurrency)}
                        aria-describedby={fieldErrors.preferredCurrency ? 'prefs-curr-err' : undefined}
                        className={`w-full px-3 py-2 text-sm rounded-lg border bg-white dark:bg-slate-950 text-slate-900 dark:text-white ${fieldBorderClass(Boolean(fieldErrors.preferredCurrency))}`}
                      >
                        <option value="USD">USD ($)</option>
                        <option value="EUR">EUR (€)</option>
                        <option value="GBP">GBP (£)</option>
                        <option value="CAD">CAD (CA$)</option>
                        <option value="NGN">NGN (₦)</option>
                        <option value="KES">KES (KSh)</option>
                      </select>
                      <FieldError id="prefs-curr-err" message={fieldErrors.preferredCurrency} />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-lg border border-slate-200 dark:border-slate-800">
                    <div>
                      <div className="text-xs font-semibold text-slate-900 dark:text-white">Color Appearance</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        Currently using {isDark ? 'Dark' : 'Light'} theme across consoles.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={onToggleTheme}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 shrink-0"
                    >
                      Switch to {isDark ? 'Light' : 'Dark'}
                    </button>
                  </div>

                  <div className="space-y-2.5">
                    <label className="flex items-center gap-2.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={prefsForm.emailAlerts}
                        onChange={(e) => setPrefsForm({ ...prefsForm, emailAlerts: e.target.checked })}
                        className="rounded border-slate-300"
                      />
                      <span>Receive email alerts for campaign moderation and wallet funding</span>
                    </label>
                    <label className="flex items-center gap-2.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={prefsForm.fraudAlerts}
                        onChange={(e) => setPrefsForm({ ...prefsForm, fraudAlerts: e.target.checked })}
                        className="rounded border-slate-300"
                      />
                      <span>Notify immediately on invalid-traffic or abnormal CTR anomalies</span>
                    </label>
                    <label className="flex items-center gap-2.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={prefsForm.weeklyDigest}
                        onChange={(e) => setPrefsForm({ ...prefsForm, weeklyDigest: e.target.checked })}
                        className="rounded border-slate-300"
                      />
                      <span>Send weekly performance & ledger reconciliation summary</span>
                    </label>
                    <label className="flex items-center gap-2.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={prefsForm.compactDensity}
                        onChange={(e) => setPrefsForm({ ...prefsForm, compactDensity: e.target.checked })}
                        className="rounded border-slate-300"
                      />
                      <span>Use compact table row density in reporting consoles</span>
                    </label>
                  </div>

                  <div className="pt-2 flex justify-end">
                    <button
                      type="submit"
                      disabled={saving}
                      className="w-full sm:w-auto px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors disabled:opacity-60"
                    >
                      {saving ? 'Saving…' : 'Save Preferences'}
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
