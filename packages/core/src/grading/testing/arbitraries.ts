/**
 * Generators for the grading properties. Test support: nothing exports this from
 * `grading/index.ts`, and nothing outside a `.test.ts` imports it.
 *
 * The generators are TIGHT on purpose. `docs/ci.md` records why: the first four-zone
 * streak property drew 40 dates from a four-year span and produced the shape the invariant
 * was about in 2.8% of cases — "10,000 cases of a generator that cannot reach the
 * interesting shape is 10,000 cases of nothing". A grading property has the same failure
 * mode in a different costume: `fc.string()` against `fc.string()` is tier 3 essentially
 * always, so every mutation below is built FROM an accepted form and lands within one
 * tier-2 class of it.
 */
import fc from 'fast-check';
import type { GradingPack } from '../types.js';

/** Latin words the Spanish fixture knows, for building accepted forms. */
export const ES_TOKENS = ['el', 'la', 'gato', 'casa', 'carta', 'come', 'escribe', 'una'] as const;

/** Kana the Japanese fixture can build spaceless strings out of. */
export const JA_KANA = [
  'わ',
  'た',
  'し',
  'は',
  'が',
  'く',
  'せ',
  'い',
  'で',
  'す',
  'っ',
  'ー',
] as const;

/** An accepted-looking sentence for a pack: spaced tokens, or a kana run. */
export function arbTarget(pack: GradingPack): fc.Arbitrary<string> {
  if (pack.spaceless) {
    return fc
      .array(fc.constantFrom(...JA_KANA), { minLength: 2, maxLength: 8 })
      .map((a) => a.join(''));
  }
  return fc
    .array(fc.constantFrom(...ES_TOKENS), { minLength: 1, maxLength: 4 })
    .map((a) => a.join(' '));
}

/** The mutations a tier-2 class is supposed to catch, plus ones nothing should. */
export type MutationKind =
  | 'identity'
  | 'insert-space'
  | 'remove-space'
  | 'upper'
  | 'append-period'
  | 'strip-accent'
  | 'one-edit'
  | 'drop-token'
  | 'unrelated';

export const MUTATION_KINDS: readonly MutationKind[] = [
  'identity',
  'insert-space',
  'remove-space',
  'upper',
  'append-period',
  'strip-accent',
  'one-edit',
  'drop-token',
  'unrelated',
];

/** Apply a mutation deterministically, given a seed for the position it touches. */
export function mutate(target: string, kind: MutationKind, seed: number): string {
  const chars = [...target];
  const at = chars.length === 0 ? 0 : seed % chars.length;
  switch (kind) {
    case 'identity':
      return target;
    case 'insert-space':
      return [...chars.slice(0, at), ' ', ...chars.slice(at)].join('');
    case 'remove-space':
      return target.replace(' ', '');
    case 'upper':
      return target.toUpperCase();
    case 'append-period':
      return `${target}.`;
    case 'strip-accent':
      return target
        .normalize('NFD')
        .replace(/\p{Mn}/gu, '')
        .normalize('NFC');
    case 'one-edit':
      return [...chars.slice(0, at), 'x', ...chars.slice(at)].join('');
    case 'drop-token': {
      const tokens = target.split(' ');
      if (tokens.length < 2) return target;
      const drop = seed % tokens.length;
      return tokens.filter((_, i) => i !== drop).join(' ');
    }
    case 'unrelated':
      return 'zzz qqq';
  }
}

/** A (target, answer) pair that is usually within one tier-2 class of each other. */
export function arbNearMiss(pack: GradingPack): fc.Arbitrary<{
  readonly target: string;
  readonly answer: string;
  readonly kind: MutationKind;
}> {
  return fc
    .tuple(arbTarget(pack), fc.constantFrom(...MUTATION_KINDS), fc.nat({ max: 32 }))
    .map(([target, kind, seed]) => ({ target, answer: mutate(target, kind, seed), kind }));
}

/** Arbitrary text, for the totality properties: the grader must survive anything. */
export function arbAnyText(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.string({ maxLength: 24 }),
    fc.string({ unit: 'grapheme', maxLength: 12 }),
    fc.constantFrom('', ' ', '　', '​', 'año', 'está', 'がっこう', 'ｺｰﾋｰ', '猫'),
  );
}
