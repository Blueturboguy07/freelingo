/**
 * A pure, seeded, deterministic PRNG.
 *
 * INV-ECO-11: "the day's quests and the day's Daily Refresh set are pure functions of
 * `(local_day, seed)` — identical across a kill, a relaunch and a course switch on the
 * same day." That needs a generator with no hidden state and no `Math.random`, so the
 * same day always deals the same hand and a relaunch cannot re-roll a target.
 *
 * xmur3 (string -> 32-bit seed) then mulberry32 (seed -> uniform stream). Both are
 * public domain and both are exactly reproducible across engines, because every step is
 * a 32-bit integer operation rather than floating-point arithmetic.
 */

/** Hash a string to a 32-bit seed. */
export function hashSeed(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

export interface SeededPrng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both ends included. */
  int(min: number, max: number): number;
  /** A new array, Fisher-Yates shuffled. The input is untouched. */
  shuffle<T>(items: readonly T[]): T[];
}

export function seededPrng(seed: string | number): SeededPrng {
  let state = (typeof seed === 'number' ? seed >>> 0 : hashSeed(seed)) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => {
    if (max < min) throw new RangeError(`int: empty range [${min}, ${max}]`);
    return min + Math.floor(next() * (max - min + 1));
  };
  return {
    next,
    int,
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = int(0, i);
        const a = out[i] as T;
        out[i] = out[j] as T;
        out[j] = a;
      }
      return out;
    },
  };
}
