/**
 * Compliance checker. This is the last gate before email reaches strangers, so
 * the blocking paths are tested exhaustively and the house-style paths are
 * tested for "warns but still passes".
 */

import { describe, expect, it } from 'vitest';
import {
  BODY_MAX_WORDS,
  BODY_MIN_WORDS,
  checkCompliance,
  findBuzzwords,
  findCalendarAsks,
  hasEmDash,
  hasPsOptOut,
  hasSignature,
} from '../../src/lib/compliance';
import { countWords, stripTags } from '../../src/lib/word-count';
import type { CampaignCopy, ComplianceCode, ComplianceIssue, CopyStep } from '../../src/lib/contracts';

const NOW = '2026-10-23T00:00:00.000Z';
const SUBJECT = '{quick question|small idea}';

const STEP1_BODY = [
  '{{first_name}}, saw that {{company_name}} is hiring its first SDR.',
  '',
  'Most founders at that stage are still writing every cold email themselves.',
  'It works until it eats the week.',
  '',
  'We run the outbound so the founder gets the week back.',
  '',
  'Worth a look?',
  '',
  '{{sending_name}}',
  '',
  'P.S. If this isn\'t relevant, just reply "no" and I won\'t follow up.',
  'Unsubscribe: {{unsubscribe_link}}',
].join('\n');

const STEP2_BODY = [
  '{{first_name}}, following up on my note from earlier this week.',
  '',
  'When the founder stops writing cold email, two things change.',
  'The pipeline keeps moving while you are in customer calls.',
  'And the replies land in one inbox that someone actually owns.',
  '',
  'We do the list, the copy and the sending for you.',
  'All of it runs without adding headcount or touching your current CRM.',
  '',
  'Most teams tell us the hardest part was starting, not running it.',
  'Want me to send over how it works for a team of your size?',
  '',
  '{{sending_name}}',
  '',
  'P.S. Not the right person? Reply with who is and I will leave you alone.',
  'Unsubscribe: {{unsubscribe_link}}',
].join('\n');

const STEP3_BODY = [
  '{{first_name}}, last one from me.',
  '',
  'If outbound is handled, ignore this.',
  'If it is still sitting with you, the offer stands.',
  'If the timing is ever right, just reply here.',
  '',
  '{{sending_name}}',
  '',
  'P.S. Reply "stop" and you will not hear from me again.',
  'Unsubscribe: {{unsubscribe_link}}',
].join('\n');

function validCopy(): CampaignCopy {
  return {
    steps: [
      { step: 1, delay_days: 0, subject: SUBJECT, body: STEP1_BODY },
      { step: 2, delay_days: 3, subject: SUBJECT, body: STEP2_BODY },
      { step: 3, delay_days: 4, subject: SUBJECT, body: STEP3_BODY },
    ],
  };
}

/** Replace one step's body (or other fields) and return a fresh copy. */
function withStep(index: number, patch: Partial<CopyStep>): CampaignCopy {
  const copy = validCopy();
  const existing = copy.steps[index];
  if (!existing) throw new Error(`no step at index ${index}`);
  copy.steps[index] = { ...existing, ...patch };
  return copy;
}

/** A body of exactly `n` prose words plus the mandatory lines, 10 words per line. */
function fillerBody(n: number): string {
  const words: string[] = [];
  for (let i = 0; i < n; i += 1) words.push(`word${i}`);
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 10) lines.push(words.slice(i, i + 10).join(' '));
  // "P.S. reply stop" contributes 3 words; subtract them from the filler so the total is n.
  return `${lines.join('\n')}\n\n{{sending_name}}\n\nP.S. reply stop\nUnsubscribe: {{unsubscribe_link}}`;
}
const PS_WORDS = 3;

const ctx = { sendingName: 'Tom Smith', now: NOW };
const codes = (issues: ComplianceIssue[]): ComplianceCode[] => issues.map((i) => i.code);
const find = (issues: ComplianceIssue[], code: ComplianceCode, step?: number): ComplianceIssue | undefined =>
  issues.find((i) => i.code === code && (step === undefined || i.step === step));

