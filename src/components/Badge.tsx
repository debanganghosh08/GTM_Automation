import type { ReactNode } from 'react';
import type { CampaignStatus, DomainStatus, LeadVerification, MailboxStatus } from '@/lib/contracts';

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-muted border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
};

export function Badge({ tone = 'neutral', children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** Maps any status string onto a tone, so every list uses the same colours. */
export function toneFor(status: string): Tone {
  switch (status) {
    case 'ready':
    case 'active':
    case 'approved':
    case 'valid':
    case 'sending':
    case 'completed':
    case 'succeeded':
    case 'trialing':
      return 'ok';
    case 'warming':
    case 'pending_approval':
    case 'awaiting_review':
    case 'awaiting_copy':
    case 'risky':
    case 'catch_all':
    case 'dns_pending':
    case 'verifying':
    case 'provisioning':
    case 'purchasing':
    case 'scheduled':
    case 'building':
    case 'running':
    case 'past_due':
      return 'warn';
    case 'failed':
    case 'invalid':
    case 'rejected':
    case 'paused':
    case 'cancelled':
    case 'dead':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function StatusBadge({
  status,
}: {
  status: CampaignStatus | DomainStatus | MailboxStatus | LeadVerification | string;
}) {
  return <Badge tone={toneFor(status)}>{status.replace(/_/g, ' ')}</Badge>;
}
