'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ApprovalStatus, Campaign, CampaignCopy, ComplianceReport, CopyStep, Lead } from '@/lib/contracts';
import { apiFetch, formatNumber, pick, type ApiFailure } from '@/components/api-client';
import { Badge, StatusBadge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ComplianceNotice } from '@/components/ComplianceNotice';
import { DataTable } from '@/components/DataTable';
import { EmptyState } from '@/components/EmptyState';
import { Field, TextAreaField } from '@/components/Field';
import { ApiErrorNotice, Notice } from '@/components/Notice';
import { LoadingBlock } from '@/components/Spinner';

interface SendCheck {
  allowed: boolean;
  reasons: string[];
  failed_gates?: number[];
}

interface Detail {
  campaign: Campaign;
  leads: Lead[];
  /** Every lead on the campaign. `leads` holds only the first page the API returns. */
  leadTotal: number;
  copy: CampaignCopy | null;
  compliance: ComplianceReport | null;
  sendCheck: SendCheck | null;
  isFirstCampaign: boolean | null;
  approval: ApprovalStatus | null;
}

const SENDABLE_STATUSES: ReadonlySet<Campaign['status']> = new Set(['awaiting_review', 'pending_approval', 'approved', 'draft', 'paused']);

function isCampaign(v: unknown): v is Campaign {
  return typeof v === 'object' && v !== null && typeof (v as Campaign).id === 'string' && typeof (v as Campaign).name === 'string' && 'status' in v;
}

function isCopy(v: unknown): v is CampaignCopy {
  return typeof v === 'object' && v !== null && Array.isArray((v as CampaignCopy).steps);
}

/**
 * GET /api/campaigns/:id is expected to return `{ campaign, leads, copy, compliance,
 * send_check, is_first_campaign, approval }`, but a bare Campaign is accepted and
 * the rest filled from /api/campaigns/:id/copy. Anything missing renders as empty.
 */
function normalise(detailData: unknown, copyData: unknown): Detail | null {
  const campaign = isCampaign(detailData) ? detailData : pick<unknown>(detailData, 'campaign');
  if (!isCampaign(campaign)) return null;

  // GET /api/campaigns/:id answers leads as { items, total, preview_limit }, not a bare
  // array. pick<Lead[]>() asserts the type without checking it, so this read compiled
  // cleanly and handed the component an object: line 191 then threw "leads.filter is not
  // a function" and the whole campaign page rendered its error boundary. Accept either
  // shape and verify it really is an array before trusting it.
  const leadsRaw = pick<unknown>(detailData, 'leads');
  const leadItems = Array.isArray(leadsRaw) ? leadsRaw : pick<unknown>(leadsRaw, 'items');
  const leads: Lead[] = Array.isArray(leadItems) ? (leadItems as Lead[]) : [];
  const leadTotal = pick<number>(leadsRaw, 'total') ?? leads.length;

  let copy: CampaignCopy | null = null;
  const copyCandidates = [copyData, pick<unknown>(copyData, 'copy'), pick<unknown>(detailData, 'copy'), pick<unknown>(pick<unknown>(detailData, 'copy'), 'steps') !== undefined ? pick<unknown>(detailData, 'copy') : undefined];
  for (const c of copyCandidates) {
    if (isCopy(c)) {
      copy = c;
      break;
    }
  }

  const compliance =
    pick<ComplianceReport | null>(copyData, 'compliance') ??
    pick<ComplianceReport | null>(detailData, 'compliance') ??
    pick<ComplianceReport | null>(pick<unknown>(detailData, 'copy'), 'compliance') ??
    null;

  // The route returns this as `send_gate`; `send_check` and `gates` were never emitted,
  // so the blocking reasons (warm-up incomplete, first campaign unapproved) silently
  // never reached the screen. Read the real key first, keeping the others as fallbacks.
  const sendCheck = pick<SendCheck | null>(detailData, 'send_gate')
    ?? pick<SendCheck | null>(detailData, 'send_check')
    ?? pick<SendCheck | null>(detailData, 'gates')
    ?? null;
  // `is_first_campaign` is not part of the response. The approval row carries the same
  // fact as kind = 'first_campaign', so derive it from there instead of leaving isFirst
  // null — null made needsApproval false and hid the human-approval requirement, the one
  // gate the product promises customers.
  const approvalRow = pick<unknown>(detailData, 'approval');
  const explicitFirst = pick<boolean>(detailData, 'is_first_campaign');
  const isFirst = typeof explicitFirst === "boolean"
    ? explicitFirst
    : pick<string>(approvalRow, 'kind') === 'first_campaign' ? true : null;
  const approvalRaw = approvalRow;
  const approval = typeof approvalRaw === 'string' ? (approvalRaw as ApprovalStatus) : (pick<ApprovalStatus>(approvalRaw, 'status') ?? null);

  return { campaign, leads, leadTotal, copy, compliance, sendCheck, isFirstCampaign: isFirst, approval };
}

