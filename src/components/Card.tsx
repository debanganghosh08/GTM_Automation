import type { ReactNode } from 'react';

export interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned content in the header, e.g. a button or badge. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Removes inner padding, for tables that fill the card. */
  flush?: boolean;
  id?: string;
}

export function Card({ title, description, actions, children, className = '', flush = false, id }: CardProps) {
  return (
    <section id={id} className={`rounded-lg border border-line bg-surface ${className}`}>
      {title || actions ? (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold text-ink">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}
