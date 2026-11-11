/**
 * Registrar provider (live).
 *
 * NAMING. The provider registry (providers/index.ts) imports `NamecheapProvider`
 * from this file because the brief named Namecheap first. In practice the
 * implemented registrar is PORKBUN, and `NamecheapProvider` is a thin dispatcher
 * over `env.registrar.provider` that hands out a `PorkbunDomainProvider`. The
 * export keeps the registry resolving without a contract change; rename both when
 * env.ts and index.ts are next touched.
 *
 * WHY PORKBUN (docs/VENDOR_NOTES.md §4, verified 2026-10-23):
 *  - Namecheap's API needs an account with 20+ domains or $50 spent, plus IP
 *    whitelisting: a non-starter for a fresh SaaS account on a cloud egress IP.
 *  - GoDaddy v3 needs a billing method on file before any call works and is
 *    limited to 60 req/min.
 *  - Porkbun: two static keys, plain JSON, a sandbox, a default $100/month spend
 *    cap (a safety net for a bug that buys domains in a loop).
 *  - InboxKit can also register domains, which may make this provider optional for V1.
 *
 * For `namecheap` and `godaddy` we throw a clear "not implemented" rather than
 * ship an untested XML client that would only fail once a customer is waiting.
 *
 * PORKBUN API (base https://api.porkbun.com/api/json/v3, every call is a POST):
 *  - Auth: `X-API-Key` + `X-Secret-API-Key` headers per VENDOR_NOTES. Porkbun's
 *    older docs put `apikey` and `secretapikey` in the JSON body; we send both
 *    forms so either generation of the API accepts the call.
 *  - POST /domain/checkDomain/{domain}  -> { status, response: { avail: "yes"|"no", price } }
 *  - POST /domain/create/{domain}       -> { status, ... }
 *  - POST /domain/updateNs/{domain}     { ns: [...] }
 *  - POST /dns/create/{domain}          { name, type, content, ttl, prio } -> { status, id }
 *  - POST /dns/edit/{domain}/{id}       { name, type, content, ttl, prio }
 *  - POST /dns/retrieve/{domain}        -> { status, records: [{ id, name, type, content, ttl, prio }] }
 *  Every body carries `status: "SUCCESS" | "ERROR"` and on error a `message`; we
 *  check `status`, not the HTTP code.
 *
 * ENV. env.ts does not yet declare Porkbun keys and this module may not edit it,
 * so the two keys are read here in one place. Move them into env.ts when it is
 * next touched: `registrar.porkbunApiKey`, `registrar.porkbunSecretKey`.
 *
 * Never log the keys.
 */

import { env, requireCredential } from '../../lib/env';
import type { DnsRecord, DomainProvider } from '../../lib/contracts';