export function CampaignReview({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [copyFailure, setCopyFailure] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [steps, setSteps] = useState<CopyStep[]>([]);
  const [copyDirty, setCopyDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger' | 'warn'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [d, c] = await Promise.all([apiFetch<unknown>(`/api/campaigns/${id}`), apiFetch<unknown>(`/api/campaigns/${id}/copy`)]);
    if (!d.ok) {
      setFailure(d);
      setLoading(false);
      return;
    }
    setFailure(null);
    setCopyFailure(c.ok ? null : c.code === 'not_found' ? null : c);
    const n = normalise(d.data, c.ok ? c.data : null);
    if (!n) {
      setFailure({ ok: false, error: 'The campaign response did not include a campaign.', code: 'bad_response', status: d.status });
      setLoading(false);
      return;
    }
    setDetail(n);
    setSteps((prev) => (prev.length > 0 && copyDirty ? prev : (n.copy?.steps ?? [])));
    setLoading(false);
  }, [id, copyDirty]);

  useEffect(() => {
    void load();
    // Only on mount / id change; later reloads are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function removeLead(lead: Lead) {
    setBusy(`lead-${lead.id}`);
    setMessage(null);
    const res = await apiFetch<unknown>(`/api/campaigns/${id}/leads`, { method: 'POST', body: { remove: [lead.id] } });
    setBusy(null);
    if (!res.ok) {
      setMessage({ tone: 'danger', text: `Could not remove ${lead.email}: ${res.error}` });
      return;
    }
    setDetail((d) => (d ? { ...d, leads: d.leads.filter((l) => l.id !== lead.id) } : d));
  }

  async function sourceLeads() {
    setBusy('source');
    setMessage(null);
    const res = await apiFetch<unknown>(`/api/campaigns/${id}/leads`, { method: 'POST', body: { action: 'source' } });
    setBusy(null);
    if (!res.ok) {
      setMessage({ tone: 'danger', text: `Could not start lead sourcing: ${res.error}` });
      return;
    }
    setMessage({ tone: 'ok', text: 'Lead sourcing started. Verified leads appear here as they come in; refresh in a minute.' });
    await load();
  }

  async function saveCopy() {
    setBusy('copy');
    setMessage(null);
    const res = await apiFetch<unknown>(`/api/campaigns/${id}/copy`, { method: 'PUT', body: { steps } });
    setBusy(null);
    if (!res.ok) {
      setMessage({ tone: 'danger', text: `Could not save copy: ${res.error}` });
      return;
    }
    setCopyDirty(false);
    const compliance = pick<ComplianceReport | null>(res.data, 'compliance') ?? null;
    setDetail((d) => (d ? { ...d, copy: { steps }, compliance: compliance ?? d.compliance } : d));
    setMessage({ tone: 'ok', text: compliance ? (compliance.passed ? 'Copy saved and passes compliance.' : 'Copy saved. The checker found blocking errors, listed below.') : 'Copy saved.' });
    if (!compliance) await load();
  }

  async function action(kind: 'approve' | 'launch' | 'pause') {
    setBusy(kind);
    setMessage(null);
    const res = await apiFetch<unknown>(`/api/campaigns/${id}/${kind}`, { method: 'POST', body: {} });
    setBusy(null);
    if (!res.ok) {
      setMessage({ tone: 'danger', text: res.error });
      await load();
      return;
    }
    setMessage({
      tone: 'ok',
      text:
        kind === 'approve'
          ? 'Approval requested. A SparqLabs reviewer will look at the leads and copy before anything sends.'
          : kind === 'launch'
            ? 'Campaign launched. Sends start inside the next send window, at the warm-up ramped cap.'
            : 'Campaign paused. Nothing more will send until you resume.',
    });
    await load();
  }

  if (loading) return <LoadingBlock label="Loading campaign" />;

  if (failure || !detail) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Campaign</h1>
        {failure ? <ApiErrorNotice failure={failure} what="this campaign" /> : null}
        <Link href="/campaigns" className="text-xs text-accent underline">
          Back to campaigns
        </Link>
      </div>
    );
  }

  const { campaign, leads, leadTotal, compliance } = detail;
  const validLeads = leads.filter((l) => l.verification === 'valid').length;
  const isFirst = detail.isFirstCampaign ?? null;
  const needsApproval = isFirst === true && detail.approval !== 'approved';
  const compliancePassed = compliance?.passed === true;

  // Send gate: the server's assertCanSend is authoritative when provided; the
  // client adds what it can see so the reasons are never an empty list while disabled.
  const reasons: string[] = [];
  if (detail.sendCheck && !detail.sendCheck.allowed) {
    // The approval branch below says the same thing with more precision (pending vs
    // rejected), so drop the gate’s generic version rather than printing both.
    const gateReasons = needsApproval
      ? detail.sendCheck.reasons.filter((r) => !r.trimStart().startsWith('[first_campaign_unapproved]'))
      : detail.sendCheck.reasons;
    reasons.push(...gateReasons.map(humaniseReason));
  }
  if (!compliancePassed) reasons.push(compliance ? 'The copy has blocking compliance errors (see the copy pane).' : 'The copy has not passed the compliance checker yet.');
  if (leadTotal === 0) reasons.push('There are no leads in this campaign.');
  else if (validLeads === 0) reasons.push('None of the leads have a valid verified address.');
  if (needsApproval) reasons.push(detail.approval === 'pending' ? 'Your first campaign is waiting for SparqLabs approval.' : detail.approval === 'rejected' ? 'Your first campaign was rejected by review; fix the issues and request approval again.' : 'Your first campaign needs SparqLabs approval before it can send.');
  if (copyDirty) reasons.push('You have unsaved copy changes.');
  if (!SENDABLE_STATUSES.has(campaign.status)) reasons.push(`Campaign status is "${campaign.status.replace(/_/g, ' ')}", which cannot be launched from here.`);
  const uniqueReasons = Array.from(new Set(reasons));
  const canSend = uniqueReasons.length === 0;
  const isLive = campaign.status === 'sending' || campaign.status === 'scheduled';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted">
            <Link href="/campaigns" className="underline">
              Campaigns
            </Link>{' '}
            / Review
          </p>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold">
            {campaign.name}
            <StatusBadge status={campaign.status} />
            {isFirst ? <Badge tone="accent">First campaign</Badge> : null}
          </h1>
          {campaign.angle ? <p className="text-sm text-muted">{campaign.angle}</p> : null}
          {campaign.paused_reason ? (
            <Notice tone="warn" className="mt-2" title="Paused automatically">
              {campaign.paused_reason}
            </Notice>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
          {isLive ? (
            <Button variant="danger" size="sm" onClick={() => action('pause')} loading={busy === 'pause'}>
              Pause
            </Button>
          ) : null}
        </div>
      </div>

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {needsApproval ? (
        <Notice tone="warn" title="Your first campaign needs approval before it sends">
          A SparqLabs reviewer reads the leads and copy of every account&apos;s first campaign. Later campaigns send on
          your approval alone.{' '}
          {detail.approval === 'pending' ? 'Your request is in the queue.' : 'Request approval once you are happy with the leads and copy.'}
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Leads"
          // leads.length is one page (50), not the campaign. Showing it as the lead
          // count under-reported a 330-lead campaign by a factor of six, so state the
          // real total and be explicit that the verified count refers to the page shown.
          description={`${formatNumber(leadTotal)} leads. Showing the first ${formatNumber(leads.length)}, of which ${formatNumber(validLeads)} verified valid. Invalid and risky addresses are never uploaded.`}
          actions={
            <Button size="sm" variant="secondary" onClick={sourceLeads} loading={busy === 'source'}>
              {leadTotal === 0 ? 'Source leads' : 'Source more'}
            </Button>
          }
          flush
        >
          {leads.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No leads yet"
                description="Lead sourcing runs from your approved strategy. Start it here, or wait if it is already running."
              />
            </div>
          ) : (
            <DataTable
              dense
              caption="Campaign leads"
              rows={leads}
              rowKey={(l) => l.id}
              columns={[
                {
                  key: 'who',
                  header: 'Lead',
                  render: (l) => (
                    <div>
                      <p className="font-medium">{[l.first_name, l.last_name].filter(Boolean).join(' ') || '(no name)'}</p>
                      <p className="font-mono text-[11px] text-muted">{l.email}</p>
                    </div>
                  ),
                },
                {
                  key: 'company',
                  header: 'Company',
                  render: (l) => (
                    <div>
                      <p>{l.company_name ?? '–'}</p>
                      <p className="text-[11px] text-muted">{l.title ?? ''}</p>
                    </div>
                  ),
                },
                { key: 'verification', header: 'Verified', render: (l) => <StatusBadge status={l.verification} /> },
                {
                  key: 'remove',
                  header: <span className="sr-only">Remove</span>,
                  align: 'right',
                  render: (l) => (
                    <Button size="sm" variant="ghost" onClick={() => removeLead(l)} loading={busy === `lead-${l.id}`} aria-label={`Remove ${l.email}`}>
                      Remove
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </Card>

        <Card
          title="Copy"
          description="Three steps, one thread. Edit freely; the checker re-runs on save."
          actions={
            <Button size="sm" onClick={saveCopy} loading={busy === 'copy'} disabled={!copyDirty}>
              Save copy
            </Button>
          }
        >
          {copyFailure ? <ApiErrorNotice failure={copyFailure} what="the campaign copy" /> : null}
          {steps.length === 0 ? (
            <EmptyState
              title="Copy has not been generated yet"
              description="Copy is written automatically once leads are sourced and verified. Refresh in a minute."
              action={
                <Button size="sm" variant="secondary" onClick={() => setSteps([{ step: 1, delay_days: 0, subject: '', body: '' }])}>
                  Write it by hand instead
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-4">
              <ComplianceNotice report={compliance} />
              {steps.map((st, i) => (
                <StepEditor
                  key={i}
                  step={st}
                  compliance={compliance}
                  onChange={(next) => {
                    setSteps((prev) => prev.map((x, idx) => (idx === i ? next : x)));
                    setCopyDirty(true);
                  }}
                />
              ))}
              {steps.length < 3 ? (
                <div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setSteps((prev) => [...prev, { step: prev.length + 1, delay_days: 3, subject: '', body: '' }]);
                      setCopyDirty(true);
                    }}
                  >
                    Add step {steps.length + 1}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </Card>
      </div>

      <Card title="Send" description="Every gate must pass. The reasons below are exactly what is stopping the send.">
        <div className="flex flex-col gap-3">
          {canSend ? (
            <p className="rounded-md border border-ok/30 bg-ok-soft px-3 py-2 text-xs text-ok">All send gates pass. Launching schedules sends inside your send window at the warm-up ramped cap.</p>
          ) : (
            <div>
              <p className="text-xs font-semibold text-danger">Sending is disabled because:</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-ink">
                {uniqueReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {needsApproval && detail.approval !== 'pending' ? (
              <Button variant="secondary" onClick={() => action('approve')} loading={busy === 'approve'} disabled={!compliancePassed || leadTotal === 0 || copyDirty}>
                Request approval
              </Button>
            ) : null}
            <Button onClick={() => action('launch')} loading={busy === 'launch'} disabled={!canSend} aria-disabled={!canSend}>
              {isLive ? 'Sending' : 'Send campaign'}
            </Button>
            <span className="text-xs text-muted">
              Window {campaign.send_window_start} to {campaign.send_window_end} {campaign.timezone}, {campaign.send_days.join(', ') || 'weekdays'}, up to {formatNumber(campaign.daily_cap)}/day.
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Turns the gate tokens from assertCanSend into sentences. Unknown reasons pass through. */
function humaniseReason(reason: string): string {
  // guardrails builds every reason as `[code] message` (see pushReason there). The
  // original parse split on ':' instead, so `token` captured the entire leading
  // sentence, no case ever matched, and the customer was shown the raw internal code:
  // "[mailboxes_not_ready] Mailboxes still warming or not provisioned: ...". Read the
  // bracketed code, and keep the old 'code: detail' form working as a fallback.
  let token: string;
  let message: string;
  const trimmed = reason.trimStart();
  const close = trimmed.startsWith('[') ? trimmed.indexOf(']') : -1;
  if (close > 1) {
    token = trimmed.slice(1, close);
    message = trimmed.slice(close + 1).trim();
  } else {
    const parts = reason.split(':');
    token = parts[0]?.trim() ?? '';
    message = parts.slice(1).join(':').trim();
  }
  // The templates below already state the condition, so the useful part of the message
  // is whatever follows its own colon ("...not provisioned: a@x, b@x"). Without this the
  // sentence reads as a restatement of itself.
  const colon = message.indexOf(': ');
  const detail = colon >= 0 ? message.slice(colon + 2).trim() : message;
  switch (token) {
    case 'account_paused':
      return `Sending is paused on your account${detail ? `: ${detail}` : '.'}`;
    case 'account_status':
      return `Your subscription is not active${detail ? ` (${detail})` : ''}. Update billing to resume.`;
    case 'no_credits':
      return 'You have no credits left. Sending resumes when credits are added or the plan renews.';
    case 'compliance_failed':
      return 'The copy has blocking compliance errors (see the copy pane).';
    case 'mailboxes_not_ready':
      return `Mailboxes are still warming up${detail ? ` (${detail})` : ''}. Sending starts when warm-up completes.`;
    case 'first_campaign_unapproved':
      return 'Your first campaign needs SparqLabs approval before it can send.';
    case 'bounce_rate':
      return `The bounce rate is above the pause threshold${detail ? ` (${detail})` : ''}. Clean the list before resuming.`;
    case 'daily_cap_reached':
      return 'Today’s daily send cap has been reached. Sending continues tomorrow.';
    default:
      return reason;
  }
}

function StepEditor({ step, compliance, onChange }: { step: CopyStep; compliance: ComplianceReport | null; onChange: (s: CopyStep) => void }) {
  const p = `step-${step.step}`;
  const words = step.body.trim() ? step.body.trim().split(/\s+/).length : 0;
  const hasStepIssues = compliance ? [...compliance.errors, ...compliance.warnings].some((i) => i.step === step.step) : false;
  return (
    <fieldset className="rounded-md border border-line p-3">
      <legend className="px-1 text-xs font-semibold text-muted">
        Step {step.step} · day {step.delay_days === 0 && step.step === 1 ? 0 : `+${step.delay_days}`}
      </legend>
      <div className="grid gap-3 md:grid-cols-[1fr_7rem]">
        <Field id={`${p}-subject`} label="Subject" value={step.subject} onChange={(e) => onChange({ ...step, subject: e.target.value })} hint="Lowercase, under 6 words. Spintax {a|b} allowed." />
        <Field id={`${p}-delay`} label="Delay (days)" type="number" min={0} value={step.delay_days} disabled={step.step === 1} onChange={(e) => onChange({ ...step, delay_days: Number(e.target.value) })} />
      </div>
      <TextAreaField
        id={`${p}-body`}
        label="Body"
        className="mt-3"
        rows={8}
        value={step.body}
        onChange={(e) => onChange({ ...step, body: e.target.value })}
        hint={`${words} words. Merge tags: {{first_name}} {{company_name}} {{title}} {{industry}} {{sending_name}} {{unsubscribe_link}}.`}
      />
      {step.note ? <p className="mt-2 text-xs text-muted">Why this step: {step.note}</p> : null}
      {hasStepIssues ? (
        <div className="mt-3">
          <ComplianceNotice report={compliance} step={step.step} />
        </div>
      ) : null}
    </fieldset>
  );
}
