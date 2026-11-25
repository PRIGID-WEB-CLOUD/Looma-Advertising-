import React, { useMemo } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatMicros, formatNumber } from '../lib/api';

export interface SeriesPoint {
  day: string;
  impressions: number;
  clicks: number;
  amountMicros: number;
}

interface PerformanceChartProps {
  title: string;
  subtitle: string;
  data: SeriesPoint[];
  amountLabel: string;
}

export const PerformanceChart: React.FC<PerformanceChartProps> = ({
  title,
  subtitle,
  data,
  amountLabel,
}) => {
  const rows = useMemo(
    () =>
      data.slice(-14).map((d) => ({
        ...d,
        shortDay: d.day.slice(5),
        amountUsd: Number((d.amountMicros / 1_000_000).toFixed(2)),
      })),
    [data]
  );

  if (data.length === 0) {
    return (
      <div className="border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-slate-900">
        <div className="flex items-baseline justify-between mb-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
          </div>
        </div>
        <div className="h-52 flex items-center justify-center text-center px-4 text-sm text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-md">
          No verified delivery events recorded yet for this period.
        </div>
      </div>
    );
  }

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-slate-900">
      <div className="flex flex-wrap items-baseline justify-between gap-3 sm:gap-4 mb-5">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
        </div>
        <div className="flex items-center gap-4 sm:gap-5 text-xs text-slate-600 dark:text-slate-400">
          <span className="flex items-center gap-2">
            <span className="inline-block w-3 h-2 bg-blue-700 dark:bg-blue-500 rounded-xs" />
            <span>Impressions</span>
          </span>
          <span className="flex items-center gap-2">
            <span className="inline-block w-3 h-2 bg-emerald-600 dark:bg-emerald-400 rounded-xs" />
            <span>{amountLabel}</span>
          </span>
        </div>
      </div>

      <div className="w-full h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.25)" vertical={false} />
            <XAxis
              dataKey="shortDay"
              tick={{ fontSize: 11, fill: '#64748b' }}
              axisLine={{ stroke: 'rgba(148, 163, 184, 0.35)' }}
              tickLine={false}
              dy={6}
            />
            <YAxis yAxisId="left" allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="right"
              orientation="right"
              tickFormatter={(v) => `$${v}`}
              tick={{ fontSize: 11, fill: '#059669' }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={({ active, payload }) => {
                const pt = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                if (!active || !pt) return null;
                return (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 px-3 py-2 shadow-lg text-xs font-mono tabular-nums space-y-1">
                    <div className="font-sans font-semibold text-slate-900 dark:text-white">{pt.day}</div>
                    <div className="text-slate-700 dark:text-slate-200">Impressions: {formatNumber(pt.impressions)}</div>
                    <div className="text-slate-700 dark:text-slate-200">Clicks: {formatNumber(pt.clicks)}</div>
                    <div className="text-emerald-700 dark:text-emerald-400">{amountLabel}: {formatMicros(pt.amountMicros)}</div>
                  </div>
                );
              }}
            />
            <Bar yAxisId="left" dataKey="impressions" fill="#1d4ed8" radius={[4, 4, 0, 0]} maxBarSize={28} />
            <Line yAxisId="right" type="monotone" dataKey="amountUsd" stroke="#059669" strokeWidth={2} dot={{ r: 3, fill: '#059669' }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 grid grid-cols-3 gap-2 sm:gap-4 text-xs">
        <div className="min-w-0">
          <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 truncate">Period Impressions</div>
          <div className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 mt-0.5 truncate">
            {formatNumber(data.reduce((s, d) => s + d.impressions, 0))}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 truncate">Period Clicks</div>
          <div className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 mt-0.5 truncate">
            {formatNumber(data.reduce((s, d) => s + d.clicks, 0))}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 truncate">Period {amountLabel}</div>
          <div className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 mt-0.5 truncate">
            {formatMicros(data.reduce((s, d) => s + d.amountMicros, 0))}
          </div>
        </div>
      </div>
    </div>
  );
};
