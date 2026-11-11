'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { OnboardingProfile } from '@/lib/contracts';
import { apiFetch, isUnauthorized, type ApiFailure } from '@/components/api-client';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Field, SelectField, TextAreaField } from '@/components/Field';
import { ApiErrorNotice, Notice } from '@/components/Notice';
import { Spinner } from '@/components/Spinner';
import { TagInput } from '@/components/TagInput';

const HEADCOUNT_RANGES = [
  { value: 'any', label: 'Any size', min: null, max: null },
  { value: '1-10', label: '1 to 10', min: 1, max: 10 },
  { value: '11-50', label: '11 to 50', min: 11, max: 50 },
  { value: '51-200', label: '51 to 200', min: 51, max: 200 },
  { value: '201-500', label: '201 to 500', min: 201, max: 500 },
  { value: '501-1000', label: '501 to 1,000', min: 501, max: 1000 },
  { value: '1001+', label: '1,001 or more', min: 1001, max: null },
] as const;

type RangeKey = (typeof HEADCOUNT_RANGES)[number]['value'];

function rangeFor(min: number | null, max: number | null): RangeKey {
  const hit = HEADCOUNT_RANGES.find((r) => r.min === min && r.max === max);
  return hit?.value ?? 'any';
}

interface Draft {
  product: string;
  icp_description: string;
  offer: string;
  proof_points: string[];
  sending_name: string;
  target_titles: string[];
  target_industries: string[];
  target_geos: string[];
  headcount: RangeKey;
  exclusions: string[];
}

const EMPTY: Draft = {
  product: '',
  icp_description: '',
  offer: '',
  proof_points: [''],
  sending_name: '',
  target_titles: [],
  target_industries: [],
  target_geos: [],
  headcount: 'any',
  exclusions: [],
};

function fromProfile(p: Partial<OnboardingProfile>): Draft {
  return {
    product: p.product ?? '',
    icp_description: p.icp_description ?? '',
    offer: p.offer ?? '',
    proof_points: p.proof_points && p.proof_points.length > 0 ? p.proof_points : [''],
    sending_name: p.sending_name ?? '',
    target_titles: p.target_titles ?? [],
    target_industries: p.target_industries ?? [],
    target_geos: p.target_geos ?? [],
    headcount: rangeFor(p.headcount_min ?? null, p.headcount_max ?? null),
    exclusions: p.exclusions ?? [],
  };
}

