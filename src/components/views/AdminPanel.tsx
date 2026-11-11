'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Account, ApprovalStatus, CreditSummary } from '@/lib/contracts';
import { apiFetch, formatCents, formatDateTime, formatNumber, pick, type ApiFailure } from '@/components/api-client';
import { StatusBadge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { DataTable } from '@/components/DataTable';
import { EmptyState } from '@/components/EmptyState';
import { ApiErrorNotice, Notice } from '@/components/Notice';
import { LoadingBlock } from '@/components/Spinner';

/** Shapes expected from the admin routes. Every field beyond `id` is optional so a thinner route still renders. */
interface ApprovalRow {
  id: string;
  account_id?: string;
  campaign_id?: string;
  status?: ApprovalStatus;
  company_name?: string | null;
  campaign_name?: string | null;
  lead_count?: number | null;
  /** The API names this requested_at; created_at is kept for older responses. */
  requested_at?: string;
  created_at?: string;
}

interface AccountRow extends Partial<Account> {
  id: string;
  credits?: CreditSummary | null;
  credit_balance?: number | null;
  cost_cents?: number | null;
  users?: number | null;
}

interface CostRow {
  account_id: string;
  total_cents?: number;
  by_category?: Record<string, number>;
}

type JobStats = Record<string, unknown>;

function listOf<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  const inner = pick<unknown>(data, key);
  return Array.isArray(inner) ? (inner as T[]) : [];
}

