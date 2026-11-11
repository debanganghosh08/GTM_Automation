import type { ReactNode } from 'react';
import Link from 'next/link';
import type { ApiFailure } from './api-client';
import { isMissingRoute, isUnauthorized } from './api-client';

export type NoticeTone = 'info' | 'ok' | 'warn' | 'danger';

const tones: Record<NoticeTone, string> = {
  info: 'border-line bg-surface-muted text-ink',
  ok: 'border-ok/30 bg-ok-soft text-ok',
  warn: 'border-warn/30 bg-warn-soft text-warn',
  danger: 'border-danger/30 bg-danger-soft text-danger',
};

export function Notice({
  tone = 'info',
  title,
  children,
  className = '',
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-xs ${tones[tone]} ${className}`}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? 'mt-0.5' : ''}>{children}</div> : null}
    </div>
  );
}

/**
 * Renders an API failure as an inline notice. A 401 links to sign-in; a missing
 * route (the backend for this page is not built yet) is shown as a warning, not
 * an error, so the shell still reads as intentional.
 */
export function ApiErrorNotice({ failure, what = 'this page' }: { failure: ApiFailure; what?: string }) {
  if (isUnauthorized(failure)) {
    return (
      <Notice tone="warn" title="Sign in to continue">
        You need to be signed in to see {what}.{' '}
        <Link href="/login" className="font-medium underline">
          Sign in
        </Link>
      </Notice>
    );
  }
  if (isMissingRoute(failure)) {
    return (
      <Notice tone="warn" title="Not connected yet">
        The data for {what} is not available: {failure.error}.
      </Notice>
    );
  }
  return (
    <Notice tone="danger" title={`Could not load ${what}`}>
      {failure.error}
    </Notice>
  );
}
