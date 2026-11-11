import type { ComplianceCode, ComplianceIssue, ComplianceReport } from '@/lib/contracts';
import { formatDateTime } from './api-client';

/** The plain-words fix for each checker code, shown next to the issue. */
const FIXES: Record<ComplianceCode, string> = {
  missing_unsubscribe: 'Add {{unsubscribe_link}} to the body, usually in the P.S. line.',
  unknown_merge_tag:
    'Only first_name, last_name, company_name, title, industry, sending_name and unsubscribe_link are allowed inside {{ }}.',
  spam_word: 'Rephrase without the flagged word. Spam filters score it.',
  subject_too_long: 'Keep the subject to 6 words or fewer, lowercase.',
  body_too_long: 'Cut the body to 220 words or fewer.',
  body_too_short: 'The body needs at least 30 words.',
  all_caps: 'Rewrite the capitalised phrase in normal case.',
  excessive_punctuation: 'Use a single ! or ? at most.',
  link_count: 'Keep to two links or fewer per email.',
  missing_sender_identity: 'Set a sending name on the questionnaire; it is required in the signature.',
  empty_step: 'Write a subject and body for this step, or remove the step.',
};

function fixFor(code: ComplianceCode): string {
  return FIXES[code] ?? 'See the message for what to change.';
}

function IssueList({ issues, tone }: { issues: ComplianceIssue[]; tone: 'danger' | 'warn' }) {
  const colour = tone === 'danger' ? 'border-danger/30 bg-danger-soft text-danger' : 'border-warn/30 bg-warn-soft text-warn';
  return (
    <ul className="flex flex-col gap-1.5">
      {issues.map((issue, i) => (
        <li key={`${issue.code}-${issue.step ?? 'all'}-${i}`} className={`rounded-md border px-3 py-2 text-xs ${colour}`}>
          <p className="font-semibold">
            {issue.step !== undefined ? `Step ${issue.step}: ` : ''}
            {issue.message}
          </p>
          {issue.evidence ? (
            <p className="mt-0.5 font-mono text-[11px] opacity-90">“{issue.evidence}”</p>
          ) : null}
          <p className="mt-0.5 opacity-90">
            <span className="font-medium">Fix:</span> {fixFor(issue.code)}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Renders a ComplianceReport inline. Errors block the send and are red with the
 * fix; warnings are amber and allowed. `step` filters to one sequence step.
 */
export function ComplianceNotice({ report, step }: { report: ComplianceReport | null; step?: number }) {
  if (!report) {
    return <p className="text-xs text-muted">Compliance has not been checked yet. It runs automatically when copy is saved.</p>;
  }
  const errors = step === undefined ? report.errors : report.errors.filter((e) => e.step === step || e.step === undefined);
  const warnings = step === undefined ? report.warnings : report.warnings.filter((w) => w.step === step || w.step === undefined);

  if (errors.length === 0 && warnings.length === 0) {
    return (
      <p className="rounded-md border border-ok/30 bg-ok-soft px-3 py-2 text-xs text-ok" role="status">
        {step === undefined ? 'All steps pass the compliance checker' : 'This step passes the compliance checker'}
        {step === undefined ? ` (checked ${formatDateTime(report.checked_at)}).` : '.'}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" role={errors.length > 0 ? 'alert' : 'status'}>
      {errors.length > 0 ? (
        <div>
          <p className="mb-1 text-xs font-semibold text-danger">
            {errors.length} blocking {errors.length === 1 ? 'error' : 'errors'}: the send button stays off until these are fixed.
          </p>
          <IssueList issues={errors} tone="danger" />
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div>
          <p className="mb-1 text-xs font-semibold text-warn">
            {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}: allowed, but worth a look.
          </p>
          <IssueList issues={warnings} tone="warn" />
        </div>
      ) : null}
    </div>
  );
}
