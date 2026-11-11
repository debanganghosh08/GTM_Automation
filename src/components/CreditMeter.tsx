import type { CreditSummary } from '@/lib/contracts';
import { formatNumber } from './api-client';
import { Notice } from './Notice';

/**
 * Credits widget. 1 credit = 1 email sent. Warns at 80% burn and again at 100%.
 * `low` from the API (under 10% left) is honoured as well, in case the route uses
 * a different threshold than the bar.
 */
export function CreditMeter({ credits, compact = false }: { credits: CreditSummary; compact?: boolean }) {
  const granted = Math.max(0, credits.granted);
  const spent = Math.max(0, credits.spent);
  const burn = granted > 0 ? Math.min(1, spent / granted) : 0;
  const burnPct = Math.round(burn * 100);
  const exhausted = credits.balance <= 0 || burn >= 1;
  const warn = !exhausted && (burn >= 0.8 || credits.low);
  const bar = exhausted ? 'bg-danger' : warn ? 'bg-warn' : 'bg-accent';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-xs text-muted">Credits remaining</p>
          <p className={`font-semibold tabular-nums ${compact ? 'text-xl' : 'text-2xl'}`}>
            {formatNumber(credits.balance)}
            <span className="ml-1 text-xs font-normal text-muted">of {formatNumber(granted)}</span>
          </p>
        </div>
        <p className="text-xs text-muted">
          {formatNumber(spent)} used · {burnPct}% of grant
        </p>
      </div>
      <div
        role="progressbar"
        aria-label="Credits used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={burnPct}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
      >
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${burnPct}%` }} />
      </div>
      <p className="text-[11px] text-muted">1 credit = 1 email sent. Credits are charged when a send is confirmed, never before.</p>
      {exhausted ? (
        <Notice tone="danger" title="Credits exhausted">
          Sending is paused until credits are added. Nothing will go out at a zero balance.
        </Notice>
      ) : warn ? (
        <Notice tone="warn" title="Running low">
          You have used {burnPct}% of your credits. Your plan renews on day 31 with a fresh grant; until then sending
          stops when the balance reaches zero.
        </Notice>
      ) : null}
    </div>
  );
}
