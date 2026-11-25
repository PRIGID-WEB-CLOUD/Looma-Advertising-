import React, { useEffect, useState } from 'react';
import { Plus, CheckCircle2, MousePointerClick, Sparkles, AlertTriangle } from 'lucide-react';
import { apiRequest, formatMicros, formatNumber, formatPct } from '../lib/api';
import { fetchLoomaFeedAds, type LoomaFeedFetchResult } from '../lib/loomaFeedClient';
import { PerformanceChart } from './Charts';

interface PublisherOverview {
  account: {
    id: string;
    organization_name: string;
    approval_status: string;
    traffic_quality_score: number;
    custom_revenue_share_bps: number | null;
    payout_method_type: string;
    payout_destination: string;
  };
  wallet: {
    id: string;
    estimated_micros: number;
    available_micros: number;
    pending_micros: number;
    lifetime_earned_micros: number;
    invalid_deducted_micros: number;
  };
  defaultShareBps: number;
  minPayoutMicros: number;
  kpis: {
    total_requests: number;
    filled_requests: number;
    impressions: number;
    clicks: number;
    fillRate: number;
    ctr: number;
    ecpmMicros: number;
  };
  revenueSeries: Array<{
    day: string;
    impressions: number;
    clicks: number;
    earningsMicros: number;
  }>;
}

interface PropertyRow {
  id: string;
  property_type: string;
  name: string;
  domain_or_bundle: string;
  category: string;
  verification_status: string;
  approval_status: string;
  monthly_pageviews: number;
  verification_method: string;
  verification_token: string;
  placement_count: number;
}

interface PlacementRow {
  id: string;
  property_id: string;
  property_name: string;
  domain_or_bundle: string;
  property_approval: string;
  name: string;
  format: string;
  dimensions: string;
  floor_cpm_micros: number;
  status: string;
  integration_verified: number;
  impressions: number;
  clicks: number;
}

export type PubTab = 'overview' | 'properties' | 'placements' | 'integration' | 'sandbox' | 'earnings' | 'payouts';

interface PublisherWorkspaceProps {
  activeTab?: PubTab;
  onTabChange?: (tab: PubTab) => void;
}

