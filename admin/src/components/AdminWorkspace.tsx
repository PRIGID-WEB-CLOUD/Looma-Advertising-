import React, { useEffect, useState } from 'react';
import { X, Eye } from 'lucide-react';
import { apiRequest, extractFieldErrors, formatMicros, formatNumber } from '../lib/api';
import { FieldError, fieldBorderClass } from './FieldError';
import { LiveAdPreview } from './LiveAdPreview';
import { getAdFormatSpec } from '../lib/adFormats';
import {
  type FieldErrors,
  validatePlatformSettingsInput,
  validateProhibitedCategoryInput,
} from '../lib/validation';

export type AdminTab = 'overview' | 'moderation' | 'advertisers' | 'publishers' | 'fraud' | 'finance' | 'settings';

interface AdminWorkspaceProps {
  activeTab?: AdminTab;
  onTabChange?: (tab: AdminTab) => void;
}

export const AdminWorkspace: React.FC<AdminWorkspaceProps> = ({ activeTab }) => {
  const tab = activeTab ?? 'overview';
  const [overview, setOverview] = useState<Record<string, number> | null>(null);
  const [moderation, setModeration] = useState<{
    campaigns: Array<Record<string, any>>;
    reviews: Array<Record<string, any>>;
    appeals?: Array<Record<string, any>>;
    prohibitedCategories?: Array<{ id: string; name: string; keywords: string[]; severity: 'block' | 'review'; active: boolean }>;
  } | null>(null);
  const [advertisers, setAdvertisers] = useState<Array<Record<string, any>>>([]);
  const [publishers, setPublishers] = useState<Array<Record<string, any>>>([]);
  const [properties, setProperties] = useState<Array<Record<string, any>>>([]);
  const [fraud, setFraud] = useState<{
    alerts: Array<Record<string, any>>;
    invalidClicks: Array<Record<string, any>>;
  } | null>(null);
  const [finance, setFinance] = useState<{
    withdrawals: Array<Record<string, any>>;
    deposits: Array<Record<string, any>>;
    ledger: Array<Record<string, any>>;
    reservations?: Array<Record<string, any>>;
  } | null>(null);
  const [monitoring, setMonitoring] = useState<{
    uptimeSeconds: number;
    delivery: {
      adRequestsTotal: number;
      adRequestsFilled: number;
      loomaFeedRequestsTotal: number;
      runtimeFillRate: number;
      p50LatencyMs: number;
      p95LatencyMs: number;
    };
    security: {
      ssoExchangesTotal: number;
      ssoExchangesRejected: number;
      webhooksVerifiedTotal: number;
      webhooksRejectedTotal: number;
      fraudEventsBlockedTotal: number;
    };
    ledgerAndReservations: {
      active_reservations: number;
      active_reserved_micros: number;
      captured_reservations: number;
      released_reservations: number;
      linked_looma_identities: number;
      total_ledger_entries: number;
    };
  } | null>(null);
  const [settings, setSettings] = useState<Record<string, any> | null>(null);
  const [jobRuns, setJobRuns] = useState<Array<Record<string, any>>>([]);
  const [newPolicy, setNewPolicy] = useState({ name: '', keywords: '', severity: 'block' as 'block' | 'review' });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [policyErrors, setPolicyErrors] = useState<FieldErrors>({});
  const [settingsErrors, setSettingsErrors] = useState<FieldErrors>({});
  const [selectedModerationCampaignId, setSelectedModerationCampaignId] = useState<string | null>(null);
  const [inspectorDimensionsOverride, setInspectorDimensionsOverride] = useState<string | null>(null);

  const clearPolicyError = (key: string) =>
    setPolicyErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  const clearSettingsError = (key: string) =>
    setSettingsErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [ov, mod, adv, pub, frd, fin, set, jobs, mon] = await Promise.all([
        apiRequest<{ overview: Record<string, number> }>('/api/admin/overview'),
        apiRequest<NonNullable<typeof moderation>>('/api/admin/moderation'),
        apiRequest<{ advertisers: Array<Record<string, any>> }>('/api/admin/advertisers'),
        apiRequest<{ publishers: Array<Record<string, any>>; properties: Array<Record<string, any>> }>('/api/admin/publishers'),
        apiRequest<NonNullable<typeof fraud>>('/api/admin/fraud'),
        apiRequest<NonNullable<typeof finance>>('/api/admin/finance'),
        apiRequest<{ settings: Record<string, any> }>('/api/admin/settings'),
        apiRequest<{ runs: Array<Record<string, any>> }>('/api/admin/jobs'),
        apiRequest<{ monitoring: NonNullable<typeof monitoring> }>('/api/admin/monitoring'),
      ]);
      setOverview(ov.overview);
      setModeration(mod);
      setAdvertisers(adv.advertisers);
      setPublishers(pub.publishers);
      setProperties(pub.properties);
      setFraud(frd);
      setFinance(fin);
      setSettings(set.settings);
      setJobRuns(jobs.runs || []);
      setMonitoring(mon.monitoring);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin console');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    setActionMsg(null);
    setError(null);
    setPolicyErrors({});
    setSettingsErrors({});
    setInspectorDimensionsOverride(null);
  }, [tab]);

  useEffect(() => {
    if (!actionMsg) return;
    const timer = window.setTimeout(() => setActionMsg(null), 5000);
    return () => window.clearTimeout(timer);
  }, [actionMsg]);

  async function handleModerationDecision(campaignId: string, decision: 'approved' | 'rejected' | 'suspended') {
    setError(null);
    setActionMsg(null);
    try {
      await apiRequest('/api/admin/moderation/decision', {
        method: 'POST',
        body: JSON.stringify({ campaignId, decision, reason: `Reviewed by Looma Moderation (${decision})` }),
      });
      setActionMsg(`Campaign ${campaignId} marked ${decision}.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Moderation decision failed');
    }
  }

  async function handleAdvertiserAction(id: string, verificationStatus: string, accountStatus: string) {
    await apiRequest(`/api/admin/advertisers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ verificationStatus, accountStatus }),
    });
    setActionMsg(`Advertiser ${id} updated.`);
    await loadAll();
  }

  async function handlePublisherAction(id: string, approvalStatus: string) {
    await apiRequest(`/api/admin/publishers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ approvalStatus }),
    });
    setActionMsg(`Publisher ${id} marked ${approvalStatus}.`);
    await loadAll();
  }

  async function handlePropertyAction(id: string, approvalStatus: string) {
    await apiRequest(`/api/admin/properties/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ approvalStatus }),
    });
    setActionMsg(`Property ${id} marked ${approvalStatus}.`);
    await loadAll();
  }

  async function handleFraudAction(id: string, status: 'confirmed_ivt' | 'dismissed') {
    await apiRequest(`/api/admin/fraud/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        status,
        resolutionNotes: `Admin resolution: ${status}`,
        deductMicros: status === 'confirmed_ivt' ? 5_000_000 : 0,
      }),
    });
    setActionMsg(`Fraud alert ${id} resolved as ${status}.`);
    await loadAll();
  }

  async function handleWithdrawalDecision(id: string, decision: 'paid' | 'rejected') {
    await apiRequest(`/api/admin/withdrawals/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision, notes: `Admin finance ${decision}` }),
    });
    setActionMsg(`Withdrawal ${id} marked ${decision}.`);
    await loadAll();
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setError(null);
    setActionMsg(null);
    setSettingsErrors({});
    const check = validatePlatformSettingsInput(settings);
    if (!check.valid) {
      setSettingsErrors(check.errors);
      return;
    }
    try {
      await apiRequest('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings: check.value }),
      });
      setActionMsg('Platform configuration saved.');
      await loadAll();
    } catch (err) {
      const fe = extractFieldErrors(err);
      if (Object.keys(fe).length > 0) setSettingsErrors(fe);
      setError(err instanceof Error ? err.message : 'Unable to save platform settings');
    }
  }

  async function handleAppealDecision(id: string, decision: 'approved' | 'rejected') {
    setError(null);
    setActionMsg(null);
    try {
      await apiRequest(`/api/admin/appeals/${id}/decision`, {
        method: 'POST',
        body: JSON.stringify({
          decision,
          adminResponse:
            decision === 'approved'
              ? 'Appeal approved; campaign reactivated for delivery.'
              : 'Appeal declined after policy compliance re-review.',
        }),
      });
      setActionMsg(`Appeal ${id} marked ${decision}.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to process appeal');
    }
  }

  async function handleAddPolicyRule(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setActionMsg(null);
    setPolicyErrors({});
    const check = validateProhibitedCategoryInput(newPolicy);
    if (!check.valid) {
      setPolicyErrors(check.errors);
      return;
    }
    try {
      await apiRequest('/api/admin/prohibited-categories', {
        method: 'POST',
        body: JSON.stringify({
          name: check.value!.name,
          keywords: check.value!.keywords,
          severity: check.value!.severity,
        }),
      });
      setNewPolicy({ name: '', keywords: '', severity: 'block' });
      setActionMsg('Added prohibited category policy rule.');
      await loadAll();
    } catch (err) {
      const fe = extractFieldErrors(err);
      if (Object.keys(fe).length > 0) setPolicyErrors(fe);
      setError(err instanceof Error ? err.message : 'Unable to add policy rule');
    }
  }

  async function handleDeletePolicyRule(id: string) {
    setError(null);
    try {
      await apiRequest(`/api/admin/prohibited-categories/${id}`, { method: 'DELETE' });
      setActionMsg('Removed prohibited category rule.');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete policy rule');
    }
  }

  async function handleRunJob(
    jobName:
      | 'daily_budget_reset'
      | 'publisher_earnings_settlement'
      | 'expired_token_cleanup'
      | 'release_expired_reservations'
  ) {
    setError(null);
    setActionMsg(null);
    try {
      const res = await apiRequest<{ summary: string }>('/api/admin/jobs/run', {
        method: 'POST',
        body: JSON.stringify({ jobName }),
      });
      setActionMsg(res.summary);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Background job execution failed');
    }
  }

  if (loading && !overview) {
    return (
      <div className="space-y-4">
        <div className="h-24 rounded-xl bg-slate-100 dark:bg-slate-900 animate-pulse" />
        <div className="h-64 rounded-xl bg-slate-100 dark:bg-slate-900 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="min-w-0">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Platform Administration · Moderation, Traffic Quality & Financial Reconciliation
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-bold text-slate-900 dark:text-white mt-0.5">
            Looma Ecosystem Operations
          </h1>
        </div>
        <div className="sm:text-right shrink-0">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">Platform Commission Revenue</div>
          <div className="font-mono tabular-nums text-base font-semibold text-slate-900 dark:text-white">
            {formatMicros(overview?.platform_revenue_micros)}
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/40 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {actionMsg && (
        <div className="p-3.5 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-sm text-emerald-800 dark:text-emerald-200 flex items-start justify-between gap-3">
          <span>{actionMsg}</span>
          <button
            type="button"
            onClick={() => setActionMsg(null)}
            aria-label="Dismiss notification"
            className="p-0.5 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/40 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* TAB: OVERVIEW */}
      {tab === 'overview' && overview && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <div className="p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
            <div className="text-xs text-slate-500">Total Advertisers / Publishers</div>
            <div className="mt-1 font-mono tabular-nums text-lg sm:text-2xl font-semibold truncate">
              {formatNumber(overview.total_advertisers)} / {formatNumber(overview.total_publishers)}
            </div>
          </div>
          <div className="p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
            <div className="text-xs text-slate-500">Active Campaigns</div>
            <div className="mt-1 font-mono tabular-nums text-lg sm:text-2xl font-semibold truncate">
              {formatNumber(overview.active_campaigns)}
            </div>
          </div>
          <div className="p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
            <div className="text-xs text-slate-500">Total Ad Spend</div>
            <div className="mt-1 font-mono tabular-nums text-lg sm:text-2xl font-semibold truncate">
              {formatMicros(overview.total_ad_spend_micros)}
            </div>
          </div>
          <div className="p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
            <div className="text-xs text-slate-500">Publisher Liabilities</div>
            <div className="mt-1 font-mono tabular-nums text-lg sm:text-2xl font-semibold truncate">
              {formatMicros(overview.publisher_liabilities_micros)}
            </div>
          </div>
          <div className="p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
            <div className="text-xs text-slate-500">Verified Impressions</div>
            <div className="mt-1 font-mono tabular-nums text-lg sm:text-2xl font-semibold truncate">
              {formatNumber(overview.total_impressions)}
            </div>
          </div>
          <div className="p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
            <div className="text-xs text-slate-500">Valid Clicks</div>
            <div className="mt-1 font-mono tabular-nums text-lg sm:text-2xl font-semibold truncate">
              {formatNumber(overview.total_clicks)}
            </div>
          </div>
          <div className="p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
            <div className="text-xs text-slate-500">Pending Payouts</div>
            <div className="mt-1 font-mono tabular-nums text-lg sm:text-2xl font-semibold truncate">
              {formatMicros(overview.pending_payouts_micros)}
            </div>
          </div>
          <div className="p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
            <div className="text-xs text-slate-500">Open Fraud Alerts</div>
            <div className="mt-1 font-mono tabular-nums text-lg sm:text-2xl font-semibold text-amber-600 dark:text-amber-400 truncate">
              {formatNumber(overview.open_fraud_alerts)}
            </div>
          </div>
          {monitoring && (
            <>
              <div className="p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
                <div className="text-xs text-slate-500">Ad Delivery p95 Latency</div>
                <div className="mt-1 font-mono tabular-nums text-lg sm:text-2xl font-semibold truncate">
                  {monitoring.delivery.p95LatencyMs.toFixed(1)} ms
                </div>
              </div>
              <div className="p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
                <div className="text-xs text-slate-500">Active Budget Holds</div>
                <div className="mt-1 font-mono tabular-nums text-lg sm:text-2xl font-semibold text-blue-700 dark:text-blue-400 truncate">
                  {formatNumber(monitoring.ledgerAndReservations.active_reservations)} ({formatMicros(monitoring.ledgerAndReservations.active_reserved_micros)})
                </div>
              </div>
              <div className="p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
                <div className="text-xs text-slate-500">Linked Looma SSO Accounts</div>
                <div className="mt-1 font-mono tabular-nums text-lg sm:text-2xl font-semibold truncate">
                  {formatNumber(monitoring.ledgerAndReservations.linked_looma_identities)}
                </div>
              </div>
              <div className="p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
                <div className="text-xs text-slate-500">Immutable Ledger Entries</div>
                <div className="mt-1 font-mono tabular-nums text-lg sm:text-2xl font-semibold truncate">
                  {formatNumber(monitoring.ledgerAndReservations.total_ledger_entries)}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB: MODERATION */}
      {tab === 'moderation' && moderation && (() => {
        const campaigns = moderation.campaigns || [];
        const selectedCampaign =
          campaigns.find((c) => c.id === selectedModerationCampaignId) ??
          campaigns[0] ??
          null;
        const selectedFormat = String(selectedCampaign?.ad_format || 'native');
        const selectedSpec = getAdFormatSpec(selectedFormat);
        const submittedDimensions = String(
          selectedCampaign?.dimensions || selectedSpec.defaultDimensions
        );
        const activeDimensions = inspectorDimensionsOverride || submittedDimensions;

        return (
        <div className="space-y-6">
          <div className="grid lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-7 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">Campaign & Creative Moderation Queue</span>
                <span className="text-xs font-mono text-slate-500">
                  {campaigns.length} campaign{campaigns.length === 1 ? '' : 's'}
                </span>
              </div>
              {campaigns.length === 0 ? (
                <div className="p-5 text-xs text-slate-500">No campaigns queued for moderation.</div>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-800">
                  {campaigns.map((c) => {
                    const isSelected = selectedCampaign?.id === c.id;
                    const rowFormat = String(c.ad_format || 'native');
                    const rowSpec = getAdFormatSpec(rowFormat);
                    const rowDims = String(c.dimensions || rowSpec.defaultDimensions);
                    return (
                      <div
                        key={c.id}
                        className={`p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4 transition-colors ${
                          isSelected
                            ? 'bg-blue-50/50 dark:bg-blue-950/20'
                            : 'hover:bg-slate-50/60 dark:hover:bg-slate-800/30'
                        }`}
                      >
                        <div className="max-w-2xl min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                              {rowSpec.label} · {rowDims}
                            </span>
                            <span>
                              {c.company_name} · {c.pricing_model} ({formatMicros(c.max_bid_micros)}) · Moderation: {c.moderation_status}
                            </span>
                          </div>
                          <div className="text-base font-semibold text-slate-900 dark:text-white mt-1">{c.name}</div>
                          <div className="text-xs text-slate-600 dark:text-slate-300 mt-1">
                            Creative: <strong>{c.creative_title}</strong> — {c.creative_description}
                          </div>
                          <div className="text-[11px] font-mono text-slate-400 mt-1 break-all">{c.destination_url}</div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          <button
                            type="button"
                            aria-pressed={isSelected}
                            onClick={() => {
                              setSelectedModerationCampaignId(c.id);
                              setInspectorDimensionsOverride(null);
                            }}
                            className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md border ${
                              isSelected
                                ? 'border-blue-700 bg-blue-700 text-white'
                                : 'border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'
                            }`}
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>{isSelected ? 'Inspecting' : 'Preview Ad'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleModerationDecision(c.id, 'approved')}
                            className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-md"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => handleModerationDecision(c.id, 'rejected')}
                            className="px-3 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            onClick={() => handleModerationDecision(c.id, 'suspended')}
                            className="px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900 rounded-md"
                          >
                            Suspend
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div
              className="lg:col-span-5 min-w-0 lg:sticky lg:top-20 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 bg-white dark:bg-slate-900 space-y-4"
              data-testid="admin-creative-inspector"
            >
              <div className="flex flex-wrap items-start justify-between gap-2 pb-3 border-b border-slate-200 dark:border-slate-800">
                <div className="min-w-0">
                  <div className="text-xs font-mono uppercase tracking-wider text-slate-500">
                    Live Creative Moderation Inspector
                  </div>
                  {selectedCampaign ? (
                    <h3 className="text-base font-semibold text-slate-900 dark:text-white mt-0.5 truncate">
                      {selectedCampaign.name}
                    </h3>
                  ) : (
                    <h3 className="text-base font-semibold text-slate-900 dark:text-white mt-0.5">
                      No Creative Selected
                    </h3>
                  )}
                </div>
                {selectedCampaign && (
                  <span className="text-[11px] font-mono capitalize px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 shrink-0">
                    {selectedCampaign.moderation_status}
                  </span>
                )}
              </div>

              {selectedCampaign ? (
                <>
                  {selectedSpec.dimensionsOptions.length > 1 && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-slate-500 dark:text-slate-400">Preview Slot Size</span>
                        {inspectorDimensionsOverride && inspectorDimensionsOverride !== submittedDimensions && (
                          <button
                            type="button"
                            onClick={() => setInspectorDimensionsOverride(null)}
                            className="text-blue-700 dark:text-blue-400 hover:underline font-medium"
                          >
                            Submitted Default ({submittedDimensions})
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedSpec.dimensionsOptions.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => setInspectorDimensionsOverride(opt.value)}
                            className={`px-2 py-1 text-[11px] font-mono rounded-md border transition-colors ${
                              activeDimensions === opt.value
                                ? 'border-blue-700 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                            }`}
                          >
                            {opt.value}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <LiveAdPreview
                    format={selectedFormat}
                    dimensions={activeDimensions}
                    pricingModel={String(selectedCampaign.pricing_model || 'CPC')}
                    title={String(selectedCampaign.creative_title || selectedCampaign.name || '')}
                    description={String(selectedCampaign.creative_description || '')}
                    mediaUrl={String(selectedCampaign.media_url || '')}
                    destinationUrl={String(selectedCampaign.destination_url || '')}
                    ctaText={String(selectedCampaign.cta_text || selectedSpec.defaultCta)}
                  />

                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3 text-xs space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Advertiser</span>
                      <span className="font-medium text-slate-900 dark:text-white truncate">
                        {selectedCampaign.company_name}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Daily / Total Budget</span>
                      <span className="font-mono text-slate-800 dark:text-slate-200">
                        {formatMicros(selectedCampaign.daily_budget_micros)} / {formatMicros(selectedCampaign.total_budget_micros)}
                      </span>
                    </div>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-slate-500 shrink-0">Destination</span>
                      <span className="font-mono text-[11px] text-slate-700 dark:text-slate-300 break-all text-right">
                        {selectedCampaign.destination_url}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => handleModerationDecision(selectedCampaign.id, 'approved')}
                      className="py-2 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-md"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => handleModerationDecision(selectedCampaign.id, 'rejected')}
                      className="py-2 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => handleModerationDecision(selectedCampaign.id, 'suspended')}
                      className="py-2 text-xs font-medium text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900 rounded-md hover:bg-red-50 dark:hover:bg-red-950/40"
                    >
                      Suspend
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-xs text-slate-500">Select a campaign from the moderation queue to inspect its rendered creative.</div>
              )}
            </div>
          </div>

          {/* Advertiser Policy Appeals */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Advertiser Policy Appeals
            </div>
            {(!moderation.appeals || moderation.appeals.length === 0) ? (
              <div className="p-5 text-xs text-slate-500">No campaign appeals submitted yet.</div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {moderation.appeals.map((ap) => (
                  <div key={ap.id} className="p-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="max-w-2xl min-w-0">
                      <div className="text-xs text-slate-500">
                        {ap.company_name} · Campaign: {ap.campaign_name} · Status: {ap.status}
                      </div>
                      <div className="text-sm text-slate-900 dark:text-white mt-0.5">{ap.reason}</div>
                    </div>
                    {ap.status === 'open' ? (
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleAppealDecision(ap.id, 'approved')}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-md"
                        >
                          Approve & Reactivate
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAppealDecision(ap.id, 'rejected')}
                          className="px-3 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-md"
                        >
                          Decline
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs font-mono uppercase text-slate-500">{ap.status}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Prohibited Categories & Policy Scanner Rules */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Prohibited Categories & Automated Policy Rules
            </div>
            <form onSubmit={handleAddPolicyRule} noValidate className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 grid grid-cols-1 md:grid-cols-12 gap-3 items-start">
              <div className="md:col-span-4">
                <label htmlFor="admin-pol-name" className="block text-xs font-medium mb-1">Category Name</label>
                <input
                  id="admin-pol-name"
                  type="text"
                  required
                  value={newPolicy.name}
                  onChange={(e) => {
                    setNewPolicy({ ...newPolicy, name: e.target.value });
                    clearPolicyError('name');
                  }}
                  aria-invalid={Boolean(policyErrors.name)}
                  aria-describedby={policyErrors.name ? 'admin-pol-name-err' : undefined}
                  placeholder="Unverified Crypto Schemes"
                  className={`w-full px-3 py-2 text-xs rounded-lg border ${fieldBorderClass(Boolean(policyErrors.name))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="admin-pol-name-err" message={policyErrors.name} />
              </div>
              <div className="md:col-span-5">
                <label htmlFor="admin-pol-kw" className="block text-xs font-medium mb-1">Trigger Keywords (comma-separated)</label>
                <input
                  id="admin-pol-kw"
                  type="text"
                  required
                  value={newPolicy.keywords}
                  onChange={(e) => {
                    setNewPolicy({ ...newPolicy, keywords: e.target.value });
                    clearPolicyError('keywords');
                  }}
                  aria-invalid={Boolean(policyErrors.keywords)}
                  aria-describedby={policyErrors.keywords ? 'admin-pol-kw-err' : undefined}
                  placeholder="guaranteed yield, instant 10x token"
                  className={`w-full px-3 py-2 text-xs rounded-lg border ${fieldBorderClass(Boolean(policyErrors.keywords))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="admin-pol-kw-err" message={policyErrors.keywords} />
              </div>
              <div className="md:col-span-2">
                <label htmlFor="admin-pol-sev" className="block text-xs font-medium mb-1">Action</label>
                <select
                  id="admin-pol-sev"
                  value={newPolicy.severity}
                  onChange={(e) => {
                    setNewPolicy({ ...newPolicy, severity: e.target.value as 'block' | 'review' });
                    clearPolicyError('severity');
                  }}
                  className={`w-full px-3 py-2 text-xs rounded-lg border ${fieldBorderClass(Boolean(policyErrors.severity))} bg-white dark:bg-slate-950`}
                >
                  <option value="block">Auto-Block</option>
                  <option value="review">Flag for Review</option>
                </select>
                <FieldError id="admin-pol-sev-err" message={policyErrors.severity} />
              </div>
              <div className="md:col-span-1 md:pt-5">
                <button
                  type="submit"
                  className="w-full py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg"
                >
                  Add
                </button>
              </div>
            </form>
            <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
              {(moderation.prohibitedCategories || []).map((cat) => (
                <div key={cat.id} className="px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 dark:text-white">
                      {cat.name}{' '}
                      <span className="font-mono text-[10px] uppercase ml-1 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                        {cat.severity}
                      </span>
                    </div>
                    <div className="text-slate-500 mt-0.5 font-mono text-[11px] break-words">{cat.keywords.join(', ')}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeletePolicyRule(cat.id)}
                    className="px-2.5 py-1 text-xs text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900 rounded-md hover:bg-red-50 dark:hover:bg-red-950/40 shrink-0"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Moderation Audit Records
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 whitespace-nowrap">
                  <tr>
                    <th className="py-2.5 px-3 sm:px-4">Target</th>
                    <th className="py-2.5 px-3 sm:px-4">Decision</th>
                    <th className="py-2.5 px-3 sm:px-4">Reason</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Reviewed At</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {moderation.reviews.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2.5 px-3 sm:px-4 font-mono whitespace-nowrap">{r.target_type} · {r.target_id}</td>
                      <td className="py-2.5 px-3 sm:px-4 capitalize font-medium whitespace-nowrap">{r.decision}</td>
                      <td className="py-2.5 px-3 sm:px-4 text-slate-600 dark:text-slate-300 min-w-[180px]">{r.reason}</td>
                      <td className="py-2.5 px-3 sm:px-4 text-right font-mono text-slate-500 whitespace-nowrap">{r.created_at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        );
      })()}

      {/* TAB: ADVERTISERS */}
      {tab === 'advertisers' && (
        <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
          <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
            Advertiser Accounts & Verification
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 whitespace-nowrap">
                <tr>
                  <th className="py-2.5 px-3 sm:px-4">Company & Contact</th>
                  <th className="py-2.5 px-3 sm:px-4">Verification</th>
                  <th className="py-2.5 px-3 sm:px-4 text-right">Wallet Balance</th>
                  <th className="py-2.5 px-3 sm:px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 whitespace-nowrap">
                {advertisers.map((a) => (
                  <tr key={a.id}>
                    <td className="py-3 px-3 sm:px-4">
                      <div className="font-medium text-slate-900 dark:text-white">{a.company_name}</div>
                      <div className="text-slate-500">{a.full_name} · {a.email}</div>
                    </td>
                    <td className="py-3 px-3 sm:px-4 capitalize">
                      {a.verification_status} · {a.account_status}
                    </td>
                    <td className="py-3 px-3 sm:px-4 text-right font-mono tabular-nums">
                      {formatMicros(a.available_micros)}
                    </td>
                    <td className="py-3 px-3 sm:px-4 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleAdvertiserAction(a.id, 'verified', 'active')}
                          className="px-2.5 py-1 border border-slate-300 dark:border-slate-700 rounded-md"
                        >
                          Verify & Activate
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAdvertiserAction(a.id, a.verification_status, a.account_status === 'active' ? 'suspended' : 'active')}
                          className="px-2.5 py-1 border border-slate-300 dark:border-slate-700 rounded-md"
                        >
                          {a.account_status === 'active' ? 'Suspend' : 'Unsuspend'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB: PUBLISHERS & PROPERTIES */}
      {tab === 'publishers' && (
        <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
          <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
            Publisher Accounts & Properties
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 whitespace-nowrap">
                <tr>
                  <th className="py-2.5 px-3 sm:px-4">Publisher</th>
                  <th className="py-2.5 px-3 sm:px-4">Quality Score</th>
                  <th className="py-2.5 px-3 sm:px-4">Status</th>
                  <th className="py-2.5 px-3 sm:px-4 text-right">Available Balance</th>
                  <th className="py-2.5 px-3 sm:px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 whitespace-nowrap">
                {publishers.map((p) => (
                  <tr key={p.id}>
                    <td className="py-3 px-3 sm:px-4">
                      <div className="font-medium text-slate-900 dark:text-white">{p.organization_name}</div>
                      <div className="text-slate-500">{p.full_name} · {p.email}</div>
                    </td>
                    <td className="py-3 px-3 sm:px-4 font-mono tabular-nums">{p.traffic_quality_score}/100</td>
                    <td className="py-3 px-3 sm:px-4 capitalize">{p.approval_status}</td>
                    <td className="py-3 px-3 sm:px-4 text-right font-mono tabular-nums">{formatMicros(p.available_micros)}</td>
                    <td className="py-3 px-3 sm:px-4 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handlePublisherAction(p.id, 'approved')}
                          className="px-2.5 py-1 border border-slate-300 dark:border-slate-700 rounded-md"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => handlePublisherAction(p.id, 'suspended')}
                          className="px-2.5 py-1 border border-slate-300 dark:border-slate-700 rounded-md"
                        >
                          Suspend
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="px-4 sm:px-5 py-3 border-t border-b border-slate-200 dark:border-slate-800 text-xs font-semibold bg-slate-50 dark:bg-slate-950/40">
            Submitted Websites & Applications
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {properties.map((prop) => (
              <div key={prop.id} className="px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <span className="font-medium text-slate-900 dark:text-white">{prop.name}</span>
                  <span className="text-slate-500 ml-1.5 font-mono break-all">
                    ({prop.domain_or_bundle} · {prop.organization_name})
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <span className="capitalize text-slate-500">{prop.approval_status}</span>
                  <button
                    type="button"
                    onClick={() => handlePropertyAction(prop.id, 'approved')}
                    className="px-2.5 py-1 border border-slate-300 dark:border-slate-700 rounded-md"
                  >
                    Approve Property
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePropertyAction(prop.id, 'rejected')}
                    className="px-2.5 py-1 border border-slate-300 dark:border-slate-700 rounded-md"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB: TRAFFIC QUALITY & FRAUD */}
      {tab === 'fraud' && fraud && (
        <div className="space-y-6">
          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Traffic Quality & Invalid Traffic Investigation Queue
            </div>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {fraud.alerts.map((f) => (
                <div key={f.id} className="p-4 flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-mono text-slate-500">
                      {f.signal_type} · Severity: {f.severity} · Status: {f.status}
                    </div>
                    <div className="text-sm font-medium text-slate-900 dark:text-white mt-0.5">{f.description}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Publisher: {f.publisher_name || 'N/A'} · Campaign: {f.campaign_name || 'N/A'}
                    </div>
                  </div>
                  {f.status === 'open' && (
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleFraudAction(f.id, 'confirmed_ivt')}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-red-700 hover:bg-red-800 rounded-md"
                      >
                        Confirm IVT & Deduct
                      </button>
                      <button
                        type="button"
                        onClick={() => handleFraudAction(f.id, 'dismissed')}
                        className="px-3 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-md"
                      >
                        Dismiss Signal
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB: FINANCE */}
      {tab === 'finance' && finance && (
        <div className="space-y-6">
          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Publisher Payout Approvals
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 whitespace-nowrap">
                  <tr>
                    <th className="py-2.5 px-3 sm:px-4">Publisher</th>
                    <th className="py-2.5 px-3 sm:px-4">Destination</th>
                    <th className="py-2.5 px-3 sm:px-4">Status</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Amount</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Decision</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 whitespace-nowrap">
                  {finance.withdrawals.map((w) => (
                    <tr key={w.id}>
                      <td className="py-3 px-3 sm:px-4 font-medium">{w.organization_name}</td>
                      <td className="py-3 px-3 sm:px-4">{w.payout_method} · {w.payout_destination}</td>
                      <td className="py-3 px-3 sm:px-4 capitalize">{w.status}</td>
                      <td className="py-3 px-3 sm:px-4 text-right font-mono tabular-nums font-semibold">
                        {formatMicros(w.amount_micros)}
                      </td>
                      <td className="py-3 px-3 sm:px-4 text-right">
                        {w.status === 'pending' ? (
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleWithdrawalDecision(w.id, 'paid')}
                              className="px-2.5 py-1 text-white bg-emerald-700 rounded-md"
                            >
                              Approve & Pay
                            </button>
                            <button
                              type="button"
                              onClick={() => handleWithdrawalDecision(w.id, 'rejected')}
                              className="px-2.5 py-1 border border-slate-300 dark:border-slate-700 rounded-md"
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <span className="text-slate-400">Settled</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Prepaid Budget Reservations Ledger
            </div>
            <div className="overflow-x-auto max-h-72">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 whitespace-nowrap">
                  <tr>
                    <th className="py-2.5 px-3 sm:px-4">Request ID</th>
                    <th className="py-2.5 px-3 sm:px-4">Advertiser</th>
                    <th className="py-2.5 px-3 sm:px-4">Campaign</th>
                    <th className="py-2.5 px-3 sm:px-4">Status</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Reserved</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Captured</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Released</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 whitespace-nowrap">
                  {(!finance.reservations || finance.reservations.length === 0) ? (
                    <tr>
                      <td colSpan={7} className="py-4 px-3 sm:px-4 text-slate-500">
                        No active or historical budget reservations recorded yet.
                      </td>
                    </tr>
                  ) : (
                    finance.reservations.map((r) => (
                      <tr key={r.id}>
                        <td className="py-2.5 px-3 sm:px-4 font-mono">{r.request_id}</td>
                        <td className="py-2.5 px-3 sm:px-4">{r.company_name}</td>
                        <td className="py-2.5 px-3 sm:px-4">{r.campaign_name}</td>
                        <td className="py-2.5 px-3 sm:px-4 capitalize font-mono">{r.status}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right font-mono tabular-nums">{formatMicros(r.amount_micros)}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right font-mono tabular-nums">{formatMicros(r.captured_micros)}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right font-mono tabular-nums">{formatMicros(r.released_micros)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Platform Master Financial Ledger
            </div>
            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500">
                  <tr>
                    <th className="py-2.5 px-4">Account</th>
                    <th className="py-2.5 px-4">Type</th>
                    <th className="py-2.5 px-4">Description</th>
                    <th className="py-2.5 px-4 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {finance.ledger.map((l) => (
                    <tr key={l.id}>
                      <td className="py-2.5 px-4 font-mono">{l.account_type}</td>
                      <td className="py-2.5 px-4 font-mono">{l.entry_type}</td>
                      <td className="py-2.5 px-4">{l.description}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                        {l.direction === 'credit' ? '+' : '-'}{formatMicros(l.amount_micros)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB: SETTINGS */}
      {tab === 'settings' && settings && (
        <div className="space-y-6">
          <form
            onSubmit={handleSaveSettings}
            noValidate
            className="w-full border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-slate-900 space-y-4"
          >
            <h2 className="text-base font-semibold">Global Platform Configuration</h2>
            <div>
              <label htmlFor="admin-set-bps" className="block text-xs font-medium mb-1">Default Publisher Revenue Share (Basis Points, e.g. 7000 = 70%)</label>
              <input
                id="admin-set-bps"
                type="number"
                min="1000"
                max="9500"
                value={settings.default_publisher_share_bps ?? 7000}
                onChange={(e) => {
                  setSettings({ ...settings, default_publisher_share_bps: Number(e.target.value) });
                  clearSettingsError('default_publisher_share_bps');
                }}
                aria-invalid={Boolean(settingsErrors.default_publisher_share_bps)}
                aria-describedby={settingsErrors.default_publisher_share_bps ? 'admin-set-bps-err' : undefined}
                className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(settingsErrors.default_publisher_share_bps))} bg-white dark:bg-slate-950`}
              />
              <FieldError id="admin-set-bps-err" message={settingsErrors.default_publisher_share_bps} />
            </div>
            <div>
              <label htmlFor="admin-set-payout" className="block text-xs font-medium mb-1">Minimum Publisher Payout (USD Micros, 50000000 = $50)</label>
              <input
                id="admin-set-payout"
                type="number"
                min="1000000"
                step="1000000"
                value={settings.minimum_publisher_payout_micros ?? 50000000}
                onChange={(e) => {
                  setSettings({ ...settings, minimum_publisher_payout_micros: Number(e.target.value) });
                  clearSettingsError('minimum_publisher_payout_micros');
                }}
                aria-invalid={Boolean(settingsErrors.minimum_publisher_payout_micros)}
                aria-describedby={settingsErrors.minimum_publisher_payout_micros ? 'admin-set-payout-err' : undefined}
                className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(settingsErrors.minimum_publisher_payout_micros))} bg-white dark:bg-slate-950`}
              />
              <FieldError id="admin-set-payout-err" message={settingsErrors.minimum_publisher_payout_micros} />
            </div>
            <div>
              <label htmlFor="admin-set-budget" className="block text-xs font-medium mb-1">Minimum Campaign Budget (USD Micros)</label>
              <input
                id="admin-set-budget"
                type="number"
                min="1000000"
                step="1000000"
                value={settings.minimum_campaign_budget_micros ?? 25000000}
                onChange={(e) => {
                  setSettings({ ...settings, minimum_campaign_budget_micros: Number(e.target.value) });
                  clearSettingsError('minimum_campaign_budget_micros');
                }}
                aria-invalid={Boolean(settingsErrors.minimum_campaign_budget_micros)}
                aria-describedby={settingsErrors.minimum_campaign_budget_micros ? 'admin-set-budget-err' : undefined}
                className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(settingsErrors.minimum_campaign_budget_micros))} bg-white dark:bg-slate-950`}
              />
              <FieldError id="admin-set-budget-err" message={settingsErrors.minimum_campaign_budget_micros} />
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={Boolean(settings.gdpr_consent_enforcement)}
                onChange={(e) => setSettings({ ...settings, gdpr_consent_enforcement: e.target.checked })}
              />
              <span>Enforce GDPR / regional consent checks globally</span>
            </label>

            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
              <div className="text-xs font-semibold text-slate-900 dark:text-white">
                Launch & Expansion Feature Flags (ADR Controls)
              </div>
              <p className="text-[11px] text-slate-500">
                Looma operates as the exclusive first-party publisher at initial launch. Keep external third-party network flags disabled until the expansion phase.
              </p>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={settings.looma_first_party_only_mode !== false}
                  onChange={(e) => setSettings({ ...settings, looma_first_party_only_mode: e.target.checked })}
                />
                <span>Looma First-Party Exclusive Delivery Mode (Launch Default: On)</span>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={Boolean(settings.external_publisher_registration_enabled)}
                  onChange={(e) => setSettings({ ...settings, external_publisher_registration_enabled: e.target.checked })}
                />
                <span>Enable External Third-Party Publisher Self-Registration</span>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={Boolean(settings.third_party_sdk_distribution_enabled)}
                  onChange={(e) => setSettings({ ...settings, third_party_sdk_distribution_enabled: e.target.checked })}
                />
                <span>Enable Third-Party SDK Distribution & Ad Serving</span>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={Boolean(settings.third_party_revenue_allocation_enabled)}
                  onChange={(e) => setSettings({ ...settings, third_party_revenue_allocation_enabled: e.target.checked })}
                />
                <span>Enable Third-Party Publisher Revenue Allocation</span>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={Boolean(settings.third_party_publisher_payouts_enabled)}
                  onChange={(e) => setSettings({ ...settings, third_party_publisher_payouts_enabled: e.target.checked })}
                />
                <span>Enable Third-Party Publisher Payout Withdrawals</span>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={Boolean(settings.postpaid_advertiser_credit_enabled)}
                  onChange={(e) => setSettings({ ...settings, postpaid_advertiser_credit_enabled: e.target.checked })}
                />
                <span>Enable Postpaid Advertiser Credit Accounts (Disabled at Launch — Prepaid Only)</span>
              </label>
            </div>

            <button
              type="submit"
              className="w-full sm:w-auto px-5 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg"
            >
              Save Configuration
            </button>
          </form>

          <div className="w-full border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Scheduled Background Jobs & Maintenance</h2>
                <p className="text-xs text-slate-500">Run scheduled ledger, daily budget, reservation release, and token cleanup jobs on demand.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleRunJob('release_expired_reservations')}
                  className="px-3 py-1.5 text-xs font-medium text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-800 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-950/40"
                >
                  Release Expired Reservations
                </button>
                <button
                  type="button"
                  onClick={() => handleRunJob('daily_budget_reset')}
                  className="px-3 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Run Daily Budget Reset
                </button>
                <button
                  type="button"
                  onClick={() => handleRunJob('publisher_earnings_settlement')}
                  className="px-3 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Run Earnings Settlement
                </button>
                <button
                  type="button"
                  onClick={() => handleRunJob('expired_token_cleanup')}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-lg"
                >
                  Run Token & Rate-Limit Cleanup
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 whitespace-nowrap">
                  <tr>
                    <th className="py-2.5 px-3 sm:px-4">Job</th>
                    <th className="py-2.5 px-3 sm:px-4">Status</th>
                    <th className="py-2.5 px-3 sm:px-4">Summary</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Executed At</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {jobRuns.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-4 px-3 sm:px-4 text-slate-500">
                        No background jobs executed yet. Use the controls above to trigger a run.
                      </td>
                    </tr>
                  ) : (
                    jobRuns.map((run) => (
                      <tr key={run.id}>
                        <td className="py-2.5 px-3 sm:px-4 font-mono whitespace-nowrap">{run.job_name}</td>
                        <td className="py-2.5 px-3 sm:px-4 capitalize font-medium whitespace-nowrap">{run.status}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-slate-600 dark:text-slate-300 min-w-[200px]">{run.summary}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right font-mono text-slate-500 whitespace-nowrap">{run.ran_at}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