// ---------------------------------------------------------------- word-count

describe('countWords', () => {
  it('ignores merge tags', () => {
    expect(countWords('{{first_name}}, hello there {{company_name}}')).toBe(2);
    expect(countWords('{{first_name}}')).toBe(0);
  });

  it('ignores URLs', () => {
    expect(countWords('see https://example.com/a/b?c=d and www.example.org now')).toBe(3);
  });

  it('ignores the whole unsubscribe line', () => {
    expect(countWords('one two three\nUnsubscribe here: {{unsubscribe_link}} please\nfour')).toBe(4);
  });

  it('counts one spintax alternative, not the braces', () => {
    expect(countWords('{quick question|small idea}')).toBe(2);
  });

  it('does not count punctuation-only tokens', () => {
    expect(countWords('- one | two -- three')).toBe(3);
  });

  it('stripTags removes tags, URLs and the unsubscribe line', () => {
    const out = stripTags('hi {{first_name}} https://x.io\nUnsubscribe: {{unsubscribe_link}}');
    expect(out).not.toMatch(/\{\{/);
    expect(out).not.toMatch(/https/);
    expect(out).not.toMatch(/Unsubscribe/);
  });
});

// ---------------------------------------------------------------- blocking errors

describe('checkCompliance: blocking errors', () => {
  it('fails with missing_unsubscribe when any step lacks the link', () => {
    const body = STEP2_BODY.replace('Unsubscribe: {{unsubscribe_link}}', '');
    const report = checkCompliance(withStep(1, { body }), ctx);
    expect(report.passed).toBe(false);
    const issue = find(report.errors, 'missing_unsubscribe', 2);
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/unsubscribe_link/);
    // Other steps are untouched.
    expect(find(report.errors, 'missing_unsubscribe', 1)).toBeUndefined();
  });

  it('fails with unknown_merge_tag and names the tag', () => {
    const body = STEP1_BODY.replace('{{first_name}}', '{{firstName}}');
    const report = checkCompliance(withStep(0, { body }), ctx);
    expect(report.passed).toBe(false);
    const issue = find(report.errors, 'unknown_merge_tag', 1);
    expect(issue?.evidence).toBe('firstName');
    expect(issue?.message).toContain('{{firstName}}');
  });

  it('catches unknown tags in the subject and fallback syntax', () => {
    const report = checkCompliance(withStep(0, { subject: '{{company}} question' }), ctx);
    expect(find(report.errors, 'unknown_merge_tag')?.evidence).toBe('company');

    const fallback = checkCompliance(withStep(0, { body: STEP1_BODY.replace('{{first_name}}', '{{first_name|there}}') }), ctx);
    expect(find(fallback.errors, 'unknown_merge_tag')?.evidence).toBe('first_name|there');
  });

  it('fails with body_too_short under the 20-word floor and does not also warn', () => {
    const report = checkCompliance(withStep(2, { body: fillerBody(15 - PS_WORDS) }), ctx);
    expect(report.passed).toBe(false);
    expect(find(report.errors, 'body_too_short', 3)?.evidence).toBe('15');
    expect(find(report.warnings, 'body_too_short', 3)).toBeUndefined();
  });

  it('lets a terse breakup email through as a warning, not a blocking error', () => {
    // A step-3 breakup is deliberately short. The house band is 30-60 words, so 28
    // words is slightly under ideal but perfectly good copy: it must warn, never
    // block. Blocking it would push writers to pad the email, which is worse copy.
    const report = checkCompliance(withStep(2, { body: fillerBody(28 - PS_WORDS) }), ctx);
    expect(report.passed, '28 words must not block the send').toBe(true);
    expect(find(report.errors, 'body_too_short', 3)).toBeUndefined();
    expect(find(report.warnings, 'body_too_short', 3), 'but it should still be flagged').toBeDefined();
  });

  it('fails with body_too_long over 220 words', () => {
    const report = checkCompliance(withStep(1, { body: fillerBody(BODY_MAX_WORDS + 1 - PS_WORDS) }), ctx);
    expect(report.passed).toBe(false);
    expect(find(report.errors, 'body_too_long', 2)?.evidence).toBe(String(BODY_MAX_WORDS + 1));
  });

  it('fails with empty_step for a blank subject or body, and reports nothing else for that step', () => {
    const blankSubject = checkCompliance(withStep(0, { subject: '   ' }), ctx);
    expect(blankSubject.passed).toBe(false);
    expect(codes(blankSubject.errors.filter((e) => e.step === 1))).toEqual(['empty_step']);

    const blankBody = checkCompliance(withStep(2, { body: '' }), ctx);
    expect(codes(blankBody.errors.filter((e) => e.step === 3))).toEqual(['empty_step']);
    expect(blankBody.warnings.filter((w) => w.step === 3)).toHaveLength(0);
  });

  it('fails with empty_step when there are no steps at all', () => {
    const report = checkCompliance({ steps: [] }, ctx);
    expect(report.passed).toBe(false);
    expect(codes(report.errors)).toEqual(['empty_step']);
  });

  it('fails with missing_sender_identity when there is no sending name and no signature', () => {
    const noTag = STEP1_BODY.replace('{{sending_name}}', '');
    const report = checkCompliance(withStep(0, { body: noTag }), { sendingName: null, now: NOW });
    expect(report.passed).toBe(false);
    expect(find(report.errors, 'missing_sender_identity', 1)).toBeDefined();
    expect(find(report.errors, 'missing_sender_identity', 2)).toBeUndefined();
  });

  it('accepts a {{sending_name}} tag or a sign-off as identity when no sending name is set', () => {
    const tagged = checkCompliance(validCopy(), { sendingName: null, now: NOW });
    expect(tagged.passed).toBe(true);

    const signed = STEP1_BODY.replace('{{sending_name}}', 'Best,\nTom');
    const report = checkCompliance(withStep(0, { body: signed }), { sendingName: '', now: NOW });
    expect(find(report.errors, 'missing_sender_identity')).toBeUndefined();
    expect(hasSignature(signed)).toBe(true);
    expect(hasSignature('hello\nBest,\nP.S. reply no')).toBe(false);
  });
});

// ---------------------------------------------------------------- valid copy

describe('checkCompliance: valid house-style copy', () => {
  it('passes with no errors and no warnings', () => {
    const report = checkCompliance(validCopy(), ctx);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checked_at).toBe(NOW);
  });

  it('is deterministic', () => {
    const a = checkCompliance(validCopy(), ctx);
    const b = checkCompliance(validCopy(), ctx);
    expect(a).toEqual(b);
  });

  it('fills checked_at from the clock when none is injected', () => {
    const report = checkCompliance(validCopy(), { sendingName: 'Tom' });
    expect(() => new Date(report.checked_at).toISOString()).not.toThrow();
  });

  it('keeps the valid bodies inside the house bands', () => {
    expect(countWords(STEP1_BODY)).toBeGreaterThanOrEqual(BODY_MIN_WORDS);
    expect(countWords(STEP1_BODY)).toBeLessThan(80);
    expect(countWords(STEP2_BODY)).toBeGreaterThanOrEqual(80);
    expect(countWords(STEP2_BODY)).toBeLessThanOrEqual(120);
    expect(countWords(STEP3_BODY)).toBeGreaterThanOrEqual(30);
    expect(countWords(STEP3_BODY)).toBeLessThanOrEqual(60);
  });
});

