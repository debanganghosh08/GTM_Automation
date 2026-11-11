import type { ReactNode } from 'react';

export interface Column<Row> {
  key: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  /** Right-align numbers. */
  align?: 'left' | 'right';
  className?: string;
}

export interface DataTableProps<Row> {
  columns: Array<Column<Row>>;
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Rendered when `rows` is empty. */
  empty?: ReactNode;
  /** An optional final row, e.g. totals. */
  footer?: ReactNode;
  caption?: string;
  dense?: boolean;
}

/**
 * A plain, typed table. It scrolls horizontally inside its own wrapper so a wide
 * table never causes the page to scroll sideways on a phone.
 */
export function DataTable<Row>({ columns, rows, rowKey, empty, footer, caption, dense = false }: DataTableProps<Row>) {
  const cell = dense ? 'px-3 py-1.5' : 'px-3 py-2';
  return (
    <div className="table-wrap">
      <table className="w-full min-w-[520px] border-collapse text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-line bg-surface-muted text-left text-[11px] uppercase tracking-wide text-muted">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`${cell} font-medium ${c.align === 'right' ? 'text-right' : ''} ${c.className ?? ''}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-xs text-muted">
                {empty ?? 'Nothing here yet.'}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className="border-b border-line last:border-b-0 hover:bg-surface-muted/60">
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`${cell} align-top ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.className ?? ''}`}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        {footer ? <tfoot className="border-t border-line-strong bg-surface-muted font-medium">{footer}</tfoot> : null}
      </table>
    </div>
  );
}