export function AdminPanel({ adminEmail }: { adminEmail: string }) {
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [costs, setCosts] = useState<Map<string, CostRow>>(new Map());
  const [jobs, setJobs] = useState<JobStats | null>(null);
  const [failures, setFailures] = useState<Record<string, ApiFailure | undefined>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [ap, ac, co, he] = await Promise.all([
      apiFetch<unknown>('/api/admin/approvals'),
      apiFetch<unknown>('/api/admin/accounts'),
      apiFetch<unknown>('/api/admin/costs'),
      apiFetch<unknown>('/api/health'),
    ]);
    const nextFailures: Record<string, ApiFailure | undefined> = {};
    if (ap.ok) setApprovals(listOf<ApprovalRow>(ap.data, 'approvals'));
    else nextFailures.approvals = ap;
    if (ac.ok) setAccounts(listOf<AccountRow>(ac.data, 'accounts'));
    else nextFailures.accounts = ac;
    if (co.ok) {
      const rows = listOf<CostRow>(co.data, 'costs').concat(listOf<CostRow>(co.data, 'by_account'));
      setCosts(new Map(rows.map((r) => [r.account_id, r])));
    } else nextFailures.costs = co;
    if (he.ok) {
      const j = pick<JobStats>(he.data, 'jobs');
      setJobs(j && typeof j === 'object' ? j : null);
    } else nextFailures.jobs = he;
    setFailures(nextFailures);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(row: ApprovalRow, decision: 'approved' | 'rejected') {
    setBusy(`${row.id}-${decision}`);
    setMessage(null);
    // The route takes { decision: 'approve' | 'reject' } and its schema is .strict().
    // This sent the stored past-tense status instead ('approved') plus a second `status`
    // key, so every decision came back 400 and a first campaign could never be approved
    // from this panel — the one human gate the product promises the customer. Keep the
    // past-tense value in the UI (it reads better in the toast) and translate it here.
    const verb = decision === 'approved' ? 'approve' : 'reject';
    const res = await apiFetch<unknown>(`/api/admin/approvals/${row.id}`, { method: 'POST', body: { decision: verb } });
    setBusy(null);
    if (!res.ok) {
      setMessage({ tone: 'danger', text: `Could not record the decision: ${res.error}` });
      return;
    }
    setMessage({ tone: 'ok', text: `${row.campaign_name ?? 'Campaign'} ${decision}.` });
    await load();
  }

  if (loading) return <LoadingBlock label="Loading admin data" />;

  const pending = approvals.filter((a) => (a.status ?? 'pending') === 'pending');

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted">Signed in as {adminEmail}.</p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Card title="Approvals queue" description={`${pending.length} first-campaign ${pending.length === 1 ? 'approval' : 'approvals'} waiting. Read the leads and copy before approving.`} flush>
        {failures.approvals ? (
          <div className="p-4">
            <ApiErrorNotice failure={failures.approvals} what="the approvals queue" />
          </div>
        ) : pending.length === 0 ? (
          <div className="p-4">
            <EmptyState title="Queue is empty" description="New accounts' first campaigns appear here when they request approval." />
          </div>
        ) : (
          <DataTable
            caption="Pending approvals"
            rows={pending}
            rowKey={(r) => r.id}
            columns={[
              { key: 'account', header: 'Account', render: (r) => r.company_name ?? r.account_id ?? '–' },
              {
                key: 'campaign',
                header: 'Campaign',
                render: (r) =>
                  r.campaign_id ? (
                    <Link href={`/campaigns/${r.campaign_id}`} className="text-accent underline-offset-2 hover:underline">
                      {r.campaign_name ?? r.campaign_id}
                    </Link>
                  ) : (
                    (r.campaign_name ?? '–')
                  ),
              },
              { key: 'leads', header: 'Leads', align: 'right', render: (r) => formatNumber(r.lead_count ?? null) },
              { key: 'requested', header: 'Requested', render: (r) => formatDateTime(r.requested_at ?? r.created_at) },
              {
                key: 'actions',
                header: 'Decision',
                align: 'right',
                render: (r) => (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" onClick={() => decide(r, 'approved')} loading={busy === `${r.id}-approved`}>
                      Approve
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => decide(r, 'rejected')} loading={busy === `${r.id}-rejected`}>
                      Reject
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card title="Accounts" description="Credit balance and our cost per account. Cost is what we have spent on data, verification, mailboxes, domains and LLM calls." flush>
        {failures.accounts ? (
          <div className="p-4">
            <ApiErrorNotice failure={failures.accounts} what="the accounts list" />
          </div>
        ) : (
          <>
            {failures.costs ? (
              <div className="p-4 pb-0">
                <ApiErrorNotice failure={failures.costs} what="per-account costs" />
              </div>
            ) : null}
            <DataTable
              caption="Accounts"
              rows={accounts}
              rowKey={(a) => a.id}
              empty="No accounts yet."
              columns={[
                {
                  key: 'company',
                  header: 'Company',
                  render: (a) => (
                    <div>
                      <p className="font-medium">{a.company_name ?? a.id}</p>
                      {a.website_url ? <p className="text-[11px] text-muted">{a.website_url}</p> : null}
                    </div>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (a) => (
                    <div className="flex flex-col gap-1">
                      {a.status ? <StatusBadge status={a.status} /> : '–'}
                      {a.sending_paused ? <span className="text-[11px] text-danger">paused: {a.paused_reason ?? 'no reason recorded'}</span> : null}
                    </div>
                  ),
                },
                { key: 'credits', header: 'Credits', align: 'right', render: (a) => formatNumber(a.credits?.balance ?? a.credit_balance ?? null) },
                {
                  key: 'cost',
                  header: 'Our cost',
                  align: 'right',
                  render: (a) => formatCents(a.cost_cents ?? costs.get(a.id)?.total_cents ?? null),
                },
                { key: 'cap', header: 'Daily cap', align: 'right', render: (a) => formatNumber(a.daily_send_cap ?? null) },
                { key: 'trial', header: 'Trial ends', render: (a) => formatDateTime(a.trial_ends_at) },
              ]}
            />
          </>
        )}
      </Card>

      <Card title="Job queue" description="From /api/health. Dead jobs need a human; failed jobs retry on their own.">
        {failures.jobs ? (
          <ApiErrorNotice failure={failures.jobs} what="job queue stats" />
        ) : !jobs ? (
          <p className="text-xs text-muted">Health endpoint returned no job stats.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Object.entries(jobs).map(([k, v]) => (
              <div key={k} className="rounded-md border border-line p-3">
                <dt className="text-[11px] uppercase tracking-wide text-muted">{k.replace(/_/g, ' ')}</dt>
                <dd className={`text-lg font-semibold tabular-nums ${k === 'dead' && Number(v) > 0 ? 'text-danger' : k === 'failed' && Number(v) > 0 ? 'text-warn' : ''}`}>
                  {typeof v === 'number' || typeof v === 'string' ? String(v) : JSON.stringify(v)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
    </div>
  );
}
