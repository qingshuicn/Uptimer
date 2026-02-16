import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

import type { MonitorAnalyticsDayPoint } from '../api/types';
import { useI18n } from '../app/I18nContext';
import { useTheme } from '../app/ThemeContext';
import { suggestLatencyAxisCeiling } from '../utils/latencyScale';

interface DailyLatencyChartProps {
  points: MonitorAnalyticsDayPoint[];
  height?: number;
}

function formatDay(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString([], { month: '2-digit', day: '2-digit' });
}

export function DailyLatencyChart({ points, height = 220 }: DailyLatencyChartProps) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const data = points
    .filter((p) => typeof p.p95_latency_ms === 'number')
    .map((p) => ({
      day: p.day_start_at,
      p95_latency_ms: p.p95_latency_ms,
      p50_latency_ms: p.p50_latency_ms,
    }));
  const axisCeiling = suggestLatencyAxisCeiling(
    data.flatMap((point) => [point.p95_latency_ms, point.p50_latency_ms]).filter(
      (value): value is number => typeof value === 'number',
    ),
  );
  const yAxisDomainProps =
    axisCeiling === null ? {} : { domain: [0, axisCeiling] as [number, number] };

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[220px] text-slate-500 dark:text-slate-400">
        {t('common.no_latency_data')}
      </div>
    );
  }

  const axisColor = isDark ? '#64748b' : '#9ca3af';
  const p95Color = isDark ? '#38bdf8' : '#0ea5e9';
  const p50Color = isDark ? '#64748b' : '#94a3b8';

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
        <XAxis
          dataKey="day"
          tickFormatter={formatDay}
          tick={{ fontSize: 12, fill: axisColor }}
          stroke={axisColor}
        />
        <YAxis
          tick={{ fontSize: 12, fill: axisColor }}
          stroke={axisColor}
          {...yAxisDomainProps}
          tickFormatter={(v) => `${v}ms`}
        />
        <Tooltip
          labelFormatter={(v) => new Date(Number(v) * 1000).toLocaleDateString()}
          formatter={(v: number, name) => [`${v}ms`, name === 'p50_latency_ms' ? 'P50' : 'P95']}
          contentStyle={{
            backgroundColor: isDark ? '#1e293b' : '#ffffff',
            borderColor: isDark ? '#334155' : '#e2e8f0',
            borderRadius: '0.5rem',
            color: isDark ? '#f1f5f9' : '#0f172a',
          }}
        />
        <Line
          type="monotone"
          dataKey="p95_latency_ms"
          stroke={p95Color}
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="p50_latency_ms"
          stroke={p50Color}
          strokeWidth={1}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
