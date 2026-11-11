/**
 * Denial-of-service resistance in the text handling.
 *
 * Every function here runs on adversarial input: copy a customer typed, or HTML from
 * a website we were told to scrape. They run synchronously on the single Node event
 * loop, so a quadratic regex does not slow one request down, it freezes every tenant
 * until it finishes. The audit measured a 58-second freeze from `{{` plus spaces and
 * 78 seconds from a hostile page.
 *
 * These are timing assertions, so the bounds are deliberately loose: they are there
 * to catch a return to catastrophic backtracking, not to measure performance.
 */

import { describe, expect, it } from 'vitest';
import { findUnknownMergeTags, checkCompliance } from '../../src/lib/compliance';
import { countWords, stripTags } from '../../src/lib/word-count';

const BUDGET_MS = 2_000;

function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('merge-tag scanning', () => {
  it('survives an unclosed tag followed by thousands of spaces', () => {
    const attack = `{{${' '.repeat(8_000)}`;
    expect(timed(() => findUnknownMergeTags(attack))).toBeLessThan(BUDGET_MS);
  });

  it('survives many unclosed braces', () => {
    const attack = '{{'.repeat(5_000);
    expect(timed(() => findUnknownMergeTags(attack))).toBeLessThan(BUDGET_MS);
  });

  it('still recognises a padded tag as known', () => {
    expect(findUnknownMergeTags('hello {{  first_name  }}')).toEqual([]);
    expect(findUnknownMergeTags('hello {{ not_a_tag }}')).toEqual(['not_a_tag']);
  });
});

describe('word counting', () => {
  it('survives space-padded braces', () => {
    const attack = `{{${' '.repeat(8_000)}}} word`;
    expect(timed(() => countWords(attack))).toBeLessThan(BUDGET_MS);
  });

  it('survives a long run of angle brackets', () => {
    expect(timed(() => stripTags('<'.repeat(20_000)))).toBeLessThan(BUDGET_MS);
  });
});

describe('full compliance check', () => {
  it('survives a hostile body at the maximum accepted length', () => {
    const body = `{{${' '.repeat(7_900)}}} {{unsubscribe_link}}`;
    const copy = {
      steps: [1, 2, 3].map((step) => ({
        step,
        delay_days: step === 1 ? 0 : 3,
        subject: '{a|b}',
        body,
      })),
    };
    expect(timed(() => checkCompliance(copy, { sendingName: 'Sam' }))).toBeLessThan(BUDGET_MS * 2);
  });
});

describe('HTML extraction on hostile pages', () => {
  it('survives a page of bare angle brackets, unterminated comments and scripts', async () => {
    const { extractPage } = await import('../../src/providers/live/scrape');
    const cases: Array<[string, string]> = [
      ['bare brackets', '<'.repeat(250_000)],
      ['unterminated comments', '<!--'.repeat(80_000)],
      ['unterminated scripts', '<script>'.repeat(50_000)],
      ['anchor soup', '<a '.repeat(120_000)],
      ['heading soup', '<h1>'.repeat(90_000)],
      ['title soup', '<title>'.repeat(60_000)],
    ];
    for (const [name, html] of cases) {
      const start = performance.now();
      extractPage(html);
      const ms = performance.now() - start;
      expect(ms, `${name} took ${Math.round(ms)}ms`).toBeLessThan(2_000);
    }
  });

  it('still extracts real content, and still strips scripts', async () => {
    const { extractPage } = await import('../../src/providers/live/scrape');
    const page = extractPage(
      '<html><head><title>Acme Dispatch</title>'
      + '<meta name="description" content="Scheduling for field teams">'
      + '</head><body><script>var secret = "should not appear";</script>'
      + '<h1>Dispatch software</h1><h2>For HVAC teams</h2>'
      + '<p>We help operators schedule more jobs.</p></body></html>',
    );
    expect(page.title).toBe('Acme Dispatch');
    expect(page.description).toBe('Scheduling for field teams');
    expect(page.headings).toContain('Dispatch software');
    expect(JSON.stringify(page)).not.toContain('should not appear');
  });

  it('is not fooled by a tag that merely starts with a block tag name', async () => {
    const { extractPage } = await import('../../src/providers/live/scrape');
    const page = extractPage('<html><body><h1>Keep this</h1><styleguide>also kept</styleguide></body></html>');
    expect(page.headings).toContain('Keep this');
  });
});
