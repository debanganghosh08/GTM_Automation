'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { apiFetch } from '@/components/api-client';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Notice } from '@/components/Notice';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const body: Record<string, string> = {
      email: String(fd.get('email') ?? '').trim(),
      password: String(fd.get('password') ?? ''),
    };
    if (mode === 'register') body.company_name = String(fd.get('company_name') ?? '').trim();

    setBusy(true);
    const res = await apiFetch<unknown>(`/api/auth/${mode}`, { method: 'POST', body });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.push(mode === 'register' ? '/onboarding' : '/dashboard');
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {mode === 'register' ? (
        <Field id="company_name" label="Company name" required autoComplete="organization" />
      ) : null}
      <Field id="email" label="Work email" type="email" required autoComplete="email" />
      <Field
        id="password"
        label="Password"
        type="password"
        required
        minLength={mode === 'register' ? 8 : undefined}
        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
        hint={mode === 'register' ? 'At least 8 characters.' : undefined}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button type="submit" loading={busy}>
        {mode === 'register' ? 'Create account' : 'Sign in'}
      </Button>
      <p className="text-xs text-muted">
        {mode === 'register' ? (
          <>
            Already have an account?{' '}
            <Link href="/login" className="font-medium text-accent underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{' '}
            <Link href="/" className="font-medium text-accent underline">
              Claim 30,000 credits
            </Link>{' '}
            or{' '}
            <Link href="/register" className="font-medium text-accent underline">
              register without a code
            </Link>
            .
          </>
        )}
      </p>
    </form>
  );
}
