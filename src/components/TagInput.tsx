'use client';

import { useId, useState, type KeyboardEvent } from 'react';

export interface TagInputProps {
  id: string;
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  hint?: string;
  required?: boolean;
}

/**
 * A list-of-strings input. Enter or comma adds a tag; Backspace on an empty
 * field removes the last one. Each tag has a real remove button for keyboard users.
 */
export function TagInput({ id, label, value, onChange, placeholder, hint, required }: TagInputProps) {
  const [draft, setDraft] = useState('');
  const listId = useId();

  function commit() {
    const parts = draft
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !value.includes(s));
    if (parts.length > 0) onChange([...value, ...parts]);
    setDraft('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-ink">
        {label}
        {required ? <span className="ml-0.5 text-danger" aria-hidden="true">*</span> : null}
      </label>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30">
        <ul id={listId} className="contents" aria-label={`${label} entries`}>
          {value.map((tag) => (
            <li key={tag} className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">
              <span>{tag}</span>
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                onClick={() => onChange(value.filter((t) => t !== tag))}
                className="rounded-full px-1 leading-none hover:bg-accent hover:text-accent-contrast"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <input
          id={id}
          name={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
          placeholder={value.length === 0 ? placeholder : undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          aria-controls={listId}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-ink outline-none placeholder:text-faint"
        />
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted">
        {hint ?? 'Press Enter or type a comma to add each one.'}
      </p>
    </div>
  );
}
