/**
 * HTTP site scraper for onboarding: fetches the customer's own homepage and pulls
 * out the title, meta description, headings and a text excerpt with regex. No DOM
 * library, no JavaScript execution.
 *
 * Defensive by design, because the URL is typed by a customer:
 *   - only http/https;
 *   - SSRF guard: loopback, private, link-local (incl. the cloud metadata address
 *     169.254.169.254), CGNAT, unspecified and multicast hosts are refused, both as
 *     IP literals and after DNS resolution, and again on every redirect hop;
 *   - 10s timeout per hop, at most 3 redirects, body capped at ~500KB (reported as
 *     `truncated`), HTML content types only.
 *
 * Never throws: every failure comes back as a SiteScrape with `error` set, because
 * onboarding must continue without a scrape. Page bodies are never logged.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ScrapeProvider, SiteScrape } from '../../lib/contracts';

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 500 * 1024;

/**
 * Extraction is capped well below the download cap. The regexes below are linear, but
 * running any of them across half a megabyte of hostile markup still burns event-loop
 * time that every other tenant is waiting on, and nothing useful for a GTM strategy
 * lives past the first 128KB of a page.
 */
const MAX_EXTRACT_BYTES = 128 * 1024;
const EXCERPT_CHARS = 2_000;
const MAX_HEADINGS = 30;
const USER_AGENT = 'GTM-Autopilot-Onboarding/1.0 (+site profile for the account owner)';

type FetchLike = typeof fetch;
type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
type Clock = () => number;

export interface HttpScrapeOptions {
  fetch?: FetchLike;
  /** DNS resolver, injectable for tests. Defaults to node:dns/promises lookup({ all: true }). */
  lookup?: Lookup;
  now?: Clock;
}

// ---------------------------------------------------------------- SSRF guard

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((b & mask) >>> 0);
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable: refuse
  return BLOCKED_V4.some(([base, bits]) => inCidr4(n, base, bits));
}

/** Expands an IPv6 literal to 8 hextets, or null when malformed. */
function expandV6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  // Embedded IPv4 tail (::ffff:1.2.3.4)
  const v4Tail = /:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4Tail) {
    const n = ipv4ToInt(v4Tail[1]!);
    if (n === null) return null;
    addr = addr.slice(0, -v4Tail[1]!.length) + ((n >>> 16).toString(16)) + ':' + ((n & 0xffff).toString(16));
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(Number.parseInt(g, 16));
  }
  return out;
}

