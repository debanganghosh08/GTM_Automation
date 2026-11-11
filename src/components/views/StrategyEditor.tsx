'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GtmStrategy, SequenceStepPlan, StrategySegment } from '@/lib/contracts';
import { apiFetch, isMissingRoute, isUnauthorized, pick, type ApiFailure } from '@/components/api-client';
import { Badge } from '@/components/Badge';
import { Button, LinkButton } from '@/components/Button';
import { Card } from '@/components/Card';
import { Field, TextAreaField, controlClass } from '@/components/Field';
import { ApiErrorNotice, Notice } from '@/components/Notice';
import { Spinner } from '@/components/Spinner';
import { TagInput } from '@/components/TagInput';

const POLL_MS = 4000;
const POLL_LIMIT_MS = 10 * 60 * 1000;

interface Loaded {
  strategy: GtmStrategy;
  status: string | null;
  approved: boolean;
}

function isStrategy(v: unknown): v is GtmStrategy {
  return typeof v === 'object' && v !== null && typeof (v as GtmStrategy).positioning === 'string' && Array.isArray((v as GtmStrategy).segments);
}

/**
 * GET /api/strategy may return the GtmStrategy itself or a row wrapping it as
 * `payload`. Both are accepted. Returns null when no strategy exists yet.
 */
function normalise(data: unknown): Loaded | null {
  if (data === null || data === undefined) return null;
  if (isStrategy(data)) return { strategy: data, status: null, approved: false };

  // GET /api/strategy answers { strategy: <row> }, and the row keeps the strategy in
  // its `payload` column, so the value sits TWO levels down. Unwrapping one level left
  // `payload` holding the row itself, isStrategy() rejected it, normalise() returned
  // null, and load() read that as 'generating' — so the strategy screen polled forever
  // even though the strategy had been generated and stored. Walk down to find it
  // instead of assuming a depth, and read the status fields off whichever wrapper
  // actually carries them (the row, not the response).
  let node: unknown = data;
  for (let depth = 0; depth < 4; depth += 1) {
    const inner = pick<unknown>(node, 'payload') ?? pick<unknown>(node, 'strategy');
    if (inner === null || inner === undefined) return null;
    if (isStrategy(inner)) {
      const status = pick<string>(node, 'status') ?? null;
      const approvedAt = pick<string | null>(node, 'approved_at') ?? null;
      return { strategy: inner, status, approved: Boolean(approvedAt) || status === 'approved' };
    }
    node = inner;
  }
  return null;
}