// ---------------------------------------------------------------- warnings

describe('checkCompliance: warnings do not block', () => {
  it('warns on spam words and em dashes but still passes', () => {
    const body = STEP2_BODY.replace(
      'Most teams tell us the hardest part was starting, not running it.',
      'This is a risk-free guarantee — act now and click here.',
    );
    const report = checkCompliance(withStep(1, { body }), ctx);
    expect(report.passed).toBe(true);
    expect(report.errors).toEqual([]);

    const spam = find(report.warnings, 'spam_word', 2);
    expect(spam?.evidence).toContain('guarantee');
    expect(spam?.evidence).toContain('act now');
    expect(spam?.evidence).toContain('risk-free');
    expect(spam?.evidence).toContain('click here');

    const dash = report.warnings.find((w) => w.step === 2 && w.evidence === '—');
    expect(dash?.code).toBe('excessive_punctuation');
    expect(dash?.message).toMatch(/em dash/i);
    expect(hasEmDash(body)).toBe(true);
    expect(hasEmDash('a - b – c')).toBe(false);
  });

  it('warns on buzzwords', () => {
    const body = STEP2_BODY.replace('We do the list, the copy and the sending for you.', 'We leverage a seamless, game-changing engine to unlock growth.');
    const report = checkCompliance(withStep(1, { body }), ctx);
    expect(report.passed).toBe(true);
    const buzz = report.warnings.find((w) => w.step === 2 && w.code === 'spam_word' && /buzzword/i.test(w.message));
    expect(buzz?.evidence).toContain('leverage');
    expect(buzz?.evidence).toContain('seamless');
    expect(buzz?.evidence).toContain('unlock');
    expect(findBuzzwords('Unlock synergies')).toEqual(['unlock', 'synergies']);
    expect(findBuzzwords('unlocked door')).toEqual([]);
  });

  it('warns on a calendar link or hard CTA in step 1 only', () => {
    const ask = 'Book a call here: https://calendly.com/tom/15min';
    const step1 = checkCompliance(withStep(0, { body: STEP1_BODY.replace('Worth a look?', ask) }), ctx);
    expect(step1.passed).toBe(true);
    const warning = step1.warnings.find((w) => w.step === 1 && /calendar/i.test(w.message));
    expect(warning?.code).toBe('spam_word');
    expect(warning?.evidence).toContain('calendly.com');
    expect(warning?.evidence).toContain('book a call');

    const step2 = checkCompliance(withStep(1, { body: STEP2_BODY.replace('Want me to send over how it works for a team of your size?', ask) }), ctx);
    expect(step2.warnings.find((w) => /calendar/i.test(w.message))).toBeUndefined();

    expect(findCalendarAsks('see https://cal.com/x and schedule a demo')).toEqual(['https://cal.com/x', 'schedule a demo']);
    expect(findCalendarAsks('send me a calendar invite to the offsite')).toEqual([]);
  });

  it('warns on a bullet list in step 1 only', () => {
    const list = '- one thing\n- two things\n- three things';
    const step1 = checkCompliance(withStep(0, { body: STEP1_BODY.replace('Worth a look?', list) }), ctx);
    expect(step1.warnings.find((w) => w.step === 1 && /bullet/i.test(w.message))?.code).toBe('excessive_punctuation');
    const step2 = checkCompliance(withStep(1, { body: STEP2_BODY.replace('Want me to send over how it works for a team of your size?', list) }), ctx);
    expect(step2.warnings.find((w) => /bullet/i.test(w.message))).toBeUndefined();
  });

  describe('house word bands', () => {
    it('warns when step 1 is 80 words or more but under the hard max', () => {
      const report = checkCompliance(withStep(0, { body: fillerBody(90 - PS_WORDS) }), ctx);
      expect(report.passed).toBe(true);
      expect(find(report.warnings, 'body_too_long', 1)?.evidence).toBe('90');
    });

    it('warns when step 2 is under 80 words', () => {
      const report = checkCompliance(withStep(1, { body: fillerBody(50 - PS_WORDS) }), ctx);
      expect(report.passed).toBe(true);
      expect(find(report.warnings, 'body_too_short', 2)?.evidence).toBe('50');
      expect(find(report.errors, 'body_too_short', 2)).toBeUndefined();
    });

    it('warns when step 3 is over 60 words', () => {
      const report = checkCompliance(withStep(2, { body: fillerBody(70 - PS_WORDS) }), ctx);
      expect(report.passed).toBe(true);
      expect(find(report.warnings, 'body_too_long', 3)?.evidence).toBe('70');
    });

    it('does not band-warn when the body is inside the band', () => {
      const report = checkCompliance(withStep(2, { body: fillerBody(45 - PS_WORDS) }), ctx);
      expect(find(report.warnings, 'body_too_long', 3)).toBeUndefined();
      expect(find(report.warnings, 'body_too_short', 3)).toBeUndefined();
    });
  });

  it('warns on a subject over 6 words, measured on the longest spintax variant', () => {
    const report = checkCompliance(withStep(0, { subject: '{hi|a very long subject line about your outbound}' }), ctx);
    expect(report.passed).toBe(true);
    expect(find(report.warnings, 'subject_too_long', 1)?.evidence).toBe('8');
    expect(find(checkCompliance(withStep(0, { subject: 'one two three four five six' }), ctx).warnings, 'subject_too_long')).toBeUndefined();
  });

  it('warns on all-caps words but allows the acronym list', () => {
    const body = STEP1_BODY.replace('Worth a look?', 'URGENT: worth a look for a SaaS CEO with ROI goals?');
    const report = checkCompliance(withStep(0, { body }), ctx);
    expect(report.passed).toBe(true);
    expect(find(report.warnings, 'all_caps', 1)?.evidence).toBe('URGENT');
  });

  it('warns on excessive punctuation', () => {
    expect(find(checkCompliance(withStep(0, { body: STEP1_BODY.replace('Worth a look?', 'Worth a look??') }), ctx).warnings, 'excessive_punctuation', 1)).toBeDefined();
    expect(find(checkCompliance(withStep(0, { body: STEP1_BODY.replace('Worth a look?', 'Worth a look! Really!') }), ctx).warnings, 'excessive_punctuation', 1)).toBeDefined();
    expect(find(checkCompliance(withStep(0, { body: STEP1_BODY.replace('Worth a look?', 'Worth a look!') }), ctx).warnings, 'excessive_punctuation', 1)).toBeUndefined();
  });

  it('warns on more than two links, not counting the unsubscribe link', () => {
    const two = STEP2_BODY.replace('We do the list, the copy and the sending for you.', 'See https://a.io and https://b.io for the details.');
    expect(find(checkCompliance(withStep(1, { body: two }), ctx).warnings, 'link_count')).toBeUndefined();
    const three = STEP2_BODY.replace('We do the list, the copy and the sending for you.', 'See https://a.io and https://b.io and www.c.io for details.');
    const report = checkCompliance(withStep(1, { body: three }), ctx);
    expect(report.passed).toBe(true);
    expect(find(report.warnings, 'link_count', 2)?.evidence).toBe('3');
  });

  it('warns on a line over 25 words', () => {
    const long = Array.from({ length: 26 }, (_, i) => `w${i}`).join(' ');
    const report = checkCompliance(withStep(1, { body: STEP2_BODY.replace('We do the list, the copy and the sending for you.', long) }), ctx);
    expect(report.passed).toBe(true);
    expect(report.warnings.find((w) => w.step === 2 && /25 words/.test(w.message))?.code).toBe('body_too_long');
  });

  it('warns, but does not block, when the P.S. opt-out is missing', () => {
    const body = STEP3_BODY.replace('P.S. Reply "stop" and you will not hear from me again.', 'Thanks for reading all the way down to here.');
    const report = checkCompliance(withStep(2, { body }), ctx);
    expect(report.passed).toBe(true);
    expect(find(report.warnings, 'missing_unsubscribe', 3)?.message).toMatch(/P\.S\./);
    expect(hasPsOptOut('PS: not relevant? reply no')).toBe(true);
    expect(hasPsOptOut('P.S. We also do landscaping.')).toBe(false);
  });
});