export function OnboardingForm() {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiFailure | null>(null);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'generating'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [savedButNotGenerated, setSavedButNotGenerated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Partial<OnboardingProfile> | null>('/api/onboarding').then((res) => {
      if (cancelled) return;
      if (res.ok) {
        if (res.data) setDraft(fromProfile(res.data));
      } else if (res.code !== 'not_found') {
        setLoadError(res);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function setProof(i: number, value: string) {
    setDraft((d) => ({ ...d, proof_points: d.proof_points.map((p, idx) => (idx === i ? value : p)) }));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSavedButNotGenerated(false);
    const range = HEADCOUNT_RANGES.find((r) => r.value === draft.headcount) ?? HEADCOUNT_RANGES[0];
    const body = {
      product: draft.product.trim(),
      icp_description: draft.icp_description.trim(),
      offer: draft.offer.trim(),
      proof_points: draft.proof_points.map((p) => p.trim()).filter((p) => p.length > 0),
      sending_name: draft.sending_name.trim(),
      target_titles: draft.target_titles,
      target_industries: draft.target_industries,
      target_geos: draft.target_geos,
      headcount_min: range.min,
      headcount_max: range.max,
      exclusions: draft.exclusions,
      // POST /api/strategy/generate refuses to start unless onboarding_profiles.completed_at
      // is set, and only a body with `complete` sets it. Without this flag the form saved the
      // answers, then got a 400 from generation every single time, so the questionnaire could
      // never hand off to the strategy step. Completing here also queues the site scrape, which
      // is what gives the strategy anything to read beyond these answers.
      complete: true,
    };
    if (body.target_titles.length === 0) {
      setError('Add at least one target title so we know who to write to.');
      return;
    }

    setSaving('saving');
    const saved = await apiFetch<unknown>('/api/onboarding', { method: 'POST', body });
    if (!saved.ok) {
      setSaving('idle');
      setError(saved.error);
      return;
    }
    setSaving('generating');
    const gen = await apiFetch<unknown>('/api/strategy/generate', { method: 'POST', body: {} });
    setSaving('idle');
    if (!gen.ok) {
      setSavedButNotGenerated(true);
      setError(`Answers saved, but strategy generation could not start: ${gen.error}`);
      return;
    }
    router.push('/strategy');
  }

  if (loading) {
    return (
      <Card>
        <Spinner label="Loading your answers" />
      </Card>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {loadError ? (
        <ApiErrorNotice failure={loadError} what="your saved answers" />
      ) : null}
      {loadError && isUnauthorized(loadError) ? null : (
        <>
          <Card title="1. The product" description="What you sell, in your own words. Plain language beats the website copy.">
            <div className="flex flex-col gap-3">
              <TextAreaField
                id="product"
                label="What does your product do?"
                required
                value={draft.product}
                onChange={(e) => set('product', e.target.value)}
                placeholder="We run outbound for B2B teams that have no SDRs..."
              />
              <TextAreaField
                id="offer"
                label="The offer"
                required
                hint="What a prospect gets if they say yes. A pilot, a free audit, a fixed-price package."
                value={draft.offer}
                onChange={(e) => set('offer', e.target.value)}
              />
              <fieldset className="flex flex-col gap-2">
                <legend className="text-xs font-medium text-ink">Proof points</legend>
                <p className="text-xs text-muted">
                  Real results, named customers, numbers you can stand behind. Leave empty rather than guess: the
                  strategy will not invent any.
                </p>
                {draft.proof_points.map((p, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <label htmlFor={`proof-${i}`} className="sr-only">
                      Proof point {i + 1}
                    </label>
                    <input
                      id={`proof-${i}`}
                      value={p}
                      onChange={(e) => setProof(i, e.target.value)}
                      placeholder="e.g. 41 meetings booked for Acme in 60 days"
                      className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove proof point ${i + 1}`}
                      onClick={() =>
                        set(
                          'proof_points',
                          draft.proof_points.length === 1 ? [''] : draft.proof_points.filter((_, idx) => idx !== i),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <div>
                  <Button type="button" size="sm" variant="secondary" onClick={() => set('proof_points', [...draft.proof_points, ''])}>
                    Add another
                  </Button>
                </div>
              </fieldset>
            </div>
          </Card>

          <Card title="2. Who buys it" description="The ideal customer profile. Specific beats broad; we can widen later.">
            <div className="flex flex-col gap-3">
              <TextAreaField
                id="icp_description"
                label="Describe your ideal customer"
                required
                value={draft.icp_description}
                onChange={(e) => set('icp_description', e.target.value)}
                placeholder="Founders of 20 to 200 person B2B software companies who sell a considered purchase and have no SDR team."
              />
              <TagInput
                id="target_titles"
                label="Target titles"
                required
                value={draft.target_titles}
                onChange={(v) => set('target_titles', v)}
                placeholder="Founder, VP Sales, Head of Growth"
              />
              <TagInput
                id="target_industries"
                label="Target industries"
                value={draft.target_industries}
                onChange={(v) => set('target_industries', v)}
                placeholder="Software, Logistics, Professional services"
              />
              <TagInput
                id="target_geos"
                label="Target geographies"
                value={draft.target_geos}
                onChange={(v) => set('target_geos', v)}
                placeholder="United States, United Kingdom"
              />
              <SelectField
                id="headcount"
                label="Company headcount"
                value={draft.headcount}
                onChange={(e) => set('headcount', e.target.value as RangeKey)}
                options={HEADCOUNT_RANGES.map((r) => ({ value: r.value, label: r.label }))}
              />
              <TagInput
                id="exclusions"
                label="Exclusions"
                value={draft.exclusions}
                onChange={(v) => set('exclusions', v)}
                placeholder="Competitors, existing customers, agencies"
                hint="Companies, domains or categories we must never email. Press Enter after each."
              />
            </div>
          </Card>

          <Card title="3. Who the emails come from" description="The name in the signature. Emails without a sender identity fail the compliance check.">
            <Field
              id="sending_name"
              label="Sending name"
              required
              value={draft.sending_name}
              onChange={(e) => set('sending_name', e.target.value)}
              placeholder="Jane Doe"
              autoComplete="name"
            />
          </Card>

          {error ? (
            <Notice tone={savedButNotGenerated ? 'warn' : 'danger'}>
              {error}
              {savedButNotGenerated ? (
                <>
                  {' '}
                  <Link href="/strategy" className="font-medium underline">
                    Go to the strategy page
                  </Link>{' '}
                  to retry from there.
                </>
              ) : null}
            </Notice>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="lg" loading={saving !== 'idle'}>
              {saving === 'generating' ? 'Starting strategy generation' : saving === 'saving' ? 'Saving' : 'Save and generate strategy'}
            </Button>
            <p className="text-xs text-muted">The strategy takes a few minutes. You can edit every line of it.</p>
          </div>
        </>
      )}
    </form>
  );
}
