/**
 * Deterministic helpers shared by the mock providers.
 *
 * Mocks must never call Math.random(): the same input has to produce the same
 * output across processes so tests are stable and re-syncs do not duplicate rows.
 */

/** FNV-1a 32-bit. Fast, stable, good enough to spread fixtures around. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/** mulberry32: a tiny seeded PRNG returning floats in [0, 1). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks an element by seed. Throws on an empty list so a bad fixture is loud. */
export function pick<T>(items: readonly T[], seed: number): T {
  const item = items[(seed >>> 0) % items.length];
  if (item === undefined) throw new Error('pick() called with an empty list');
  return item;
}

export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