export const PublisherWorkspace: React.FC<PublisherWorkspaceProps> = ({ activeTab }) => {
  const tab = activeTab ?? 'overview';
  const [overview, setOverview] = useState<PublisherOverview | null>(null);
  const [properties, setProperties] = useState<PropertyRow[]>([]);
  const [placements, setPlacements] = useState<PlacementRow[]>([]);
  const [earnings, setEarnings] = useState<{
    wallet: PublisherOverview['wallet'];
    withdrawals: Array<{ id: string; amount_micros: number; payout_method: string; payout_destination: string; status: string; created_at: string }>;
    ledger: Array<{ id: string; entry_type: string; direction: string; amount_micros: number; balance_after_micros: number; description: string; created_at: string }>;
    minPayoutMicros: number;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Forms
  const [propForm, setPropForm] = useState({
    propertyType: 'website',
    name: '',
    domainOrBundle: '',
    category: 'business_finance',
    monthlyPageviews: 120000,
    verificationMethod: 'dns_txt',
  });

  const [placeForm, setPlaceForm] = useState({
    propertyId: '',
    name: '',
    format: 'native',
    dimensions: 'responsive',
    floorCpmUsd: 0.75,
  });

  const [withdrawUsd, setWithdrawUsd] = useState('100');
  const [payoutMethodType, setPayoutMethodType] = useState('bank_transfer');
  const [payoutDestination, setPayoutDestination] = useState('');

  // Integration Center & Live Ad Delivery Sandbox
  const [sdkDocTab, setSdkDocTab] = useState<'web' | 'rest' | 'android' | 'ios'>('web');
  const [sandboxConfig, setSandboxConfig] = useState({
    placementId: 'plc_looma_feed_native',
    country: 'US',
    deviceCategory: 'desktop',
    category: 'business_finance',
    consentGranted: true,
  });
  const [loomaFeedResult, setLoomaFeedResult] = useState<LoomaFeedFetchResult | null>(null);
  const [loomaFeedLoading, setLoomaFeedLoading] = useState(false);
  const [sandboxResult, setSandboxResult] = useState<{
    filled: boolean;
    requestId: string | null;
    reason?: string;
    auction?: { model: string; effectiveCpmMicros: number; auctionScore: number };
    ad?: {
      campaignId: string;
      campaignName: string;
      creativeId: string;
      format: string;
      pricingModel: string;
      title: string;
      description: string;
      mediaUrl: string;
      destinationUrl: string;
      ctaText: string;
      sponsoredLabel: string;
    };
    tracking?: {
      impressionToken: string;
      clickToken: string;
      conversionToken: string;
      videoToken?: string;
      installToken?: string;
    };
  } | null>(null);
  const [sandboxEvents, setSandboxEvents] = useState<string[]>([]);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [ov, pr, pl, er] = await Promise.all([
        apiRequest<PublisherOverview>('/api/publisher/overview'),
        apiRequest<{ properties: PropertyRow[] }>('/api/publisher/properties'),
        apiRequest<{ placements: PlacementRow[] }>('/api/publisher/placements'),
        apiRequest<NonNullable<typeof earnings>>('/api/publisher/earnings'),
      ]);
      setOverview(ov);
      setProperties(pr.properties);
      setPlacements(pl.placements);
      setEarnings(er);
      setPayoutMethodType(ov.account.payout_method_type || 'bank_transfer');
      setPayoutDestination(ov.account.payout_destination || '');
      if (pr.properties.length > 0 && !placeForm.propertyId) {
        setPlaceForm((prev) => ({ ...prev, propertyId: pr.properties[0].id }));
      }
      if (pl.placements.length > 0 && !pl.placements.some((p) => p.id === sandboxConfig.placementId)) {
        setSandboxConfig((prev) => ({ ...prev, placementId: pl.placements[0].id }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load publisher workspace');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function handleAddProperty(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setActionMsg(null);
    try {
      const res = await apiRequest<{ propertyId: string; verificationToken: string }>('/api/publisher/properties', {
        method: 'POST',
        body: JSON.stringify(propForm),
      });
      setActionMsg(`Property ${res.propertyId} registered. Token: ${res.verificationToken}`);
      setPropForm({ ...propForm, name: '', domainOrBundle: '' });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register property');
    }
  }

  async function handleVerifyProperty(id: string, sandboxOverride = false) {
    setError(null);
    setActionMsg(null);
    try {
      const res = await apiRequest<{
        verified: boolean;
        mode: 'live' | 'sandbox';
        checkedTarget: string;
        detail: string;
      }>(`/api/publisher/properties/${id}/verify`, {
        method: 'POST',
        body: JSON.stringify({ sandboxOverride }),
      });
      if (res.verified) {
        setActionMsg(res.detail);
      } else {
        setError(`${res.detail} (Target: ${res.checkedTarget})`);
      }
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    }
  }

  async function handleAddPlacement(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setActionMsg(null);
    try {
      const res = await apiRequest<{ placementId: string }>('/api/publisher/placements', {
        method: 'POST',
        body: JSON.stringify(placeForm),
      });
      setActionMsg(`Placement ${res.placementId} created and ready for SDK integration.`);
      setPlaceForm({ ...placeForm, name: '' });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create placement');
    }
  }

  async function handleTogglePlacement(id: string, currentStatus: string) {
    const nextStatus = currentStatus === 'active' ? 'paused' : 'active';
    await apiRequest(`/api/publisher/placements/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus }),
    });
    await loadAll();
  }

  async function handleRequestWithdrawal(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setActionMsg(null);
    try {
      const res = await apiRequest<{ withdrawalId: string }>('/api/publisher/withdraw', {
        method: 'POST',
        body: JSON.stringify({ amountUsd: Number(withdrawUsd) }),
      });
      setActionMsg(`Withdrawal ${res.withdrawalId} queued for finance approval.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Withdrawal request failed');
    }
  }

  async function handleSavePayoutMethod(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiRequest('/api/publisher/payout-method', {
        method: 'PATCH',
        body: JSON.stringify({ payoutMethodType, payoutDestination }),
      });
      setActionMsg('Payout destination updated.');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update payout method');
    }
  }

  // Live Ad-Serving Sandbox Actions
  async function handleRunAdRequest() {
    setError(null);
    try {
      const res = await apiRequest<NonNullable<typeof sandboxResult>>('/api/v1/ad/request', {
        method: 'POST',
        body: JSON.stringify({
          ...sandboxConfig,
          sessionId: `sandbox_${Date.now()}`,
        }),
      });
      setSandboxResult(res);
      setSandboxEvents((prev) => [
        `${new Date().toLocaleTimeString()} · POST /api/v1/ad/request -> ${res.filled ? `Filled (${res.ad?.campaignName})` : `Unfilled (${res.reason})`}`,
        ...prev.slice(0, 8),
      ]);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ad request failed');
    }
  }

  async function handleFireImpression() {
    if (!sandboxResult?.tracking?.impressionToken) return;
    setError(null);
    try {
      const res = await apiRequest<{ recorded: boolean; billedMicros: number }>('/api/v1/ad/impression', {
        method: 'POST',
        body: JSON.stringify({ impressionToken: sandboxResult.tracking.impressionToken, viewable: true }),
      });
      setSandboxEvents((prev) => [
        `${new Date().toLocaleTimeString()} · POST /api/v1/ad/impression -> recorded=${res.recorded}, billed=${formatMicros(res.billedMicros, 4)}`,
        ...prev.slice(0, 8),
      ]);
      await loadAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Impression tracking failed';
      setError(msg);
      setSandboxEvents((prev) => [
        `${new Date().toLocaleTimeString()} · POST /api/v1/ad/impression -> error (${msg})`,
        ...prev.slice(0, 8),
      ]);
    }
  }

  async function handleFireClick(simulateBot = false) {
    if (!sandboxResult?.tracking?.clickToken) return;
    setError(null);
    try {
      const res = await apiRequest<{ valid: boolean; invalidReason: string | null; billedMicros: number; publisherShareMicros: number }>('/api/v1/ad/click', {
        method: 'POST',
        body: JSON.stringify({
          clickToken: sandboxResult.tracking.clickToken,
          sandboxMode: true,
          simulateBot,
        }),
      });
      setSandboxEvents((prev) => [
        `${new Date().toLocaleTimeString()} · POST /api/v1/ad/click -> valid=${res.valid}${res.invalidReason ? ` (${res.invalidReason})` : ''}, billed=${formatMicros(res.billedMicros)}, pubShare=${formatMicros(res.publisherShareMicros)}`,
        ...prev.slice(0, 8),
      ]);
      await loadAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Click validation failed';
      setError(msg);
      setSandboxEvents((prev) => [
        `${new Date().toLocaleTimeString()} · POST /api/v1/ad/click -> blocked (${msg})`,
        ...prev.slice(0, 8),
      ]);
    }
  }

  async function handleFireConversion() {
    if (!sandboxResult?.tracking?.conversionToken) return;
    setError(null);
    try {
      const res = await apiRequest<{ recorded: boolean; billedMicros: number }>('/api/v1/ad/conversion', {
        method: 'POST',
        body: JSON.stringify({
          conversionToken: sandboxResult.tracking.conversionToken,
          eventName: 'signup_completed',
          conversionValueMicros: 95_000_000,
        }),
      });
      setSandboxEvents((prev) => [
        `${new Date().toLocaleTimeString()} · POST /api/v1/ad/conversion -> recorded=${res.recorded}, billed=${formatMicros(res.billedMicros)}`,
        ...prev.slice(0, 8),
      ]);
      await loadAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Conversion tracking failed';
      setError(msg);
      setSandboxEvents((prev) => [
        `${new Date().toLocaleTimeString()} · POST /api/v1/ad/conversion -> error (${msg})`,
        ...prev.slice(0, 8),
      ]);
    }
  }

  async function handleFireVideoComplete() {
    if (!sandboxResult?.tracking?.videoToken) return;
    setError(null);
    try {
      const res = await apiRequest<{ recorded: boolean; billedMicros: number; duplicateComplete?: boolean }>(
        '/api/v1/ad/video-event',
        {
          method: 'POST',
          body: JSON.stringify({
            videoToken: sandboxResult.tracking.videoToken,
            eventName: 'complete',
            watchedMs: 15000,
          }),
        }
      );
      setSandboxEvents((prev) => [
        `${new Date().toLocaleTimeString()} · POST /api/v1/ad/video-event (complete) -> recorded=${res.recorded}, billed=${formatMicros(res.billedMicros)}`,
        ...prev.slice(0, 8),
      ]);
      await loadAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Video tracking failed';
      setError(msg);
    }
  }

  async function handleFireAppInstall() {
    if (!sandboxResult?.tracking?.installToken) return;
    setError(null);
    try {
      const res = await apiRequest<{ recorded: boolean; billedMicros: number; duplicate?: boolean }>(
        '/api/v1/ad/install',
        {
          method: 'POST',
          body: JSON.stringify({
            installToken: sandboxResult.tracking.installToken,
            appBundleId: 'com.meridianmedia.reader',
            deviceOs: 'iOS',
          }),
        }
      );
      setSandboxEvents((prev) => [
        `${new Date().toLocaleTimeString()} · POST /api/v1/ad/install -> recorded=${res.recorded}, billed=${formatMicros(res.billedMicros)}`,
        ...prev.slice(0, 8),
      ]);
      await loadAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'App install attribution failed';
      setError(msg);
    }
  }

  async function handleTestLoomaFeed(simulateOutage = false) {
    setError(null);
    setLoomaFeedLoading(true);
    try {
      const slots = placements.slice(0, 3).map((pl, idx) => ({
        slotIndex: idx * 4 + 2,
        placementId: pl.id,
      }));
      const res = await fetchLoomaFeedAds({
        slots: slots.length > 0 ? slots : undefined,
        country: sandboxConfig.country,
        deviceCategory: sandboxConfig.deviceCategory,
        feedCategory: sandboxConfig.category,
        consentGranted: sandboxConfig.consentGranted,
        timeoutMs: 800,
        simulateOutage,
      });
      setLoomaFeedResult(res);
      setSandboxEvents((prev) => [
        `${new Date().toLocaleTimeString()} · POST /api/v1/looma/feed/ads -> degraded=${res.degraded}, slots=${res.decisions.length}, latency=${res.latencyMs}ms`,
        ...prev.slice(0, 8),
      ]);
      if (!simulateOutage) {
        await loadAll();
      }
    } finally {
      setLoomaFeedLoading(false);
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

  const effectiveRevShare = ((overview?.account.custom_revenue_share_bps ?? overview?.defaultShareBps ?? 7000) / 100).toFixed(0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="min-w-0">
          <div className="text-xs text-slate-500 dark:text-slate-400 break-words">
            Publisher Workspace · {overview?.account.organization_name} · Share: {effectiveRevShare}% · Quality Score:{' '}
            <span className="font-mono tabular-nums">{overview?.account.traffic_quality_score}/100</span>
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-bold text-slate-900 dark:text-white mt-0.5">
            Inventory, Ad Delivery SDK & Revenue
          </h1>
        </div>

        <div className="sm:text-right shrink-0">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">Finalized Available Balance</div>
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
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">Estimated Earnings</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold truncate">
                {formatMicros(overview.wallet.estimated_micros)}
              </div>
            </div>
            <div className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">Available (Finalized)</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold text-emerald-700 dark:text-emerald-400 truncate">
                {formatMicros(overview.wallet.available_micros)}
              </div>
            </div>
            <div className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">Pending Payouts</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold truncate">
                {formatMicros(overview.wallet.pending_micros)}
              </div>
            </div>
            <div className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">Fill Rate</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold truncate">
                {formatPct(overview.kpis.fillRate)}
              </div>
            </div>
            <div className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">eCPM</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold truncate">
                {formatMicros(overview.kpis.ecpmMicros)}
              </div>
            </div>
            <div className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">CTR</div>
              <div className="mt-1 font-mono tabular-nums text-lg sm:text-xl font-semibold truncate">
                {formatPct(overview.kpis.ctr)}
              </div>
            </div>
          </div>

          <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 text-xs text-slate-600 dark:text-slate-300">
            Estimated earnings reflect unadjusted real-time delivery and are not guaranteed. Finalized available balances
            exclude invalid traffic deductions ({formatMicros(overview.wallet.invalid_deducted_micros)} deducted lifetime).
          </div>

          <PerformanceChart
            title="Publisher Impressions & Revenue Share"
            subtitle="Verified rendered impressions and publisher revenue share across active placements"
            amountLabel="Earnings"
            data={overview.revenueSeries.map((d) => ({
              day: d.day,
              impressions: d.impressions,
              clicks: d.clicks,
              amountMicros: d.earningsMicros,
            }))}
          />
        </div>
      )}

      {/* TAB: PROPERTIES */}
      {tab === 'properties' && (
        <div className="grid lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleAddProperty}
            className="lg:col-span-4 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 bg-white dark:bg-slate-900 space-y-3.5"
          >
            <h2 className="text-base font-semibold">Register Website or App</h2>
            <div>
              <label className="block text-xs font-medium mb-1">Property Type</label>
              <select
                value={propForm.propertyType}
                onChange={(e) => setPropForm({ ...propForm, propertyType: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="website">Website</option>
                <option value="web_app">Web Application</option>
                <option value="ios_app">iOS Application</option>
                <option value="android_app">Android Application</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Property Name</label>
              <input
                type="text"
                required
                value={propForm.name}
                onChange={(e) => setPropForm({ ...propForm, name: e.target.value })}
                placeholder="Meridian Tech Journal"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Domain or App Bundle ID</label>
              <input
                type="text"
                required
                value={propForm.domainOrBundle}
                onChange={(e) => setPropForm({ ...propForm, domainOrBundle: e.target.value })}
                placeholder="techjournal.meridian.io"
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Category</label>
                <select
                  value={propForm.category}
                  onChange={(e) => setPropForm({ ...propForm, category: e.target.value })}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="business_finance">Business & Finance</option>
                  <option value="news_technology">News & Tech</option>
                  <option value="fintech">Fintech</option>
                  <option value="retail">Retail & Commerce</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Verification</label>
                <select
                  value={propForm.verificationMethod}
                  onChange={(e) => setPropForm({ ...propForm, verificationMethod: e.target.value })}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="dns_txt">DNS TXT</option>
                  <option value="ads_txt">ads.txt</option>
                  <option value="meta_tag">Meta Tag</option>
                </select>
              </div>
            </div>
            <button
              type="submit"
              className="w-full inline-flex items-center justify-center gap-1.5 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg"
            >
              <Plus className="w-4 h-4" />
              <span>Register Property</span>
            </button>
          </form>

          <div className="lg:col-span-8 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Registered Properties
            </div>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {properties.map((p) => (
                <div key={p.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-slate-900 dark:text-white">{p.name}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono break-all">
                      {p.domain_or_bundle} · {p.property_type} · {p.category}
                    </div>
                    <div className="text-[11px] font-mono text-slate-500 mt-1 break-all">
                      Token ({p.verification_method}): {p.verification_token}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 shrink-0">
                    <div className="sm:text-right text-xs">
                      <div>Ownership: {p.verification_status}</div>
                      <div className="text-slate-500">Admin: {p.approval_status}</div>
                    </div>
                    {p.verification_status !== 'verified' ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleVerifyProperty(p.id, false)}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg"
                        >
                          Run Live DNS / ads.txt Check
                        </button>
                        <button
                          type="button"
                          onClick={() => handleVerifyProperty(p.id, true)}
                          className="px-3 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800"
                        >
                          Verify (Sandbox)
                        </button>
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Verified</span>
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB: AD PLACEMENTS */}
      {tab === 'placements' && (
        <div className="grid lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleAddPlacement}
            className="lg:col-span-4 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 bg-white dark:bg-slate-900 space-y-3.5"
          >
            <h2 className="text-base font-semibold">Create Ad Unit Placement</h2>
            <div>
              <label className="block text-xs font-medium mb-1">Property</label>
              <select
                value={placeForm.propertyId}
                onChange={(e) => setPlaceForm({ ...placeForm, propertyId: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.domain_or_bundle})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Placement Name</label>
              <input
                type="text"
                required
                value={placeForm.name}
                onChange={(e) => setPlaceForm({ ...placeForm, name: e.target.value })}
                placeholder="Sidebar Native Unit"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Format</label>
                <select
                  value={placeForm.format}
                  onChange={(e) => setPlaceForm({ ...placeForm, format: e.target.value })}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="native">Native</option>
                  <option value="banner">Display Banner</option>
                  <option value="responsive">Responsive</option>
                  <option value="in_feed">In-Feed</option>
                  <option value="video">Video</option>
                  <option value="interstitial">Interstitial</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Dimensions</label>
                <input
                  type="text"
                  value={placeForm.dimensions}
                  onChange={(e) => setPlaceForm({ ...placeForm, dimensions: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Floor CPM (USD)</label>
              <input
                type="number"
                step="0.1"
                min="0.1"
                value={placeForm.floorCpmUsd}
                onChange={(e) => setPlaceForm({ ...placeForm, floorCpmUsd: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg"
            >
              Generate Placement ID
            </button>
          </form>

          <div className="lg:col-span-8 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Ad Placements
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 whitespace-nowrap">
                  <tr>
                    <th className="py-2.5 px-3 sm:px-4">Placement ID & Name</th>
                    <th className="py-2.5 px-3 sm:px-4">Format</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Floor CPM</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Impr. / Clicks</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 whitespace-nowrap">
                  {placements.map((pl) => (
                    <tr key={pl.id}>
                      <td className="py-3 px-3 sm:px-4">
                        <div className="font-medium text-slate-900 dark:text-white">{pl.name}</div>
                        <div className="font-mono text-[11px] text-slate-500">
                          {pl.id} · {pl.property_name}
                        </div>
                      </td>
                      <td className="py-3 px-3 sm:px-4">
                        {pl.format} · {pl.dimensions}
                      </td>
                      <td className="py-3 px-3 sm:px-4 text-right font-mono tabular-nums">
                        {formatMicros(pl.floor_cpm_micros)}
                      </td>
                      <td className="py-3 px-3 sm:px-4 text-right font-mono tabular-nums">
                        {formatNumber(pl.impressions)} / {formatNumber(pl.clicks)}
                      </td>
                      <td className="py-3 px-3 sm:px-4 text-right">
                        <button
                          type="button"
                          onClick={() => handleTogglePlacement(pl.id, pl.status)}
                          className="px-2.5 py-1 text-xs rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 capitalize"
                        >
                          {pl.status}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB: INTEGRATION CENTER */}
      {tab === 'integration' && (
        <div className="grid lg:grid-cols-12 gap-6 items-start">
          {/* SDK & Documentation */}
          <div className="lg:col-span-7 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 bg-white dark:bg-slate-900 space-y-4">
            <h2 className="text-base font-semibold">Publisher Integration Center</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Embed the lightweight Looma JavaScript SDK on web properties or call the REST, Android, and iOS delivery APIs directly.
            </p>
            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit max-w-full">
              {(['web', 'rest', 'android', 'ios'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSdkDocTab(k)}
                  className={`px-3 py-1 text-xs font-medium rounded-md uppercase ${
                    sdkDocTab === k ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white' : 'text-slate-500'
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>

            <div className="rounded-lg bg-slate-950 text-slate-100 p-4 overflow-x-auto text-xs font-mono leading-relaxed">
              {sdkDocTab === 'web' && (
                <pre>{`<div id="looma-ad-slot"></div>
<script src="/sdk/looma-ads.js"></script>
<script>
  LoomaAds.renderPlacement({
    container: '#looma-ad-slot',
    placementId: '${sandboxConfig.placementId}',
    country: '${sandboxConfig.country}',
    category: '${sandboxConfig.category}',
    consentGranted: ${sandboxConfig.consentGranted}
  });
</script>`}</pre>
              )}
              {sdkDocTab === 'rest' && (
                <pre>{`POST /api/v1/ad/request
Content-Type: application/json

{
  "placementId": "${sandboxConfig.placementId}",
  "country": "${sandboxConfig.country}",
  "deviceCategory": "${sandboxConfig.deviceCategory}",
  "category": "${sandboxConfig.category}",
  "consentGranted": ${sandboxConfig.consentGranted}
}`}</pre>
              )}
              {sdkDocTab === 'android' && (
                <pre>{`val client = LoomaAdsClient(baseUrl = "https://ads.looma.network")
val response = client.requestAd(
  placementId = "${sandboxConfig.placementId}",
  country = "${sandboxConfig.country}",
  consentGranted = ${sandboxConfig.consentGranted}
)`}</pre>
              )}
              {sdkDocTab === 'ios' && (
                <pre>{`let client = LoomaAdsClient(endpoint: URL(string: "https://ads.looma.network")!)
let ad = try await client.requestAd(
  placementId: "${sandboxConfig.placementId}",
  country: "${sandboxConfig.country}",
  consentGranted: ${sandboxConfig.consentGranted}
)`}</pre>
              )}
            </div>
          </div>

          <div className="lg:col-span-5 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Placement Integration Status
            </div>
            <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
              {placements.map((pl) => (
                <div key={pl.id} className="p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 dark:text-white truncate">{pl.name}</div>
                    <div className="font-mono text-[11px] text-slate-500 truncate">
                      {pl.id} · {pl.format}
                    </div>
                  </div>
                  <span
                    className={`font-medium shrink-0 ${
                      pl.integration_verified ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {pl.integration_verified ? 'Verified' : 'Awaiting Signal'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB: LIVE AD SANDBOX */}
      {tab === 'sandbox' && (
        <div className="w-full border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-slate-900 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">Live Ad-Serving & Tracking Sandbox</h2>
            <span className="text-xs font-mono text-slate-500">Test Ad Delivery Engine</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block font-medium mb-1">Placement</label>
              <select
                value={sandboxConfig.placementId}
                onChange={(e) => setSandboxConfig({ ...sandboxConfig, placementId: e.target.value })}
                className="w-full px-2.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
              >
                {placements.map((pl) => (
                  <option key={pl.id} value={pl.id}>
                    {pl.id} ({pl.format})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">Visitor Country</label>
              <select
                value={sandboxConfig.country}
                onChange={(e) => setSandboxConfig({ ...sandboxConfig, country: e.target.value })}
                className="w-full px-2.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="US">United States (US)</option>
                <option value="GB">United Kingdom (GB)</option>
                <option value="DE">Germany (DE)</option>
                <option value="NG">Nigeria (NG)</option>
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">Device</label>
              <select
                value={sandboxConfig.deviceCategory}
                onChange={(e) => setSandboxConfig({ ...sandboxConfig, deviceCategory: e.target.value })}
                className="w-full px-2.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="desktop">Desktop</option>
                <option value="mobile">Mobile</option>
                <option value="tablet">Tablet</option>
              </select>
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={sandboxConfig.consentGranted}
                  onChange={(e) => setSandboxConfig({ ...sandboxConfig, consentGranted: e.target.checked })}
                />
                <span>GDPR Consent Granted</span>
              </label>
            </div>
          </div>

          <button
            type="button"
            onClick={handleRunAdRequest}
            className="w-full py-2.5 px-4 text-xs sm:text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg"
          >
            Send Live Ad Request (POST /api/v1/ad/request)
          </button>

          {sandboxResult && (
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
              {sandboxResult.filled && sandboxResult.ad ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs text-slate-500">
                    <span>{sandboxResult.ad.sponsoredLabel}</span>
                    <span className="font-mono">
                      eCPM: {formatMicros(sandboxResult.auction?.effectiveCpmMicros)} · Model: {sandboxResult.ad.pricingModel}
                    </span>
                  </div>
                  {sandboxResult.ad.mediaUrl && (
                    <img
                      src={sandboxResult.ad.mediaUrl}
                      alt={sandboxResult.ad.title}
                      referrerPolicy="no-referrer"
                      className="w-full h-40 object-cover rounded-md"
                    />
                  )}
                  <div>
                    <div className="font-semibold text-sm text-slate-900 dark:text-white">{sandboxResult.ad.title}</div>
                    <p className="text-xs text-slate-600 dark:text-slate-300 mt-1">{sandboxResult.ad.description}</p>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleFireImpression}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded-md whitespace-nowrap"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Record Impression</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleFireClick(false)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-blue-700 text-white rounded-md whitespace-nowrap"
                    >
                      <MousePointerClick className="w-3.5 h-3.5" />
                      <span>Simulate Click</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleFireConversion}
                      className="px-2.5 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-md whitespace-nowrap"
                    >
                      Track Conversion
                    </button>
                    <button
                      type="button"
                      onClick={handleFireVideoComplete}
                      className="px-2.5 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-md whitespace-nowrap"
                    >
                      Video Complete (CPV)
                    </button>
                    <button
                      type="button"
                      onClick={handleFireAppInstall}
                      className="px-2.5 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-md whitespace-nowrap"
                    >
                      App Install (CPI)
                    </button>
                    <button
                      type="button"
                      onClick={() => handleFireClick(true)}
                      className="px-2.5 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-800 rounded-md whitespace-nowrap"
                    >
                      Test Bot Block
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>Unfilled response: {sandboxResult.reason}</span>
                </div>
              )}
            </div>
          )}

          {sandboxEvents.length > 0 && (
            <div className="space-y-1 text-[11px] font-mono text-slate-600 dark:text-slate-400 pt-2 border-t border-slate-200 dark:border-slate-800 break-words">
              {sandboxEvents.map((ev, idx) => (
                <div key={idx}>{ev}</div>
              ))}
            </div>
          )}

          {/* Looma First-Party Feed Multi-Slot Integration Adapter */}
          <div className="pt-5 border-t border-slate-200 dark:border-slate-800 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Looma First-Party Feed Adapter (Multi-Slot & Fail-Open Contract)
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Looma renders organic feed items while LOOMA ADS returns data-only slot decisions with atomic prepaid budget reservations.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 shrink-0">
                <button
                  type="button"
                  disabled={loomaFeedLoading}
                  onClick={() => handleTestLoomaFeed(false)}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-lg disabled:opacity-60"
                >
                  {loomaFeedLoading ? 'Requesting…' : 'Fetch Looma Feed Slots'}
                </button>
                <button
                  type="button"
                  disabled={loomaFeedLoading}
                  onClick={() => handleTestLoomaFeed(true)}
                  className="px-3 py-1.5 text-xs font-medium border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-950/30"
                >
                  Simulate Ad Service Outage (Fail-Open)
                </button>
              </div>
            </div>

            {loomaFeedResult && (
              <div className="space-y-3">
                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-xs flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono">
                    Contract: {loomaFeedResult.contractVersion} · Fallback: {loomaFeedResult.fallbackBehavior} · Latency: {loomaFeedResult.latencyMs}ms
                  </span>
                  <span
                    className={`font-semibold ${
                      loomaFeedResult.degraded
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-emerald-700 dark:text-emerald-400'
                    }`}
                  >
                    {loomaFeedResult.degraded
                      ? `Fail-Open Active (${loomaFeedResult.degradedReason}) — Organic Looma Feed Unaffected`
                      : `${loomaFeedResult.decisions.filter((d) => d.filled).length}/${loomaFeedResult.decisions.length} Feed Slots Filled`}
                  </span>
                </div>

                <div className="grid sm:grid-cols-3 gap-3 text-xs">
                  <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
                    <div className="text-[11px] font-mono text-slate-400">Organic Looma Post #1</div>
                    <div className="font-semibold text-slate-900 dark:text-white mt-1">Community Update</div>
                    <p className="text-slate-600 dark:text-slate-300 mt-1">
                      Looma always renders organic feed posts even when LOOMA ADS is degraded or unreachable.
                    </p>
                  </div>
                  {loomaFeedResult.decisions.map((dec) => (
                    <div
                      key={`${dec.slotIndex}-${dec.placementId}`}
                      className="p-3 rounded-lg border border-blue-200 dark:border-blue-900/60 bg-blue-50/40 dark:bg-blue-950/20 min-w-0"
                    >
                      <div className="text-[11px] font-mono text-blue-700 dark:text-blue-300 truncate">
                        Slot #{dec.slotIndex} · {dec.placementId}
                      </div>
                      {dec.filled && dec.ad ? (
                        <>
                          <div className="font-semibold text-slate-900 dark:text-white mt-1 truncate">{dec.ad.title}</div>
                          <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5 line-clamp-2">
                            {dec.ad.description}
                          </div>
                          <div className="text-[10px] font-mono text-slate-500 mt-2 break-all">
                            Hold: {dec.reservationId} ({formatMicros(dec.reservedMicros)}) · Rot: {dec.auction?.rotationFactor}x
                          </div>
                        </>
                      ) : (
                        <div className="text-slate-500 mt-1">Slot skipped gracefully ({dec.reason || 'unfilled'})</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB: EARNINGS & PAYOUTS */}
      {tab === 'earnings' && earnings && (
        <div className="grid lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleRequestWithdrawal}
            className="lg:col-span-4 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 bg-white dark:bg-slate-900 space-y-3.5"
          >
            <h2 className="text-base font-semibold">Request Payout Withdrawal</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Minimum threshold: <span className="font-mono">{formatMicros(earnings.minPayoutMicros)}</span>.
              Finalized available: <span className="font-mono">{formatMicros(earnings.wallet.available_micros)}</span>.
            </p>
            <div>
              <label className="block text-xs font-medium mb-1">Withdrawal Amount (USD)</label>
              <input
                type="number"
                min="1"
                required
                value={withdrawUsd}
                onChange={(e) => setWithdrawUsd(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg"
            >
              Submit Withdrawal Request
            </button>
          </form>

          <div className="lg:col-span-8 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Publisher Revenue Ledger
            </div>
            <div className="overflow-x-auto">
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
                  {earnings.ledger.map((l) => (
                    <tr key={l.id}>
                      <td className="py-2.5 px-3 sm:px-4 font-mono whitespace-nowrap">{l.entry_type}</td>
                      <td className="py-2.5 px-3 sm:px-4 text-slate-600 dark:text-slate-300 min-w-[180px]">{l.description}</td>
                      <td className="py-2.5 px-3 sm:px-4 text-right font-mono tabular-nums whitespace-nowrap">
                        {l.direction === 'credit' ? '+' : '-'}{formatMicros(l.amount_micros)}
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
      )}

      {/* TAB: PAYOUT SETTINGS */}
      {tab === 'payouts' && earnings && (
        <div className="grid lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleSavePayoutMethod}
            className="lg:col-span-5 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 bg-white dark:bg-slate-900 space-y-3.5"
          >
            <h2 className="text-base font-semibold">Payout Method & Thresholds</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Minimum payout threshold is <span className="font-mono">{formatMicros(earnings.minPayoutMicros)}</span>. Invalid traffic deductions ({formatMicros(earnings.wallet.invalid_deducted_micros)} lifetime) are excluded prior to payout eligibility.
            </p>
            <div>
              <label className="block text-xs font-medium mb-1">Settlement Method</label>
              <select
                value={payoutMethodType}
                onChange={(e) => setPayoutMethodType(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="bank_transfer">International Bank Transfer</option>
                <option value="paystack">Paystack Settlement</option>
                <option value="flutterwave">Flutterwave Payout</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Destination Account / IBAN</label>
              <input
                type="text"
                value={payoutDestination}
                onChange={(e) => setPayoutDestination(e.target.value)}
                placeholder="IBAN / Settlement Account Reference"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <button
              type="submit"
              className="w-full sm:w-auto px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg"
            >
              Save Payout Method
            </button>
          </form>

          <div className="lg:col-span-7 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold">
              Withdrawal & Payment History
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 whitespace-nowrap">
                  <tr>
                    <th className="py-2.5 px-3 sm:px-4">ID</th>
                    <th className="py-2.5 px-3 sm:px-4">Method & Destination</th>
                    <th className="py-2.5 px-3 sm:px-4">Status</th>
                    <th className="py-2.5 px-3 sm:px-4 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 whitespace-nowrap">
                  {earnings.withdrawals.map((w) => (
                    <tr key={w.id}>
                      <td className="py-2.5 px-3 sm:px-4 font-mono">{w.id}</td>
                      <td className="py-2.5 px-3 sm:px-4">{w.payout_method} · {w.payout_destination}</td>
                      <td className="py-2.5 px-3 sm:px-4 capitalize">{w.status}</td>
                      <td className="py-2.5 px-3 sm:px-4 text-right font-mono tabular-nums font-semibold">
                        {formatMicros(w.amount_micros)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
