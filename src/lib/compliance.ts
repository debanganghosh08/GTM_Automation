/**
 * Compliance + house-style checker. The last gate before email reaches strangers.
 *
 * Pure and deterministic: no I/O, no clock unless the caller injects one. The
 * same copy always yields the same report (modulo `checked_at`).
 *
 * Severity policy
 * ---------------
 * ERRORS block the send (`passed: false`). They are legal or structural: a body
 * with no unsubscribe link, an unknown merge tag that would render literally in a
 * stranger's inbox, an empty step, no sender identity, a body far outside the
 * sane length range. See docs/SPEC.md §6.
 *
 * WARNINGS surface to the reviewer but do not block. They are spam heuristics
 * and SparqLabs house style (docs/VENDOR_NOTES.md §2). The customer may have
 * edited the copy by hand and may legitimately disagree with a style rule, so
 * style never blocks a legally compliant send. That includes the em dash: it is
 * banned by the house style, not by law, so it is a warning (mapped to
 * `excessive_punctuation`, the closest existing code, with an explicit message).
 *
 * Code mapping for house-style checks (the contract's ComplianceCode is closed):
 *   em dash                       -> excessive_punctuation (warning)
 *   buzzword                      -> spam_word             (warning)
 *   calendar ask / hard CTA in 1  -> spam_word             (warning)
 *   bullet-hyphen list in step 1  -> excessive_punctuation (warning)
 *   per-step word band            -> body_too_short / body_too_long (warning)
 *   line over 25 words            -> body_too_long         (warning)
 *   missing P.S. opt-out          -> missing_unsubscribe   (warning)
 */

import { MERGE_TAGS, type CampaignCopy, type ComplianceIssue, type ComplianceReport, type CopyStep, type IsoTimestamp, type MergeTag } from './contracts';
import { countWords, stripTags } from './word-count';

// ---------------------------------------------------------------- constants

/**
 * Global body length bounds. Outside these the step is a blocking error (SPEC §6).
 *
 * The floor is 20, not 30, deliberately. The house style wants a step-3 breakup
 * email at 30-60 words, and a genuinely terse breakup lands just under that — which
 * is correct copy, not broken copy. A BLOCKING error should mean "this email is
 * empty or malformed"; being a few words shorter than the ideal band is a matter of
 * judgement, so the per-step band (WORD_BANDS) reports it as a warning instead and
 * the customer decides. Blocking a well-written short email would push users to pad
 * it, which is worse copy.
 */
export const BODY_MIN_WORDS = 20;
export const BODY_MAX_WORDS = 220;

/** Subject lines over this many words warn. */
export const SUBJECT_MAX_WORDS = 6;

/** Lines over this many words warn (house style: "every line under 25 words"). */
export const LINE_MAX_WORDS = 25;

/** More than this many non-unsubscribe links in a body warns. */
export const LINK_MAX = 2;

/** Per-step word bands from VENDOR_NOTES §2. Inclusive. `null` means unbounded. */
export const WORD_BANDS: Readonly<Record<number, { min: number | null; max: number | null }>> = {
  1: { min: null, max: 79 },  // "under 80 words"
  2: { min: 80, max: 120 },
  3: { min: 30, max: 60 },
};

/** Spam-filter trigger phrases. Matched case-insensitively on whole phrases. */
export const SPAM_WORDS: readonly string[] = [
  'free', 'guarantee', 'guaranteed', 'act now', 'risk-free', 'risk free', 'click here',
  'limited time', '100%', 'cash bonus', 'no obligation', 'no cost', 'no catch',
  'winner', 'congratulations', 'urgent', 'buy now', 'order now', 'apply now',
  'double your', 'earn extra', 'extra income', 'make money', 'million dollars',
  'once in a lifetime', 'this is not spam', 'not spam', 'no strings attached',
  'special promotion', 'exclusive deal', 'lowest price', 'best price', 'save big',
  'dear friend', 'be amazed', 'you have been selected', 'satisfaction guaranteed',
  'increase sales', 'increase traffic', 'cancel at any time', 'credit card',
];

