/**
 * A tiny seeded PRNG (mulberry32) plus sampling helpers. Not cryptographic —
 * it exists purely so `generate` is a pure function of CORPUS_SEED: the same
 * seed always reproduces the same corpus, byte for byte, which is what lets
 * the ticket's resolution record "the seeding command" instead of shipping a
 * multi-GB fixture.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: Rng, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[randInt(rng, 0, items.length - 1)];
  if (item === undefined) {
    throw new Error("pick() called on an empty array");
  }
  return item;
}

/** Weighted sample by cumulative-weight scan. `weights` need not sum to 1. */
export function weightedIndex(rng: Rng, weights: readonly number[]): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i] ?? 0;
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * A rank-biased draw over `count` items (Zipf-like: item 0 is drawn far more
 * often than item `count - 1`), used for correspondent frequency so a
 * handful of contacts dominate a long tail of one-off senders.
 */
export function zipfIndex(rng: Rng, count: number, exponent = 1.05): number {
  // Inverse-CDF via cumulative scan over precomputed rank weights would cost
  // O(count) per draw; instead reject-sample: draw a rank threshold and a
  // uniform candidate, retry if the candidate loses to the rank's weight.
  // Cheap because most draws land in the light head of the distribution.
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = randInt(rng, 0, count - 1);
    const threshold = 1 / (candidate + 1) ** exponent;
    if (rng() < threshold) return candidate;
  }
  return 0;
}

/** Sum of `samples` uniform draws, roughly bell-shaped (Irwin–Hall). */
export function approxNormal01(rng: Rng, samples = 4): number {
  let sum = 0;
  for (let i = 0; i < samples; i++) sum += rng();
  return sum / samples;
}
