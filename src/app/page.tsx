import type { Metadata } from 'next';
import { Card } from '@/components/Card';
import { Notice } from '@/components/Notice';
import { SignupForm } from '@/components/views/SignupForm';

export const metadata: Metadata = {
  title: 'GTM Autopilot: 30,000 outbound credits, free for your first month',
};

const STAGES = [
  { n: 1, title: 'Strategy, written for you', body: 'Answer a short questionnaire. We read your website and draft your ICP, segments, angles, offer and sequence plan. You edit and approve it.' },
  { n: 2, title: 'Leads sourced and verified', body: 'Lists built from your approved strategy, every address verified before it is uploaded. Nothing goes to a list that bounces.' },
  { n: 3, title: 'Copy that passes the checker', body: 'Three-step sequences in the house style, with an automatic compliance check. You review every word before the first send.' },
  { n: 4, title: 'Domains and mailboxes, warmed', body: 'We register or connect a sending domain, set SPF, DKIM and DMARC, provision mailboxes and warm them for 7 days.' },
  { n: 5, title: 'Sends, replies, results', body: 'Campaigns send inside your daily caps. Replies are classified. The dashboard shows sent, opens, replies, interested and credits.' },
] as const;

type Search = Record<string, string | string[] | undefined>;

export default async function LandingPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const raw = sp.code;
  const code = (Array.isArray(raw) ? raw[0] : raw)?.trim() || null;
  const cancelled = sp.checkout === 'cancelled';

  return (
    <div className="flex flex-col gap-10">
      <section className="grid gap-8 lg:grid-cols-[1.2fr_1fr] lg:items-start">
        <div className="flex flex-col gap-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">SparqLabs GTM Autopilot</p>
          <h1 className="text-3xl font-semibold leading-tight text-ink sm:text-4xl">
            30,000 outbound email credits and a done-for-you GTM strategy. Free for your first month.
          </h1>
          <p className="max-w-prose text-base text-muted">
            Not a trial of a tool. A full outbound programme: strategy, verified leads, copy, warmed mailboxes and
            sending, with 30,000 credits loaded on day one. 1 credit = 1 email sent. From day 31 it is $2,000 a month,
            cancel any time before that and you owe nothing.
          </p>

          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-line bg-surface p-3">
              <dt className="text-[11px] uppercase tracking-wide text-muted">Credits on day one</dt>
              <dd className="text-2xl font-semibold tabular-nums">30,000</dd>
              <dd className="text-xs text-muted">enough for ~10,000 contacts across a 3-step sequence</dd>
            </div>
            <div className="rounded-lg border border-line bg-surface p-3">
              <dt className="text-[11px] uppercase tracking-wide text-muted">Due today</dt>
              <dd className="text-2xl font-semibold tabular-nums">$0</dd>
              <dd className="text-xs text-muted">card saved, nothing charged for 30 days</dd>
            </div>
            <div className="rounded-lg border border-line bg-surface p-3">
              <dt className="text-[11px] uppercase tracking-wide text-muted">From day 31</dt>
              <dd className="text-2xl font-semibold tabular-nums">$2,000/mo</dd>
              <dd className="text-xs text-muted">plus ~$30 per mailbox at cost</dd>
            </div>
          </dl>

          <Notice tone="info" title="The honest part about timing">
            New sending domains need a 7-day warm-up before the first email goes out, and we do not skip it. Your
            strategy, leads and copy will be ready well before that; the first send happens when warm-up completes.
            Day 1 of your free month is the day you sign up, so expect sends to begin in week two.
          </Notice>
        </div>

        <Card title="Claim your credits" description="Takes two minutes. Card on the next screen, $0 today.">
          {cancelled ? (
            <Notice tone="warn" className="mb-3">
              Checkout was cancelled. Nothing was charged. You can try again below.
            </Notice>
          ) : null}
          <SignupForm code={code} />
        </Card>
      </section>

      <section aria-labelledby="how-it-works" className="flex flex-col gap-4">
        <h2 id="how-it-works" className="text-lg font-semibold">
          What the system does, end to end
        </h2>
        <ol className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          {STAGES.map((s) => (
            <li key={s.n} className="rounded-lg border border-line bg-surface p-4">
              <p className="text-xs font-semibold text-accent">Step {s.n}</p>
              <h3 className="mt-1 text-sm font-semibold">{s.title}</h3>
              <p className="mt-1 text-xs text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="what-you-get" className="grid gap-4 md:grid-cols-2">
        <Card title="What 30,000 credits are worth">
          <ul className="flex flex-col gap-2 text-sm text-muted">
            <li>
              <strong className="text-ink">30,000 emails sent.</strong> A credit is only spent when a send is confirmed
              by the sending platform, never on intent, and never on a bounce.
            </li>
            <li>
              <strong className="text-ink">About 10,000 contacts</strong> across a 3-step sequence, or more if replies
              end sequences early.
            </li>
            <li>
              <strong className="text-ink">Lead data and verification included</strong> for the first campaign set,
              capped so the free month cannot be used to strip-mine lists.
            </li>
            <li>
              <strong className="text-ink">A reviewed first campaign.</strong> A human at SparqLabs approves your first
              campaign before it sends. Later campaigns do not need that.
            </li>
          </ul>
        </Card>
        <Card title="What it is not">
          <ul className="flex flex-col gap-2 text-sm text-muted">
            <li>Not a seat in a tool you have to learn. You review and approve; the system runs.</li>
            <li>Not instant. Warm-up is 7 days. We would rather tell you now than land in spam later.</li>
            <li>Not unlimited. Daily caps, bounce thresholds and a compliance checker are on by default and pause sending automatically.</li>
            <li>Not a lock-in. Cancel before day 31 and the card is never charged.</li>
          </ul>
        </Card>
      </section>
    </div>
  );
}
