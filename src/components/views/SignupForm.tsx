'use client';

import { useState, type FormEvent } from 'react';
import { apiFetch } from '@/components/api-client';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Notice } from '@/components/Notice';

interface CheckoutData {
  url: string;
  session_id: string;
  account_id: string;
}

/**
 * Landing signup. POSTs to /api/checkout and follows the returned Stripe URL.
 * The card is saved at $0; nothing is charged until day 31.
 */
export function SignupForm({ code }: { code: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const payload = {
      company_name: String(fd.get('company_name') ?? '').trim(),
      email: String(fd.get('email') ?? '').trim(),
      website_url: String(fd.get('website_url') ?? '').trim(),
      password: String(fd.get('password') ?? ''),
      code: code ?? undefined,
    };
    if (payload.password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    const res = await apiFetch<CheckoutData>('/api/checkout', { method: 'POST', body: payload });
    if (!res.ok) {
      setBusy(false);
      setError(res.code === 'account_exists' ? `${res.error} ` : res.error);
      return;
    }
    if (!res.data.url) {
      setBusy(false);
      setError('Checkout did not return a payment link. Please try again.');
      return;
    }
    window.location.assign(res.data.url);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-describedby="signup-terms">
      {code ? (
        <p className="inline-flex w-fit items-center gap-2 rounded-full border border-accent/30 bg-accent-soft px-3 py-1 text-xs font-medium text-accent">
          <span aria-hidden="true">✓</span> Partner code <code className="font-mono">{code}</code> applied: 30,000 credits
        </p>
      ) : (
        <Notice tone="info">
          No partner code in the link. You can still sign up; add the code later if your partner gave you one.
        </Notice>
      )}
      <Field id="company_name" label="Company name" required autoComplete="organization" placeholder="Acme Robotics" />
      <Field id="email" label="Work email" type="email" required autoComplete="email" placeholder="you@company.com" />
      <Field
        id="website_url"
        label="Website URL"
        type="url"
        autoComplete="url"
        placeholder="https://company.com"
        hint="We read your site to draft the strategy. You review everything before anything sends."
      />
      <Field
        id="password"
        label="Password"
        type="password"
        required
        minLength={8}
        autoComplete="new-password"
        hint="At least 8 characters."
      />
      {error ? (
        <Notice tone="danger">
          {error}
          {error.includes('already exists') ? (
            <a href="/login" className="font-medium underline">
              Sign in
            </a>
          ) : null}
        </Notice>
      ) : null}
      <Button type="submit" size="lg" loading={busy}>
        Claim 30,000 credits
      </Button>
      <p id="signup-terms" className="text-[11px] text-muted">
        You will add a card on the next screen. $0 today. $2,000/month from day 31 unless you cancel first. Mailboxes
        are about $30 each, passed through at cost.
      </p>
    </form>
  );
}
