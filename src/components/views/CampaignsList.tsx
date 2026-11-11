'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Campaign, CampaignStats } from '@/lib/contracts';
import { apiFetch, formatDate, formatNumber, formatRate, pick, ratio, type ApiFailure } from '@/components/api-client';
import { StatusBadge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { DataTable } from '@/components/DataTable';
import { EmptyState } from '@/components/EmptyState';
import { Field } from '@/components/Field';
import { ApiErrorNotice, Notice } from '@/components/Notice';
import { LoadingBlock } from '@/components/Spinner';

type Row = Campaign & { stats?: CampaignStats | null };

/** GET /api/campaigns may return Campaign[] or { campaigns: [...] }. */
function normalise(data: unknown): Row[] {
  if (Array.isArray(data)) return data as Row[];
  return pick<Row[]>(data, 'campaigns') ?? [];
}

export function CampaignsList() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch<unknown>('/api/campaigns');
    if (res.ok) {
      setRows(normalise(res.data));
      setFailure(null);
    } else {
      setFailure(res);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const body = {
      name: String(fd.get('name') ?? '').trim(),
      angle: String(fd.get('angle') ?? '').trim() || null,
      target_lead_count: Number(fd.get('target_lead_count') ?? 500) || 500,
    };
    if (!body.name) {
      setError('Give the campaign a name.');
      return;
    }
    setCreating(true);
    const res = await apiFetch<unknown>('/api/campaigns', { method: 'POST', body });
    setCreating(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const id = pick<string>(res.data, 'id') ?? pick<string>(pick<unknown>(res.data, 'campaign'), 'id');
    if (id) {
      router.push(`/campaigns/${id}`);
    } else {
      setShowForm(false);
      await load();
    }
  }

  if (loading) return <LoadingBlock label="Loading campaigns" />;

  return (
    <div className="flex flex-col gap-4">
      {failure ? <ApiErrorNotice failure={failure} what="your campaigns" /> : null}

      <Card
        title="All campaigns"
        description={`${rows.length} ${rows.length === 1 ? 'campaign' : 'campaigns'}`}
        actions={
          <Button size="sm" onClick={() => setShowForm((v) => !v)} aria-expanded={showForm} aria-controls="create-campaign">
            Create campaign
          </Button>
        }
        flush
      >
        {showForm ? (
          <form id="create-campaign" onSubmit={create} className="flex flex-col gap-3 border-b border-line p-4">
            <div className="grid gap-3 md:grid-cols-3">
              <Field id="name" label="Name" required placeholder="Founder-led sales, Q4" />
              <Field id="angle" label="Angle" placeholder="Get the founder out of top-of-funnel" hint="Optional. Defaults to the segment's angle." />
              <Field id="target_lead_count" label="Target leads" type="number" min={50} max={5000} defaultValue={500} hint="Capped during the free month." />
            </div>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex gap-2">
              <Button type="submit" loading={creating}>
                Create
              </Button>
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}

        {rows.length === 0 && !failure ? (
          <div className="p-4">
            <EmptyState
              title="No campaigns yet"
              description="Create your first campaign. It will source leads from your approved strategy, write the copy, and wait for your review."
              action={<Button onClick={() => setShowForm(true)}>Create campaign</Button>}
            />
          </div>
        ) : (
          <DataTable
            caption="Campaigns"
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 'name',
                header: 'Campaign',
                render: (r) => (
                  <div>
                    <Link href={`/campaigns/${r.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                      {r.name}
                    </Link>
                    {r.angle ? <p className="text-xs text-muted">{r.angle}</p> : null}
                  </div>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (r) => (
                  <div className="flex flex-col gap-1">
                    <StatusBadge status={r.status} />
                    {r.paused_reason ? <span className="text-[11px] text-danger">{r.paused_reason}</span> : null}
                  </div>
                ),
              },
              { key: 'target', header: 'Target leads', align: 'right', render: (r) => formatNumber(r.target_lead_count) },
              { key: 'sent', header: 'Sent', align: 'right', render: (r) => formatNumber(r.stats?.sent ?? 0) },
              { key: 'replies', header: 'Reply rate', align: 'right', render: (r) => (r.stats ? formatRate(ratio(r.stats.replies, r.stats.sent)) : '–') },
              { key: 'cap', header: 'Daily cap', align: 'right', render: (r) => formatNumber(r.daily_cap) },
              { key: 'launched', header: 'Launched', render: (r) => formatDate(r.launched_at) },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
