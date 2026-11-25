import React, { useEffect, useState } from 'react';
import { Pause, Play, Copy, Archive, Download, Wallet, Upload, Flag } from 'lucide-react';
import { apiRequest, formatMicros, formatNumber, formatPct, getAuthToken } from '../lib/api';
import {
  AdvertiserDailyPoint,
  AdvertiserPerformanceTrendChart,
  CampaignComparisonChart,
} from './AdvertiserPerformanceCharts';

interface AdvertiserOverview {
  account: {
    id: string;
    company_name: string;
    verification_status: string;
    account_status: string;
    currency: string;
  };
  wallet: {
    id: string;
    available_micros: number;
    reserved_micros: number;
    lifetime_deposited_micros: number;
    lifetime_spent_micros: number;
  };
  kpis: {
    impressions: number;
    clicks: number;
    conversions: number;
    total_spend_micros: number;
    ctr: number;
    conversionRate?: number;
    avgCpcMicros: number;
  };
  performanceSeries: AdvertiserDailyPoint[];
  notifications: Array<{
    id: string;
    title: string;
    message: string;
    created_at: string;
  }>;
}

interface CampaignRow {
  id: string;
  name: string;
  objective: string;
  pricing_model: string;
  bidding_strategy: string;
  status: string;
  moderation_status: string;
  start_date: string;
  end_date: string;
  daily_budget_micros: number;
  total_budget_micros: number;
  spent_today_micros: number;
  spent_total_micros: number;
  max_bid_micros: number;
  pacing_mode: string;
  ad_format: string;
  creative_title: string;
  creative_description: string;
  media_url: string;
  destination_url: string;
  cta_text: string;
  creative_approval_status: string;
  impressions: number;
  clicks: number;
  conversions: number;
  countries_json?: string;
  languages_json?: string;
  device_categories_json?: string;
  operating_systems_json?: string;
  browsers_json?: string;
  interest_categories_json?: string;
  contextual_categories_json?: string;
  retargeting_enabled?: number;
  consent_required?: number;
}

export type AdvTab =
  | 'overview'
  | 'campaigns'
  | 'studio'
  | 'targeting'
  | 'bidding'
  | 'reporting'
  | 'billing'
  | 'activity';

interface AdvertiserWorkspaceProps {
  activeTab?: AdvTab;
  onTabChange?: (tab: AdvTab) => void;
}