function isBlockedV6(ip: string): boolean {
  const h = expandV6(ip);
  if (!h) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = h as [number, number, number, number, number, number, number, number];
  const allZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (allZeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  if (allZeroPrefix && g5 === 0xffff) {
    // IPv4-mapped: judge the embedded v4.
    const v4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    return isBlockedV4(v4);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  return false;
}

/** True when an IP address (v4 or v6 literal) must not be fetched. Exported for tests. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true;
}

function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  if (!h.includes('.')) return true; // single-label names resolve to intranet hosts
  return false;
}

const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true });

// ---------------------------------------------------------------- HTML extraction

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', middot: '·', bull: '•',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeChar(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
}

function stripTags(s: string): string {
  // `[^<>]` rather than `[^>]`: with the latter, a page of bare '<' characters makes
  // every match attempt scan to the end of the input. The audit measured 78 seconds
  // on a 500KB page of '<'.
  return s.replace(/<[^<>]*>/g, ' ');
}

function clean(s: string): string {
  return decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();
}

/**
 * Removes everything between `open` and the next `close`, walking the string once.
 *
 * Replaces a lazy `[\s\S]*?` regex. With that pattern, a page containing thousands of
 * unterminated `<!--` or `<script` openers restarts the inner scan at each one, which
 * is quadratic: the audit measured 9 seconds for comments and nearly 4 for scripts on
 * a 500KB page, on top of 78 seconds for the tag stripper.
 *
 * An unterminated opener drops the remainder of the document, which is the right
 * behaviour: a browser would not render it either.
 */
function cutBetween(input: string, open: string, close: string): string {
  let out = '';
  let cursor = 0;

  for (;;) {
    const start = input.indexOf(open, cursor);
    if (start === -1) {
      out += input.slice(cursor);
      return out;
    }
    out += input.slice(cursor, start);
    const end = input.indexOf(close, start + open.length);
    if (end === -1) return out;
    out += ' ';
    cursor = end + close.length;
  }
}

const BLOCK_TAGS = ['script', 'style', 'noscript', 'svg', 'template', 'iframe'] as const;

function removeBlocks(html: string): string {
  let out = cutBetween(html, '<!--', '-->');
  for (const tag of BLOCK_TAGS) {
    // Case-insensitive: lowercase a copy to find positions, but cut from the original
    // so the surviving text keeps its original casing.
    out = cutBetweenTag(out, tag);
  }
  return out;
}

/** cutBetween for `<tag …> … </tag>`, matched case-insensitively. */
function cutBetweenTag(input: string, tag: string): string {
  const lower = input.toLowerCase();
  const openToken = `<${tag}`;
  const closeToken = `</${tag}`;
  let out = '';
  let cursor = 0;

  for (;;) {
    const start = lower.indexOf(openToken, cursor);
    if (start === -1) {
      out += input.slice(cursor);
      return out;
    }
    // `<scriptable>` is not `<script>`: the next character must end the tag name.
    const after = lower[start + openToken.length];
    if (after !== undefined && /[a-z0-9]/.test(after)) {
      out += input.slice(cursor, start + openToken.length);
      cursor = start + openToken.length;
      continue;
    }
    out += input.slice(cursor, start);
    const end = lower.indexOf(closeToken, start + openToken.length);
    if (end === -1) return out;
    const gt = lower.indexOf('>', end);
    out += ' ';
    cursor = gt === -1 ? input.length : gt + 1;
  }
}

function metaContent(html: string, key: 'name' | 'property', value: string): string | null {
  // Both attribute orders: <meta name=".." content=".."> and <meta content=".." name="..">
  const re1 = new RegExp(`<meta\\b[^>]*\\b${key}\\s*=\\s*["']${value}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta\\b[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\b${key}\\s*=\\s*["']${value}["']`, 'i');
  const m = re1.exec(html) ?? re2.exec(html);
  const text = m?.[1] ? clean(m[1]) : '';
  return text || null;
}

export interface ExtractedPage {
  title: string | null;
  description: string | null;
  headings: string[];
  value_props: string[];
  excerpt: string | null;
}

/** Pure extraction from an HTML string. Exported for tests. */
export function extractPage(rawHtml: string): ExtractedPage {
  // Bound the work before any scanning starts. The download cap is 500KB, but nothing
  // a GTM strategy needs lives past the first 128KB, and every byte beyond that is
  // event-loop time taken from other tenants.
  const bounded = rawHtml.length > MAX_EXTRACT_BYTES ? rawHtml.slice(0, MAX_EXTRACT_BYTES) : rawHtml;
  const html = removeBlocks(bounded);

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = titleMatch?.[1] ? clean(titleMatch[1]) || null : null;

  const description =
    metaContent(html, 'name', 'description') ??
    metaContent(html, 'property', 'og:description') ??
    metaContent(html, 'name', 'twitter:description');

  const headings: string[] = [];
  const seen = new Set<string>();
  const headingRe = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(html)) !== null && headings.length < MAX_HEADINGS) {
    const text = clean(m[2] ?? '');
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    headings.push(text);
  }

  // Heuristic: headings that read like a claim (a sentence-ish length, not a nav label)
  // are the page's value propositions. The LLM strategy step refines these.
  const value_props = headings
    .filter((h) => h.length >= 20 && h.length <= 140 && !/^(home|about|contact|pricing|blog|login|sign in|customers)$/i.test(h))
    .slice(0, 6);

  const bodyMatch = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html);
  const text = clean(bodyMatch?.[1] ?? html);
  const excerpt = text ? text.slice(0, EXCERPT_CHARS) : null;

  return { title, description, headings, value_props, excerpt };
}

