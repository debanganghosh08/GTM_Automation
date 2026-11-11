export function Spinner({ label = 'Loading', className = '' }: { label?: string; className?: string }) {
  return (
    <span role="status" className={`inline-flex items-center gap-2 text-xs text-muted ${className}`}>
      <span
        aria-hidden="true"
        className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent"
      />
      <span>{label}</span>
    </span>
  );
}

/** Full-width loading block for a data view that has not resolved yet. */
export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center rounded-md border border-line bg-surface px-4 py-10">
      <Spinner label={label} />
    </div>
  );
}
