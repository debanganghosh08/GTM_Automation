import type { ReactNode } from 'react';
import { Tooltip } from './Tooltip';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  /** Shown in a "?" tooltip next to the label. Use it to define the metric. */
  definition?: string;
  sub?: ReactNode;
  /** Small trend series, rendered as inline SVG. */
  trend?: number[];
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
}

const toneText = {
  neutral: 'text-ink',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
} as const;

export function StatCard({ label, value, definition, sub, trend, tone = 'neutral' }: StatCardProps) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">
        {definition ? <Tooltip text={definition}>{label}</Tooltip> : label}
      </div>
      <div className={`text-xl font-semibold tabular-nums ${toneText[tone]}`}>{value}</div>
      {sub ? <div className="text-xs text-muted">{sub}</div> : null}
      {trend && trend.length > 1 ? <Sparkline values={trend} /> : null}
    </div>
  );
}

/** Inline SVG sparkline. No chart library. */
export function Sparkline({ values, height = 24 }: { values: number[]; height?: number }) {
  const width = 100;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * (height - 2) - 1).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="mt-1 text-accent"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Horizontal CSS bar, for small comparisons inside a table or card. */
export function MiniBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted" role="img" aria-label={label}>
      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
    </div>
  );
}
