'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from './api-client';

const APP_LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/strategy', label: 'Strategy' },
  { href: '/infrastructure', label: 'Infrastructure' },
  { href: '/onboarding', label: 'Questionnaire' },
  { href: '/admin', label: 'Admin' },
] as const;

/**
 * Top navigation. It does not know whether the visitor is signed in (the pages
 * find that out from their own API calls and show a sign-in notice on 401), so
 * it always offers both the app links and sign in / out.
 */
export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const isPublic = pathname === '/' || pathname === '/login' || pathname === '/register' || pathname === '/unsubscribed';

  async function signOut() {
    setSigningOut(true);
    await apiFetch('/api/auth/logout', { method: 'POST' });
    setSigningOut(false);
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span aria-hidden="true" className="inline-block h-5 w-5 rounded bg-accent" />
          GTM Autopilot
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {APP_LINKS.map((l) => {
            const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={`rounded-md px-2.5 py-1.5 text-xs font-medium ${
                  active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-muted hover:text-ink'
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          {isPublic ? (
            <Link href="/login" className="text-xs font-medium text-muted hover:text-ink">
              Sign in
            </Link>
          ) : (
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              className="text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
            >
              Sign out
            </button>
          )}
        </div>

        <button
          type="button"
          className="rounded-md border border-line px-2 py-1 text-xs md:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          onClick={() => setOpen((v) => !v)}
        >
          Menu
        </button>
      </div>

      {open ? (
        <nav id="mobile-nav" aria-label="Main" className="border-t border-line bg-surface px-4 py-2 md:hidden">
          <ul className="flex flex-col">
            {APP_LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-md px-2 py-2 text-sm text-ink hover:bg-surface-muted"
                >
                  {l.label}
                </Link>
              </li>
            ))}
            <li>
              {isPublic ? (
                <Link href="/login" onClick={() => setOpen(false)} className="block rounded-md px-2 py-2 text-sm text-ink">
                  Sign in
                </Link>
              ) : (
                <button type="button" onClick={signOut} className="block w-full rounded-md px-2 py-2 text-left text-sm text-ink">
                  Sign out
                </button>
              )}
            </li>
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