export function StrategyEditor() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<GtmStrategy | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [phase, setPhase] = useState<'loading' | 'generating' | 'ready' | 'error'>('loading');
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger' | 'warn'; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const pollStart = useRef<number>(Date.now());

  const load = useCallback(async () => {
    const res = await apiFetch<unknown>('/api/strategy');
    if (!res.ok) {
      if (res.code === 'not_found') {
        setPhase('generating');
        return;
      }
      setFailure(res);
      setPhase('error');
      return;
    }
    const n = normalise(res.data);
    if (!n) {
      setPhase('generating');
      return;
    }
    const generating = n.status === 'generating' || n.status === 'pending';
    setLoaded(n);
    if (!generating) {
      setDraft((prev) => prev ?? n.strategy);
      setPhase('ready');
    } else {
      setPhase('generating');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while generation is in flight, with a hard stop so a stuck job cannot poll forever.
  useEffect(() => {
    if (phase !== 'generating') return;
    const id = window.setInterval(() => {
      if (Date.now() - pollStart.current > POLL_LIMIT_MS) {
        window.clearInterval(id);
        setMessage({ tone: 'warn', text: 'Generation is taking longer than expected. Refresh, or start it again below.' });
        return;
      }
      void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [phase, load]);

  function patch(fn: (prev: GtmStrategy) => GtmStrategy) {
    setDraft((prev) => (prev ? fn(prev) : prev));
    setDirty(true);
    setMessage(null);
  }

  async function generate() {
    setMessage(null);
    const res = await apiFetch<unknown>('/api/strategy/generate', { method: 'POST', body: {} });
    if (!res.ok) {
      setMessage({ tone: 'danger', text: res.error });
      return;
    }
    pollStart.current = Date.now();
    setPhase('generating');
  }

  async function save(): Promise<boolean> {
    if (!draft) return false;
    setSaving(true);
    const res = await apiFetch<unknown>('/api/strategy', { method: 'PUT', body: draft });
    setSaving(false);
    if (!res.ok) {
      setMessage({ tone: 'danger', text: `Could not save: ${res.error}` });
      return false;
    }
    setDirty(false);
    const n = normalise(res.data);
    if (n) setLoaded(n);
    setMessage({ tone: 'ok', text: 'Strategy saved.' });
    return true;
  }

  async function approve() {
    setApproving(true);
    if (dirty) {
      const ok = await save();
      if (!ok) {
        setApproving(false);
        return;
      }
    }
    const res = await apiFetch<unknown>('/api/strategy/approve', { method: 'POST', body: {} });
    setApproving(false);
    if (!res.ok) {
      setMessage({ tone: 'danger', text: `Could not approve: ${res.error}` });
      return;
    }
    setLoaded((l) => (l ? { ...l, approved: true, status: 'approved' } : l));
    setMessage({ tone: 'ok', text: 'Strategy approved. Next: connect or buy a sending domain.' });
  }

  if (phase === 'loading') {
    return (
      <Card>
        <Spinner label="Loading your strategy" />
      </Card>
    );
  }

  if (phase === 'error' && failure) {
    return (
      <div className="flex flex-col gap-3">
        <ApiErrorNotice failure={failure} what="your strategy" />
        {!isUnauthorized(failure) && !isMissingRoute(failure) ? (
          <div>
            <Button variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  if (phase === 'generating' || !draft) {
    return (
      <Card title="Generating your strategy">
        <div className="flex flex-col gap-3">
          <Spinner label="Reading your answers and website, drafting ICP, segments, angles, offer and sequence plan. Usually under five minutes." />
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void load()}>
              Check now
            </Button>
            <Button variant="ghost" onClick={generate}>
              Start generation again
            </Button>
            <LinkButton href="/onboarding" variant="ghost">
              Edit questionnaire
            </LinkButton>
          </div>
        </div>
      </Card>
    );
  }

  const approved = loaded?.approved ?? false;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <div className="flex items-center gap-2">
          {approved ? <Badge tone="ok">Approved</Badge> : <Badge tone="warn">Awaiting your approval</Badge>}
          {dirty ? <Badge tone="accent">Unsaved changes</Badge> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void save()} loading={saving} disabled={!dirty}>
            Save changes
          </Button>
          {approved ? (
            <LinkButton href="/infrastructure">Continue to domain setup</LinkButton>
          ) : (
            <Button onClick={approve} loading={approving}>
              Approve strategy
            </Button>
          )}
        </div>
      </div>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Card
        title="What we assumed"
        description="The model could not determine these from your inputs and guessed. Correct anything wrong before approving."
        className="border-warn/40"
      >
        {draft.assumptions.length === 0 ? (
          <p className="text-xs text-muted">No assumptions were recorded. Either the inputs were complete, or the generator did not report them.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {draft.assumptions.map((a, i) => (
              <li key={i} className="flex items-start gap-2">
                <span aria-hidden="true" className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                <label htmlFor={`assumption-${i}`} className="sr-only">
                  Assumption {i + 1}
                </label>
                <input
                  id={`assumption-${i}`}
                  value={a}
                  onChange={(e) => patch((s) => ({ ...s, assumptions: s.assumptions.map((x, idx) => (idx === i ? e.target.value : x)) }))}
                  className={controlClass}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove assumption ${i + 1}`}
                  onClick={() => patch((s) => ({ ...s, assumptions: s.assumptions.filter((_, idx) => idx !== i) }))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Positioning">
        <TextAreaField
          id="positioning"
          label="One-paragraph positioning"
          value={draft.positioning}
          onChange={(e) => patch((s) => ({ ...s, positioning: e.target.value }))}
        />
      </Card>

      <Card title="Ideal customer profile">
        <div className="flex flex-col gap-3">
          <TextAreaField
            id="icp-summary"
            label="Summary"
            value={draft.icp.summary}
            onChange={(e) => patch((s) => ({ ...s, icp: { ...s.icp, summary: e.target.value } }))}
          />
          <div className="grid gap-3 md:grid-cols-2">
            <TagInput id="icp-titles" label="Titles" value={draft.icp.titles} onChange={(v) => patch((s) => ({ ...s, icp: { ...s.icp, titles: v } }))} />
            <TagInput
              id="icp-industries"
              label="Industries"
              value={draft.icp.industries}
              onChange={(v) => patch((s) => ({ ...s, icp: { ...s.icp, industries: v } }))}
            />
            <TagInput id="icp-geos" label="Geographies" value={draft.icp.geos} onChange={(v) => patch((s) => ({ ...s, icp: { ...s.icp, geos: v } }))} />
            <TagInput
              id="icp-exclusions"
              label="Exclusions"
              value={draft.icp.exclusions}
              onChange={(v) => patch((s) => ({ ...s, icp: { ...s.icp, exclusions: v } }))}
            />
            <Field
              id="icp-headcount-min"
              label="Headcount minimum"
              type="number"
              min={0}
              value={draft.icp.headcount_min ?? ''}
              onChange={(e) => patch((s) => ({ ...s, icp: { ...s.icp, headcount_min: e.target.value === '' ? null : Number(e.target.value) } }))}
            />
            <Field
              id="icp-headcount-max"
              label="Headcount maximum"
              type="number"
              min={0}
              value={draft.icp.headcount_max ?? ''}
              onChange={(e) => patch((s) => ({ ...s, icp: { ...s.icp, headcount_max: e.target.value === '' ? null : Number(e.target.value) } }))}
            />
          </div>
        </div>
      </Card>

      <Card
        title="Segments"
        description="Each segment gets its own list filters (signals) and its own angle."
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              patch((s) => ({
                ...s,
                segments: [...s.segments, { name: '', description: '', signals: [], angle: '', estimated_size: null }],
              }))
            }
          >
            Add segment
          </Button>
        }
      >
        {draft.segments.length === 0 ? (
          <p className="text-xs text-muted">No segments yet. Add at least one so leads can be sourced.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {draft.segments.map((seg, i) => (
              <SegmentEditor
                key={i}
                index={i}
                segment={seg}
                onChange={(next) => patch((s) => ({ ...s, segments: s.segments.map((x, idx) => (idx === i ? next : x)) }))}
                onRemove={() => patch((s) => ({ ...s, segments: s.segments.filter((_, idx) => idx !== i) }))}
              />
            ))}
          </div>
        )}
      </Card>

      <Card title="Offer">
        <div className="flex flex-col gap-3">
          <Field id="offer-headline" label="Headline" value={draft.offer.headline} onChange={(e) => patch((s) => ({ ...s, offer: { ...s.offer, headline: e.target.value } }))} />
          <TextAreaField id="offer-body" label="Body" value={draft.offer.body} onChange={(e) => patch((s) => ({ ...s, offer: { ...s.offer, body: e.target.value } }))} />
          <TagInput
            id="offer-proof"
            label="Proof points"
            value={draft.offer.proof_points}
            onChange={(v) => patch((s) => ({ ...s, offer: { ...s.offer, proof_points: v } }))}
            hint="Only claims you can back up. Empty is better than invented."
          />
          <Field
            id="offer-risk"
            label="Risk reversal"
            hint="What makes saying yes safe. Leave blank if there is none."
            value={draft.offer.risk_reversal ?? ''}
            onChange={(e) => patch((s) => ({ ...s, offer: { ...s.offer, risk_reversal: e.target.value || null } }))}
          />
        </div>
      </Card>

      <Card
        title="Sequence plan"
        description="Step 1 is day 0. Delays are days after the previous step."
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              patch((s) => ({
                ...s,
                sequence_plan: [...s.sequence_plan, { step: s.sequence_plan.length + 1, delay_days: 3, purpose: '', channel: 'email' }],
              }))
            }
          >
            Add step
          </Button>
        }
      >
        <ol className="flex flex-col gap-3">
          {draft.sequence_plan.map((st, i) => (
            <StepEditor
              key={i}
              index={i}
              step={st}
              onChange={(next) => patch((s) => ({ ...s, sequence_plan: s.sequence_plan.map((x, idx) => (idx === i ? next : x)) }))}
              onRemove={() =>
                patch((s) => ({
                  ...s,
                  sequence_plan: s.sequence_plan.filter((_, idx) => idx !== i).map((x, idx) => ({ ...x, step: idx + 1 })),
                }))
              }
            />
          ))}
        </ol>
      </Card>

      <Card title="Rationale" description="Why this strategy, in your context.">
        <TextAreaField id="rationale" label="Rationale" value={draft.rationale} onChange={(e) => patch((s) => ({ ...s, rationale: e.target.value }))} />
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => void save()} loading={saving} disabled={!dirty}>
          Save changes
        </Button>
        {approved ? (
          <LinkButton href="/infrastructure">Continue to domain setup</LinkButton>
        ) : (
          <Button onClick={approve} loading={approving}>
            Approve strategy
          </Button>
        )}
        <Link href="/onboarding" className="text-xs text-muted underline">
          Change questionnaire answers
        </Link>
      </div>
    </div>
  );
}

function SegmentEditor({
  index,
  segment,
  onChange,
  onRemove,
}: {
  index: number;
  segment: StrategySegment;
  onChange: (s: StrategySegment) => void;
  onRemove: () => void;
}) {
  const p = `seg-${index}`;
  return (
    <fieldset className="rounded-md border border-line p-3">
      <legend className="px-1 text-xs font-semibold text-muted">Segment {index + 1}</legend>
      <div className="grid gap-3 md:grid-cols-2">
        <Field id={`${p}-name`} label="Name" value={segment.name} onChange={(e) => onChange({ ...segment, name: e.target.value })} />
        <Field
          id={`${p}-size`}
          label="Estimated size"
          type="number"
          min={0}
          value={segment.estimated_size ?? ''}
          onChange={(e) => onChange({ ...segment, estimated_size: e.target.value === '' ? null : Number(e.target.value) })}
        />
        <TextAreaField id={`${p}-desc`} label="Description" className="md:col-span-2" value={segment.description} onChange={(e) => onChange({ ...segment, description: e.target.value })} />
        <TagInput id={`${p}-signals`} label="Buying signals" value={segment.signals} onChange={(v) => onChange({ ...segment, signals: v })} placeholder="hiring SDRs, raised seed <12mo" />
        <TextAreaField id={`${p}-angle`} label="Angle" value={segment.angle} onChange={(e) => onChange({ ...segment, angle: e.target.value })} />
      </div>
      <div className="mt-2 text-right">
        <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove segment ${index + 1}`}>
          Remove segment
        </Button>
      </div>
    </fieldset>
  );
}

function StepEditor({
  index,
  step,
  onChange,
  onRemove,
}: {
  index: number;
  step: SequenceStepPlan;
  onChange: (s: SequenceStepPlan) => void;
  onRemove: () => void;
}) {
  const p = `plan-${index}`;
  return (
    <li className="grid gap-3 rounded-md border border-line p-3 md:grid-cols-[6rem_1fr_auto] md:items-end">
      <Field
        id={`${p}-delay`}
        label={`Step ${step.step} delay (days)`}
        type="number"
        min={0}
        value={step.delay_days}
        disabled={index === 0}
        onChange={(e) => onChange({ ...step, delay_days: Number(e.target.value) })}
      />
      <Field id={`${p}-purpose`} label="Purpose" value={step.purpose} onChange={(e) => onChange({ ...step, purpose: e.target.value })} />
      <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove step ${step.step}`}>
        Remove
      </Button>
    </li>
  );
}
