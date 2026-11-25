import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiRequest, AuthUser } from '../lib/api';

export type SupportPrivacyMode = 'privacy' | 'support';

interface SupportPrivacyModalProps {
  open: boolean;
  mode: SupportPrivacyMode;
  user: AuthUser;
  onClose: () => void;
}

export const SupportPrivacyModal: React.FC<SupportPrivacyModalProps> = ({ open, mode, user, onClose }) => {
  const [privacyForm, setPrivacyForm] = useState({
    email: user.email,
    requestType: 'data_export',
    jurisdiction: 'GDPR',
    details: '',
  });
  const [supportForm, setSupportForm] = useState({
    name: user.fullName,
    email: user.email,
    company: '',
    interest: user.role === 'publisher' ? 'publisher_monetization' : 'advertising',
    message: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStatusMsg(null);
    setError(null);
    setPrivacyForm((prev) => ({ ...prev, email: user.email }));
    setSupportForm((prev) => ({
      ...prev,
      name: user.fullName,
      email: user.email,
      interest: user.role === 'publisher' ? 'publisher_monetization' : 'advertising',
    }));

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, user, onClose]);

  if (!open) return null;

  async function handlePrivacySubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setStatusMsg(null);
    try {
      const res = await apiRequest<{ requestId: string }>('/api/public/privacy-request', {
        method: 'POST',
        body: JSON.stringify(privacyForm),
      });
      setStatusMsg(`Privacy request ${res.requestId} logged under ${privacyForm.jurisdiction} compliance workflow.`);
      setPrivacyForm((prev) => ({ ...prev, details: '' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to submit privacy request');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSupportSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setStatusMsg(null);
    try {
      const res = await apiRequest<{ inquiryId: string }>('/api/public/contact', {
        method: 'POST',
        body: JSON.stringify(supportForm),
      });
      setStatusMsg(`Support inquiry ${res.inquiryId} received by Looma Operations.`);
      setSupportForm((prev) => ({ ...prev, message: '' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send support inquiry');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 w-full h-full overflow-y-auto overflow-x-clip bg-white dark:bg-slate-950 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-labelledby="support-privacy-title"
    >
      <header className="flex items-center justify-between gap-3 px-4 sm:px-10 h-16 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 sticky top-0 z-10 shrink-0">
        <div className="min-w-0">
          <h2 id="support-privacy-title" className="font-display text-base sm:text-lg font-semibold text-slate-900 dark:text-white truncate">
            {mode === 'privacy' ? 'Privacy & Compliance' : 'Contact Support'}
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
            {mode === 'privacy'
              ? 'Submit a GDPR or US state privacy request for data export, deletion, or consent withdrawal.'
              : 'Reach Looma Advertising operations, billing, or technical integration support.'}
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
            <div className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
          {statusMsg && (
            <div className="p-3.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-800 dark:text-emerald-200">
              {statusMsg}
            </div>
          )}

          {mode === 'privacy' ? (
            <form onSubmit={handlePrivacySubmit} className="space-y-3.5">
              <div>
                <label htmlFor="prv-email" className="block text-xs font-medium mb-1">
                  Account Email
                </label>
                <input
                  id="prv-email"
                  type="email"
                  required
                  value={privacyForm.email}
                  onChange={(e) => setPrivacyForm({ ...privacyForm, email: e.target.value })}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="prv-type" className="block text-xs font-medium mb-1">
                    Request Type
                  </label>
                  <select
                    id="prv-type"
                    value={privacyForm.requestType}
                    onChange={(e) => setPrivacyForm({ ...privacyForm, requestType: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="data_export">Data Export</option>
                    <option value="data_deletion">Data Deletion</option>
                    <option value="consent_withdrawal">Withdraw Consent</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="prv-jur" className="block text-xs font-medium mb-1">
                    Jurisdiction
                  </label>
                  <select
                    id="prv-jur"
                    value={privacyForm.jurisdiction}
                    onChange={(e) => setPrivacyForm({ ...privacyForm, jurisdiction: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="GDPR">EU / UK GDPR</option>
                    <option value="CCPA">US State Privacy</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="prv-details" className="block text-xs font-medium mb-1">
                  Details (Optional)
                </label>
                <textarea
                  id="prv-details"
                  rows={3}
                  value={privacyForm.details}
                  onChange={(e) => setPrivacyForm({ ...privacyForm, details: e.target.value })}
                  placeholder="Specify scope or reference details"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full sm:w-auto px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60"
                >
                  {submitting ? 'Submitting…' : 'Submit Privacy Request'}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleSupportSubmit} className="space-y-3.5">
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="sup-name" className="block text-xs font-medium mb-1">
                    Name
                  </label>
                  <input
                    id="sup-name"
                    type="text"
                    required
                    value={supportForm.name}
                    onChange={(e) => setSupportForm({ ...supportForm, name: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="sup-email" className="block text-xs font-medium mb-1">
                    Email
                  </label>
                  <input
                    id="sup-email"
                    type="email"
                    required
                    value={supportForm.email}
                    onChange={(e) => setSupportForm({ ...supportForm, email: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="sup-company" className="block text-xs font-medium mb-1">
                    Organization (Optional)
                  </label>
                  <input
                    id="sup-company"
                    type="text"
                    value={supportForm.company}
                    onChange={(e) => setSupportForm({ ...supportForm, company: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="sup-topic" className="block text-xs font-medium mb-1">
                    Topic
                  </label>
                  <select
                    id="sup-topic"
                    value={supportForm.interest}
                    onChange={(e) => setSupportForm({ ...supportForm, interest: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="advertising">Campaigns & Delivery</option>
                    <option value="publisher_monetization">Publisher SDK & Payouts</option>
                    <option value="billing">Billing & Reconciliation</option>
                    <option value="compliance">Policy & Moderation</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="sup-msg" className="block text-xs font-medium mb-1">
                  Message
                </label>
                <textarea
                  id="sup-msg"
                  rows={3}
                  required
                  value={supportForm.message}
                  onChange={(e) => setSupportForm({ ...supportForm, message: e.target.value })}
                  placeholder="Describe your request, campaign ID, or placement ID"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full sm:w-auto px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60"
                >
                  {submitting ? 'Sending…' : 'Send Support Inquiry'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
