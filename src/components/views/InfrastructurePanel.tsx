'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { DashboardSummary, DnsRecord, Domain, Mailbox, WarmupProgress } from '@/lib/contracts';
import { apiFetch, formatCents, pick, type ApiFailure } from '@/components/api-client';
import { Badge, StatusBadge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { CopyButton } from '@/components/CopyButton';
import { DataTable } from '@/components/DataTable';
import { EmptyState } from '@/components/EmptyState';
import { Field } from '@/components/Field';
import { ApiErrorNotice, Notice } from '@/components/Notice';
import { LoadingBlock } from '@/components/Spinner';
import { WarmupBar } from '@/components/WarmupBar';

const PURPOSE_HELP: Record<DnsRecord['purpose'], { name: string; what: string }> = {
  spf: {
    name: 'SPF',
    what: 'Lists which servers are allowed to send mail for this domain. Without it, receivers treat your mail as possibly forged.',
  },
  dkim: {
    name: 'DKIM',
    what: 'A cryptographic signature on every email proving it was not altered in transit and really came from this domain.',
  },
  dmarc: {
    name: 'DMARC',
    what: 'Tells receivers what to do when SPF or DKIM fail (we start with monitoring only) and where to send reports.',
  },
  mx: { name: 'MX', what: 'Where replies to your outbound mail are delivered, so they reach your inbox and the dashboard.' },
  tracking: { name: 'Tracking', what: 'A custom subdomain for open and link tracking, so tracking links carry your domain, not a shared one.' },
  verification: { name: 'Verification', what: 'Proves to the mailbox provider that you control this domain. Can be removed after verification.' },
};

interface State {
  domains: Domain[];
  mailboxes: Mailbox[];
  warmup: WarmupProgress | null;
}

/** GET /api/domains may return Domain[] or { domains, mailboxes?, warmup? }. Both are accepted. */
function normaliseDomains(data: unknown): Pick<State, 'domains' | 'mailboxes'> & { warmup?: WarmupProgress | null } {
  if (Array.isArray(data)) return { domains: data as Domain[], mailboxes: [] };
  const domains = pick<Domain[]>(data, 'domains') ?? [];
  const mailboxes = pick<Mailbox[]>(data, 'mailboxes') ?? [];
  const warmup = pick<WarmupProgress | null>(data, 'warmup');
  return { domains, mailboxes, warmup };
}

export function InfrastructurePanel() {
  const [state, setState] = useState<State>({ domains: [], mailboxes: [], warmup: null });
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [warmupFailure, setWarmupFailure] = useState<ApiFailure | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [domRes, dashRes] = await Promise.all([apiFetch<unknown>('/api/domains'), apiFetch<DashboardSummary>('/api/dashboard')]);
    let next: State = { domains: [], mailboxes: [], warmup: null };
    if (domRes.ok) {
      const n = normaliseDomains(domRes.data);
      next = { domains: n.domains, mailboxes: n.mailboxes, warmup: n.warmup ?? null };
      setFailure(null);
    } else {
      setFailure(domRes);
    }
    if (dashRes.ok) {
      if (!next.warmup) next.warmup = dashRes.data.warmup;
      setWarmupFailure(null);
    } else if (!next.warmup) {
      setWarmupFailure(dashRes);
    }
    setState(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addDomain(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);
    const fd = new FormData(e.currentTarget);
    const domain = String(fd.get('domain') ?? '')
      .trim()
      .toLowerCase();
    const source = String(fd.get('source') ?? 'connected') as Domain['source'];
    if (!domain.includes('.')) {
      setMessage({ tone: 'danger', text: 'Enter a full domain, like acme-outreach.com.' });
      return;
    }
    setBusy('add');
    // The radio carries the database's vocabulary ('connected' | 'purchased') because the
    // badge below renders the same value. POST /api/domains speaks a different one and its
    // schema is .strict(), so sending `source` was rejected outright with "Unrecognized
    // key(s) in object: 'source'" — which made adding a domain impossible from the UI for
    // both options. Translate here rather than reshaping the request schema, so the API
    // contract and the stored vocabulary each stay as they are.
    const mode = source === 'purchased' ? 'buy' : 'connect';
    const res = await apiFetch<unknown>('/api/domains', { method: 'POST', body: { domain, mode } });
    setBusy(null);
    if (!res.ok) {
      setMessage({ tone: 'danger', text: res.error });
      return;
    }
    setMessage({
      tone: 'ok',
      text: source === 'purchased' ? `Registering ${domain}. DNS records appear below once it is live.` : `${domain} added. Add the DNS records below, then verify.`,
    });
    e.currentTarget.reset();
    await load();
  }

  async function verify(d: Domain) {
    setBusy(`verify-${d.id}`);
    setMessage(null);
    const res = await apiFetch<unknown>(`/api/domains/${d.id}/verify`, { method: 'POST', body: {} });
    setBusy(null);
    if (!res.ok) {
      setMessage({ tone: 'danger', text: `Verification of ${d.domain} failed: ${res.error}` });
    } else {
      setMessage({ tone: 'ok', text: `Verification requested for ${d.domain}. DNS can take up to an hour to propagate.` });
    }
    await load();
  }

  async function provisionMailboxes(d: Domain, count: number) {
    setBusy(`mail-${d.id}`);
    setMessage(null);
    const res = await apiFetch<unknown>('/api/mailboxes', { method: 'POST', body: { domain_id: d.id, count } });
    setBusy(null);
    if (!res.ok) {
      setMessage({ tone: 'danger', text: `Could not provision mailboxes: ${res.error}` });
    } else {
      setMessage({ tone: 'ok', text: `${count} mailboxes requested on ${d.domain}. Warm-up starts when they are live.` });
    }
    await load();
  }

  if (loading) return <LoadingBlock label="Loading domains and warm-up" />;

  return (
    <div className="flex flex-col gap-4">
      <Card title="Warm-up" description="Strategy and leads can be ready now; sending starts when this completes.">
        {warmupFailure && !state.warmup ? <ApiErrorNotice failure={warmupFailure} what="warm-up progress" /> : <WarmupBar warmup={state.warmup} />}
      </Card>

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {failure ? <ApiErrorNotice failure={failure} what="your domains" /> : null}

      {state.domains.length === 0 ? (
        <EmptyState
          title="No sending domain yet"
          description="Add one below. We recommend a variant of your main domain, such as acme-hq.com or getacme.com, so replies still look like you."
        />
      ) : (
        state.domains.map((d) => (
          <DomainCard
            key={d.id}
            domain={d}
            mailboxes={state.mailboxes.filter((m) => m.domain_id === d.id)}
            busy={busy}
            onVerify={() => verify(d)}
            onProvision={(n) => provisionMailboxes(d, n)}
          />
        ))
      )}

      <Card title="Add a domain" description="Connect a domain you already own, or buy a new one through us at cost.">
        <form onSubmit={addDomain} className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-medium text-ink">How do you want to get the domain?</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="source" value="connected" defaultChecked className="mt-1" />
              <span>
                <span className="font-medium">Connect a domain I own.</span>{' '}
                <span className="text-muted">You add the DNS records at your registrar; we check them.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="source" value="purchased" className="mt-1" />
              <span>
                <span className="font-medium">Buy a new domain.</span>{' '}
                <span className="text-muted">We register it and set the records for you. Registration cost is passed through.</span>
              </span>
            </label>
          </fieldset>
          <Field id="domain" label="Domain" required placeholder="acme-outreach.com" autoComplete="off" spellCheck={false} />
          <div>
            <Button type="submit" loading={busy === 'add'}>
              Add domain
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function DomainCard({
  domain,
  mailboxes,
  busy,
  onVerify,
  onProvision,
}: {
  domain: Domain;
  mailboxes: Mailbox[];
  busy: string | null;
  onVerify: () => void;
  onProvision: (count: number) => void;
}) {
  const [count, setCount] = useState(3);
  const verified = Boolean(domain.dns_verified_at);

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{domain.domain}</span>
          <StatusBadge status={domain.status} />
          <Badge>{domain.source}</Badge>
        </span>
      }
      description={
        verified
          ? `DNS verified. ${domain.warmup_started_at ? 'Warm-up is running.' : 'Provision mailboxes to start warm-up.'}`
          : 'Add every record below at your DNS provider, then press Verify.'
      }
      actions={
        <Button size="sm" variant={verified ? 'secondary' : 'primary'} onClick={onVerify} loading={busy === `verify-${domain.id}`}>
          {verified ? 'Re-check DNS' : 'Verify DNS'}
        </Button>
      }
    >
      {domain.error ? (
        <Notice tone="danger" className="mb-3" title="Provider reported a problem">
          {domain.error}
        </Notice>
      ) : null}

      {domain.dns_records.length === 0 ? (
        <p className="text-xs text-muted">
          DNS records have not been generated yet. They appear here once the domain is registered or the mailbox provider has assigned signing keys.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {domain.dns_records.map((r, i) => {
            const help = PURPOSE_HELP[r.purpose];
            return (
              <li key={`${r.type}-${r.host}-${i}`} className="rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold">
                    {help.name} <span className="font-normal text-muted">({r.type} record)</span>
                    {r.verified === true ? <Badge tone="ok" className="ml-2">verified</Badge> : r.verified === false ? <Badge tone="warn" className="ml-2">not found yet</Badge> : null}
                  </p>
                </div>
                <p className="mt-1 text-xs text-muted">{help.what}</p>
                <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-[5rem_1fr_auto] sm:items-center">
                  <dt className="text-muted">Host</dt>
                  <dd className="break-all font-mono">{r.host}</dd>
                  <dd>
                    <CopyButton value={r.host} label="Copy host" />
                  </dd>
                  <dt className="text-muted">Value</dt>
                  <dd className="break-all font-mono">{r.value}</dd>
                  <dd>
                    <CopyButton value={r.value} label="Copy value" />
                  </dd>
                  {r.priority !== undefined ? (
                    <>
                      <dt className="text-muted">Priority</dt>
                      <dd className="font-mono">{r.priority}</dd>
                      <dd />
                    </>
                  ) : null}
                </dl>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mt-4 border-t border-line pt-3">
        <h3 className="text-xs font-semibold">Mailboxes</h3>
        <p className="mt-0.5 text-xs text-muted">
          Each mailbox sends a limited number per day; more mailboxes mean more volume without hurting reputation. About {formatCents(3000)} each, passed through at cost.
        </p>
        {mailboxes.length > 0 ? (
          <div className="mt-2">
            <DataTable
              dense
              caption={`Mailboxes on ${domain.domain}`}
              rows={mailboxes}
              rowKey={(m) => m.id}
              columns={[
                { key: 'email', header: 'Address', render: (m) => <span className="font-mono text-xs">{m.email}</span> },
                { key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
                { key: 'cap', header: 'Daily cap', align: 'right', render: (m) => m.daily_cap },
                { key: 'cost', header: 'Cost', align: 'right', render: (m) => formatCents(m.cost_cents) },
              ]}
            />
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field
            id={`count-${domain.id}`}
            label="Mailboxes to add"
            type="number"
            min={1}
            max={10}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            className="w-32"
          />
          <Button size="md" variant="secondary" onClick={() => onProvision(count)} loading={busy === `mail-${domain.id}`} disabled={!verified}>
            Provision mailboxes
          </Button>
          {!verified ? <p className="text-xs text-muted">Verify DNS first.</p> : null}
        </div>
      </div>
    </Card>
  );
}
