import type { WarmupProgress } from '@/lib/contracts';
import { formatDate } from './api-client';

/**
 * Warm-up progress bar with honest copy. Warm-up is 7 days and cannot be
 * skipped: strategy and leads can be ready, but nothing sends before `ready_at`.
 */
export function WarmupBar({ warmup }: { warmup: WarmupProgress | null }) {
  if (!warmup || warmup.started_at === null) {
    return (
      <div className="flex flex-col gap-2">
        <Bar percent={0} label="Warm-up not started" />
        <p className="text-xs text-muted">
          Warm-up starts once a domain is verified and mailboxes are provisioned. It takes {warmup?.days_total ?? 7} days
          and cannot be skipped, so the first email will go out no earlier than {warmup?.days_total ?? 7} days after that.
        </p>
      </div>
    );
  }

  if (warmup.complete) {
    return (
      <div className="flex flex-col gap-2">
        <Bar percent={100} label="Warm-up complete" tone="ok" />
        <p className="text-xs text-muted">
          Mailboxes finished warming on {formatDate(warmup.ready_at)}. Sending is allowed as soon as a campaign passes
          review.
        </p>
      </div>
    );
  }

  const remaining = Math.max(0, warmup.days_total - warmup.days_elapsed);
  return (
    <div className="flex flex-col gap-2">
      <Bar
        percent={warmup.percent}
        label={`Warm-up: day ${Math.min(warmup.days_elapsed + 1, warmup.days_total)} of ${warmup.days_total}`}
      />
      <p className="text-xs text-ink">
        Your strategy and leads can be ready now. <strong>Sending starts when warm-up completes on {formatDate(warmup.ready_at)}</strong>
        {remaining > 0 ? ` (${remaining} ${remaining === 1 ? 'day' : 'days'} to go).` : '.'} Warm-up cannot be skipped: new
        mailboxes that send at full volume on day one land in spam.
      </p>
    </div>
  );
}

function Bar({ percent, label, tone = 'accent' }: { percent: number; label: string; tone?: 'accent' | 'ok' }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-ink">{label}</span>
        <span className="tabular-nums text-muted">{clamped}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        className="h-2.5 w-full overflow-hidden rounded-full bg-surface-muted"
      >
        <div className={`h-full rounded-full ${tone === 'ok' ? 'bg-ok' : 'bg-accent'}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