/** Marketing-deck vocabulary banned by the house style. Whole words, case-insensitive. */
export const BUZZWORDS: readonly string[] = [
  'revolutionize', 'revolutionise', 'revolutionary', 'game-changing', 'game changing', 'game-changer',
  'unlock', 'synergy', 'synergies', 'leverage', 'cutting-edge', 'cutting edge', 'seamless', 'seamlessly',
  'best-in-class', 'best in class', 'world-class', 'disrupt', 'disruptive', 'next-generation', 'next-gen',
  'supercharge', 'turbocharge', 'empower', 'paradigm', 'holistic', 'robust', 'innovative', 'state-of-the-art',
];

/** Upper-case tokens that are acronyms, not shouting. */
export const CAPS_ALLOWLIST: readonly string[] = [
  'CEO', 'CTO', 'CFO', 'COO', 'CMO', 'CRO', 'VP', 'SaaS', 'ROI', 'B2B', 'B2C', 'API', 'AI', 'GTM',
  'SDR', 'BDR', 'AE', 'HR', 'IT', 'KPI', 'CRM', 'ERP', 'SEO', 'SEM', 'PPC', 'USA', 'UK', 'EU',
  'LLC', 'INC', 'LTD', 'GDPR', 'SOC', 'ISO', 'HIPAA', 'ARR', 'MRR', 'NPS', 'OKR', 'RFP', 'NDA',
];

/** Calendar/scheduling hosts. Any link to these in step 1 is a calendar ask. */
export const CALENDAR_HOSTS: readonly string[] = [
  'calendly.com', 'cal.com', 'savvycal.com', 'meetings.hubspot.com', 'hubspot.com/meetings',
  'chilipiper.com', 'zcal.co', 'tidycal.com', 'acuityscheduling.com', 'youcanbook.me',
  'outlook.office.com/bookwithme', 'outlook.office365.com/owa/calendar', 'calendar.app.google',
  'calendar.google.com', 'doodle.com', 'meetings.salesloft.com', 'lemcal.com',
];

/** Hard-CTA phrases. Any of these in step 1 is a hard ask on first touch. */
export const HARD_CTA_PHRASES: readonly string[] = [
  'book a call', 'book a meeting', 'book a demo', 'book a time', 'book some time', 'book 15',
  'book 30', 'schedule a call', 'schedule a demo', 'schedule a meeting', 'schedule a time',
  'schedule 15', 'schedule 30', 'grab a time', 'grab 15', 'grab 30', 'pick a time', 'pick a slot',
  'hop on a call', 'jump on a call', 'get on a call', 'set up a call', 'set up a demo',
  'set up a meeting', 'find a time', 'are you free for a call', 'free for a quick call',
  'here is my calendar', "here's my calendar", 'my calendar link', 'calendar link', 'book here',
];

/** Opt-out vocabulary a P.S. line must carry to count as the house opt-out. */
const OPT_OUT_PHRASES: readonly string[] = [
  'reply', 'let me know', 'not relevant', 'not the right', 'wrong person', 'stop', 'no longer',
  'opt out', 'opt-out', 'unsubscribe', "won't reach out", 'will not reach out', "won't follow up",
  'will not follow up', "won't email", 'will not email', 'remove you', 'leave you alone', 'no more',
];

// ---------------------------------------------------------------- regexes

// Capture the raw inside and trim in code. The previous
// /\{\{\s*([^{}]*?)\s*\}\}/ had a lazy quantifier between two \s* groups, which
// backtracks catastrophically: `'{{' + 8000 spaces` took ~58 seconds and froze the
// whole process, reachable from any authenticated copy edit.
const MERGE_TAG_RE = /\{\{([^{}]*)\}\}/g;
const UNSUBSCRIBE_TAG_RE = /\{\{\s*unsubscribe_link\s*\}\}/;
const SENDING_NAME_TAG_RE = /\{\{\s*sending_name\s*\}\}/;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()\]]+/gi;
const EM_DASH_RE = /—/;
const PS_LINE_RE = /^\s*(?:P\.?\s?S\.?|PS)\b[\s:.\-–]*(.*)$/im;
const SIGN_OFF_RE = /^\s*(?:best|thanks|thank you|cheers|regards|kind regards|warm regards|best regards|all the best|talk soon|speak soon|sincerely|appreciate it|many thanks)\s*[,.!]?\s*$/i;
const BULLET_LINE_RE = /^\s*(?:[-•–—*]|\d+[.)])\s+\S/m;