const PORKBUN_BASE = 'https://api.porkbun.com/api/json/v3';
const DEFAULT_TTL = 600;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function normaliseDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/** "11.98" -> 1198. Porkbun prices are USD strings. */
export function dollarsToCents(value: unknown): number | null {
  const s = asString(value);
  if (!s) return null;
  const n = Number.parseFloat(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Our relative host ("@", "_dmarc") -> Porkbun's `name` (subdomain, "" for apex). */
function toPorkbunName(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  return h === '@' || h === '' ? '' : h;
}

/** Porkbun's FQDN `name` -> our relative host. */
function fromPorkbunName(name: string, domain: string): string {
  const h = name.trim().toLowerCase().replace(/\.$/, '');
  if (h === domain || h === '') return '@';
  return h.endsWith(`.${domain}`) ? h.slice(0, -(domain.length + 1)) : h;
}

function inferPurpose(type: DnsRecord['type'], host: string, value: string): DnsRecord['purpose'] {
  const v = value.trim().toLowerCase();
  if (type === 'MX') return 'mx';
  if (host.startsWith('_dmarc')) return 'dmarc';
  if (host.includes('_domainkey')) return 'dkim';
  if (type === 'TXT' && v.startsWith('v=spf1')) return 'spf';
  if (type === 'CNAME') return 'tracking';
  return 'verification';
}

function isDnsType(v: string): v is DnsRecord['type'] {
  return v === 'TXT' || v === 'MX' || v === 'CNAME' || v === 'A';
}

export class PorkbunApiError extends Error {
  constructor(readonly path: string, readonly httpStatus: number, detail: string | null) {
    super(`Porkbun ${path} failed (HTTP ${httpStatus})${detail ? `: ${detail}` : ''}`);
    this.name = 'PorkbunApiError';
  }
}

export interface PorkbunOptions {
  apiKey?: string;
  secretKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
}


export class PorkbunDomainProvider implements DomainProvider {
  readonly name = 'porkbun';

  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;

  constructor(options: PorkbunOptions = {}) {
    this.apiKey = options.apiKey ?? requireCredential('Porkbun', 'PORKBUN_API_KEY', env.registrar.porkbunApiKey);
    this.secretKey = options.secretKey ?? requireCredential('Porkbun', 'PORKBUN_SECRET_API_KEY', env.registrar.porkbunSecretApiKey);
    this.baseUrl = (options.baseUrl ?? PORKBUN_BASE).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retries = options.retries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 500;
  }

  async checkAvailability(domain: string): Promise<{ available: boolean; price_cents: number | null }> {
    const name = normaliseDomain(domain);
    if (!name.includes('.')) throw new Error(`Porkbun: "${domain}" is not a registrable domain name.`);
    const body = await this.call(`/domain/checkDomain/${encodeURIComponent(name)}`, {});
    const response = isObject(body['response']) ? body['response'] : null;
    const avail = response ? asString(response['avail']) : null;
    if (avail === null) throw new Error(`Porkbun: checkDomain for ${name} returned no "avail" field.`);
    const available = avail.toLowerCase() === 'yes';
    const price = response ? dollarsToCents(response['price']) : null;
    return { available, price_cents: available ? price : null };
  }

  async register(input: { domain: string; years?: number }): Promise<{ provider_ref: string; price_cents: number }> {
    const name = normaliseDomain(input.domain);
    const years = Math.max(1, Math.floor(input.years ?? 1));

    // Check first: it gives us the price to book, and avoids a paid call that would fail.
    const check = await this.checkAvailability(name);
    if (!check.available) throw new Error(`Porkbun: "${name}" is not available to register.`);
    if (check.price_cents === null) throw new Error(`Porkbun: no price returned for ${name}; refusing to register at an unknown cost.`);

    const body = await this.call(`/domain/create/${encodeURIComponent(name)}`, { years });
    const ref = asString(body['orderId']) ?? asString(body['order_id']) ?? asString(body['id']) ?? `porkbun:${name}`;
    return { provider_ref: ref, price_cents: check.price_cents * years };
  }

  /** Not on the interface: point the domain at other nameservers (e.g. InboxKit's). */
  async setNameservers(input: { domain: string; nameservers: string[] }): Promise<void> {
    const name = normaliseDomain(input.domain);
    const ns = input.nameservers.map(normaliseDomain).filter(Boolean);
    if (ns.length < 2) throw new Error('Porkbun: updateNs needs at least two nameservers.');
    await this.call(`/domain/updateNs/${encodeURIComponent(name)}`, { ns });
  }

  /**
   * Idempotent: records already present (same type, host, value) are left alone.
   * Single-valued records (CNAME, MX at the same host, the one SPF and the one
   * DMARC TXT) are EDITED in place when the value differs, since a second SPF
   * record would make SPF permanently fail. Anything else is created.
   */
  async setDnsRecords(input: { domain: string; records: DnsRecord[] }): Promise<void> {
    const name = normaliseDomain(input.domain);
    const existing = await this.retrieve(name);

    for (const record of input.records) {
      if (/\{\{[A-Z0-9_]+\}\}/.test(record.value)) {
        throw new Error(`Porkbun: refusing to write ${record.type} ${record.host} with an unsubstituted placeholder: ${record.value}`);
      }
      const host = toPorkbunName(record.host);
      const sameHost = existing.filter((e) => e.type === record.type && toPorkbunName(e.host) === host);
      const same = sameHost.find((e) => sameValue(e, record));
      if (same) continue;

      const payload = {
        name: host,
        type: record.type,
        content: record.value,
        ttl: String(DEFAULT_TTL),
        ...(record.type === 'MX' ? { prio: String(record.priority ?? 0) } : {}),
      };

      const singleValued = record.type === 'CNAME' || record.purpose === 'spf' || record.purpose === 'dmarc';
      const toEdit = singleValued ? sameHost.find((e) => e.purpose === record.purpose || record.type === 'CNAME') : undefined;
      if (toEdit && toEdit.id) {
        await this.call(`/dns/edit/${encodeURIComponent(name)}/${encodeURIComponent(toEdit.id)}`, payload);
      } else {
        const body = await this.call(`/dns/create/${encodeURIComponent(name)}`, payload);
        if (asString(body['id']) === null) {
          throw new Error(`Porkbun: dns/create for ${record.type} ${record.host} returned no record id.`);
        }
      }
    }
  }

  async getDnsRecords(input: { domain: string }): Promise<DnsRecord[]> {
    const rows = await this.retrieve(normaliseDomain(input.domain));
    return rows.map(({ id: _id, ...record }) => record);
  }

  // -------------------------------------------------------------- internals

  private async retrieve(domain: string): Promise<Array<DnsRecord & { id: string | null }>> {
    const body = await this.call(`/dns/retrieve/${encodeURIComponent(domain)}`, {});
    const raw = body['records'];
    if (!Array.isArray(raw)) throw new Error(`Porkbun: dns/retrieve for ${domain} returned no "records" array.`);

    const out: Array<DnsRecord & { id: string | null }> = [];
    for (const row of raw) {
      if (!isObject(row)) continue;
      const type = asString(row['type'])?.toUpperCase() ?? '';
      if (!isDnsType(type)) continue; // NS, SOA, ALIAS etc. are not ours to manage
      const host = fromPorkbunName(asString(row['name']) ?? '', domain);
      const value = asString(row['content']) ?? '';
      const prio = type === 'MX' ? Number.parseInt(asString(row['prio']) ?? '0', 10) : undefined;
      out.push({
        id: asString(row['id']),
        type,
        host,
        value,
        ...(prio !== undefined && Number.isFinite(prio) ? { priority: prio } : {}),
        purpose: inferPurpose(type, host, value),
      });
    }
    return out;
  }

  /** POST + JSON, bounded, retried on 429/5xx, and validated on `status`. */
  private async call(path: string, payload: Json): Promise<Json> {
    const body = JSON.stringify({ apikey: this.apiKey, secretapikey: this.secretKey, ...payload });
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-Key': this.apiKey,
      'X-Secret-API-Key': this.secretKey,
    };

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.retryBaseMs * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await globalThis.fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = err;
        continue;
      }

      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        parsed = null;
      }

      if (res.status === 429 || res.status >= 500) {
        lastError = new PorkbunApiError(path, res.status, isObject(parsed) ? asString(parsed['message'])?.slice(0, 200) ?? null : null);
        continue;
      }
      if (!isObject(parsed)) throw new PorkbunApiError(path, res.status, 'response was not a JSON object');
      const status = asString(parsed['status'])?.toUpperCase();
      if (status !== 'SUCCESS') {
        throw new PorkbunApiError(path, res.status, asString(parsed['message'])?.slice(0, 200) ?? `status=${status ?? 'missing'}`);
      }
      return parsed;
    }
    throw lastError instanceof Error ? lastError : new Error(`Porkbun ${path}: request failed after ${this.retries + 1} attempts`);
  }
}

