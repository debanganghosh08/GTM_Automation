import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const control =
  'w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink ' +
  'placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 ' +
  'disabled:opacity-60';

interface BaseProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
}

function Wrapper({
  id,
  label,
  hint,
  error,
  required,
  className = '',
  children,
}: BaseProps & { children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-xs font-medium text-ink">
        {label}
        {required ? <span className="ml-0.5 text-danger" aria-hidden="true">*</span> : null}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface FieldProps extends BaseProps, Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className' | 'required'> {}

/** A labelled text input. The label is a real <label for=…>, always. */
export function Field({ id, label, hint, error, required, className, ...input }: FieldProps) {
  return (
    <Wrapper id={id} label={label} hint={hint} error={error} required={required} className={className}>
      <input
        id={id}
        name={input.name ?? id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={control}
        {...input}
      />
    </Wrapper>
  );
}

export interface TextAreaFieldProps
  extends BaseProps,
    Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'className' | 'required'> {}

export function TextAreaField({ id, label, hint, error, required, className, ...area }: TextAreaFieldProps) {
  return (
    <Wrapper id={id} label={label} hint={hint} error={error} required={required} className={className}>
      <textarea
        id={id}
        name={area.name ?? id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={`${control} min-h-24 resize-y`}
        {...area}
      />
    </Wrapper>
  );
}

export interface SelectFieldProps
  extends BaseProps,
    Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'className' | 'required'> {
  options: Array<{ value: string; label: string }>;
}

export function SelectField({ id, label, hint, error, required, className, options, ...select }: SelectFieldProps) {
  return (
    <Wrapper id={id} label={label} hint={hint} error={error} required={required} className={className}>
      <select
        id={id}
        name={select.name ?? id}
        required={required}
        aria-invalid={error ? true : undefined}
        className={control}
        {...select}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Wrapper>
  );
}

export const controlClass = control;