// ---------------------------------------------------------------- provider

export class HttpScrapeProvider implements ScrapeProvider {
  readonly name = 'http-scrape';
  private readonly fetchImpl: FetchLike;
  private readonly lookup: Lookup;
  private readonly now: Clock;

  constructor(options: HttpScrapeOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.lookup = options.lookup ?? defaultLookup;
    this.now = options.now ?? Date.now;
  }

  async scrape(url: string): Promise<SiteScrape> {
    const fetched_at = new Date(this.now()).toISOString();
    const empty = (error: string): SiteScrape => ({
      url,
      fetched_at,
      title: null,
      description: null,
      headings: [],
      value_props: [],
      customers_mentioned: [],
      raw_text_excerpt: null,
      truncated: false,
      error,
    });

    let current: URL;
    try {
      current = new URL(url.trim().match(/^[a-z][a-z0-9+.-]*:/i) ? url.trim() : `https://${url.trim()}`);
    } catch {
      return empty(`"${url}" is not a valid URL`);
    }

    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const refusal = await this.refuse(current);
        if (refusal) return empty(refusal);

        const response = await this.fetchImpl(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
            'Accept-Language': 'en',
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await discardBody(response);
          const location = response.headers.get('location');
          if (!location) return empty(`redirect (HTTP ${response.status}) without a Location header`);
          if (hop === MAX_REDIRECTS) return empty(`too many redirects (more than ${MAX_REDIRECTS})`);
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            return empty(`redirect to an invalid URL`);
          }
          current = next;
          continue;
        }

        if (!response.ok) {
          await discardBody(response);
          return empty(`HTTP ${response.status} from ${current.hostname}`);
        }

        const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
        if (contentType && !/text\/html|application\/xhtml\+xml/.test(contentType)) {
          await discardBody(response);
          return empty(`not an HTML page (content-type: ${contentType.split(';')[0]})`);
        }

        const { html, truncated } = await readCapped(response, MAX_BODY_BYTES);
        const page = extractPage(html);
        return {
          url,
          fetched_at,
          title: page.title,
          description: page.description,
          headings: page.headings,
          value_props: page.value_props,
          // Deliberately empty: we do not guess customer names from a homepage. A later
          // LLM pass over the excerpt may fill this with evidence.
          customers_mentioned: [],
          raw_text_excerpt: page.excerpt,
          truncated,
        };
      }
      return empty(`too many redirects (more than ${MAX_REDIRECTS})`);
    } catch (err) {
      const reason = err instanceof Error
        ? (err.name === 'TimeoutError' || err.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : err.message)
        : String(err);
      return empty(`fetch failed: ${reason}`);
    }
  }

  /** Returns a refusal message when the URL must not be fetched, else null. */
  private async refuse(target: URL): Promise<string | null> {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return `unsupported URL scheme "${target.protocol.replace(/:$/, '')}" (only http and https)`;
    }
    if (target.username || target.password) return 'URLs with embedded credentials are refused';
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      return isBlockedAddress(host) ? `refusing to fetch private or local address ${host}` : null;
    }
    if (isBlockedHostname(host)) return `refusing to fetch local hostname "${host}"`;
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await this.lookup(host);
    } catch (err) {
      return `could not resolve "${host}": ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!addresses.length) return `could not resolve "${host}"`;
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad) return `refusing to fetch "${host}": it resolves to private or local address ${bad.address}`;
    return null;
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* nothing to do */
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<{ html: string; truncated: boolean }> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  if (!response.body) {
    const text = await response.text();
    return text.length > maxBytes
      ? { html: text.slice(0, maxBytes), truncated: true }
      : { html: text, truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const room = maxBytes - received;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      received += room;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    received += value.byteLength;
  }
  let html = '';
  for (const chunk of chunks) html += decoder.decode(chunk, { stream: true });
  html += decoder.decode();
  return { html, truncated };
}