// ---------------------------------------------------------------- small helpers

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-phrase, case-insensitive match that does not fire inside a longer word. */
function phraseRegex(phrase: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(phrase)}(?![\\p{L}\\p{N}])`, 'iu');
}

function findPhrases(text: string, phrases: readonly string[]): string[] {
  const hits: string[] = [];
  for (const phrase of phrases) {
    if (phraseRegex(phrase).test(text)) hits.push(phrase);
  }
  return hits;
}

/** Expands spintax to the alternative with the most words, for subject length. */
function longestSpintaxVariant(text: string): string {
  return text.replace(/\{([^{}]*\|[^{}]*)\}/g, (_m, inner: string) => {
    let best = '';
    let bestCount = -1;
    for (const alt of inner.split('|')) {
      const n = countWords(alt);
      if (n > bestCount) { best = alt; bestCount = n; }
    }
    return best;
  });
}

function isMergeTag(tag: string): tag is MergeTag {
  return (MERGE_TAGS as readonly string[]).includes(tag);
}

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

// ---------------------------------------------------------------- exported predicates

/** House style bans the em dash. Checked on the raw text, tags included. */
export function hasEmDash(text: string): boolean {
  return EM_DASH_RE.test(text);
}

/** Every `{{tag}}` in the text that is not in MERGE_TAGS. Deduplicated, in order. */
export function findUnknownMergeTags(text: string): string[] {
  const unknown: string[] = [];
  for (const m of text.matchAll(MERGE_TAG_RE)) {
    // MERGE_TAG_RE captures the raw inside, whitespace included, so trim here rather
    // than in the pattern (trimming in the pattern is what caused the backtracking).
    const tag = (m[1] ?? '').trim();
    if (!isMergeTag(tag) && !unknown.includes(tag)) unknown.push(tag);
  }
  return unknown;
}

export function findSpamWords(text: string): string[] {
  return findPhrases(stripTags(text), SPAM_WORDS);
}

export function findBuzzwords(text: string): string[] {
  return findPhrases(stripTags(text), BUZZWORDS);
}

/** Calendar links and hard-CTA phrases. The house rule: none of these in email 1. */
export function findCalendarAsks(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].toLowerCase();
    if (CALENDAR_HOSTS.some((host) => url.includes(host))) hits.push(m[0]);
  }
  return hits.concat(findPhrases(stripTags(text), HARD_CTA_PHRASES));
}

/** Words of 4+ letters in all caps, minus the acronym allowlist. Deduplicated. */
export function findAllCaps(text: string): string[] {
  const hits: string[] = [];
  for (const m of stripTags(text).matchAll(/(?<![\p{L}\p{N}])([A-Z]{4,})(?![\p{L}\p{N}])/gu)) {
    const word = m[1] ?? '';
    if (!CAPS_ALLOWLIST.includes(word) && !hits.includes(word)) hits.push(word);
  }
  return hits;
}

/** `!!`, `??`, or more than one `!` anywhere in the text. */
export function hasExcessivePunctuation(text: string): boolean {
  if (/!!|\?\?/.test(text)) return true;
  return (text.match(/!/g) ?? []).length > 1;
}

/** Links in the body. The unsubscribe merge tag is not a URL and never counts. */
export function countLinks(text: string): number {
  return (text.match(URL_RE) ?? []).length;
}

/** A line starting with "P.S." that reads as an opt-out ("reply stop", "let me know"...). */
export function hasPsOptOut(text: string): boolean {
  const m = PS_LINE_RE.exec(text);
  if (!m) return false;
  const rest = (m[1] ?? '').toLowerCase();
  return OPT_OUT_PHRASES.some((p) => rest.includes(p));
}

/** `{{sending_name}}` or a conventional sign-off line followed by a name line. */
export function hasSignature(text: string): boolean {
  if (SENDING_NAME_TAG_RE.test(text)) return true;
  const ls = lines(text);
  for (let i = 0; i < ls.length - 1; i += 1) {
    const line = ls[i] ?? '';
    if (!SIGN_OFF_RE.test(line)) continue;
    const next = (ls[i + 1] ?? '').trim();
    if (next && !PS_LINE_RE.test(next) && !UNSUBSCRIBE_TAG_RE.test(next)) return true;
  }
  return false;
}

/** Lines over LINE_MAX_WORDS words (merge tags and URLs excluded from the count). */
export function findLongLines(text: string): string[] {
  return lines(text).filter((line) => countWords(line) > LINE_MAX_WORDS);
}

/** Bullet or hyphen list lines. Banned in email 1. */
export function hasBulletList(text: string): boolean {
  return BULLET_LINE_RE.test(text);
}

/** The house word band for a step, or null when the step has none. */
export function wordBand(step: number): { min: number | null; max: number | null } | null {
  return WORD_BANDS[step] ?? null;
}

// ---------------------------------------------------------------- main entry

export interface ComplianceContext {
  /** The onboarding sending name. When absent, every body must carry a signature. */
  sendingName?: string | null;
  /** Injected clock for deterministic reports. Defaults to the real time. */
  now?: IsoTimestamp;
}

export function checkCompliance(copy: CampaignCopy, ctx: ComplianceContext): ComplianceReport {
  const errors: ComplianceIssue[] = [];
  const warnings: ComplianceIssue[] = [];
  const hasSendingName = Boolean(ctx.sendingName?.trim());

  if (copy.steps.length === 0) {
    errors.push({ code: 'empty_step', message: 'The campaign has no steps.' });
  }

  for (const s of copy.steps) {
    checkStep(s, hasSendingName, errors, warnings);
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    checked_at: ctx.now ?? new Date().toISOString(),
  };
}

function checkStep(
  s: CopyStep,
  hasSendingName: boolean,
  errors: ComplianceIssue[],
  warnings: ComplianceIssue[],
): void {
  const step = s.step;
  const subject = s.subject ?? '';
  const body = s.body ?? '';
  const err = (issue: Omit<ComplianceIssue, 'step'>): void => { errors.push({ ...issue, step }); };
  const warn = (issue: Omit<ComplianceIssue, 'step'>): void => { warnings.push({ ...issue, step }); };

  // --- empty step: nothing else is meaningful, stop here for this step.
  if (!subject.trim() || !body.trim()) {
    err({
      code: 'empty_step',
      message: !subject.trim() && !body.trim()
        ? 'Subject and body are both blank.'
        : !subject.trim() ? 'Subject is blank.' : 'Body is blank.',
    });
    return;
  }

  const combined = `${subject}\n${body}`;

  // ================================================================ ERRORS

  if (!UNSUBSCRIBE_TAG_RE.test(body)) {
    err({
      code: 'missing_unsubscribe',
      message: 'Body has no {{unsubscribe_link}}. Every email sent through this platform must carry a real unsubscribe link (CAN-SPAM / GDPR). The P.S. opt-out does not replace it.',
    });
  }

  for (const tag of findUnknownMergeTags(combined)) {
    err({
      code: 'unknown_merge_tag',
      message: `Unknown merge tag {{${tag}}}. It would render literally in the recipient's inbox. Allowed tags: ${MERGE_TAGS.join(', ')}.`,
      evidence: tag,
    });
  }

  const words = countWords(body);
  let shortError = false;
  let longError = false;
  if (words < BODY_MIN_WORDS) {
    shortError = true;
    err({
      code: 'body_too_short',
      message: `Body is ${words} words; minimum is ${BODY_MIN_WORDS} (merge tags and the unsubscribe line excluded).`,
      evidence: String(words),
    });
  } else if (words > BODY_MAX_WORDS) {
    longError = true;
    err({
      code: 'body_too_long',
      message: `Body is ${words} words; maximum is ${BODY_MAX_WORDS} (merge tags and the unsubscribe line excluded).`,
      evidence: String(words),
    });
  }

  if (!hasSendingName && !hasSignature(body)) {
    err({
      code: 'missing_sender_identity',
      message: 'No sending name is configured and the body has no signature. Add {{sending_name}} or a sign-off, or set a sending name in onboarding.',
    });
  }

  // ================================================================ WARNINGS (spam heuristics)

  const spam = findSpamWords(combined);
  if (spam.length > 0) {
    warn({
      code: 'spam_word',
      message: `Spam-filter trigger phrase${spam.length > 1 ? 's' : ''}: ${spam.join(', ')}.`,
      evidence: spam.join(', '),
    });
  }

  const subjectWords = countWords(longestSpintaxVariant(subject));
  if (subjectWords > SUBJECT_MAX_WORDS) {
    warn({
      code: 'subject_too_long',
      message: `Subject is ${subjectWords} words (longest spintax variant); keep it under ${SUBJECT_MAX_WORDS + 1}. House style is two lowercase words.`,
      evidence: String(subjectWords),
    });
  }

  const caps = findAllCaps(combined);
  if (caps.length > 0) {
    warn({
      code: 'all_caps',
      message: `All-caps word${caps.length > 1 ? 's' : ''}: ${caps.join(', ')}. Reads as shouting to filters and people.`,
      evidence: caps.join(', '),
    });
  }

  if (hasExcessivePunctuation(combined)) {
    warn({
      code: 'excessive_punctuation',
      message: 'Contains "!!", "??" or more than one exclamation mark.',
    });
  }

  const linkCount = countLinks(body);
  if (linkCount > LINK_MAX) {
    warn({
      code: 'link_count',
      message: `Body has ${linkCount} links; more than ${LINK_MAX} hurts deliverability (the unsubscribe link does not count).`,
      evidence: String(linkCount),
    });
  }

  // ================================================================ WARNINGS (house style, VENDOR_NOTES §2)

  if (hasEmDash(combined)) {
    warn({
      code: 'excessive_punctuation',
      message: 'Contains an em dash (—). House style bans em dashes; use a comma, a full stop or a line break.',
      evidence: '—',
    });
  }

  const buzz = findBuzzwords(combined);
  if (buzz.length > 0) {
    warn({
      code: 'spam_word',
      message: `Buzzword${buzz.length > 1 ? 's' : ''} banned by house style: ${buzz.join(', ')}. Tone should be a smart person texting a smart person.`,
      evidence: buzz.join(', '),
    });
  }

  if (step === 1) {
    const asks = findCalendarAsks(combined);
    if (asks.length > 0) {
      warn({
        code: 'spam_word',
        message: `Step 1 contains a calendar link or hard call to action: ${asks.join(', ')}. House rule: no calendar ask and no hard CTA in email 1; gauge interest with a soft question instead.`,
        evidence: asks.join(', '),
      });
    }
    if (hasBulletList(body)) {
      warn({
        code: 'excessive_punctuation',
        message: 'Step 1 contains a bullet or hyphen list. House rule: no bullet-hyphen lists in email 1; write one idea per line as prose.',
      });
    }
  }

  const band = wordBand(step);
  if (band) {
    if (band.min !== null && words < band.min && !shortError) {
      warn({
        code: 'body_too_short',
        message: `Step ${step} is ${words} words; house style wants ${band.min}–${band.max ?? '∞'} words for this step.`,
        evidence: String(words),
      });
    } else if (band.max !== null && words > band.max && !longError) {
      warn({
        code: 'body_too_long',
        message: `Step ${step} is ${words} words; house style wants ${band.min !== null ? `${band.min}–${band.max}` : `under ${band.max + 1}`} words for this step.`,
        evidence: String(words),
      });
    }
  }

  const longLines = findLongLines(body);
  if (longLines.length > 0) {
    const first = longLines[0] ?? '';
    warn({
      code: 'body_too_long',
      message: `${longLines.length} line${longLines.length > 1 ? 's' : ''} over ${LINE_MAX_WORDS} words. House style: every line under ${LINE_MAX_WORDS} words, hard line breaks, one idea per line.`,
      evidence: first.length > 80 ? `${first.slice(0, 77)}...` : first,
    });
  }

  if (!hasPsOptOut(body)) {
    warn({
      code: 'missing_unsubscribe',
      message: 'No P.S. opt-out line. House style ends every email with a P.S. that lets the reader reply to opt out (the {{unsubscribe_link}} is still required separately).',
    });
  }
}
