import React, { useEffect, useState } from 'react';
import { Pause, Play, Copy, Archive, Download, Wallet, Upload, Flag, Pencil, X, Plus, Info } from 'lucide-react';
import { apiRequest, extractFieldErrors, formatMicros, formatNumber, formatPct, getAuthToken } from '../lib/api';
import {
  AdvertiserDailyPoint,
  AdvertiserPerformanceTrendChart,
  CampaignComparisonChart,
} from './AdvertiserPerformanceCharts';
import {
  DEFAULT_IMAGE_ASSET,
  applyFormatChange,
  getAdFormatSpec,
  validateCreativeForFormat,
} from '../lib/adFormats';
import { LiveAdPreview } from './LiveAdPreview';
import { FieldError, fieldBorderClass } from './FieldError';
import {
  type FieldErrors,
  validateAppealInput,
  validateBudgetBiddingInput,
  validateCampaignCreateInput,
  validateDepositInput,
  validateMediaUploadFile,
  validateRefundInput,
  validateTargetingFields,
} from '../lib/validation';

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
  tracking_params?: string;
  dimensions?: string;
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

  const createInitialForm = () => ({
    name: '',
    objective: 'website_traffic',
    pricingModel: 'CPC',
    biddingStrategy: 'manual',
    startDate: '2026-01-01',
    endDate: '2027-12-31',
    dailyBudgetUsd: 100,
    totalBudgetUsd: 1000,
    maxBidUsd: 1.35,
    pacingMode: 'standard',
    format: 'native',
    dimensions: 'responsive',
    title: '',
    description: '',
    mediaUrl: DEFAULT_IMAGE_ASSET,
    destinationUrl: 'https://atlascommerce.io/offer',
    ctaText: 'Explore Offer',
    trackingParams: 'utm_source=looma&utm_medium=native',
    countries: 'US,GB,DE,NG,ALL',
    deviceCategories: 'desktop,mobile',
    contextualCategories: 'business_finance,news_technology,ALL',
    consentRequired: true,
  });

  // Campaign + Creative + Targeting Builder & Editor state
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [savingCampaign, setSavingCampaign] = useState(false);
  const [form, setForm] = useState(createInitialForm);

  // Deposit & Refund state
  const [depositAmount, setDepositAmount] = useState('250');
  const [depositProvider, setDepositProvider] = useState('paystack');
  const [depositMsg, setDepositMsg] = useState<string | null>(null);
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

  // Field-level inline validation states
  const [studioErrors, setStudioErrors] = useState<FieldErrors>({});
  const [appealErrors, setAppealErrors] = useState<FieldErrors>({});
  const [targetErrors, setTargetErrors] = useState<FieldErrors>({});
  const [budgetErrors, setBudgetErrors] = useState<FieldErrors>({});
  const [billingErrors, setBillingErrors] = useState<FieldErrors>({});

  const clearStudioError = (key: string) =>
    setStudioErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  const clearTargetError = (key: string) =>
    setTargetErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  const clearBudgetError = (key: string) =>
    setBudgetErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  const clearBillingError = (key: string) =>
    setBillingErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
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

  useEffect(() => {
    setActionMsg(null);
    setError(null);
    setDepositMsg(null);
    setStudioErrors({});
    setAppealErrors({});
    setTargetErrors({});
    setBudgetErrors({});
    setBillingErrors({});
  }, [tab]);

  useEffect(() => {
    if (!actionMsg) return;
    const timer = window.setTimeout(() => setActionMsg(null), 5000);
    return () => window.clearTimeout(timer);
  }, [actionMsg]);

  useEffect(() => {
    if (!depositMsg) return;
    const timer = window.setTimeout(() => setDepositMsg(null), 6000);
    return () => window.clearTimeout(timer);
  }, [depositMsg]);

  function parseJsonList(raw?: string, fallback = '') {
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.join(', ') : fallback;
    } catch {
      return fallback;
    }
  }

  function startEditingCampaign(cmpRow: CampaignRow) {
    const spec = getAdFormatSpec(cmpRow.ad_format || 'native');
    const allowedDims = spec.dimensionsOptions.map((d) => d.value);
    const resolvedDims =
      cmpRow.dimensions && allowedDims.includes(cmpRow.dimensions)
        ? cmpRow.dimensions
        : spec.defaultDimensions;

    setEditingCampaignId(cmpRow.id);
    setSelectedCampaignId(cmpRow.id);
    setError(null);
    setActionMsg(null);
    setStudioErrors({});
    setForm({
      name: cmpRow.name || '',
      objective: cmpRow.objective || 'website_traffic',
      pricingModel: cmpRow.pricing_model || 'CPC',
      biddingStrategy: cmpRow.bidding_strategy || 'manual',
      startDate: cmpRow.start_date || '2026-01-01',
      endDate: cmpRow.end_date || '2027-12-31',
      dailyBudgetUsd: Number((cmpRow.daily_budget_micros / 1_000_000).toFixed(2)),
      totalBudgetUsd: Number((cmpRow.total_budget_micros / 1_000_000).toFixed(2)),
      maxBidUsd: Number((cmpRow.max_bid_micros / 1_000_000).toFixed(2)),
      pacingMode: cmpRow.pacing_mode || 'standard',
      format: spec.format,
      dimensions: resolvedDims,
      title: cmpRow.creative_title || '',
      description: cmpRow.creative_description || '',
      mediaUrl: spec.mediaMode === 'none' ? '' : cmpRow.media_url || '',
      destinationUrl: cmpRow.destination_url || 'https://atlascommerce.io/offer',
      ctaText: cmpRow.cta_text || spec.defaultCta,
      trackingParams: cmpRow.tracking_params || `utm_source=looma&utm_medium=${spec.format}`,
      countries: parseJsonList(cmpRow.countries_json, 'ALL'),
      deviceCategories: parseJsonList(cmpRow.device_categories_json, 'desktop, mobile'),
      contextualCategories: parseJsonList(cmpRow.contextual_categories_json, 'ALL'),
      consentRequired: cmpRow.consent_required !== 0,
    });
    setTab('studio');
  }

  function cancelEditingCampaign() {
    setEditingCampaignId(null);
    setForm(createInitialForm());
    setStudioErrors({});
    setError(null);
    setActionMsg(null);
  }

  async function handleSaveCampaignForm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setActionMsg(null);
    setStudioErrors({});

    const check = validateCampaignCreateInput({
      ...form,
      enforceFormatMedia: true,
    });
    const mergedErrors: FieldErrors = { ...check.errors };

    const spec = getAdFormatSpec(form.format);
    if (!mergedErrors.title && form.title.trim().length > spec.titleMaxLength) {
      mergedErrors.title = `${spec.titleLabel} must be ${spec.titleMaxLength} characters or fewer for ${spec.label}.`;
    }
    if (!mergedErrors.description && form.description.trim().length > spec.descriptionMaxLength) {
      mergedErrors.description = `${spec.descriptionLabel} must be ${spec.descriptionMaxLength} characters or fewer for ${spec.label}.`;
    }
    const formatValidationError = validateCreativeForFormat({
      format: form.format,
      title: form.title,
      description: form.description,
      mediaUrl: form.mediaUrl,
    });
    if (formatValidationError && !mergedErrors.mediaUrl && !mergedErrors.title && !mergedErrors.description) {
      mergedErrors.mediaUrl = formatValidationError;
    }

    if (Object.keys(mergedErrors).length > 0) {
      setStudioErrors(mergedErrors);
      setError(Object.values(mergedErrors)[0]);
      return;
    }

    const countriesArr = form.countries.split(',').map((s) => s.trim()).filter(Boolean);
    const devicesArr = form.deviceCategories.split(',').map((s) => s.trim()).filter(Boolean);
    const contextualArr = form.contextualCategories.split(',').map((s) => s.trim()).filter(Boolean);

    setSavingCampaign(true);
    try {
      if (editingCampaignId) {
        const currentRow = campaigns.find((c) => c.id === editingCampaignId);
        await apiRequest<{ updated: boolean; id: string }>(`/api/advertiser/campaigns/${editingCampaignId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: form.name,
            objective: form.objective,
            pricingModel: form.pricingModel,
            biddingStrategy: form.biddingStrategy,
            startDate: form.startDate,
            endDate: form.endDate,
            dailyBudgetUsd: Number(form.dailyBudgetUsd),
            totalBudgetUsd: Number(form.totalBudgetUsd),
            maxBidUsd: Number(form.maxBidUsd),
            pacingMode: form.pacingMode,
            format: form.format,
            dimensions: form.dimensions,
            title: form.title,
            description: form.description,
            mediaUrl: form.format === 'text' ? '' : form.mediaUrl,
            destinationUrl: form.destinationUrl,
            ctaText: form.ctaText,
            trackingParams: form.trackingParams,
            targeting: {
              countries: countriesArr.length > 0 ? countriesArr : ['ALL'],
              languages: parseJsonList(currentRow?.languages_json, 'en')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              deviceCategories: devicesArr.length > 0 ? devicesArr : ['desktop', 'mobile'],
              operatingSystems: parseJsonList(currentRow?.operating_systems_json, 'ALL')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              browsers: parseJsonList(currentRow?.browsers_json, 'ALL')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              contextualCategories: contextualArr.length > 0 ? contextualArr : ['ALL'],
              interestCategories: parseJsonList(currentRow?.interest_categories_json, '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              retargetingEnabled: Boolean(currentRow?.retargeting_enabled),
              consentRequired: form.consentRequired,
            },
          }),
        });
        setActionMsg(`Campaign "${form.name}" (${editingCampaignId}) updated successfully.`);
        setEditingCampaignId(null);
        setForm(createInitialForm());
        setTab('campaigns');
        await loadAll();
      } else {
        const res = await apiRequest<{ campaignId: string }>('/api/advertiser/campaigns', {
          method: 'POST',
          body: JSON.stringify({
            ...form,
            mediaUrl: form.format === 'text' ? '' : form.mediaUrl,
            countries: countriesArr.length > 0 ? countriesArr : ['ALL'],
            deviceCategories: devicesArr.length > 0 ? devicesArr : ['desktop', 'mobile'],
            contextualCategories: contextualArr.length > 0 ? contextualArr : ['ALL'],
          }),
        });
        setActionMsg(`Campaign ${res.campaignId} created and submitted to moderation queue.`);
        setForm(createInitialForm());
        setTab('campaigns');
        await loadAll();
      }
    } catch (err) {
      const fe = extractFieldErrors(err);
      if (Object.keys(fe).length > 0) setStudioErrors(fe);
      setError(err instanceof Error ? err.message : editingCampaignId ? 'Failed to update campaign' : 'Failed to create campaign');
    } finally {
      setSavingCampaign(false);
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
    const fileErr = validateMediaUploadFile(file, form.format);
    if (fileErr) {
      setStudioErrors((prev) => ({ ...prev, mediaUrl: fileErr }));
      setError(fileErr);
      e.target.value = '';
      return;
    }
    clearStudioError('mediaUrl');
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
      setForm((prev) => {
        if (res.mimeType.startsWith('video/')) {
          return {
            ...applyFormatChange(prev, 'video', { isEditing: Boolean(editingCampaignId) }),
            mediaUrl: res.url,
          };
        }
        return {
          ...prev,
          mediaUrl: res.url,
        };
      });
      setActionMsg(`Uploaded ${res.originalName} and linked to creative preview.`);
      await loadAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Media upload failed';
      setStudioErrors((prev) => ({ ...prev, mediaUrl: msg }));
      setError(msg);
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
    setAppealErrors({});
    const check = validateAppealInput({ reason: appealReason });
    if (!check.valid) {
      setAppealErrors(check.errors);
      return;
    }
    try {
      await apiRequest(`/api/advertiser/campaigns/${appealTarget.id}/appeal`, {
        method: 'POST',
        body: JSON.stringify({ reason: check.value!.reason }),
      });
      setActionMsg(`Policy appeal submitted for ${appealTarget.name}.`);
      setAppealTarget(null);
      setAppealReason('');
      await loadAll();
    } catch (err) {
      const fe = extractFieldErrors(err);
      if (Object.keys(fe).length > 0) setAppealErrors(fe);
      setError(err instanceof Error ? err.message : 'Unable to submit appeal');
    }
  }

  async function handleDeposit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setActionMsg(null);
    setDepositMsg(null);
    setLiveCheckoutUrl(null);
    setBillingErrors((prev) => {
      const next = { ...prev };
      delete next.amountUsd;
      delete next.provider;
      return next;
    });
    const check = validateDepositInput({
      amountUsd: depositAmount,
      provider: depositProvider,
    });
    if (!check.valid) {
      setBillingErrors((prev) => ({ ...prev, ...check.errors }));
      return;
    }
    const providerLabels: Record<string, string> = {
      paystack: 'Paystack',
      flutterwave: 'Flutterwave',
      bank_transfer: 'Bank Transfer',
    };
    const providerLabel = providerLabels[depositProvider] || depositProvider;
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
          amountUsd: check.value!.amountUsd,
          provider: check.value!.provider,
        }),
      });
      if (res.mode === 'live') {
        setLiveCheckoutUrl(res.checkoutUrl || null);
        setDepositMsg(
          `${providerLabel} checkout initialized (${res.providerRef}). Complete payment to credit your wallet.`
        );
      } else {
        setDepositMsg(
          `$${check.value!.amountUsd.toFixed(2)} credited via ${providerLabel}. Receipt ${res.invoiceNumber || res.depositId} added to your ledger.`
        );
      }
      await loadAll();
    } catch (err) {
      const fe = extractFieldErrors(err);
      if (Object.keys(fe).length > 0) setBillingErrors((prev) => ({ ...prev, ...fe }));
      setError(err instanceof Error ? err.message : 'Deposit failed');
    }
  }

  async function handleRefund(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setActionMsg(null);
    clearBillingError('refundAmount');
    const check = validateRefundInput({
      amountUsd: refundAmount,
      maxAvailableUsd: billing ? billing.wallet.available_micros / 1_000_000 : undefined,
    });
    if (!check.valid) {
      setBillingErrors((prev) => ({ ...prev, refundAmount: check.errors.amountUsd || check.firstError || 'Invalid refund amount.' }));
      return;
    }
    try {
      const res = await apiRequest<{ refundId: string }>('/api/advertiser/refund', {
        method: 'POST',
        body: JSON.stringify({ amountUsd: check.value!.amountUsd }),
      });
      setActionMsg(`Refund ${res.refundId} processed and recorded in financial ledger.`);
      await loadAll();
    } catch (err) {
      const fe = extractFieldErrors(err);
      if (fe.amountUsd) setBillingErrors((prev) => ({ ...prev, refundAmount: fe.amountUsd }));
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
    setTargetErrors({});
    const check = validateTargetingFields(targetEdit);
    if (!check.valid) {
      setTargetErrors(check.errors);
      return;
    }
    try {
      await apiRequest(`/api/advertiser/campaigns/${selectedCampaignId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          targeting: {
            ...check.value!,
            retargetingEnabled: targetEdit.retargetingEnabled,
            consentRequired: targetEdit.consentRequired,
          },
        }),
      });
      setActionMsg(`Audience targeting updated for campaign ${selectedCampaignId}.`);
      await loadAll();
    } catch (err) {
      const fe = extractFieldErrors(err);
      if (Object.keys(fe).length > 0) setTargetErrors(fe);
      setError(err instanceof Error ? err.message : 'Failed to update audience targeting');
    }
  }

  async function handleSaveBudgetBidding(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCampaignId) return;
    setError(null);
    setActionMsg(null);
    setBudgetErrors({});
    const currentCampaign = campaigns.find((c) => c.id === selectedCampaignId);
    const check = validateBudgetBiddingInput({
      ...budgetEdit,
      pricingModel: currentCampaign?.pricing_model,
    });
    if (!check.valid) {
      setBudgetErrors(check.errors);
      return;
    }
    try {
      await apiRequest(`/api/advertiser/campaigns/${selectedCampaignId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          biddingStrategy: check.value!.biddingStrategy,
          maxBidUsd: check.value!.maxBidUsd,
          dailyBudgetUsd: check.value!.dailyBudgetUsd,
          totalBudgetUsd: check.value!.totalBudgetUsd,
          pacingMode: check.value!.pacingMode,
          startDate: check.value!.startDate,
          endDate: check.value!.endDate,
        }),
      });
      setActionMsg(`Budget & bidding rules saved for campaign ${selectedCampaignId}.`);
      await loadAll();
    } catch (err) {
      const fe = extractFieldErrors(err);
      if (Object.keys(fe).length > 0) setBudgetErrors(fe);
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
          <div className="px-4 sm:px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">Campaign Inventory</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Click Edit on any campaign to update its name, format, dimensions, creative copy, budget, or targeting.
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {campaigns.length} {campaigns.length === 1 ? 'campaign' : 'campaigns'}
              </span>
              <button
                type="button"
                onClick={() => {
                  cancelEditingCampaign();
                  setTab('studio');
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Campaign</span>
              </button>
            </div>
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
                        <span className="capitalize font-medium text-slate-700 dark:text-slate-300">{c.ad_format}</span>
                        {c.dimensions ? ` (${c.dimensions})` : ''} · {c.objective.replace(/_/g, ' ')} · {c.start_date} to {c.end_date}
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
                        <button
                          type="button"
                          onClick={() => startEditingCampaign(c)}
                          title={`Edit ${c.name}`}
                          aria-label={`Edit ${c.name}`}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 bg-blue-50/60 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
                        >
                          <Pencil className="w-3 h-3" />
                          <span>Edit</span>
                        </button>
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
              noValidate
              className="p-5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-slate-900 dark:text-white">
                  Submit Policy Appeal — {appealTarget.name}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setAppealTarget(null);
                    setAppealErrors({});
                  }}
                  className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                >
                  Cancel
                </button>
              </div>
              <div>
                <textarea
                  id="appeal-reason"
                  rows={3}
                  required
                  minLength={10}
                  value={appealReason}
                  onChange={(e) => {
                    setAppealReason(e.target.value);
                    setAppealErrors({});
                  }}
                  aria-invalid={Boolean(appealErrors.reason)}
                  aria-describedby={appealErrors.reason ? 'appeal-reason-err' : undefined}
                  placeholder="Explain creative adjustments, regulatory licenses, or landing page compliance details for moderation review."
                  className={`w-full px-3 py-2 text-sm rounded-lg border ${fieldBorderClass(Boolean(appealErrors.reason))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="appeal-reason-err" message={appealErrors.reason} />
              </div>
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

      {/* TAB: AD CREATION & EDITING STUDIO */}
      {tab === 'studio' && (() => {
        const formatSpec = getAdFormatSpec(form.format);
        const filteredUploadedAssets = uploadedAssets.filter((asset) =>
          formatSpec.mediaMode === 'video'
            ? asset.mime_type.startsWith('video/')
            : formatSpec.mediaMode === 'image'
            ? asset.mime_type.startsWith('image/')
            : false
        );

        return (
          <div className="grid lg:grid-cols-12 gap-6 items-start">
            <form
              onSubmit={handleSaveCampaignForm}
              noValidate
              className="lg:col-span-7 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-slate-900 space-y-5"
            >
              {/* Mode header: Create vs Edit Existing */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {editingCampaignId ? 'Edit Existing Campaign' : 'Create Campaign, Targeting & Ad Creative'}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    {editingCampaignId
                      ? `Updating campaign ${editingCampaignId} — changes save directly to the database.`
                      : 'Select an ad format below to unlock format-specific dimensions, media controls, and live previews.'}
                  </p>
                </div>

                {campaigns.length > 0 && (
                  <div className="flex items-center gap-2">
                    <label htmlFor="studio-edit-picker" className="sr-only">
                      Load existing campaign to edit
                    </label>
                    <select
                      id="studio-edit-picker"
                      value={editingCampaignId || ''}
                      onChange={(e) => {
                        const id = e.target.value;
                        if (!id) {
                          cancelEditingCampaign();
                          return;
                        }
                        const found = campaigns.find((c) => c.id === id);
                        if (found) startEditingCampaign(found);
                      }}
                      className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 max-w-[230px]"
                    >
                      <option value="">+ New Campaign</option>
                      {campaigns.map((c) => (
                        <option key={c.id} value={c.id}>
                          Edit: {c.name} ({c.ad_format})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {editingCampaignId && (
                <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 rounded-lg border border-blue-200 dark:border-blue-900/70 bg-blue-50/70 dark:bg-blue-950/30 text-xs">
                  <div className="flex items-center gap-2 text-blue-900 dark:text-blue-200">
                    <Pencil className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      Editing <strong>{form.name || editingCampaignId}</strong> ({editingCampaignId})
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={cancelEditingCampaign}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-blue-300 dark:border-blue-800 text-blue-800 dark:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-900/50 font-medium"
                  >
                    <X className="w-3 h-3" />
                    <span>Cancel Edit</span>
                  </button>
                </div>
              )}

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
                    onChange={(e) => {
                      setForm({ ...form, name: e.target.value });
                      clearStudioError('name');
                    }}
                    aria-invalid={Boolean(studioErrors.name)}
                    aria-describedby={studioErrors.name ? 'cmp-name-err' : undefined}
                    placeholder="Q4 Enterprise Cloud Launch"
                    className={`w-full min-w-0 px-3 py-2 text-sm rounded-lg border ${fieldBorderClass(Boolean(studioErrors.name))} bg-white dark:bg-slate-950`}
                  />
                  <FieldError id="cmp-name-err" message={studioErrors.name} />
                </div>
                <div className="min-w-0">
                  <label htmlFor="cmp-obj" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Advertising Objective
                  </label>
                  <select
                    id="cmp-obj"
                    value={form.objective}
                    onChange={(e) => {
                      setForm({ ...form, objective: e.target.value });
                      clearStudioError('objective');
                    }}
                    aria-invalid={Boolean(studioErrors.objective)}
                    aria-describedby={studioErrors.objective ? 'cmp-obj-err' : undefined}
                    className={`w-full min-w-0 px-3 py-2 text-sm rounded-lg border ${fieldBorderClass(Boolean(studioErrors.objective))} bg-white dark:bg-slate-950`}
                  >
                    <option value="brand_awareness">Brand Awareness</option>
                    <option value="website_traffic">Website Traffic</option>
                    <option value="lead_generation">Lead Generation</option>
                    <option value="sales_conversions">Sales & Conversions</option>
                    <option value="app_installs">App Installations</option>
                    <option value="video_views">Video Views</option>
                    <option value="product_promotion">Product Promotion</option>
                  </select>
                  <FieldError id="cmp-obj-err" message={studioErrors.objective} />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label htmlFor="cmp-model" className="block text-xs font-medium mb-1">Pricing Model</label>
                  <select
                    id="cmp-model"
                    value={form.pricingModel}
                    onChange={(e) => {
                      setForm({ ...form, pricingModel: e.target.value });
                      clearStudioError('pricingModel');
                      clearStudioError('maxBidUsd');
                    }}
                    className={`w-full px-3 py-2 text-sm rounded-lg border ${fieldBorderClass(Boolean(studioErrors.pricingModel))} bg-white dark:bg-slate-950`}
                  >
                    <option value="CPC">CPC</option>
                    <option value="CPM">CPM</option>
                    <option value="CPA">CPA</option>
                    <option value="CPI">CPI</option>
                    <option value="CPV">CPV</option>
                    <option value="FIXED">FIXED</option>
                  </select>
                  <FieldError id="cmp-model-err" message={studioErrors.pricingModel} />
                </div>
                <div>
                  <label htmlFor="cmp-bid" className="block text-xs font-medium mb-1">Max Bid (USD)</label>
                  <input
                    id="cmp-bid"
                    type="number"
                    step="0.05"
                    min="0.05"
                    required
                    value={form.maxBidUsd}
                    onChange={(e) => {
                      setForm({ ...form, maxBidUsd: Number(e.target.value) });
                      clearStudioError('maxBidUsd');
                    }}
                    aria-invalid={Boolean(studioErrors.maxBidUsd)}
                    aria-describedby={studioErrors.maxBidUsd ? 'cmp-bid-err' : undefined}
                    className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(studioErrors.maxBidUsd))} bg-white dark:bg-slate-950`}
                  />
                  <FieldError id="cmp-bid-err" message={studioErrors.maxBidUsd} />
                </div>
                <div>
                  <label htmlFor="cmp-daily" className="block text-xs font-medium mb-1">Daily Budget ($)</label>
                  <input
                    id="cmp-daily"
                    type="number"
                    min="5"
                    required
                    value={form.dailyBudgetUsd}
                    onChange={(e) => {
                      setForm({ ...form, dailyBudgetUsd: Number(e.target.value) });
                      clearStudioError('dailyBudgetUsd');
                      clearStudioError('totalBudgetUsd');
                      clearStudioError('maxBidUsd');
                    }}
                    aria-invalid={Boolean(studioErrors.dailyBudgetUsd)}
                    aria-describedby={studioErrors.dailyBudgetUsd ? 'cmp-daily-err' : undefined}
                    className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(studioErrors.dailyBudgetUsd))} bg-white dark:bg-slate-950`}
                  />
                  <FieldError id="cmp-daily-err" message={studioErrors.dailyBudgetUsd} />
                </div>
                <div>
                  <label htmlFor="cmp-total" className="block text-xs font-medium mb-1">Total Budget ($)</label>
                  <input
                    id="cmp-total"
                    type="number"
                    min="5"
                    required
                    value={form.totalBudgetUsd}
                    onChange={(e) => {
                      setForm({ ...form, totalBudgetUsd: Number(e.target.value) });
                      clearStudioError('totalBudgetUsd');
                    }}
                    aria-invalid={Boolean(studioErrors.totalBudgetUsd)}
                    aria-describedby={studioErrors.totalBudgetUsd ? 'cmp-total-err' : undefined}
                    className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(studioErrors.totalBudgetUsd))} bg-white dark:bg-slate-950`}
                  />
                  <FieldError id="cmp-total-err" message={studioErrors.totalBudgetUsd} />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label htmlFor="cmp-bidding" className="block text-xs font-medium mb-1">Bidding Strategy</label>
                  <select
                    id="cmp-bidding"
                    value={form.biddingStrategy}
                    onChange={(e) => {
                      setForm({ ...form, biddingStrategy: e.target.value });
                      clearStudioError('biddingStrategy');
                    }}
                    className={`w-full px-3 py-2 text-sm rounded-lg border ${fieldBorderClass(Boolean(studioErrors.biddingStrategy))} bg-white dark:bg-slate-950`}
                  >
                    <option value="manual">Manual Bid</option>
                    <option value="auto_cpc">Auto CPC</option>
                    <option value="target_cpa">Target CPA</option>
                  </select>
                  <FieldError id="cmp-bidding-err" message={studioErrors.biddingStrategy} />
                </div>
                <div>
                  <label htmlFor="cmp-pacing" className="block text-xs font-medium mb-1">Pacing</label>
                  <select
                    id="cmp-pacing"
                    value={form.pacingMode}
                    onChange={(e) => {
                      setForm({ ...form, pacingMode: e.target.value });
                      clearStudioError('pacingMode');
                    }}
                    className={`w-full px-3 py-2 text-sm rounded-lg border ${fieldBorderClass(Boolean(studioErrors.pacingMode))} bg-white dark:bg-slate-950`}
                  >
                    <option value="standard">Standard</option>
                    <option value="accelerated">Accelerated</option>
                  </select>
                  <FieldError id="cmp-pacing-err" message={studioErrors.pacingMode} />
                </div>
                <div>
                  <label htmlFor="cmp-start" className="block text-xs font-medium mb-1">Start Date</label>
                  <input
                    id="cmp-start"
                    type="date"
                    value={form.startDate}
                    onChange={(e) => {
                      setForm({ ...form, startDate: e.target.value });
                      clearStudioError('startDate');
                      clearStudioError('endDate');
                    }}
                    aria-invalid={Boolean(studioErrors.startDate)}
                    aria-describedby={studioErrors.startDate ? 'cmp-start-err' : undefined}
                    className={`w-full px-2.5 py-2 text-xs font-mono rounded-lg border ${fieldBorderClass(Boolean(studioErrors.startDate))} bg-white dark:bg-slate-950`}
                  />
                  <FieldError id="cmp-start-err" message={studioErrors.startDate} />
                </div>
                <div>
                  <label htmlFor="cmp-end" className="block text-xs font-medium mb-1">End Date</label>
                  <input
                    id="cmp-end"
                    type="date"
                    value={form.endDate}
                    onChange={(e) => {
                      setForm({ ...form, endDate: e.target.value });
                      clearStudioError('endDate');
                    }}
                    aria-invalid={Boolean(studioErrors.endDate)}
                    aria-describedby={studioErrors.endDate ? 'cmp-end-err' : undefined}
                    className={`w-full px-2.5 py-2 text-xs font-mono rounded-lg border ${fieldBorderClass(Boolean(studioErrors.endDate))} bg-white dark:bg-slate-950`}
                  />
                  <FieldError id="cmp-end-err" message={studioErrors.endDate} />
                </div>
              </div>

              {/* Creative Details — Dynamically adapts per Ad Format */}
              <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-slate-900 dark:text-white">
                    Creative Format & Assets
                  </div>
                  <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                    {formatSpec.label} · {form.dimensions}
                  </span>
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="min-w-0">
                    <label htmlFor="crt-format" className="block text-xs font-medium mb-1">Ad Format</label>
                    <select
                      id="crt-format"
                      value={form.format}
                      onChange={(e) =>
                        setForm((prev) =>
                          applyFormatChange(prev, e.target.value, { isEditing: Boolean(editingCampaignId) })
                        )
                      }
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

                  {/* Dynamic Dimensions / Aspect Ratio Selector */}
                  <div className="min-w-0">
                    <label htmlFor="crt-dimensions" className="block text-xs font-medium mb-1">
                      {formatSpec.format === 'video'
                        ? 'Video Aspect Ratio'
                        : formatSpec.format === 'banner'
                        ? 'IAB Banner Dimensions'
                        : 'Creative Dimensions'}
                    </label>
                    {formatSpec.dimensionsOptions.length > 1 ? (
                      <select
                        id="crt-dimensions"
                        value={form.dimensions}
                        onChange={(e) => setForm({ ...form, dimensions: e.target.value })}
                        className="w-full min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      >
                        {formatSpec.dimensionsOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div
                        id="crt-dimensions"
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-slate-600 dark:text-slate-300"
                      >
                        {formatSpec.dimensionsOptions[0]?.label || form.dimensions}
                      </div>
                    )}
                  </div>
                </div>

                {/* Format Specification Guidance Strip */}
                <div
                  data-testid="format-spec-banner"
                  className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 px-3.5 py-2.5 text-xs space-y-1"
                >
                  <div className="flex items-start gap-2 text-slate-700 dark:text-slate-200">
                    <Info className="w-3.5 h-3.5 mt-0.5 text-blue-600 dark:text-blue-400 shrink-0" />
                    <span>{formatSpec.summary}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-5 text-[11px] text-slate-500 dark:text-slate-400">
                    <span>
                      Placements: <strong className="font-mono text-slate-700 dark:text-slate-300">{formatSpec.compatiblePlacements.join(', ')}</strong>
                    </span>
                    <span>
                      Billing: <strong className="font-mono text-slate-700 dark:text-slate-300">{formatSpec.recommendedPricingModels.join(' / ')}</strong>
                    </span>
                  </div>
                </div>

                {/* Format-Specific Media Controls */}
                {formatSpec.mediaMode === 'none' ? (
                  <div
                    data-testid="text-ad-no-media-notice"
                    className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/40 px-3.5 py-3 text-xs text-slate-600 dark:text-slate-300"
                  >
                    <strong className="text-slate-900 dark:text-white">No Media Asset Required:</strong> Text Ads deliver purely as contextual text units (headline, display URL, description, and CTA) with zero image or video weight.
                  </div>
                ) : formatSpec.mediaMode === 'video' ? (
                  <div className="space-y-3" data-testid="video-media-controls">
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div className="min-w-0">
                        <label htmlFor="crt-video-library" className="block text-xs font-medium mb-1">
                          Uploaded Video Assets
                        </label>
                        <select
                          id="crt-video-library"
                          value={filteredUploadedAssets.some((a) => a.url === form.mediaUrl) ? form.mediaUrl : ''}
                          onChange={(e) => setForm({ ...form, mediaUrl: e.target.value })}
                          className="w-full min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        >
                          <option value="">
                            {filteredUploadedAssets.length > 0 ? 'Select uploaded video…' : 'No uploaded videos yet (upload below or paste URL)'}
                          </option>
                          {filteredUploadedAssets.map((asset) => (
                            <option key={asset.id} value={asset.url}>
                              Video: {asset.original_name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="min-w-0">
                        <label htmlFor="crt-video-url" className="block text-xs font-medium mb-1">
                          Direct Video URL (MP4 / WEBM)
                        </label>
                        <input
                          id="crt-video-url"
                          type="text"
                          value={form.mediaUrl}
                          onChange={(e) => {
                            setForm({ ...form, mediaUrl: e.target.value });
                            clearStudioError('mediaUrl');
                          }}
                          aria-invalid={Boolean(studioErrors.mediaUrl)}
                          aria-describedby={studioErrors.mediaUrl ? 'crt-media-err' : undefined}
                          placeholder="https://cdn.yourbrand.com/spot-15s.mp4"
                          className={`w-full min-w-0 px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(studioErrors.mediaUrl))} bg-white dark:bg-slate-950`}
                        />
                        <FieldError id="crt-media-err" message={studioErrors.mediaUrl} />
                      </div>
                    </div>

                    <div className="p-3.5 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="min-w-0 text-xs text-slate-600 dark:text-slate-300">
                        <div className="font-medium text-slate-900 dark:text-white">Upload Video Creative</div>
                        <div className="text-[11px] text-slate-500">{formatSpec.uploadHint}</div>
                      </div>
                      <label className="inline-flex items-center justify-center gap-1.5 px-3 py-2 sm:py-1.5 text-xs font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-lg cursor-pointer hover:opacity-90 shrink-0 w-full sm:w-auto">
                        <Upload className="w-3.5 h-3.5" />
                        <span>{uploadingMedia ? 'Uploading…' : 'Upload MP4 / WEBM'}</span>
                        <input
                          type="file"
                          accept={formatSpec.acceptMime}
                          onChange={handleMediaUpload}
                          disabled={uploadingMedia}
                          className="hidden"
                        />
                      </label>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3" data-testid="image-media-controls">
                    <div className="min-w-0">
                      <label htmlFor="crt-media" className="block text-xs font-medium mb-1">
                        Image Asset Library {formatSpec.mediaRequired ? '(Required)' : '(Optional)'}
                      </label>
                      <select
                        id="crt-media"
                        value={form.mediaUrl}
                        onChange={(e) => {
                          setForm({ ...form, mediaUrl: e.target.value });
                          clearStudioError('mediaUrl');
                        }}
                        aria-invalid={Boolean(studioErrors.mediaUrl)}
                        aria-describedby={studioErrors.mediaUrl ? 'crt-media-err' : undefined}
                        className={`w-full min-w-0 max-w-full px-3 py-2 text-sm rounded-lg border ${fieldBorderClass(Boolean(studioErrors.mediaUrl))} bg-white dark:bg-slate-950`}
                      >
                        <option value="/src/assets/images/creative_fintech_card_1795552815861.jpg">Corporate Card Asset</option>
                        <option value="/src/assets/images/creative_cloud_hardware_1795552815294.jpg">Workstation Asset</option>
                        <option value="/src/assets/images/creative_retail_sneaker_1795552816794.jpg">Retail Footwear Asset</option>
                        {filteredUploadedAssets.map((asset) => (
                          <option key={asset.id} value={asset.url}>
                            Uploaded: {asset.original_name}
                          </option>
                        ))}
                        {!formatSpec.mediaRequired && (
                          <option value="">No Image (Copy Only)</option>
                        )}
                      </select>
                      <FieldError id="crt-media-err" message={studioErrors.mediaUrl} />
                    </div>

                    <div className="p-3.5 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="min-w-0 text-xs text-slate-600 dark:text-slate-300">
                        <div className="font-medium text-slate-900 dark:text-white">Upload Custom Image Asset</div>
                        <div className="text-[11px] text-slate-500">{formatSpec.uploadHint}</div>
                      </div>
                      <label className="inline-flex items-center justify-center gap-1.5 px-3 py-2 sm:py-1.5 text-xs font-medium text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-lg cursor-pointer hover:opacity-90 shrink-0 w-full sm:w-auto">
                        <Upload className="w-3.5 h-3.5" />
                        <span>{uploadingMedia ? 'Uploading…' : 'Choose Image'}</span>
                        <input
                          type="file"
                          accept={formatSpec.acceptMime}
                          onChange={handleMediaUpload}
                          disabled={uploadingMedia}
                          className="hidden"
                        />
                      </label>
                    </div>
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label htmlFor="crt-title" className="block text-xs font-medium">
                      {formatSpec.titleLabel}
                    </label>
                    <span
                      className={`text-[11px] font-mono tabular-nums ${
                        form.title.length > formatSpec.titleMaxLength
                          ? 'text-amber-600 dark:text-amber-400 font-semibold'
                          : 'text-slate-400'
                      }`}
                    >
                      {form.title.length} / {formatSpec.titleMaxLength}
                    </span>
                  </div>
                  <input
                    id="crt-title"
                    type="text"
                    required
                    value={form.title}
                    onChange={(e) => {
                      setForm({ ...form, title: e.target.value });
                      clearStudioError('title');
                    }}
                    aria-invalid={Boolean(studioErrors.title)}
                    aria-describedby={studioErrors.title ? 'crt-title-err' : undefined}
                    placeholder={formatSpec.titlePlaceholder}
                    className={`w-full px-3 py-2 text-sm rounded-lg border ${fieldBorderClass(Boolean(studioErrors.title))} bg-white dark:bg-slate-950`}
                  />
                  <FieldError id="crt-title-err" message={studioErrors.title} />
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label htmlFor="crt-desc" className="block text-xs font-medium">
                      {formatSpec.descriptionLabel}
                    </label>
                    <span
                      className={`text-[11px] font-mono tabular-nums ${
                        form.description.length > formatSpec.descriptionMaxLength
                          ? 'text-amber-600 dark:text-amber-400 font-semibold'
                          : 'text-slate-400'
                      }`}
                    >
                      {form.description.length} / {formatSpec.descriptionMaxLength}
                    </span>
                  </div>
                  <textarea
                    id="crt-desc"
                    rows={formatSpec.format === 'sponsored' ? 3 : 2}
                    required
                    value={form.description}
                    onChange={(e) => {
                      setForm({ ...form, description: e.target.value });
                      clearStudioError('description');
                    }}
                    aria-invalid={Boolean(studioErrors.description)}
                    aria-describedby={studioErrors.description ? 'crt-desc-err' : undefined}
                    placeholder={formatSpec.descriptionPlaceholder}
                    className={`w-full px-3 py-2 text-sm rounded-lg border ${fieldBorderClass(Boolean(studioErrors.description))} bg-white dark:bg-slate-950`}
                  />
                  <FieldError id="crt-desc-err" message={studioErrors.description} />
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="crt-url" className="block text-xs font-medium mb-1">Destination URL</label>
                    <input
                      id="crt-url"
                      type="url"
                      required
                      value={form.destinationUrl}
                      onChange={(e) => {
                        setForm({ ...form, destinationUrl: e.target.value });
                        clearStudioError('destinationUrl');
                      }}
                      aria-invalid={Boolean(studioErrors.destinationUrl)}
                      aria-describedby={studioErrors.destinationUrl ? 'crt-url-err' : undefined}
                      className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(studioErrors.destinationUrl))} bg-white dark:bg-slate-950`}
                    />
                    <FieldError id="crt-url-err" message={studioErrors.destinationUrl} />
                  </div>
                  <div>
                    <label htmlFor="crt-cta" className="block text-xs font-medium mb-1">Call to Action</label>
                    <input
                      id="crt-cta"
                      type="text"
                      required
                      value={form.ctaText}
                      onChange={(e) => {
                        setForm({ ...form, ctaText: e.target.value });
                        clearStudioError('ctaText');
                      }}
                      aria-invalid={Boolean(studioErrors.ctaText)}
                      aria-describedby={studioErrors.ctaText ? 'crt-cta-err' : undefined}
                      placeholder={formatSpec.defaultCta}
                      className={`w-full px-3 py-2 text-sm rounded-lg border ${fieldBorderClass(Boolean(studioErrors.ctaText))} bg-white dark:bg-slate-950`}
                    />
                    <FieldError id="crt-cta-err" message={studioErrors.ctaText} />
                  </div>
                </div>
                <div>
                  <label htmlFor="crt-tracking" className="block text-xs font-medium mb-1">
                    Tracking Parameters (UTM Query String)
                  </label>
                  <input
                    id="crt-tracking"
                    type="text"
                    value={form.trackingParams}
                    onChange={(e) => {
                      setForm({ ...form, trackingParams: e.target.value });
                      clearStudioError('trackingParams');
                    }}
                    aria-invalid={Boolean(studioErrors.trackingParams)}
                    aria-describedby={studioErrors.trackingParams ? 'crt-tracking-err' : undefined}
                    placeholder={`utm_source=looma&utm_medium=${formatSpec.format}`}
                    className={`w-full px-3 py-2 text-xs font-mono rounded-lg border ${fieldBorderClass(Boolean(studioErrors.trackingParams))} bg-white dark:bg-slate-950`}
                  />
                  <FieldError id="crt-tracking-err" message={studioErrors.trackingParams} />
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
                      onChange={(e) => {
                        setForm({ ...form, countries: e.target.value });
                        clearStudioError('countries');
                      }}
                      aria-invalid={Boolean(studioErrors.countries)}
                      aria-describedby={studioErrors.countries ? 'tgt-countries-err' : undefined}
                      className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(studioErrors.countries))} bg-white dark:bg-slate-950`}
                    />
                    <FieldError id="tgt-countries-err" message={studioErrors.countries} />
                  </div>
                  <div>
                    <label htmlFor="tgt-devices" className="block text-xs font-medium mb-1">Devices</label>
                    <input
                      id="tgt-devices"
                      type="text"
                      value={form.deviceCategories}
                      onChange={(e) => {
                        setForm({ ...form, deviceCategories: e.target.value });
                        clearStudioError('deviceCategories');
                      }}
                      aria-invalid={Boolean(studioErrors.deviceCategories)}
                      aria-describedby={studioErrors.deviceCategories ? 'tgt-devices-err' : undefined}
                      className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(studioErrors.deviceCategories))} bg-white dark:bg-slate-950`}
                    />
                    <FieldError id="tgt-devices-err" message={studioErrors.deviceCategories} />
                  </div>
                </div>
                <div>
                  <label htmlFor="tgt-context" className="block text-xs font-medium mb-1">Contextual Categories</label>
                  <input
                    id="tgt-context"
                    type="text"
                    value={form.contextualCategories}
                    onChange={(e) => {
                      setForm({ ...form, contextualCategories: e.target.value });
                      clearStudioError('contextualCategories');
                    }}
                    aria-invalid={Boolean(studioErrors.contextualCategories)}
                    aria-describedby={studioErrors.contextualCategories ? 'tgt-context-err' : undefined}
                    className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(studioErrors.contextualCategories))} bg-white dark:bg-slate-950`}
                  />
                  <FieldError id="tgt-context-err" message={studioErrors.contextualCategories} />
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

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={savingCampaign}
                  className="w-full sm:w-auto px-5 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors disabled:opacity-60"
                >
                  {savingCampaign
                    ? 'Saving…'
                    : editingCampaignId
                    ? 'Save Campaign Changes'
                    : 'Submit Campaign for Review'}
                </button>
                {editingCampaignId && (
                  <button
                    type="button"
                    onClick={cancelEditingCampaign}
                    className="w-full sm:w-auto px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>

            {/* Format-Adaptive Live Creative Preview */}
            <div className="lg:col-span-5 lg:sticky lg:top-6 min-w-0 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-slate-900">
              <LiveAdPreview
                format={form.format}
                dimensions={form.dimensions}
                pricingModel={form.pricingModel}
                title={form.title}
                description={form.description}
                mediaUrl={form.mediaUrl}
                destinationUrl={form.destinationUrl}
                ctaText={form.ctaText}
              />
            </div>
          </div>
        );
      })()}

      {/* TAB: AUDIENCE TARGETING */}
      {tab === 'targeting' && (
        <div className="grid lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleSaveTargeting}
            noValidate
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
                  setTargetErrors({});
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
                  onChange={(e) => {
                    setTargetEdit({ ...targetEdit, countries: e.target.value });
                    clearTargetError('countries');
                  }}
                  aria-invalid={Boolean(targetErrors.countries)}
                  aria-describedby={targetErrors.countries ? 'tgt-edit-countries-err' : undefined}
                  className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(targetErrors.countries))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="tgt-edit-countries-err" message={targetErrors.countries} />
              </div>
              <div>
                <label htmlFor="tgt-edit-langs" className="block text-xs font-medium mb-1">
                  Languages (comma-separated)
                </label>
                <input
                  id="tgt-edit-langs"
                  type="text"
                  value={targetEdit.languages}
                  onChange={(e) => {
                    setTargetEdit({ ...targetEdit, languages: e.target.value });
                    clearTargetError('languages');
                  }}
                  aria-invalid={Boolean(targetErrors.languages)}
                  aria-describedby={targetErrors.languages ? 'tgt-edit-langs-err' : undefined}
                  className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(targetErrors.languages))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="tgt-edit-langs-err" message={targetErrors.languages} />
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
                  onChange={(e) => {
                    setTargetEdit({ ...targetEdit, deviceCategories: e.target.value });
                    clearTargetError('deviceCategories');
                  }}
                  aria-invalid={Boolean(targetErrors.deviceCategories)}
                  aria-describedby={targetErrors.deviceCategories ? 'tgt-edit-devices-err' : undefined}
                  className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(targetErrors.deviceCategories))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="tgt-edit-devices-err" message={targetErrors.deviceCategories} />
              </div>
              <div>
                <label htmlFor="tgt-edit-os" className="block text-xs font-medium mb-1">
                  Operating Systems
                </label>
                <input
                  id="tgt-edit-os"
                  type="text"
                  value={targetEdit.operatingSystems}
                  onChange={(e) => {
                    setTargetEdit({ ...targetEdit, operatingSystems: e.target.value });
                    clearTargetError('operatingSystems');
                  }}
                  aria-invalid={Boolean(targetErrors.operatingSystems)}
                  aria-describedby={targetErrors.operatingSystems ? 'tgt-edit-os-err' : undefined}
                  className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(targetErrors.operatingSystems))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="tgt-edit-os-err" message={targetErrors.operatingSystems} />
              </div>
              <div>
                <label htmlFor="tgt-edit-browsers" className="block text-xs font-medium mb-1">
                  Browsers
                </label>
                <input
                  id="tgt-edit-browsers"
                  type="text"
                  value={targetEdit.browsers}
                  onChange={(e) => {
                    setTargetEdit({ ...targetEdit, browsers: e.target.value });
                    clearTargetError('browsers');
                  }}
                  aria-invalid={Boolean(targetErrors.browsers)}
                  aria-describedby={targetErrors.browsers ? 'tgt-edit-browsers-err' : undefined}
                  className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(targetErrors.browsers))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="tgt-edit-browsers-err" message={targetErrors.browsers} />
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
                  onChange={(e) => {
                    setTargetEdit({ ...targetEdit, contextualCategories: e.target.value });
                    clearTargetError('contextualCategories');
                  }}
                  aria-invalid={Boolean(targetErrors.contextualCategories)}
                  aria-describedby={targetErrors.contextualCategories ? 'tgt-edit-ctx-err' : undefined}
                  className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(targetErrors.contextualCategories))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="tgt-edit-ctx-err" message={targetErrors.contextualCategories} />
              </div>
              <div>
                <label htmlFor="tgt-edit-int" className="block text-xs font-medium mb-1">
                  Interest Categories
                </label>
                <input
                  id="tgt-edit-int"
                  type="text"
                  value={targetEdit.interestCategories}
                  onChange={(e) => {
                    setTargetEdit({ ...targetEdit, interestCategories: e.target.value });
                    clearTargetError('interestCategories');
                  }}
                  aria-invalid={Boolean(targetErrors.interestCategories)}
                  aria-describedby={targetErrors.interestCategories ? 'tgt-edit-int-err' : undefined}
                  placeholder="fintech, enterprise_saas"
                  className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(targetErrors.interestCategories))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="tgt-edit-int-err" message={targetErrors.interestCategories} />
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
            noValidate
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
                  setBudgetErrors({});
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
                  onChange={(e) => {
                    setBudgetEdit({ ...budgetEdit, biddingStrategy: e.target.value });
                    clearBudgetError('biddingStrategy');
                  }}
                  className={`w-full px-3 py-2 text-sm rounded-lg border ${fieldBorderClass(Boolean(budgetErrors.biddingStrategy))} bg-white dark:bg-slate-950`}
                >
                  <option value="manual">Manual Bid</option>
                  <option value="auto_cpc">Automated CPC Optimization</option>
                  <option value="target_cpa">Target CPA</option>
                </select>
                <FieldError id="bdg-strategy-err" message={budgetErrors.biddingStrategy} />
              </div>
              <div>
                <label htmlFor="bdg-pacing" className="block text-xs font-medium mb-1">
                  Delivery Pacing
                </label>
                <select
                  id="bdg-pacing"
                  value={budgetEdit.pacingMode}
                  onChange={(e) => {
                    setBudgetEdit({ ...budgetEdit, pacingMode: e.target.value });
                    clearBudgetError('pacingMode');
                  }}
                  className={`w-full px-3 py-2 text-sm rounded-lg border ${fieldBorderClass(Boolean(budgetErrors.pacingMode))} bg-white dark:bg-slate-950`}
                >
                  <option value="standard">Standard (Even Distribution)</option>
                  <option value="accelerated">Accelerated</option>
                </select>
                <FieldError id="bdg-pacing-err" message={budgetErrors.pacingMode} />
              </div>
            </div>

            <div className="grid sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="bdg-max" className="block text-xs font-medium mb-1">Max Bid (USD)</label>
                <input
                  id="bdg-max"
                  type="number"
                  step="0.05"
                  min="0.05"
                  required
                  value={budgetEdit.maxBidUsd}
                  onChange={(e) => {
                    setBudgetEdit({ ...budgetEdit, maxBidUsd: Number(e.target.value) });
                    clearBudgetError('maxBidUsd');
                  }}
                  aria-invalid={Boolean(budgetErrors.maxBidUsd)}
                  aria-describedby={budgetErrors.maxBidUsd ? 'bdg-max-err' : undefined}
                  className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(budgetErrors.maxBidUsd))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="bdg-max-err" message={budgetErrors.maxBidUsd} />
              </div>
              <div>
                <label htmlFor="bdg-daily" className="block text-xs font-medium mb-1">Daily Cap ($)</label>
                <input
                  id="bdg-daily"
                  type="number"
                  min="5"
                  required
                  value={budgetEdit.dailyBudgetUsd}
                  onChange={(e) => {
                    setBudgetEdit({ ...budgetEdit, dailyBudgetUsd: Number(e.target.value) });
                    clearBudgetError('dailyBudgetUsd');
                    clearBudgetError('totalBudgetUsd');
                    clearBudgetError('maxBidUsd');
                  }}
                  aria-invalid={Boolean(budgetErrors.dailyBudgetUsd)}
                  aria-describedby={budgetErrors.dailyBudgetUsd ? 'bdg-daily-err' : undefined}
                  className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(budgetErrors.dailyBudgetUsd))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="bdg-daily-err" message={budgetErrors.dailyBudgetUsd} />
              </div>
              <div>
                <label htmlFor="bdg-total" className="block text-xs font-medium mb-1">Total Budget ($)</label>
                <input
                  id="bdg-total"
                  type="number"
                  min="5"
                  required
                  value={budgetEdit.totalBudgetUsd}
                  onChange={(e) => {
                    setBudgetEdit({ ...budgetEdit, totalBudgetUsd: Number(e.target.value) });
                    clearBudgetError('totalBudgetUsd');
                  }}
                  aria-invalid={Boolean(budgetErrors.totalBudgetUsd)}
                  aria-describedby={budgetErrors.totalBudgetUsd ? 'bdg-total-err' : undefined}
                  className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(budgetErrors.totalBudgetUsd))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="bdg-total-err" message={budgetErrors.totalBudgetUsd} />
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="bdg-start" className="block text-xs font-medium mb-1">Start Date</label>
                <input
                  id="bdg-start"
                  type="date"
                  value={budgetEdit.startDate}
                  onChange={(e) => {
                    setBudgetEdit({ ...budgetEdit, startDate: e.target.value });
                    clearBudgetError('startDate');
                    clearBudgetError('endDate');
                  }}
                  aria-invalid={Boolean(budgetErrors.startDate)}
                  aria-describedby={budgetErrors.startDate ? 'bdg-start-err' : undefined}
                  className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(budgetErrors.startDate))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="bdg-start-err" message={budgetErrors.startDate} />
              </div>
              <div>
                <label htmlFor="bdg-end" className="block text-xs font-medium mb-1">End Date</label>
                <input
                  id="bdg-end"
                  type="date"
                  value={budgetEdit.endDate}
                  onChange={(e) => {
                    setBudgetEdit({ ...budgetEdit, endDate: e.target.value });
                    clearBudgetError('endDate');
                  }}
                  aria-invalid={Boolean(budgetErrors.endDate)}
                  aria-describedby={budgetErrors.endDate ? 'bdg-end-err' : undefined}
                  className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(budgetErrors.endDate))} bg-white dark:bg-slate-950`}
                />
                <FieldError id="bdg-end-err" message={budgetErrors.endDate} />
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
              noValidate
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
                    onChange={(e) => {
                      setDepositAmount(e.target.value);
                      clearBillingError('amountUsd');
                    }}
                    aria-invalid={Boolean(billingErrors.amountUsd)}
                    aria-describedby={billingErrors.amountUsd ? 'dep-amount-err' : undefined}
                    className={`w-full px-3 py-2 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(billingErrors.amountUsd))} bg-white dark:bg-slate-950`}
                  />
                  <FieldError id="dep-amount-err" message={billingErrors.amountUsd} />
                </div>
                <div>
                  <label htmlFor="dep-provider" className="block text-xs font-medium mb-1">Payment Provider</label>
                  <select
                    id="dep-provider"
                    value={depositProvider}
                    onChange={(e) => {
                      setDepositProvider(e.target.value);
                      clearBillingError('provider');
                    }}
                    aria-invalid={Boolean(billingErrors.provider)}
                    aria-describedby={billingErrors.provider ? 'dep-provider-err' : undefined}
                    className={`w-full px-3 py-2 text-sm rounded-lg border ${fieldBorderClass(Boolean(billingErrors.provider))} bg-white dark:bg-slate-950`}
                  >
                    <option value="paystack">Paystack</option>
                    <option value="flutterwave">Flutterwave</option>
                    <option value="bank_transfer">Bank Transfer</option>
                  </select>
                  <FieldError id="dep-provider-err" message={billingErrors.provider} />
                </div>
              </div>
              <button
                type="submit"
                className="w-full py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg"
              >
                Deposit Funds
              </button>

              {depositMsg && (
                <div className="p-3 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-xs text-emerald-800 dark:text-emerald-200 flex items-start justify-between gap-2">
                  <span>{depositMsg}</span>
                  <button
                    type="button"
                    onClick={() => setDepositMsg(null)}
                    aria-label="Dismiss receipt notice"
                    className="p-0.5 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/40 shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

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
                    id="refund-amount"
                    type="number"
                    min="5"
                    value={refundAmount}
                    onChange={(e) => {
                      setRefundAmount(e.target.value);
                      clearBillingError('refundAmount');
                    }}
                    aria-label="Refund amount in USD"
                    aria-invalid={Boolean(billingErrors.refundAmount)}
                    aria-describedby={billingErrors.refundAmount ? 'refund-amount-err' : undefined}
                    className={`flex-1 min-w-0 px-3 py-1.5 text-sm font-mono rounded-lg border ${fieldBorderClass(Boolean(billingErrors.refundAmount))} bg-white dark:bg-slate-950`}
                  />
                  <button
                    type="button"
                    onClick={handleRefund}
                    className="px-3.5 py-2 sm:py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 shrink-0"
                  >
                    Request Refund
                  </button>
                </div>
                <FieldError id="refund-amount-err" message={billingErrors.refundAmount} />
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
