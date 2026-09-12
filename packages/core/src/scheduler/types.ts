/**
 * The scheduler's vocabulary.
 *
 * Plan §Engine: `scheduler/` owns "FSRS + early-review guard, clamped elapsed, idempotent
 * attempts, review pools" (§5 SCH). This file holds the types those rules are written in.
 *
 * COORDINATION NOTE (read before merging): `ItemId` and `SessionId` are re-declared here
 * with the SAME brand strings the foundation task gives them in
 * `packages/core/src/types/index.ts`, which is outside this task's file lane and had not
 * landed on `origin/main` when this branch was cut. Identical brands are structurally
 * identical to TypeScript, so replacing these three declarations with
 * `export type { ItemId, SessionId } from '../types/index.js'` at integration is a no-op
 * for every caller. Do that; do not leave two spellings in the tree.
 */

/**
 * A CONTENT-HASHED item id (scope2 §D "stable-item-id contract"): the hash of the item's
 * normalised content, never a sequence counter, so FSRS rows survive a pack update whose
 * content did not change (S027).
 */
export type ItemId = string & { readonly __brand: 'ItemId' };
/** One learning session. Attempts and the reward commit are both keyed by it. */
export type SessionId = string & { readonly __brand: 'SessionId' };

export function asItemId(value: string): ItemId {
  return value as ItemId;
}
export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

/**
 * One accepted written or spoken form of an item, as the pack declares it.
 *
 * EC-SCH-12: `猫` is introduced in a picture-select and the pack enumerates three accepted
 * surfaces (`ねこ`, `猫`, `neko`). FSRS state is held per `(item, surface)` because a
 * stored SET has no per-member scheduling state, and a kana-only learner must never meet
 * a kanji nobody taught them.
 */
export type Surface = string;

/**
 * The modality a form is generated in (`listening`, `speaking`, …).
 *
 * Left as a string on purpose: `modality/` (P3, §11 MOD) owns the canonical list and the
 * suspension record. The scheduler only needs to know which modalities a row can be
 * generated in, so that disabling all of them holds the row (INV-SCH-08).
 */
export type Modality = string;

/**
 * What kind of thing the item is.
 *
 * `grapheme` exists for INV-SCH-12: a kanji/kana item accrues FSRS credit only from
 * ruby-SUPPRESSED encounters, while the `lexeme` that contains it schedules normally with
 * ruby on. `grammarConcept` is scope2 §Q2 option C — a case is ONE item, not one per noun.
 */
export const ITEM_KINDS = ['lexeme', 'grapheme', 'grammarConcept'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** `(item, surface)` flattened into one map key (INV-SCH-11). */
export type FsrsRowKey = string & { readonly __brand: 'FsrsRowKey' };

/**
 * ASCII UNIT SEPARATOR. A surface is arbitrary pack text — it can contain `|`, `#`, `:`
 * and every other character somebody would reach for — so the separator is one that
 * cannot occur in rendered content.
 */
export const ROW_KEY_SEPARATOR = '\u001f';

export function rowKeyOf(itemId: ItemId, surface: Surface): FsrsRowKey {
  return `${itemId}${ROW_KEY_SEPARATOR}${surface}` as FsrsRowKey;
}

export function parseRowKey(key: FsrsRowKey): { itemId: ItemId; surface: Surface } {
  const at = key.indexOf(ROW_KEY_SEPARATOR);
  if (at < 0) throw new RangeError(`not an FSRS row key: ${JSON.stringify(key)}`);
  return { itemId: key.slice(0, at) as ItemId, surface: key.slice(at + 1) };
}

/**
 * ts-fsrs `Rating` minus `Manual`: 1 Again, 2 Hard, 3 Good, 4 Easy.
 *
 * Declared as a numeric union rather than imported so that callers outside this package
 * (the session module, the app) never need a ts-fsrs import to answer an exercise.
 */
export type Grade = 1 | 2 | 3 | 4;
export const GRADES: readonly Grade[] = [1, 2, 3, 4] as const;
/** Grades that are NOT a lapse. A lapse legitimately shortens the interval. */
export const NON_LAPSE_GRADES: readonly Grade[] = [2, 3, 4] as const;

/**
 * What the scheduler did with an encounter, written on the attempt row.
 *
 * - `introduction` — the item's introduction beat for this surface (INV-SCH-11).
 * - `scheduled`    — a real review: stability, difficulty and `due_at` all move.
 * - `early`        — INV-SCH-01: `elapsed < 0.6 x scheduled_interval`. Retrievability is
 *                    updated and the attempt is logged; stability and `due_at` are NOT.
 * - `rubyAssisted` — INV-SCH-12: a ruby-on encounter of a grapheme item. Nothing moves.
 * - `uncredited`   — the row has no introduction beat, or is held (report, modality).
 *                    Nothing moves, and generation should never have offered it.
 */
export const REVIEW_KINDS = [
  'introduction',
  'scheduled',
  'early',
  'rubyAssisted',
  'uncredited',
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/**
 * Recognition vs production (EC-SCH-11).
 *
 * "No lexeme reaches a production type within `min_hours_between_introduction_and_production`
 * of its introduction" — so the scheduler needs the role, not the exercise type. The
 * mapping from the eleven exercise types to a role is `EXERCISE_ROLES` below; it is the
 * scheduler's own classification, not an economy constant.
 */
export const ENCOUNTER_ROLES = ['recognition', 'production'] as const;
export type EncounterRole = (typeof ENCOUNTER_ROLES)[number];

/**
 * The role each exercise type plays for the item it teaches.
 *
 * Keyed by the product-map type names (S032-S042; S043 is out of v1). Kept as a plain
 * record rather than a union over `ExerciseType` so that this file stays importable
 * before the shared type surface lands, and so a pack that adds a type does not fail to
 * compile — an unknown type resolves to `recognition`, the safe side of EC-SCH-11.
 */
export const EXERCISE_ROLES: Readonly<Record<string, EncounterRole>> = {
  pictureSelect: 'recognition',
  matchPairs: 'recognition',
  meaningSelect: 'recognition',
  listening: 'recognition',
  readRespond: 'recognition',
  character: 'recognition',
  wordBankTranslate: 'production',
  typedTranslate: 'production',
  completeTheChat: 'production',
  gapFill: 'production',
  speak: 'production',
};

export function roleOfExerciseType(type: string): EncounterRole {
  return EXERCISE_ROLES[type] ?? 'recognition';
}

/** One answered exercise, as the session hands it to the scheduler. */
export interface Encounter {
  readonly sessionId: SessionId;
  /** Position in the session queue. `(sessionId, exerciseIndex)` is the attempt key. */
  readonly exerciseIndex: number;
  readonly itemId: ItemId;
  readonly surface: Surface;
  readonly role: EncounterRole;
  readonly grade: Grade;
  /** The real wall instant the answer was submitted. */
  readonly at: Date;
  /** Whether furigana/ruby was rendered over the target (INV-SCH-12). */
  readonly rubyShown?: boolean;
}

/**
 * A clamped or refused event. Every clamp writes one (INV-SCH-02).
 *
 * `observedMs` is what the device clock claimed; `usedMs` is what reached the scheduler.
 */
export const ANOMALY_KINDS = [
  'negativeElapsed',
  'implausibleElapsed',
  'uncreditedSurface',
  'heldItemEncounter',
  'productionTooSoon',
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

export interface AnomalyRow {
  readonly kind: AnomalyKind;
  readonly rowKey: FsrsRowKey | null;
  readonly at: Date;
  readonly observedMs: number | null;
  readonly usedMs: number | null;
  readonly note: string;
}
