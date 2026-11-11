import Link from 'next/link';

/** The 7-step customer journey from SPEC §3. */
export const JOURNEY = [
  { n: 1, label: 'Sign up', href: '/' },
  { n: 2, label: 'Questionnaire', href: '/onboarding' },
  { n: 3, label: 'Strategy', href: '/strategy' },
  { n: 4, label: 'Domain & warm-up', href: '/infrastructure' },
  { n: 5, label: 'Review & send', href: '/campaigns' },
  { n: 6, label: 'Results', href: '/dashboard' },
  { n: 7, label: 'Renews day 31', href: '/dashboard' },
] as const;

export type JourneyStep = (typeof JOURNEY)[number]['n'];

/**
 * Progress indicator across the journey. Steps before `current` are done,
 * `current` is highlighted, later steps are muted. Horizontal and scrollable on
 * narrow screens so it never widens the page.
 */
export function JourneySteps({ current }: { current: JourneyStep }) {
  return (
    <nav aria-label="Setup progress" className="table-wrap">
      <ol className="flex min-w-max items-center gap-1 text-xs">
        {JOURNEY.map((s, i) => {
          const done = s.n < current;
          const active = s.n === current;
          const circle = done
            ? 'bg-accent text-accent-contrast border-accent'
            : active
              ? 'border-accent text-accent bg-accent-soft'
              : 'border-line-strong text-muted bg-surface';
          const text = active ? 'text-ink font-semibold' : done ? 'text-ink' : 'text-muted';
          return (
            <li key={s.n} className="flex items-center gap-1">
              <Link
                href={s.href}
                aria-current={active ? 'step' : undefined}
                className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-surface-muted ${text}`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-semibold ${circle}`}
                >
                  {done ? '✓' : s.n}
                </span>
                <span>
                  <span className="sr-only">{done ? 'Done: ' : active ? 'Current: ' : ''}</span>
                  {s.label}
                </span>
              </Link>
              {i < JOURNEY.length - 1 ? (
                <span aria-hidden="true" className={`h-px w-4 ${done ? 'bg-accent' : 'bg-line-strong'}`} />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