export const AdvertiserWorkspace: React.FC<AdvertiserWorkspaceProps> = ({ activeTab, onTabChange }) => {
  const [internalTab, setInternalTab] = useState<AdvTab>('overview');
  const tab = activeTab ?? internalTab;
  const setTab = (next: AdvTab) => {
    setInternalTab(next);
    onTabChange?.(next);
  };
  const [overview, setOverview] = useState<AdvertiserOverview | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [reporting, setReporting] = useState<{
    dailySeries: AdvertiserDailyPoint[];
    byGeo: Array<{ country: string; impressions: number; clicks: number; spend_micros: number }>;
    byDevice: Array<{ device_category: string; impressions: number; clicks: number; spend_micros: number }>;
    byCampaign: Array<{ id: string; name: string; pricing_model: string; status: string; impressions: number; clicks: number; conversions: number; spend_micros: number }>;
  } | null>(null);
  const [reportDays, setReportDays] = useState(30);
  const [reportCampaignId, setReportCampaignId] = useState('all');
  const [billing, setBilling] = useState<{
    wallet: AdvertiserOverview['wallet'];
    deposits: Array<{ id: string; provider: string; provider_ref: string; amount_micros: number; status: string; created_at: string }>;
    invoices: Array<{ id: string; invoice_number: string; amount_micros: number; status: string; issued_at: string }>;
    ledger: Array<{ id: string; entry_type: string; direction: string; amount_micros: number; balance_after_micros: number; description: string; created_at: string }>;
    reservations?: Array<{
      id: string;
      campaign_id: string;
      campaign_name: string;
      request_id: string;
      amount_micros: number;
      captured_micros: number;
      released_micros: number;
      status: string;
      expires_at: string;
      created_at: string;
    }>;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [uploadedAssets, setUploadedAssets] = useState<Array<{ id: string; original_name: string; mime_type: string; url: string }>>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [appeals, setAppeals] = useState<Array<{ id: string; campaign_id: string; campaign_name: string; reason: string; status: string; admin_response: string | null; created_at: string }>>([]);
  const [appealTarget, setAppealTarget] = useState<{ id: string; name: string } | null>(null);
  const [appealReason, setAppealReason] = useState('');
  const [liveCheckoutUrl, setLiveCheckoutUrl] = useState<string | null>(null);

  // Campaign + Creative + Targeting Builder state
  const [form, setForm] = useState({
    name: '',
    objective: 'website_traffic',
    pricingModel: 'CPC',
    biddingStrategy: 'manual',
    dailyBudgetUsd: 100,
    totalBudgetUsd: 1000,
    maxBidUsd: 1.35,
    pacingMode: 'standard',
    format: 'native',
    title: '',
    description: '',
    mediaUrl: '/src/assets/images/creative_fintech_card_1795552815861.jpg',
    destinationUrl: 'https://atlascommerce.io/offer',
    ctaText: 'Explore Offer',
    trackingParams: 'utm_source=looma&utm_medium=native',
    countries: 'US,GB,DE,NG,ALL',
    deviceCategories: 'desktop,mobile',
    contextualCategories: 'business_finance,news_technology,ALL',
    consentRequired: true,
  });

  // Deposit & Refund state
  const [depositAmount, setDepositAmount] = useState('250');
  const [depositProvider, setDepositProvider] = useState('paystack');
  const [refundAmount, setRefundAmount] = useState('25');

  // Standalone Targeting & Budget Editor state
  const [selectedCampaignId, setSelectedCampaignId] = useState('');
  const [targetEdit, setTargetEdit] = useState({
    countries: 'US,GB,DE,NG,ALL',
    languages: 'en',
    deviceCategories: 'desktop,mobile',
    operatingSystems: 'ALL',
    browsers: 'ALL',
    contextualCategories: 'business_finance,news_technology,ALL',
    interestCategories: '',
    retargetingEnabled: false,
    consentRequired: true,
  });
  const [budgetEdit, setBudgetEdit] = useState({
    biddingStrategy: 'manual',
    maxBidUsd: 1.35,
    dailyBudgetUsd: 100,
    totalBudgetUsd: 1000,
    pacingMode: 'standard',
    startDate: '2026-01-01',
    endDate: '2027-12-31',
  });

  function syncCampaignEditors(cmpRow: CampaignRow) {
    const parseArr = (raw?: string, fallback = '') => {
      if (!raw) return fallback;
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.join(', ') : fallback;
      } catch {
        return fallback;
      }
    };
    setTargetEdit({
      countries: parseArr(cmpRow.countries_json, 'ALL'),
      languages: parseArr(cmpRow.languages_json, 'en'),
      deviceCategories: parseArr(cmpRow.device_categories_json, 'desktop, mobile'),
      operatingSystems: parseArr(cmpRow.operating_systems_json, 'ALL'),
      browsers: parseArr(cmpRow.browsers_json, 'ALL'),
      contextualCategories: parseArr(cmpRow.contextual_categories_json, 'ALL'),
      interestCategories: parseArr(cmpRow.interest_categories_json, ''),
      retargetingEnabled: Boolean(cmpRow.retargeting_enabled),
      consentRequired: cmpRow.consent_required !== 0,
    });
    setBudgetEdit({
      biddingStrategy: cmpRow.bidding_strategy || 'manual',
      maxBidUsd: Number((cmpRow.max_bid_micros / 1_000_000).toFixed(2)),
      dailyBudgetUsd: Number((cmpRow.daily_budget_micros / 1_000_000).toFixed(2)),
      totalBudgetUsd: Number((cmpRow.total_budget_micros / 1_000_000).toFixed(2)),
      pacingMode: cmpRow.pacing_mode || 'standard',
      startDate: cmpRow.start_date || '2026-01-01',
      endDate: cmpRow.end_date || '2027-12-31',
    });
  }

  async function loadAll(days = reportDays, campaignId = reportCampaignId) {
    setLoading(true);
    setError(null);
    try {
      const [ov, cmp, rep, bil, med, apl] = await Promise.all([
        apiRequest<AdvertiserOverview>('/api/advertiser/overview'),
        apiRequest<{ campaigns: CampaignRow[] }>('/api/advertiser/campaigns'),
        apiRequest<NonNullable<typeof reporting>>(
          `/api/advertiser/reporting?days=${days}&campaignId=${encodeURIComponent(campaignId)}`
        ),
        apiRequest<NonNullable<typeof billing>>('/api/advertiser/billing'),
        apiRequest<{ assets: Array<{ id: string; original_name: string; mime_type: string; url: string }> }>('/api/advertiser/media'),
        apiRequest<{ appeals: Array<{ id: string; campaign_id: string; campaign_name: string; reason: string; status: string; admin_response: string | null; created_at: string }> }>('/api/advertiser/appeals'),
      ]);
      setOverview(ov);
      setCampaigns(cmp.campaigns);
      setReporting(rep);
      setBilling(bil);
      setUploadedAssets(med.assets || []);
      setAppeals(apl.appeals || []);
      if (cmp.campaigns.length > 0) {
        const current = cmp.campaigns.find((c) => c.id === selectedCampaignId) ?? cmp.campaigns[0];
        if (!selectedCampaignId) {
          setSelectedCampaignId(current.id);
        }
        syncCampaignEditors(current);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load advertiser workspace');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function handleCreateCampaign(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setActionMsg(null);
    try {
      const res = await apiRequest<{ campaignId: string }>('/api/advertiser/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          countries: form.countries.split(',').map((s) => s.trim()).filter(Boolean),
          deviceCategories: form.deviceCategories.split(',').map((s) => s.trim()).filter(Boolean),
          contextualCategories: form.contextualCategories.split(',').map((s) => s.trim()).filter(Boolean),
        }),
      });
      setActionMsg(`Campaign ${res.campaignId} created and submitted to moderation queue.`);
      setForm({ ...form, name: '', title: '', description: '' });
      setTab('campaigns');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create campaign');
    }
  }

  async function handleCampaignStatus(id: string, status: 'active' | 'paused' | 'archived') {
    setError(null);
    setActionMsg(null);
    try {
      await apiRequest(`/api/advertiser/campaigns/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setActionMsg(`Campaign ${id} updated to ${status}.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update campaign');
    }
  }

  async function handleDuplicate(id: string) {
    setError(null);
    try {
      const res = await apiRequest<{ campaignId: string }>(`/api/advertiser/campaigns/${id}/duplicate`, {
        method: 'POST',
      });
      setActionMsg(`Duplicated into ${res.campaignId} (pending review).`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to duplicate campaign');
    }
  }

  async function handleMediaUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setActionMsg(null);
    setUploadingMedia(true);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Unable to read selected file'));
        reader.readAsDataURL(file);
      });
      const res = await apiRequest<{ assetId: string; url: string; originalName: string; mimeType: string }>(
        '/api/advertiser/media',
        {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            mimeType: file.type,
            dataBase64,
          }),
        }
      );
      setForm((prev) => ({
        ...prev,
        mediaUrl: res.url,
        format: res.mimeType.startsWith('video/') ? 'video' : prev.format,
      }));
      setActionMsg(`Uploaded ${res.originalName} and linked to creative preview.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Media upload failed');
    } finally {
      setUploadingMedia(false);
      e.target.value = '';
    }
  }

  async function handleSubmitAppeal(e: React.FormEvent) {
    e.preventDefault();
    if (!appealTarget) return;
    setError(null);
    setActionMsg(null);
    try {
      await apiRequest(`/api/advertiser/campaigns/${appealTarget.id}/appeal`, {
        method: 'POST',
        body: JSON.stringify({ reason: appealReason }),
      });
      setActionMsg(`Policy appeal submitted for ${appealTarget.name}.`);
      setAppealTarget(null);
      setAppealReason('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to submit appeal');
    }
  }

  async function handleDeposit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setActionMsg(null);
    setLiveCheckoutUrl(null);
    try {
      const res = await apiRequest<{
        depositId: string;
        mode?: 'live' | 'sandbox';
        providerRef?: string;
        invoiceNumber?: string;
        checkoutUrl?: string | null;
      }>('/api/advertiser/deposit', {
        method: 'POST',
        body: JSON.stringify({
          amountUsd: Number(depositAmount),
          provider: depositProvider,
        }),
      });
      if (res.mode === 'live') {
        setLiveCheckoutUrl(res.checkoutUrl || null);
        setActionMsg(
          `Initialized live ${depositProvider} checkout (${res.providerRef}). Complete payment to credit your wallet via verified webhook.`
        );
      } else {
        setActionMsg(
          `Deposited $${Number(depositAmount).toFixed(2)} via ${depositProvider} (Sandbox). Invoice ${res.invoiceNumber || res.depositId} issued.`
        );
      }
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deposit failed');
    }
  }

  async function handleRefund(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setActionMsg(null);
    try {
      const res = await apiRequest<{ refundId: string }>('/api/advertiser/refund', {
        method: 'POST',
        body: JSON.stringify({ amountUsd: Number(refundAmount) }),
      });
      setActionMsg(`Refund ${res.refundId} processed and recorded in financial ledger.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refund failed');
    }
  }

  async function handleDownloadCsv() {
    try {
      const token = getAuthToken();
      const res = await fetch('/api/advertiser/reporting/csv', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        throw new Error(`CSV export failed (${res.status})`);
      }
      const csvType = res.headers.get('content-type') || '';
      const csvText = await res.text();
      if (csvType.includes('text/html') || csvText.trimStart().toLowerCase().startsWith('<!doctype')) {
        throw new Error('Unexpected HTML response when exporting CSV');
      }
      const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'looma-campaign-report.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CSV export failed');
    }
  }

  async function handleSaveTargeting(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCampaignId) return;
    setError(null);
    setActionMsg(null);
    try {
      const splitList = (val: string) =>
        val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

      await apiRequest(`/api/advertiser/campaigns/${selectedCampaignId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          targeting: {
            countries: splitList(targetEdit.countries),
            languages: splitList(targetEdit.languages),
            deviceCategories: splitList(targetEdit.deviceCategories),
            operatingSystems: splitList(targetEdit.operatingSystems),
            browsers: splitList(targetEdit.browsers),
            contextualCategories: splitList(targetEdit.contextualCategories),
            interestCategories: splitList(targetEdit.interestCategories),
            retargetingEnabled: targetEdit.retargetingEnabled,
            consentRequired: targetEdit.consentRequired,
          },
        }),
      });
      setActionMsg(`Audience targeting updated for campaign ${selectedCampaignId}.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update audience targeting');
    }
  }

  async function handleSaveBudgetBidding(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCampaignId) return;
    setError(null);
    setActionMsg(null);
    try {
      await apiRequest(`/api/advertiser/campaigns/${selectedCampaignId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          biddingStrategy: budgetEdit.biddingStrategy,
          maxBidUsd: Number(budgetEdit.maxBidUsd),
          dailyBudgetUsd: Number(budgetEdit.dailyBudgetUsd),
          totalBudgetUsd: Number(budgetEdit.totalBudgetUsd),
          pacingMode: budgetEdit.pacingMode,
          startDate: budgetEdit.startDate,
          endDate: budgetEdit.endDate,
        }),
      });
      setActionMsg(`Budget & bidding rules saved for campaign ${selectedCampaignId}.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update budget & bidding');
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
      {/* Workspace Header & Sub-navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="min-w-0">
          <div className="text-xs text-slate-500 dark:text-slate-400 break-words">
            Advertiser Workspace · {overview?.account.company_name} · Verification: {overview?.account.verification_status}
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-bold text-slate-900 dark:text-white mt-0.5">
            Campaigns, Delivery & Prepaid Billing
          </h1>
        </div>
        <div className="sm:text-right shrink-0">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">Available Prepaid Wallet</div>
          <div className="font-mono tabular-nums text-base font-semibold text-slate-900 dark:text-white">
            {formatMicros(overview?.wallet.available_micros)}
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {actionMsg && (
        <div className="p-3.5 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-sm text-emerald-800 dark:text-emerald-200">
          {actionMsg}
        </div>
      )}

      {/* TAB: OVERVIEW */}
      {tab === 'overview' && overview && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
            <div className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">Total Ad Spend</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold text-slate-900 dark:text-white truncate">
                {formatMicros(overview.kpis.total_spend_micros)}
              </div>
            </div>
            <div className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">Impressions</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold text-slate-900 dark:text-white truncate">
                {formatNumber(overview.kpis.impressions)}
              </div>
            </div>
            <div className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">Valid Clicks</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold text-slate-900 dark:text-white truncate">
                {formatNumber(overview.kpis.clicks)}
              </div>
            </div>
            <div className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">CTR</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold text-slate-900 dark:text-white truncate">
                {formatPct(overview.kpis.ctr)}
              </div>
            </div>
            <div className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">Conversions</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold text-slate-900 dark:text-white truncate">
                {formatNumber(overview.kpis.conversions)}
              </div>
            </div>
            <div className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">Avg CPC</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold text-slate-900 dark:text-white truncate">
                {formatMicros(overview.kpis.avgCpcMicros)}
              </div>
            </div>
          </div>

          <div className="grid lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 min-w-0">
              <AdvertiserPerformanceTrendChart
                title="Campaign Performance Over Time"
                subtitle="Daily verified impressions, valid clicks, CTR, conversion rates, and billed spend"
                data={overview.performanceSeries}
              />
            </div>

            <div className="min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 bg-white dark:bg-slate-900">
              <h3 className="text-base font-semibold text-slate-900 dark:text-white mb-4">Recent Activity</h3>
              {overview.notifications.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">No recent account notifications.</p>
              ) : (
                <div className="space-y-4">
                  {overview.notifications.map((n) => (
                    <div key={n.id} className="pb-3 border-b border-slate-100 dark:border-slate-800 last:border-b-0 last:pb-0">
                      <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">{n.title}</div>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">{n.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB: CAMPAIGNS */}
      {tab === 'campaigns' && (
        <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
          <div className="px-4 sm:px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">Campaign Inventory</h2>
            <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
              {campaigns.length} campaigns
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 dark:bg-slate-950/60 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 whitespace-nowrap">
                <tr>
                  <th className="py-3 px-3 sm:px-4 font-medium">Campaign & Format</th>
                  <th className="py-3 px-3 sm:px-4 font-medium">Status</th>
                  <th className="py-3 px-3 sm:px-4 font-medium">Model / Bid</th>
                  <th className="py-3 px-3 sm:px-4 font-medium text-right">Daily / Total Budget</th>
                  <th className="py-3 px-3 sm:px-4 font-medium text-right">Impr.</th>
                  <th className="py-3 px-3 sm:px-4 font-medium text-right">Clicks</th>
                  <th className="py-3 px-3 sm:px-4 font-medium text-right">Spent</th>
                  <th className="py-3 px-3 sm:px-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {campaigns.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40">
                    <td className="py-3.5 px-4">
                      <div className="font-medium text-slate-900 dark:text-white">{c.name}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        {c.ad_format} · {c.objective.replace('_', ' ')} · {c.start_date} to {c.end_date}
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="text-xs font-medium text-slate-900 dark:text-slate-100 capitalize">
                        {c.status.replace('_', ' ')}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        Moderation: {c.moderation_status}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 font-mono tabular-nums text-xs">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{c.pricing_model}</div>
                      <div className="text-slate-500 dark:text-slate-400">{formatMicros(c.max_bid_micros)}</div>
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs">
                      <div>{formatMicros(c.daily_budget_micros)} / day</div>
                      <div className="text-slate-500 dark:text-slate-400">{formatMicros(c.total_budget_micros)} cap</div>
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs">
                      {formatNumber(c.impressions)}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs">
                      {formatNumber(c.clicks)}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs font-medium">
                      {formatMicros(c.spent_total_micros)}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <div className="inline-flex items-center gap-1">
                        {c.status === 'active' && (
                          <button
                            type="button"
                            onClick={() => handleCampaignStatus(c.id, 'paused')}
                            title={`Pause ${c.name}`}
                            aria-label={`Pause ${c.name}`}
                            className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <Pause className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {c.status === 'paused' && (
                          <button
                            type="button"
                            onClick={() => handleCampaignStatus(c.id, 'active')}
                            title={`Resume ${c.name}`}
                            aria-label={`Resume ${c.name}`}
                            className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <Play className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDuplicate(c.id)}
                          title={`Duplicate ${c.name}`}
                          aria-label={`Duplicate ${c.name}`}
                          className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        {(c.status === 'rejected' || c.status === 'suspended' || c.moderation_status === 'rejected' || c.moderation_status === 'suspended') && (
                          <button
                            type="button"
                            onClick={() => {
                              setAppealTarget({ id: c.id, name: c.name });
                              setAppealReason('');
                            }}
                            title={`Appeal decision for ${c.name}`}
                            aria-label={`Appeal ${c.name}`}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40"
                          >
                            <Flag className="w-3 h-3" />
                            <span>Appeal</span>
                          </button>
                        )}
                        {c.status !== 'archived' && (
                          <button
                            type="button"
                            onClick={() => handleCampaignStatus(c.id, 'archived')}
                            title={`Archive ${c.name}`}
                            aria-label={`Archive ${c.name}`}
                            className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <Archive className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {appealTarget && (
            <form
              onSubmit={handleSubmitAppeal}
              className="p-5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-slate-900 dark:text-white">
                  Submit Policy Appeal — {appealTarget.name}
                </div>
                <button
                  type="button"
                  onClick={() => setAppealTarget(null)}
                  className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                >
                  Cancel
                </button>
              </div>
              <textarea
                rows={3}
                required
                minLength={10}
                value={appealReason}
                onChange={(e) => setAppealReason(e.target.value)}
                placeholder="Explain creative adjustments, regulatory licenses, or landing page compliance details for moderation review."
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <button
                type="submit"
                className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg"
              >
                Submit Appeal to Moderation
              </button>
            </form>
          )}

          {appeals.length > 0 && (
            <div className="border-t border-slate-200 dark:border-slate-800">
              <div className="px-5 py-3 bg-slate-50 dark:bg-slate-950/50 text-xs font-semibold text-slate-700 dark:text-slate-300">
                Submitted Policy Appeals
              </div>
              <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {appeals.map((ap) => (
                  <div key={ap.id} className="px-5 py-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="font-medium text-slate-900 dark:text-white">{ap.campaign_name}</div>
                      <div className="text-slate-600 dark:text-slate-300 mt-0.5">{ap.reason}</div>
                      {ap.admin_response && (
                        <div className="text-[11px] text-slate-500 mt-0.5">Reviewer note: {ap.admin_response}</div>
                      )}
                    </div>
                    <span className="font-mono uppercase text-[11px] px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                      {ap.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB: AD CREATION STUDIO */}
      {tab === 'studio' && (
        <div className="grid lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleCreateCampaign}
            className="lg:col-span-7 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-slate-900 space-y-5"
          >
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              Create Campaign, Targeting & Ad Creative
            </h2>

            <div className="grid sm:grid-cols-2 gap-4">
              <div className="min-w-0">
                <label htmlFor="cmp-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Campaign Name
                </label>
                <input
                  id="cmp-name"
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Q4 Enterprise Cloud Launch"
                  className="w-full min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div className="min-w-0">
                <label htmlFor="cmp-obj" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Advertising Objective
                </label>
                <select
                  id="cmp-obj"
                  value={form.objective}
                  onChange={(e) => setForm({ ...form, objective: e.target.value })}
                  className="w-full min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="brand_awareness">Brand Awareness</option>
                  <option value="website_traffic">Website Traffic</option>
                  <option value="lead_generation">Lead Generation</option>
                  <option value="sales_conversions">Sales & Conversions</option>
                  <option value="app_installs">App Installations</option>
                  <option value="video_views">Video Views</option>
                  <option value="product_promotion">Product Promotion</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label htmlFor="cmp-model" className="block text-xs font-medium mb-1">Pricing Model</label>
                <select
                  id="cmp-model"
                  value={form.pricingModel}
                  onChange={(e) => setForm({ ...form, pricingModel: e.target.value })}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="CPC">CPC</option>
                  <option value="CPM">CPM</option>
                  <option value="CPA">CPA</option>
                  <option value="CPI">CPI</option>
                  <option value="CPV">CPV</option>
                  <option value="FIXED">FIXED</option>
                </select>
              </div>
              <div>
                <label htmlFor="cmp-bid" className="block text-xs font-medium mb-1">Max Bid (USD)</label>
                <input
                  id="cmp-bid"
                  type="number"
                  step="0.05"
                  min="0.1"
                  required
                  value={form.maxBidUsd}
                  onChange={(e) => setForm({ ...form, maxBidUsd: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="cmp-daily" className="block text-xs font-medium mb-1">Daily Budget ($)</label>
                <input
                  id="cmp-daily"
                  type="number"
                  min="5"
                  required
                  value={form.dailyBudgetUsd}
                  onChange={(e) => setForm({ ...form, dailyBudgetUsd: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="cmp-total" className="block text-xs font-medium mb-1">Total Budget ($)</label>
                <input
                  id="cmp-total"
                  type="number"
                  min="25"
                  required
                  value={form.totalBudgetUsd}
                  onChange={(e) => setForm({ ...form, totalBudgetUsd: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
              <div className="text-xs font-semibold text-slate-900 dark:text-white">Creative Details</div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="min-w-0">
                  <label htmlFor="crt-format" className="block text-xs font-medium mb-1">Ad Format</label>
                  <select
                    id="crt-format"
                    value={form.format}
                    onChange={(e) => setForm({ ...form, format: e.target.value })}
                    className="w-full min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="native">Native Ad</option>
                    <option value="banner">Banner Ad</option>
                    <option value="image">Image Ad</option>
                    <option value="responsive">Responsive Ad</option>
                    <option value="text">Text Ad</option>
                    <option value="video">Video Ad</option>
                    <option value="sponsored">Sponsored Content</option>
                  </select>
                </div>
                <div className="min-w-0">
                  <label htmlFor="crt-media" className="block text-xs font-medium mb-1">Media Asset Library</label>
                  <select
                    id="crt-media"
                    value={form.mediaUrl}
                    onChange={(e) => setForm({ ...form, mediaUrl: e.target.value })}
                    className="w-full min-w-0 max-w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="/src/assets/images/creative_fintech_card_1795552815861.jpg">Corporate Card Asset</option>
                    <option value="/src/assets/images/creative_cloud_hardware_1795552815294.jpg">Workstation Asset</option>
                    <option value="/src/assets/images/creative_retail_sneaker_1795552816794.jpg">Retail Footwear Asset</option>
                    {uploadedAssets.map((asset) => (
                      <option key={asset.id} value={asset.url}>
                        Uploaded: {asset.original_name}
                      </option>
                    ))}
                    <option value="">Text-Only (No Media)</option>
                  </select>
                </div>
              </div>

              <div className="p-3.5 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0 text-xs text-slate-600 dark:text-slate-300">
                  <div className="font-medium text-slate-900 dark:text-white">Upload Custom Creative Media</div>
                  <div className="text-[11px] text-slate-500">JPEG, PNG, WEBP, MP4, or WEBM up to 10 MB (validated on upload)</div>
                </div>
                <label className="inline-flex items-center justify-center gap-1.5 px-3 py-2 sm:py-1.5 text-xs font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-lg cursor-pointer hover:opacity-90 shrink-0 w-full sm:w-auto">
                  <Upload className="w-3.5 h-3.5" />
                  <span>{uploadingMedia ? 'Uploading…' : 'Choose File'}</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"
                    onChange={handleMediaUpload}
                    disabled={uploadingMedia}
                    className="hidden"
                  />
                </label>
              </div>

              <div>
                <label htmlFor="crt-title" className="block text-xs font-medium mb-1">Advertisement Headline</label>
                <input
                  id="crt-title"
                  type="text"
                  required
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Automate Multi-Currency Treasury Operations"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="crt-desc" className="block text-xs font-medium mb-1">Description</label>
                <textarea
                  id="crt-desc"
                  rows={2}
                  required
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Issue corporate cards with deterministic spend caps and real-time ledger reconciliation."
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="crt-url" className="block text-xs font-medium mb-1">Destination URL</label>
                  <input
                    id="crt-url"
                    type="url"
                    required
                    value={form.destinationUrl}
                    onChange={(e) => setForm({ ...form, destinationUrl: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="crt-cta" className="block text-xs font-medium mb-1">Call to Action</label>
                  <input
                    id="crt-cta"
                    type="text"
                    required
                    value={form.ctaText}
                    onChange={(e) => setForm({ ...form, ctaText: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
              <div className="text-xs font-semibold text-slate-900 dark:text-white">Audience Targeting (Privacy-Safe)</div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="tgt-countries" className="block text-xs font-medium mb-1">Countries (comma-separated)</label>
                  <input
                    id="tgt-countries"
                    type="text"
                    value={form.countries}
                    onChange={(e) => setForm({ ...form, countries: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="tgt-devices" className="block text-xs font-medium mb-1">Devices</label>
                  <input
                    id="tgt-devices"
                    type="text"
                    value={form.deviceCategories}
                    onChange={(e) => setForm({ ...form, deviceCategories: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={form.consentRequired}
                  onChange={(e) => setForm({ ...form, consentRequired: e.target.checked })}
                />
                <span>Require verified GDPR / regional consent before ad eligibility</span>
              </label>
            </div>

            <button
              type="submit"
              className="w-full sm:w-auto px-5 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors"
            >
              Submit Campaign for Review
            </button>
          </form>

          {/* Live Creative Preview */}
          <div className="lg:col-span-5 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-slate-900">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-3">
              Live Placement Preview · {form.format} · {form.pricingModel}
            </div>
            <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-slate-50 dark:bg-slate-950">
              {form.mediaUrl && (
                <div className="aspect-[16/10] bg-slate-200 dark:bg-slate-800">
                  {/\.(mp4|webm)$/i.test(form.mediaUrl) ? (
                    <video
                      src={form.mediaUrl}
                      controls
                      muted
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <img
                      src={form.mediaUrl}
                      alt={form.title || 'Ad creative preview'}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                  )}
                </div>
              )}
              <div className="p-4">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">Sponsored · Looma Advertising</div>
                <div className="mt-1 text-base font-semibold text-slate-900 dark:text-white break-words">
                  {form.title || 'Your Advertisement Headline'}
                </div>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 leading-relaxed break-words">
                  {form.description || 'Concise description explaining your product value and offer.'}
                </p>
                <div className="mt-3 flex items-center justify-between gap-2 min-w-0">
                  <span className="text-[11px] font-mono text-slate-400 truncate min-w-0 flex-1">{form.destinationUrl}</span>
                  <span className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-md whitespace-nowrap shrink-0">
                    {form.ctaText || 'Learn More'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB: AUDIENCE TARGETING */}
      {tab === 'targeting' && (
        <div className="grid lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleSaveTargeting}
            className="lg:col-span-7 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-slate-900 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-white">Audience Targeting Rules</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Configure geographic, language, device, browser, and contextual rules without invasive fingerprinting.
                </p>
              </div>
            </div>

            <div>
              <label htmlFor="tgt-camp-select" className="block text-xs font-medium mb-1">
                Select Campaign
              </label>
              <select
                id="tgt-camp-select"
                value={selectedCampaignId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedCampaignId(id);
                  const found = campaigns.find((c) => c.id === id);
                  if (found) syncCampaignEditors(found);
                }}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.pricing_model} · {c.status})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="tgt-edit-countries" className="block text-xs font-medium mb-1">
                  Countries (ISO codes or ALL)
                </label>
                <input
                  id="tgt-edit-countries"
                  type="text"
                  value={targetEdit.countries}
                  onChange={(e) => setTargetEdit({ ...targetEdit, countries: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="tgt-edit-langs" className="block text-xs font-medium mb-1">
                  Languages (comma-separated)
                </label>
                <input
                  id="tgt-edit-langs"
                  type="text"
                  value={targetEdit.languages}
                  onChange={(e) => setTargetEdit({ ...targetEdit, languages: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="grid sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor="tgt-edit-devices" className="block text-xs font-medium mb-1">
                  Device Categories
                </label>
                <input
                  id="tgt-edit-devices"
                  type="text"
                  value={targetEdit.deviceCategories}
                  onChange={(e) => setTargetEdit({ ...targetEdit, deviceCategories: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="tgt-edit-os" className="block text-xs font-medium mb-1">
                  Operating Systems
                </label>
                <input
                  id="tgt-edit-os"
                  type="text"
                  value={targetEdit.operatingSystems}
                  onChange={(e) => setTargetEdit({ ...targetEdit, operatingSystems: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="tgt-edit-browsers" className="block text-xs font-medium mb-1">
                  Browsers
                </label>
                <input
                  id="tgt-edit-browsers"
                  type="text"
                  value={targetEdit.browsers}
                  onChange={(e) => setTargetEdit({ ...targetEdit, browsers: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="tgt-edit-ctx" className="block text-xs font-medium mb-1">
                  Contextual Website Categories
                </label>
                <input
                  id="tgt-edit-ctx"
                  type="text"
                  value={targetEdit.contextualCategories}
                  onChange={(e) => setTargetEdit({ ...targetEdit, contextualCategories: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="tgt-edit-int" className="block text-xs font-medium mb-1">
                  Interest Categories
                </label>
                <input
                  id="tgt-edit-int"
                  type="text"
                  value={targetEdit.interestCategories}
                  onChange={(e) => setTargetEdit({ ...targetEdit, interestCategories: e.target.value })}
                  placeholder="fintech, enterprise_saas"
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="space-y-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={targetEdit.consentRequired}
                  onChange={(e) => setTargetEdit({ ...targetEdit, consentRequired: e.target.checked })}
                />
                <span>Require verified GDPR / regional consent before personalized delivery</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={targetEdit.retargetingEnabled}
                  onChange={(e) => setTargetEdit({ ...targetEdit, retargetingEnabled: e.target.checked })}
                />
                <span>Enable consent-gated retargeting audiences (first-party session only)</span>
              </label>
            </div>

            <button
              type="submit"
              disabled={!selectedCampaignId}
              className="w-full sm:w-auto px-5 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60"
            >
              Save Targeting Rules
            </button>
          </form>

          <div className="lg:col-span-5 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 bg-white dark:bg-slate-900 space-y-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Privacy-Safe Targeting Guarantees</h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Looma Advertising evaluates country, device category, language, and publisher context strictly in real time without browser fingerprinting or third-party data broker syncs.
            </p>
            <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs pt-2">
              {campaigns.map((c) => (
                <div key={c.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 dark:text-white">{c.name}</div>
                    <div className="font-mono text-[11px] text-slate-500 break-all">
                      Geo: {c.countries_json || '["ALL"]'}
                    </div>
                  </div>
                  <span className="text-[11px] text-slate-500 shrink-0">
                    {c.consent_required !== 0 ? 'Consent Enforced' : 'Contextual Only'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB: BUDGET & BIDDING */}
      {tab === 'bidding' && (
        <div className="grid lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleSaveBudgetBidding}
            className="lg:col-span-6 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-slate-900 space-y-4"
          >
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">Budget & Bidding Controls</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Configure daily caps, total campaign limits, auction max bids, and pacing speed.
              </p>
            </div>

            <div>
              <label htmlFor="bdg-camp-select" className="block text-xs font-medium mb-1">
                Campaign
              </label>
              <select
                id="bdg-camp-select"
                value={selectedCampaignId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedCampaignId(id);
                  const found = campaigns.find((c) => c.id === id);
                  if (found) syncCampaignEditors(found);
                }}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.pricing_model})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="bdg-strategy" className="block text-xs font-medium mb-1">
                  Bidding Strategy
                </label>
                <select
                  id="bdg-strategy"
                  value={budgetEdit.biddingStrategy}
                  onChange={(e) => setBudgetEdit({ ...budgetEdit, biddingStrategy: e.target.value })}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="manual">Manual Bid</option>
                  <option value="auto_cpc">Automated CPC Optimization</option>
                  <option value="target_cpa">Target CPA</option>
                </select>
              </div>
              <div>
                <label htmlFor="bdg-pacing" className="block text-xs font-medium mb-1">
                  Delivery Pacing
                </label>
                <select
                  id="bdg-pacing"
                  value={budgetEdit.pacingMode}
                  onChange={(e) => setBudgetEdit({ ...budgetEdit, pacingMode: e.target.value })}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="standard">Standard (Even Distribution)</option>
                  <option value="accelerated">Accelerated</option>
                </select>
              </div>
            </div>

            <div className="grid sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="bdg-max" className="block text-xs font-medium mb-1">Max Bid (USD)</label>
                <input
                  id="bdg-max"
                  type="number"
                  step="0.05"
                  min="0.1"
                  required
                  value={budgetEdit.maxBidUsd}
                  onChange={(e) => setBudgetEdit({ ...budgetEdit, maxBidUsd: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="bdg-daily" className="block text-xs font-medium mb-1">Daily Cap ($)</label>
                <input
                  id="bdg-daily"
                  type="number"
                  min="5"
                  required
                  value={budgetEdit.dailyBudgetUsd}
                  onChange={(e) => setBudgetEdit({ ...budgetEdit, dailyBudgetUsd: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="bdg-total" className="block text-xs font-medium mb-1">Total Budget ($)</label>
                <input
                  id="bdg-total"
                  type="number"
                  min="25"
                  required
                  value={budgetEdit.totalBudgetUsd}
                  onChange={(e) => setBudgetEdit({ ...budgetEdit, totalBudgetUsd: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="bdg-start" className="block text-xs font-medium mb-1">Start Date</label>
                <input
                  id="bdg-start"
                  type="date"
                  value={budgetEdit.startDate}
                  onChange={(e) => setBudgetEdit({ ...budgetEdit, startDate: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="bdg-end" className="block text-xs font-medium mb-1">End Date</label>
                <input
                  id="bdg-end"
                  type="date"
                  value={budgetEdit.endDate}
                  onChange={(e) => setBudgetEdit({ ...budgetEdit, endDate: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={!selectedCampaignId}
              className="w-full sm:w-auto px-5 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60"
            >
              Update Budget & Bidding
            </button>
          </form>

          <div className="lg:col-span-6 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Campaign Spend & Headroom
            </div>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {campaigns.map((c) => {
                const pct = c.total_budget_micros > 0 ? Math.min(100, Math.round((c.spent_total_micros / c.total_budget_micros) * 100)) : 0;
                return (
                  <div key={c.id} className="p-4 space-y-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <span className="font-medium text-slate-900 dark:text-white">{c.name}</span>
                      <span className="font-mono text-slate-500">
                        {c.pricing_model} · Max {formatMicros(c.max_bid_micros)} · {c.pacing_mode}
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <div className="h-full bg-blue-600 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex flex-wrap justify-between gap-2 font-mono text-[11px] text-slate-500">
                      <span>Spent: {formatMicros(c.spent_total_micros)}</span>
                      <span>Total Cap: {formatMicros(c.total_budget_micros)} ({pct}%)</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* TAB: REPORTING */}
      {tab === 'reporting' && reporting && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3 sm:gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <label htmlFor="report-days" className="text-xs font-medium text-slate-600 dark:text-slate-400 whitespace-nowrap">
                  Date Window:
                </label>
                <select
                  id="report-days"
                  value={reportDays}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setReportDays(next);
                    loadAll(next, reportCampaignId);
                  }}
                  className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                >
                  <option value={7}>Last 7 days</option>
                  <option value={30}>Last 30 days</option>
                  <option value={90}>Last 90 days</option>
                </select>
              </div>
              <div className="flex items-center gap-2 min-w-0">
                <label htmlFor="report-campaign" className="text-xs font-medium text-slate-600 dark:text-slate-400 whitespace-nowrap">
                  Campaign:
                </label>
                <select
                  id="report-campaign"
                  value={reportCampaignId}
                  onChange={(e) => {
                    const next = e.target.value;
                    setReportCampaignId(next);
                    loadAll(reportDays, next);
                  }}
                  className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 max-w-[220px] sm:max-w-[280px] truncate"
                >
                  <option value="all">All Campaigns</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              type="button"
              onClick={handleDownloadCsv}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV Report</span>
            </button>
          </div>

          <AdvertiserPerformanceTrendChart
            title="Performance Trend by Date Window"
            subtitle={
              reportCampaignId === 'all'
                ? `Verified impressions, clicks, conversion rates, and billed spend over the last ${reportDays} days`
                : `Filtered daily performance for ${campaigns.find((c) => c.id === reportCampaignId)?.name || reportCampaignId} (${reportDays}d)`
            }
            data={reporting.dailySeries || []}
            height={300}
          />

          <CampaignComparisonChart campaigns={reporting.byCampaign || []} />

          <div className="grid md:grid-cols-2 gap-6">
            <div className="min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
              <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
                Geographic Performance
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 whitespace-nowrap">
                    <tr>
                      <th className="py-2.5 px-3 sm:px-4">Country</th>
                      <th className="py-2.5 px-3 sm:px-4 text-right">Impressions</th>
                      <th className="py-2.5 px-3 sm:px-4 text-right">Clicks</th>
                      <th className="py-2.5 px-3 sm:px-4 text-right">Spend</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono tabular-nums whitespace-nowrap">
                    {reporting.byGeo.map((g) => (
                      <tr key={g.country}>
                        <td className="py-2.5 px-3 sm:px-4 font-sans font-medium">{g.country}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right">{formatNumber(g.impressions)}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right">{formatNumber(g.clicks)}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right">{formatMicros(g.spend_micros)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
              <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
                Device Performance
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 whitespace-nowrap">
                    <tr>
                      <th className="py-2.5 px-3 sm:px-4">Device Category</th>
                      <th className="py-2.5 px-3 sm:px-4 text-right">Impressions</th>
                      <th className="py-2.5 px-3 sm:px-4 text-right">Clicks</th>
                      <th className="py-2.5 px-3 sm:px-4 text-right">Spend</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono tabular-nums whitespace-nowrap">
                    {reporting.byDevice.map((d) => (
                      <tr key={d.device_category}>
                        <td className="py-2.5 px-3 sm:px-4 font-sans font-medium capitalize">{d.device_category}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right">{formatNumber(d.impressions)}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right">{formatNumber(d.clicks)}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right">{formatMicros(d.spend_micros)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB: BILLING & WALLET */}
      {tab === 'billing' && billing && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 truncate">Available Prepaid Funds</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold text-emerald-700 dark:text-emerald-400 truncate">
                {formatMicros(billing.wallet.available_micros)}
              </div>
            </div>
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 truncate">Reserved (In-Flight Holds)</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold text-blue-700 dark:text-blue-400 truncate">
                {formatMicros(billing.wallet.reserved_micros)}
              </div>
            </div>
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 truncate">Lifetime Deposited</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold truncate">
                {formatMicros(billing.wallet.lifetime_deposited_micros)}
              </div>
            </div>
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 truncate">Lifetime Ad Spend</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold truncate">
                {formatMicros(billing.wallet.lifetime_spent_micros)}
              </div>
            </div>
          </div>

          <div className="grid lg:grid-cols-12 gap-6">
            <form
              onSubmit={handleDeposit}
              className="lg:col-span-5 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 bg-white dark:bg-slate-900 space-y-4"
            >
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Wallet className="w-4 h-4 text-blue-700 dark:text-blue-400" />
                <span>Add Prepaid Funds (Paystack / Flutterwave)</span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Prepaid wallets exclusively at launch. Funds reserve atomically on ad delivery so campaigns can never overspend available balance.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="dep-amount" className="block text-xs font-medium mb-1">Amount (USD)</label>
                  <input
                    id="dep-amount"
                    type="number"
                    min="10"
                    step="10"
                    required
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="dep-provider" className="block text-xs font-medium mb-1">Payment Provider</label>
                  <select
                    id="dep-provider"
                    value={depositProvider}
                    onChange={(e) => setDepositProvider(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="paystack">Paystack</option>
                    <option value="flutterwave">Flutterwave</option>
                    <option value="stripe">Stripe</option>
                    <option value="bank_transfer">Bank Transfer</option>
                  </select>
                </div>
              </div>
              <button
                type="submit"
                className="w-full py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg"
              >
                Deposit Funds
              </button>

              {liveCheckoutUrl && (
                <div className="p-3 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 text-xs space-y-1.5">
                  <div className="font-semibold text-blue-900 dark:text-blue-200">Hosted Payment Checkout Ready</div>
                  <a
                    href={liveCheckoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block font-medium text-blue-700 dark:text-blue-300 underline break-all"
                  >
                    Open Provider Payment Page
                  </a>
                </div>
              )}

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
                <div className="text-xs font-medium mb-2">Request Unused Balance Refund</div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="number"
                    min="5"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                    aria-label="Refund amount in USD"
                    className="flex-1 min-w-0 px-3 py-1.5 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    onClick={handleRefund}
                    className="px-3.5 py-2 sm:py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 shrink-0"
                  >
                    Request Refund
                  </button>
                </div>
              </div>
            </form>

            <div className="lg:col-span-7 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
              <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
                Immutable Financial Ledger
              </div>
              <div className="overflow-x-auto max-h-96">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 whitespace-nowrap">
                    <tr>
                      <th className="py-2.5 px-3 sm:px-4">Entry</th>
                      <th className="py-2.5 px-3 sm:px-4">Description</th>
                      <th className="py-2.5 px-3 sm:px-4 text-right">Amount</th>
                      <th className="py-2.5 px-3 sm:px-4 text-right">Balance After</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {billing.ledger.map((l) => (
                      <tr key={l.id}>
                        <td className="py-2.5 px-3 sm:px-4 font-mono whitespace-nowrap">
                          {l.direction === 'credit' ? '+' : '-'} {l.entry_type}
                        </td>
                        <td className="py-2.5 px-3 sm:px-4 text-slate-600 dark:text-slate-300 min-w-[180px]">{l.description}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right font-mono tabular-nums font-medium whitespace-nowrap">
                          {l.direction === 'credit' ? '+' : '-'}
                          {formatMicros(l.amount_micros)}
                        </td>
                        <td className="py-2.5 px-3 sm:px-4 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatMicros(l.balance_after_micros)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Prepaid Budget Reservations (Overspend Protection)
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 whitespace-nowrap">
                  <tr>
                    <th className="py-2.5 px-3 sm:px-4">Request ID</th>
                    <th className="py-2.5 px-3 sm:px-4">Campaign</th>
                    <th className="py-2.5 px-3 sm:px-4">Status</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Reserved</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Captured</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Released</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 whitespace-nowrap">
                  {(!billing.reservations || billing.reservations.length === 0) ? (
                    <tr>
                      <td colSpan={7} className="py-4 px-3 sm:px-4 text-slate-500">
                        No ad delivery budget reservations recorded yet. Reservations appear automatically when ads are served.
                      </td>
                    </tr>
                  ) : (
                    billing.reservations.map((r) => (
                      <tr key={r.id}>
                        <td className="py-2.5 px-3 sm:px-4 font-mono">{r.request_id}</td>
                        <td className="py-2.5 px-3 sm:px-4 font-medium">{r.campaign_name}</td>
                        <td className="py-2.5 px-3 sm:px-4 capitalize font-mono">{r.status}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right font-mono tabular-nums">{formatMicros(r.amount_micros)}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right font-mono tabular-nums">{formatMicros(r.captured_micros)}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right font-mono tabular-nums">{formatMicros(r.released_micros)}</td>
                        <td className="py-2.5 px-3 sm:px-4 text-right">
                          {r.status === 'active' ? (
                            <button
                              type="button"
                              onClick={async () => {
                                setError(null);
                                try {
                                  await apiRequest(`/api/advertiser/reservations/${r.id}/release`, { method: 'POST' });
                                  setActionMsg(`Released reservation ${r.id} back to available balance.`);
                                  await loadAll();
                                } catch (err) {
                                  setError(err instanceof Error ? err.message : 'Unable to release reservation');
                                }
                              }}
                              className="px-2.5 py-1 border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800"
                            >
                              Release Hold
                            </button>
                          ) : (
                            <span className="text-slate-400">Settled</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Invoices
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 whitespace-nowrap">
                  <tr>
                    <th className="py-2.5 px-3 sm:px-4">Invoice Number</th>
                    <th className="py-2.5 px-3 sm:px-4">Issued At</th>
                    <th className="py-2.5 px-3 sm:px-4">Status</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 whitespace-nowrap">
                  {billing.invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td className="py-2.5 px-3 sm:px-4 font-mono font-medium">{inv.invoice_number}</td>
                      <td className="py-2.5 px-3 sm:px-4 font-mono text-slate-500">{inv.issued_at}</td>
                      <td className="py-2.5 px-3 sm:px-4 capitalize">{inv.status}</td>
                      <td className="py-2.5 px-3 sm:px-4 text-right font-mono tabular-nums font-semibold">
                        {formatMicros(inv.amount_micros)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB: ACTIVITY & ALERTS */}
      {tab === 'activity' && overview && (
        <div className="space-y-6">
          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Account Notifications & Delivery Alerts
            </div>
            {overview.notifications.length === 0 ? (
              <div className="p-6 text-sm text-slate-500 dark:text-slate-400">No recent notifications recorded.</div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {overview.notifications.map((n) => (
                  <div key={n.id} className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-start justify-between gap-2 sm:gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 dark:text-white">{n.title}</div>
                      <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">{n.message}</p>
                    </div>
                    <span className="text-[11px] font-mono text-slate-400 shrink-0">{n.created_at}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
