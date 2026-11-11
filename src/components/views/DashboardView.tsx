'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { CampaignStats, DashboardSummary } from '@/lib/contracts';
import { apiFetch, formatDate, formatNumber, formatRate, ratio, type ApiFailure } from '@/components/api-client';
import { Badge, StatusBadge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { CreditMeter } from '@/components/CreditMeter';
import { DataTable } from '@/components/DataTable';
import { EmptyState } from '@/components/EmptyState';
import { ApiErrorNotice } from '@/components/Notice';
import { LoadingBlock } from '@/components/Spinner';
import { MiniBar, StatCard } from '@/components/StatCard';
import { WarmupBar } from '@/components/WarmupBar';

/**
 * Metric definitions. Shown in tooltips because vendors disagree: some divide
 * replies by delivered, some by unique contacts. Here every rate divides by sent.
 */
const DEFINITIONS = {
  sent: 'Emails confirmed sent by the sending platform. Each one spent exactly one credit.',
  delivered: 'Sent emails that were accepted by the receiving server (sent minus bounces).',
  open_rate: 'Opens divided by sent. Opens are undercounted where image loading is blocked, so treat this as a floor.',
  reply_rate: 'Replies divided by sent. Automated replies (out of office, mail server notices) are excluded.',
  positive_rate: 'Replies classified as interested, divided by sent. Low-confidence classifications are not counted until a human reads them.',
  bounce_rate: 'Bounces divided by sent. Sending pauses automatically above the account threshold (default 3%).',
  unsubscribes: 'Recipients who used the unsubscribe link. They are suppressed from every future campaign.',
} as const;

const ZERO: CampaignStats = { campaign_id: '', sent: 0, delivered: 0, opens: 0, replies: 0, bounces: 0, unsubscribes: 0, interested: 0, bounce_rate: 0, reply_rate: 0 };

function rateTone(rate: number, warnAt: number, badAt: number): 'neutral' | 'warn' | 'danger' {
  if (rate >= badAt) return 'danger';
  if (rate >= warnAt) return 'warn';
  return 'neutral';
}

export function DashboardView() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await apiFetch<DashboardSummary>('/api/dashboard');
    if (res.ok) {
      setSummary(res.data);
      setFailure(null);
    } else {
      setFailure(res);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingBlock label="Loading results" />;

  if (failure || !summary) {
    return (
      <div className="flex flex-col gap-3">
        {failure ? <ApiErrorNotice failure={failure} what="your results" /> : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(['Sent', 'Delivered', 'Open rate', 'Reply rate'] as const).map((l) => (
            <StatCard key={l} label={l} value="–" />
          ))}
        </div>
      </div>
    );
  }

  const totals = summary.totals ?? ZERO;
  const campaigns = summary.campaigns ?? [];
  const maxSent = Math.max(1, ...campaigns.map((c) => c.stats?.sent ?? 0));
  const bounceRate = ratio(totals.bounces, totals.sent);
  const trialEnds = summary.account.trial_ends_at;

  return (
    <div className="flex flex-col gap-4">
      {/* Health strip */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-4 py-2 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="text-muted">Account</span>
          <StatusBadge status={summary.account.status} />
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-muted">Sending</span>
          {summary.account.sending_paused ? <Badge tone="danger">paused</Badge> : <Badge tone="ok">enabled</Badge>}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-muted">Warm-up</span>
          {summary.warmup === null || summary.warmup.started_at === null ? (
            <Badge>not started</Badge>
          ) : summary.warmup.complete ? (
            <Badge tone="ok">complete</Badge>
          ) : (
            <Badge tone="warn">
              day {Math.min(summary.warmup.days_elapsed + 1, summary.warmup.days_total)} of {summary.warmup.days_total}
            </Badge>
          )}
        </span>
        {trialEnds ? (
          <span className="text-muted">
            {summary.account.status === 'trialing' ? 'First charge' : 'Renews'} {formatDate(trialEnds)}
          </span>
        ) : null}
        {summary.account.sending_paused && summary.account.paused_reason ? (
          <span className="basis-full text-danger">
            <strong>Auto-pause reason:</strong> {summary.account.paused_reason}
          </span>
        ) : null}
        <span className="ml-auto">
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        </span>
      </div>

      {/* Totals */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Sent" value={formatNumber(totals.sent)} definition={DEFINITIONS.sent} sub={`${formatNumber(totals.sent)} credits spent`} />
        <StatCard label="Delivered" value={formatNumber(totals.delivered)} definition={DEFINITIONS.delivered} sub={formatRate(ratio(totals.delivered, totals.sent)) + ' of sent'} />
        <StatCard label="Open rate" value={formatRate(ratio(totals.opens, totals.sent))} definition={DEFINITIONS.open_rate} sub={`${formatNumber(totals.opens)} opens`} />
        <StatCard label="Reply rate" value={formatRate(ratio(totals.replies, totals.sent))} definition={DEFINITIONS.reply_rate} sub={`${formatNumber(totals.replies)} replies`} />
        <StatCard
          label="Positive reply rate"
          value={formatRate(ratio(totals.interested, totals.sent))}
          definition={DEFINITIONS.positive_rate}
          sub={`${formatNumber(totals.interested)} interested`}
          tone={totals.interested > 0 ? 'ok' : 'neutral'}
        />
        <StatCard
          label="Bounce rate"
          value={formatRate(bounceRate)}
          definition={DEFINITIONS.bounce_rate}
          sub={`${formatNumber(totals.bounces)} bounces`}
          tone={rateTone(bounceRate, 0.02, 0.03)}
        />
        <StatCard label="Unsubscribes" value={formatNumber(totals.unsubscribes)} definition={DEFINITIONS.unsubscribes} />
        <StatCard label="Credits remaining" value={formatNumber(summary.credits.balance)} sub={`of ${formatNumber(summary.credits.granted)} granted`} tone={summary.credits.balance <= 0 ? 'danger' : summary.credits.low ? 'warn' : 'neutral'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card title="Credits">
          <CreditMeter credits={summary.credits} />
        </Card>
        <Card title="Warm-up">
          <WarmupBar warmup={summary.warmup} />
        </Card>
      </div>

      <Card title="Per campaign" description="Rates use the same definitions as the totals above." flush>
        {campaigns.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="No campaigns yet"
              description="Results appear here once a campaign has launched and the first stats sync has run."
              action={
                <Link href="/campaigns" className="text-xs font-medium text-accent underline">
                  Go to campaigns
                </Link>
              }
            />
          </div>
        ) : (
          <DataTable
            caption="Results per campaign"
            rows={campaigns}
            rowKey={(c) => c.id}
            columns={[
              {
                key: 'name',
                header: 'Campaign',
                render: (c) => (
                  <div className="min-w-[10rem]">
                    <Link href={`/campaigns/${c.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                      {c.name}
                    </Link>
                    <div className="mt-1 flex items-center gap-2">
                      <StatusBadge status={c.status} />
                      {c.paused_reason ? <span className="text-[11px] text-danger">{c.paused_reason}</span> : null}
                    </div>
                    <div className="mt-1.5">
                      <MiniBar value={c.stats?.sent ?? 0} max={maxSent} label={`${c.name}: ${c.stats?.sent ?? 0} sent of ${maxSent} max`} />
                    </div>
                  </div>
                ),
              },
              { key: 'sent', header: 'Sent', align: 'right', render: (c) => formatNumber(c.stats?.sent ?? 0) },
              { key: 'delivered', header: 'Delivered', align: 'right', render: (c) => formatNumber(c.stats?.delivered ?? 0) },
              { key: 'open', header: 'Open', align: 'right', render: (c) => formatRate(ratio(c.stats?.opens ?? 0, c.stats?.sent ?? 0)) },
              { key: 'reply', header: 'Reply', align: 'right', render: (c) => formatRate(ratio(c.stats?.replies ?? 0, c.stats?.sent ?? 0)) },
              { key: 'positive', header: 'Positive', align: 'right', render: (c) => formatRate(ratio(c.stats?.interested ?? 0, c.stats?.sent ?? 0)) },
              {
                key: 'bounce',
                header: 'Bounce',
                align: 'right',
                render: (c) => {
                  const r = ratio(c.stats?.bounces ?? 0, c.stats?.sent ?? 0);
                  return <span className={r >= 0.03 ? 'text-danger' : r >= 0.02 ? 'text-warn' : ''}>{formatRate(r)}</span>;
                },
              },
              { key: 'unsub', header: 'Unsub', align: 'right', render: (c) => formatNumber(c.stats?.unsubscribes ?? 0) },
            ]}
            footer={
              <tr>
                <td className="px-3 py-2">Totals</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(totals.sent)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(totals.delivered)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatRate(ratio(totals.opens, totals.sent))}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatRate(ratio(totals.replies, totals.sent))}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatRate(ratio(totals.interested, totals.sent))}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatRate(bounceRate)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(totals.unsubscribes)}</td>
              </tr>
            }
          />
        )}
      </Card>
    </div>
  );
}
