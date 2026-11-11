'use client';

import { useId, useState, type ReactNode } from 'react';

/**
 * A small definition tooltip, shown on hover and on keyboard focus. The trigger
 * is a real button, so screen readers announce the definition via aria-describedby.
 */
export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center gap-1">
      {children}
      <button
        type="button"
        aria-describedby={id}
        aria-label="Definition"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-line-strong text-[10px] leading-none text-muted hover:text-ink"
      >
        ?
      </button>
      <span
        role="tooltip"
        id={id}
        className={`absolute left-0 top-full z-20 mt-1 w-56 rounded-md border border-line bg-surface p-2 text-left text-xs font-normal normal-case tracking-normal text-ink shadow-lg ${
          open ? 'block' : 'hidden'
        }`}
      >
        {text}
      </span>
    </span>
  );
}
