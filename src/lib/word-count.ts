/**
 * Word counting for compliance and house-style checks.
 *
 * Shared so the compliance checker and any UI counter agree on one number.
 * Pure, deterministic, no I/O.
 *
 * A "word" is a whitespace-delimited token that contains at least one letter
 * or digit. Merge tags (`{{first_name}}`), URLs and the unsubscribe line are
 * stripped before counting, because none of them are prose the reader reads.
 */

/** Any `{{tag}}`, including unknown tags, so the count is stable before validation. */
// No lazy quantifier between whitespace classes: see the note in compliance.ts.
const MERGE_TAG_RE = /\{\{[^{}]*\}\}/g;

/** http(s) URLs and bare `www.` links. Stops at whitespace or a closing bracket. */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()\]]+/gi;

/** A line that carries the unsubscribe merge tag. The whole line is excluded. */
const UNSUBSCRIBE_LINE_RE = /^.*\{\{\s*unsubscribe_link\s*\}\}.*$/gim;

/** Spintax `{a|b|c}`: keep the first alternative so braces do not count as words. */
const SPINTAX_RE = /\{([^{}|]*)\|[^{}]*\}/g;

/**
 * Removes the unsubscribe line, merge tags, URLs and spintax braces.
 * Exported so other modules can run text-only checks on the same view.
 */
export function stripTags(text: string): string {
  return text
    .replace(UNSUBSCRIBE_LINE_RE, '')
    .replace(MERGE_TAG_RE, ' ')
    .replace(URL_RE, ' ')
    .replace(SPINTAX_RE, '$1');
}

/** Counts words after `stripTags`. Punctuation-only tokens (`-`, `|`) do not count. */
export function countWords(text: string): number {
  const stripped = stripTags(text);
  let count = 0;
  for (const token of stripped.split(/\s+/)) {
    if (/[\p{L}\p{N}]/u.test(token)) count += 1;
  }
  return count;
}
