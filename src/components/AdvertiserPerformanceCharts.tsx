import React, { useMemo, useState } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatMicros, formatNumber } from '../lib/api';

export interface AdvertiserDailyPoint {
  day: string;
  impressions: number;
  clicks: number;
  conversions: number;
  spendMicros: number;
  ctr: number; // percentage, e.g. 3.52
  conversionRate: number; // percentage, e.g. 25.0
}

export interface CampaignComparisonRow {
  id: string;
  name: string;
  pricing_model: string;
  status: string;
  impressions: number;
  clicks: number;
  conversions: number;
  spend_micros: number;
}

type TrendView = 'volume' | 'rates' | 'spend';

interface TrendChartProps {
  title: string;
  subtitle: string;
  data: AdvertiserDailyPoint[];
  height?: number;
}

function formatAxisDate(day: string): string {
  const parts = day.split('-');
  if (parts.length !== 3) return day;
  const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  if (Number.isNaN(dt.getTime())) return day.slice(5);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

interface CustomTooltipPayloadItem {
  payload?: AdvertiserDailyPoint;
}

const PerformanceTooltip: React.FC<{
  active?: boolean;
  payload?: CustomTooltipPayloadItem[];
  label?: string;
}> = ({ active, payload, label }) => {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs px-3.5 py-2.5 shadow-lg text-xs min-w-[200px]">
      <div className="font-semibold text-slate-900 dark:text-white pb-1.5 mb-1.5 border-b border-slate-100 dark:border-slate-800">
        {label ? formatAxisDate(label) : point.day} <span className="font-mono text-[11px] font-normal text-slate-400">({point.day})</span>
      </div>
      <div className="space-y-1 font-mono tabular-nums">
        <div className="flex items-center justify-between gap-4">
          <span className="font-sans text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-xs bg-blue-700 dark:bg-blue-400 inline-block" />
            Impressions
          </span>
          <span className="font-semibold text-slate-900 dark:text-white">{formatNumber(point.impressions)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="font-sans text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-xs bg-emerald-600 dark:bg-emerald-400 inline-block" />
            Valid Clicks
          </span>
          <span className="font-semibold text-slate-900 dark:text-white">{formatNumber(point.clicks)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="font-sans text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-xs bg-amber-600 dark:bg-amber-400 inline-block" />
            Conversions
          </span>
          <span className="font-semibold text-slate-900 dark:text-white">{formatNumber(point.conversions)}</span>
        </div>
        <div className="pt-1 mt-1 border-t border-slate-100 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between gap-4">
            <span className="font-sans text-slate-500 dark:text-slate-400">CTR</span>
            <span className="text-slate-900 dark:text-slate-100">{point.ctr.toFixed(2)}%</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="font-sans text-slate-500 dark:text-slate-400">Conversion Rate</span>
            <span className="text-slate-900 dark:text-slate-100">{point.conversionRate.toFixed(2)}%</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="font-sans text-slate-500 dark:text-slate-400">Billed Spend</span>
            <span className="font-semibold text-slate-900 dark:text-white">{formatMicros(point.spendMicros)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export const AdvertiserPerformanceTrendChart: React.FC<TrendChartProps> = ({
  title,
  subtitle,
  data,
  height = 290,
}) => {
  const [view, setView] = useState<TrendView>('volume');

  const chartRows = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        spendUsd: Number((d.spendMicros / 1_000_000).toFixed(2)),
      })),
    [data]
  );

  const summary = useMemo(() => {
    const impressions = data.reduce((s, d) => s + d.impressions, 0);
    const clicks = data.reduce((s, d) => s + d.clicks, 0);
    const conversions = data.reduce((s, d) => s + d.conversions, 0);
    const spendMicros = data.reduce((s, d) => s + d.spendMicros, 0);
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
    const cvr = clicks > 0 ? (conversions / clicks) * 100 : 0;
    return { impressions, clicks, conversions, spendMicros, ctr, cvr };
  }, [data]);

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-slate-900 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
        </div>

        {/* Segmented metric switcher */}
        <div
          role="tablist"
          aria-label="Chart metric view"
          className="grid grid-cols-3 sm:inline-flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800/80 rounded-lg w-full sm:w-auto shrink-0"
        >
          {[
            { id: 'volume' as const, label: 'Impressions & Clicks', mobileLabel: 'Impr. & Clicks' },
            { id: 'rates' as const, label: 'CTR & Conv. Rate', mobileLabel: 'CTR & CVR' },
            { id: 'spend' as const, label: 'Spend & Conv.', mobileLabel: 'Spend & Conv.' },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={view === item.id}
              onClick={() => setView(item.id)}
              className={`px-2 sm:px-2.5 py-1.5 text-[11px] sm:text-xs font-medium rounded-md transition-colors whitespace-nowrap text-center ${
                view === item.id
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <span className="sm:hidden">{item.mobileLabel}</span>
              <span className="hidden sm:inline">{item.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Clean inline legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-slate-600 dark:text-slate-400 mb-4">
        {view === 'volume' && (
          <>
            <span className="inline-flex items-center gap-2">
              <span className="w-3 h-2 rounded-xs bg-blue-700 dark:bg-blue-500 inline-block" />
              <span>Verified Impressions (Left Axis)</span>
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="w-3 h-2 rounded-xs bg-emerald-600 dark:bg-emerald-400 inline-block" />
              <span>Valid Clicks (Right Axis)</span>
            </span>
          </>
        )}
        {view === 'rates' && (
          <>
            <span className="inline-flex items-center gap-2">
              <span className="w-3 h-2 rounded-xs bg-blue-700 dark:bg-blue-400 inline-block" />
              <span>Click-Through Rate (CTR %)</span>
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="w-3 h-2 rounded-xs bg-amber-600 dark:bg-amber-400 inline-block" />
              <span>Conversion Rate (CVR %)</span>
            </span>
          </>
        )}
        {view === 'spend' && (
          <>
            <span className="inline-flex items-center gap-2">
              <span className="w-3 h-2 rounded-xs bg-slate-700 dark:bg-slate-300 inline-block" />
              <span>Billed Spend (USD, Left Axis)</span>
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="w-3 h-2 rounded-xs bg-emerald-600 dark:bg-emerald-400 inline-block" />
              <span>Conversions (Right Axis)</span>
            </span>
          </>
        )}
      </div>

      {chartRows.length === 0 ? (
        <div className="h-60 flex items-center justify-center text-center px-4 text-sm text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
          No verified delivery events recorded yet for this period or campaign filter.
        </div>
      ) : (
        <div className="w-full" style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart key={view} data={chartRows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <defs>
                <linearGradient id="loomaImpFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#1d4ed8" stopOpacity={0.22} />
                  <stop offset="95%" stopColor="#1d4ed8" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="loomaSpendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#334155" stopOpacity={0.22} />
                  <stop offset="95%" stopColor="#334155" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.25)" vertical={false} />
              <XAxis
                dataKey="day"
                tickFormatter={formatAxisDate}
                tick={{ fontSize: 11, fill: '#64748b' }}
                axisLine={{ stroke: 'rgba(148, 163, 184, 0.35)' }}
                tickLine={false}
                dy={6}
              />
              {view === 'volume' && (
                <>
                  <YAxis
                    yAxisId="left"
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: '#059669' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip content={<PerformanceTooltip />} />
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="impressions"
                    name="Impressions"
                    stroke="#1d4ed8"
                    strokeWidth={2}
                    fill="url(#loomaImpFill)"
                    activeDot={{ r: 4, fill: '#1d4ed8' }}
                    isAnimationActive={false}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="clicks"
                    name="Valid Clicks"
                    stroke="#059669"
                    strokeWidth={2.25}
                    dot={{ r: 3, fill: '#059669' }}
                    activeDot={{ r: 5, fill: '#059669' }}
                    isAnimationActive={false}
                  />
                </>
              )}

              {view === 'rates' && (
                <>
                  <YAxis
                    yAxisId="left"
                    unit="%"
                    tick={{ fontSize: 11, fill: '#1d4ed8' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    unit="%"
                    tick={{ fontSize: 11, fill: '#d97706' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip content={<PerformanceTooltip />} />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="ctr"
                    name="CTR %"
                    stroke="#1d4ed8"
                    strokeWidth={2.25}
                    dot={{ r: 3, fill: '#1d4ed8' }}
                    activeDot={{ r: 5, fill: '#1d4ed8' }}
                    isAnimationActive={false}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="conversionRate"
                    name="Conversion Rate %"
                    stroke="#d97706"
                    strokeWidth={2.25}
                    dot={{ r: 3, fill: '#d97706' }}
                    activeDot={{ r: 5, fill: '#d97706' }}
                    isAnimationActive={false}
                  />
                </>
              )}

              {view === 'spend' && (
                <>
                  <YAxis
                    yAxisId="left"
                    tickFormatter={(v) => `$${v}`}
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: '#059669' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip content={<PerformanceTooltip />} />
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="spendUsd"
                    name="Spend (USD)"
                    stroke="#334155"
                    strokeWidth={2}
                    fill="url(#loomaSpendFill)"
                    activeDot={{ r: 4, fill: '#334155' }}
                    isAnimationActive={false}
                  />
                  <Bar
                    yAxisId="right"
                    dataKey="conversions"
                    name="Conversions"
                    fill="#059669"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={26}
                    isAnimationActive={false}
                  />
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Tabular Summary Strip */}
      <div className="mt-5 pt-4 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
        <div className="min-w-0">
          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">Period Impressions</div>
          <div className="font-mono tabular-nums font-semibold text-slate-900 dark:text-white mt-0.5 truncate">
            {formatNumber(summary.impressions)}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">Period Clicks</div>
          <div className="font-mono tabular-nums font-semibold text-slate-900 dark:text-white mt-0.5 truncate">
            {formatNumber(summary.clicks)}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">Period Conversions</div>
          <div className="font-mono tabular-nums font-semibold text-slate-900 dark:text-white mt-0.5 truncate">
            {formatNumber(summary.conversions)}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">Blended CTR / CVR</div>
          <div className="font-mono tabular-nums font-semibold text-slate-900 dark:text-white mt-0.5 truncate">
            {summary.ctr.toFixed(2)}% / {summary.cvr.toFixed(1)}%
          </div>
        </div>
        <div className="min-w-0 col-span-2 sm:col-span-1">
          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">Period Spend</div>
          <div className="font-mono tabular-nums font-semibold text-slate-900 dark:text-white mt-0.5 truncate">
            {formatMicros(summary.spendMicros)}
          </div>
        </div>
      </div>
    </div>
  );
};

interface CampaignComparisonChartProps {
  campaigns: CampaignComparisonRow[];
}

export const CampaignComparisonChart: React.FC<CampaignComparisonChartProps> = ({ campaigns }) => {
  const [metricMode, setMetricMode] = useState<'engagement' | 'efficiency'>('engagement');

  const rows = useMemo(
    () =>
      campaigns.map((c) => {
        const shortName = c.name.length > 22 ? `${c.name.slice(0, 21)}…` : c.name;
        const ctr = c.impressions > 0 ? Number(((c.clicks / c.impressions) * 100).toFixed(2)) : 0;
        const cvr = c.clicks > 0 ? Number(((c.conversions / c.clicks) * 100).toFixed(2)) : 0;
        return {
          ...c,
          shortName,
          ctr,
          cvr,
          spendUsd: Number((c.spend_micros / 1_000_000).toFixed(2)),
        };
      }),
    [campaigns]
  );

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-slate-900 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">Campaign Breakdown Comparison</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Compare verified delivery volume and conversion efficiency across campaigns
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Campaign comparison mode"
          className="grid grid-cols-2 sm:inline-flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800/80 rounded-lg w-full sm:w-auto shrink-0"
        >
          <button
            type="button"
            role="tab"
            aria-selected={metricMode === 'engagement'}
            onClick={() => setMetricMode('engagement')}
            className={`px-2.5 py-1.5 text-[11px] sm:text-xs font-medium rounded-md transition-colors whitespace-nowrap text-center ${
              metricMode === 'engagement'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            Impressions &amp; Clicks
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={metricMode === 'efficiency'}
            onClick={() => setMetricMode('efficiency')}
            className={`px-2.5 py-1.5 text-[11px] sm:text-xs font-medium rounded-md transition-colors whitespace-nowrap text-center ${
              metricMode === 'efficiency'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            CTR &amp; Conversion Rate
          </button>
        </div>
      </div>

      {/* Inline Legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-slate-600 dark:text-slate-400 mb-4">
        {metricMode === 'engagement' ? (
          <>
            <span className="inline-flex items-center gap-2">
              <span className="w-3 h-2 rounded-xs bg-blue-700 dark:bg-blue-500 inline-block" />
              <span>Impressions (Left Axis)</span>
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="w-3 h-2 rounded-xs bg-emerald-600 dark:bg-emerald-400 inline-block" />
              <span>Valid Clicks (Right Axis)</span>
            </span>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-2">
              <span className="w-3 h-2 rounded-xs bg-blue-700 dark:bg-blue-400 inline-block" />
              <span>Click-Through Rate (CTR %, Left Axis)</span>
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="w-3 h-2 rounded-xs bg-amber-600 dark:bg-amber-400 inline-block" />
              <span>Conversion Rate (CVR %, Right Axis)</span>
            </span>
          </>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="h-56 flex items-center justify-center text-sm text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
          Create and activate a campaign to compare cross-campaign delivery metrics.
        </div>
      ) : (
        <div className="w-full h-[260px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart key={metricMode} data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.25)" vertical={false} />
              <XAxis
                dataKey="shortName"
                tick={{ fontSize: 11, fill: '#64748b' }}
                axisLine={{ stroke: 'rgba(148, 163, 184, 0.35)' }}
                tickLine={false}
                dy={6}
              />
              <YAxis
                yAxisId="left"
                allowDecimals={metricMode === 'efficiency'}
                unit={metricMode === 'efficiency' ? '%' : undefined}
                tick={{ fontSize: 11, fill: '#64748b' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                allowDecimals={metricMode === 'efficiency'}
                unit={metricMode === 'efficiency' ? '%' : undefined}
                tick={{ fontSize: 11, fill: metricMode === 'efficiency' ? '#d97706' : '#059669' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                content={({ active, payload }) => {
                  const row = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                  if (!active || !row) return null;
                  return (
                    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 px-3.5 py-2.5 shadow-lg text-xs min-w-[210px]">
                      <div className="font-semibold text-slate-900 dark:text-white pb-1.5 mb-1.5 border-b border-slate-100 dark:border-slate-800">
                        {row.name}
                      </div>
                      <div className="space-y-1 font-mono tabular-nums">
                        <div className="flex justify-between gap-4">
                          <span className="font-sans text-slate-500">Pricing Model</span>
                          <span className="text-slate-900 dark:text-white">{row.pricing_model}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="font-sans text-slate-500">Impressions</span>
                          <span className="text-slate-900 dark:text-white">{formatNumber(row.impressions)}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="font-sans text-slate-500">Clicks</span>
                          <span className="text-slate-900 dark:text-white">{formatNumber(row.clicks)}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="font-sans text-slate-500">Conversions</span>
                          <span className="text-slate-900 dark:text-white">{formatNumber(row.conversions)}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="font-sans text-slate-500">CTR / CVR</span>
                          <span className="text-slate-900 dark:text-white">{row.ctr.toFixed(2)}% / {row.cvr.toFixed(1)}%</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="font-sans text-slate-500">Total Spend</span>
                          <span className="font-semibold text-slate-900 dark:text-white">{formatMicros(row.spend_micros)}</span>
                        </div>
                      </div>
                    </div>
                  );
                }}
              />
              {metricMode === 'engagement' ? (
                <>
                  <Bar yAxisId="left" dataKey="impressions" name="Impressions" fill="#1d4ed8" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
                  <Bar yAxisId="right" dataKey="clicks" name="Clicks" fill="#059669" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
                </>
              ) : (
                <>
                  <Bar yAxisId="left" dataKey="ctr" name="CTR %" fill="#1d4ed8" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
                  <Bar yAxisId="right" dataKey="cvr" name="Conversion Rate %" fill="#d97706" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
                </>
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
};