function sameValue(a: DnsRecord, b: DnsRecord): boolean {
  const norm = (r: DnsRecord): string =>
    r.type === 'TXT' ? r.value.replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase() : r.value.trim().toLowerCase().replace(/\.$/, '');
  if (norm(a) !== norm(b)) return false;
  if (a.type === 'MX' && a.priority !== undefined && b.priority !== undefined) return a.priority === b.priority;
  return true;
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- dispatcher

export type RegistrarName = 'porkbun' | 'namecheap' | 'godaddy';

export class RegistrarNotImplementedError extends Error {
  constructor(registrar: string) {
    super(
      `Registrar "${registrar}" is not implemented. Set REGISTRAR_PROVIDER=porkbun (two API keys, no ` +
        `account minimums), or let InboxKit register the domain (POST /v1/api/domains/register). ` +
        `Namecheap requires 20+ domains plus IP whitelisting; GoDaddy v3 requires a billing method on file.`,
    );
    this.name = 'RegistrarNotImplementedError';
  }
}

/**
 * Picks the registrar from `env.registrar.provider`. Despite the name (see the
 * file header), the only working path is Porkbun. Note env.ts currently defaults
 * REGISTRAR_PROVIDER to "namecheap", so a live deployment MUST set it to "porkbun"
 * until that default is changed.
 */
export class NamecheapProvider implements DomainProvider {
  readonly name: string;
  private readonly impl: DomainProvider;

  constructor(options: { provider?: string; porkbun?: PorkbunOptions } = {}) {
    const chosen = (options.provider ?? env.registrar.provider ?? '').trim().toLowerCase();
    switch (chosen) {
      case 'porkbun':
      case '':
        this.impl = new PorkbunDomainProvider(options.porkbun);
        break;
      case 'namecheap':
      case 'godaddy':
        throw new RegistrarNotImplementedError(chosen);
      default:
        throw new RegistrarNotImplementedError(chosen);
    }
    this.name = this.impl.name;
  }

  checkAvailability(domain: string): Promise<{ available: boolean; price_cents: number | null }> {
    return this.impl.checkAvailability(domain);
  }

  register(input: { domain: string; years?: number }): Promise<{ provider_ref: string; price_cents: number }> {
    return this.impl.register(input);
  }

  setDnsRecords(input: { domain: string; records: DnsRecord[] }): Promise<void> {
    return this.impl.setDnsRecords(input);
  }

  getDnsRecords(input: { domain: string }): Promise<DnsRecord[]> {
    return this.impl.getDnsRecords(input);
  }
}
