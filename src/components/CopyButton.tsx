'use client';

import { useState } from 'react';
import { Button } from './Button';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.setTimeout(() => setState('idle'), 1500);
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={copy}
      aria-live="polite"
      aria-label={state === 'copied' ? 'Copied' : `${label} to clipboard`}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy' : label}
    </Button>
  );
}
