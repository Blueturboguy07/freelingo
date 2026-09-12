/**
 * The committed falsifiers (plan §Verification: `pnpm test:falsify`).
 *
 * > "An invariant that cannot fail is not an invariant; each row names a concrete
 * > falsifier." (`docs/invariants.md`)
 *
 * Every id this task owns has a file in `__falsifiers__/` holding the INPUT that would
 * expose the invariant if the grader got it wrong, plus the verdict the invariant demands.
 * The files are data, not code: they survive a rewrite of the module, they can be handed
 * to a refuter, and a future engine in another language can be driven by the same corpus.
 *
 * Two gates beyond the cases themselves:
 *
 *  - every id in `docs/owned/grading.json` HAS a file — a falsifier nobody wrote is the
 *    failure mode this whole file exists to prevent;
 *  - every file's `invariant` matches its filename, so a copy-paste cannot quietly give
 *    two ids the same evidence.
 *
 * Test names carry both the id and the word `falsifier`, which is what
 * `vitest run --project core -t falsifier` selects.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { accuracyOf, isPerfectLesson } from './accuracy.js';
import { bannerFor } from './banner.js';
import { gradeMultiGap, gradeTypedAnswer, NO_SURFACES_INTRODUCED } from './grade.js';
import { highlightRanges } from './highlight.js';
import { moraCount, normaliseJa } from './ja.js';
import { gradeListening, unitReadingCollisions } from './listening.js';
import { gradeMatch } from './match.js';
import { gradeOpenResponse, type OpenResponsePath } from './open-response.js';
import { isSnoozed, snooze } from './banner.js';
import { classifyTier2 } from './tier2.js';
import { applyTypoGuards } from './typo-guards.js';
import { tier1Normalise } from './normalise.js';
import {
  EMPTY_SELECT_STATE,
  gradeCharacterSelect,
  gradeWordBank,
  tapCharacter,
  wordBankAnswer,
} from './wordbank.js';
import { DE_PACK, DE_UNIT } from './packs/de.js';
import { ES_PACK, ES_UNIT } from './packs/es.js';
import { JA_PACK, JA_QUOTATION_UNIT, JA_UNIT } from './packs/ja.js';
import type {
  AttemptRow,
  GradableItem,
  GradingPack,
  GradingUnit,
  TypoGuards,
  Verdict,
} from './types.js';

const FALSIFIER_DIR = fileURLToPath(new URL('./__falsifiers__/', import.meta.url));
const OWNED_PATH = fileURLToPath(new URL('../../../../docs/owned/grading.json', import.meta.url));

const PACKS: Record<string, GradingPack> = { es: ES_PACK, ja: JA_PACK, de: DE_PACK };
const UNITS: Record<string, GradingUnit> = {
  es: ES_UNIT,
  ja: JA_UNIT,
  'ja-quote': JA_QUOTATION_UNIT,
  de: DE_UNIT,
};

/** A falsifier file. `kind` selects which harness below reads `cases`. */
interface FalsifierFile {
  readonly invariant: string;
  readonly why: string;
  readonly kind: string;
  readonly cases: readonly Record<string, unknown>[];
}

/** Fill a JSON item stub out to a `GradableItem`. */
function toItem(raw: Record<string, unknown> | undefined): GradableItem {
  const stub = (raw ?? {}) as Partial<GradableItem>;
  return {
    itemId: stub.itemId ?? 'item-1',
    family: stub.family ?? 'typed-translate',
    accepted: stub.accepted ?? [],
    ...stub,
  } as GradableItem;
}

function packOf(c: Record<string, unknown>): GradingPack {
  const name = (c.pack as string | undefined) ?? 'es';
  const pack = PACKS[name];
  if (pack === undefined) throw new Error(`falsifier names an unknown pack: ${name}`);
  return pack;
}

function unitOf(c: Record<string, unknown>): GradingUnit {
  const name = (c.unit as string | undefined) ?? (c.pack as string | undefined) ?? 'es';
  const unit = UNITS[name];
  if (unit === undefined) throw new Error(`falsifier names an unknown unit: ${name}`);
  return unit;
}

function learnerOf(c: Record<string, unknown>) {
  const introduced = (c.introducedSurfaceIds as string[] | undefined) ?? null;
  return introduced === null
    ? NO_SURFACES_INTRODUCED
    : { introducedSurfaceIds: new Set(introduced) };
}

/**
 * Assert only the keys the falsifier listed; everything else is the module's business.
 *
 * `skip` names keys a harness has already asserted by hand — `perfectLesson` is not a
 * field of `AccuracySummary`, and `answerString` is not a field of a `Verdict`. Without
 * it they would silently compare against `undefined`, which reads as a failing test for
 * the wrong reason.
 */
function expectSubset(
  actual: unknown,
  expected: Record<string, unknown>,
  label: string,
  skip: readonly string[] = [],
): void {
  const record = actual as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    if (skip.includes(key)) continue;
    expect(record[key], `${label} :: ${key}`).toEqual(value);
  }
}

/** One harness per `kind`. Each takes a case and asserts its `expect` block. */
const HARNESSES: Record<string, (c: Record<string, unknown>, label: string) => void> = {
  typed(c, label) {
    const verdict = gradeTypedAnswer({
      pack: packOf(c),
      unit: unitOf(c),
      item: toItem(c.item as Record<string, unknown>),
      answer: c.answer as string,
      learner: learnerOf(c),
    });
    expectSubset(verdict, c.expect as Record<string, unknown>, label);
  },

  multigap(c, label) {
    const { verdict } = gradeMultiGap({
      pack: packOf(c),
      unit: unitOf(c),
      item: toItem(c.item as Record<string, unknown>),
      answers: c.answers as string[],
      learner: learnerOf(c),
    });
    expectSubset(verdict, c.expect as Record<string, unknown>, label);
  },

  tier2(c, label) {
    const pack = packOf(c);
    const unit = unitOf(c);
    const result = classifyTier2(
      tier1Normalise(c.answer as string, pack),
      tier1Normalise(c.target as string, pack),
      pack,
      unit,
      {
        targetReading: (c.targetReading as string | undefined) ?? null,
        targetLexemeSurface: (c.targetLexemeSurface as string | undefined) ?? null,
      },
    );
    const expected = c.expect as Record<string, unknown>;
    if (expected.tier2Class === null) expect(result, label).toBeNull();
    else expectSubset(result, expected, label);
  },

  guards(c, label) {
    const pack = packOf(c);
    const overrides = (c.guards ?? {}) as Partial<TypoGuards>;
    const guards: TypoGuards = { ...pack.typoGuards, ...overrides };
    const outcome = applyTypoGuards(
      {
        mistypedWord: c.mistypedWord as string,
        targetWord: c.targetWord as string,
        targetReading: (c.targetReading as string | undefined) ?? null,
        answerReading: (c.answerReading as string | undefined) ?? null,
        editOffsetInTarget: c.editOffsetInTarget as number,
        targetString: c.targetString as string,
        targetLexemeSurface: (c.targetLexemeSurface as string | undefined) ?? null,
        targetLanguageWords: pack.targetLanguageWords,
      },
      guards,
    );
    expectSubset(outcome, c.expect as Record<string, unknown>, label);
  },

  accuracy(c, label) {
    const attempts = c.attempts as AttemptRow[];
    const summary = accuracyOf(attempts);
    const expected = c.expect as Record<string, unknown>;
    expectSubset(summary, expected, label, ['perfectLesson', 'accuracy']);
    // JSON has no `undefined`, and `undefined` is precisely what this invariant is about:
    // "accuracy is **undefined** … never rendered as 0%". So a falsifier writes `null` and
    // this asserts the real thing, plus the negative the invariant names.
    if ('accuracy' in expected) {
      if (expected.accuracy === null) {
        expect(summary.accuracy, `${label} :: accuracy is undefined`).toBeUndefined();
        expect(summary.accuracy, `${label} :: never 0%`).not.toBe(0);
      } else {
        expect(summary.accuracy, `${label} :: accuracy`).toBeCloseTo(
          expected.accuracy as number,
          12,
        );
      }
    }
    if ('perfectLesson' in expected) {
      expect(isPerfectLesson(attempts), `${label} :: perfectLesson`).toBe(expected.perfectLesson);
    }
  },

  match(c, label) {
    const outcome = gradeMatch(
      toItem(c.item as Record<string, unknown>),
      c.taps as { leftLexemeId: string; rightLexemeId: string }[],
    );
    const expected = c.expect as Record<string, unknown>;
    const flat: Record<string, unknown> = {
      ...outcome,
      mistakeLexemeIds: outcome.verdict.mistakeLexemeIds,
      wrong: outcome.verdict.wrong,
      schedulerTargets: outcome.verdict.schedulerTargets,
    };
    expectSubset(flat, expected, label);
  },

  'open-response'(c, label) {
    const verdict = gradeOpenResponse({
      pack: packOf(c),
      unit: unitOf(c),
      item: toItem(c.item as Record<string, unknown>),
      reply: c.reply as string,
      path: (c.path as OpenResponsePath | undefined) ?? 'keyword-length',
    });
    expectSubset(verdict, c.expect as Record<string, unknown>, label);
  },

  banner(c, label) {
    const verdict = gradeTypedAnswer({
      pack: packOf(c),
      unit: unitOf(c),
      item: toItem(c.item as Record<string, unknown>),
      answer: c.answer as string,
      learner: learnerOf(c),
    });
    const pack = packOf(c);
    const target = tier1Normalise(
      toItem(c.item as Record<string, unknown>).accepted[0]?.surface ?? '',
      pack,
    );
    const banner = bannerFor(verdict, tier1Normalise(c.answer as string, pack), target, pack, {
      motivationalMessages: (c.motivationalMessages as boolean | undefined) ?? true,
      headlineIndex: (c.headlineIndex as number | undefined) ?? 0,
    });
    expect(banner.headline, `${label} :: headline is never empty`).not.toBe('');
    expectSubset(banner, c.expect as Record<string, unknown>, label);
  },

  snooze(c, label) {
    let rows = snooze([], c.itemId as string, c.day as string);
    rows = snooze(rows, c.itemId as string, c.day as string);
    const expected = c.expect as Record<string, unknown>;
    expect(rows.length, `${label} :: idempotent`).toBe(expected.rowCount);
    expect(isSnoozed(rows, c.itemId as string, c.day as string), `${label} :: today`).toBe(
      expected.snoozedToday,
    );
    expect(
      isSnoozed(rows, c.itemId as string, c.otherDay as string),
      `${label} :: another day`,
    ).toBe(expected.snoozedOtherDay);
  },

  'ja-normalise'(c, label) {
    const expected = c.expect as Record<string, unknown>;
    const inputs = c.inputs as string[];
    const normalised = inputs.map((s) => normaliseJa(s));
    if (expected.collapseToOne === true) {
      expect(new Set(normalised).size, `${label} :: collapse`).toBe(1);
    }
    if (expected.distinctFrom !== undefined) {
      expect(normalised).not.toContain(normaliseJa(expected.distinctFrom as string));
    }
    if (expected.idempotent === true) {
      for (const s of normalised) expect(normaliseJa(s), `${label} :: idempotent`).toBe(s);
    }
    if (expected.equalsAll !== undefined) {
      for (const s of normalised) expect(s, `${label} :: equalsAll`).toBe(expected.equalsAll);
    }
    if (expected.mora !== undefined) {
      expect(moraCount(inputs[0] ?? ''), `${label} :: mora`).toBe(expected.mora);
    }
    // The ja fold is only half of tier 1: `tier1Normalise` also strips whitespace for a
    // spaceless pack, and the two stages feed each other. A case that pins the ja fold
    // alone would have missed the が + U+3000 + ヾ regression entirely.
    if (expected.tier1IdempotentInJaPack === true) {
      for (const input of inputs) {
        const once = tier1Normalise(input, JA_PACK);
        expect(tier1Normalise(once, JA_PACK), `${label} :: tier1 idempotent`).toBe(once);
        if (expected.tier1EqualsAll !== undefined) {
          expect(once, `${label} :: tier1EqualsAll`).toBe(expected.tier1EqualsAll);
        }
      }
    }
  },

  'word-bank'(c, label) {
    const pack = packOf(c);
    const item = toItem(c.item as Record<string, unknown>);
    const answer = wordBankAnswer(item, c.tappedTileIds as string[], pack);
    const verdict = gradeWordBank({
      pack,
      unit: unitOf(c),
      item,
      learner: learnerOf(c),
      tappedTileIds: c.tappedTileIds as string[],
    });
    const expected = c.expect as Record<string, unknown>;
    if (expected.answerString !== undefined) {
      expect(answer, `${label} :: joined string`).toBe(expected.answerString);
    }
    if (expected.containsSpace !== undefined) {
      expect(answer.includes(' '), `${label} :: U+0020`).toBe(expected.containsSpace);
    }
    expectSubset(verdict, expected, label, ['answerString', 'containsSpace']);
  },

  select(c, label) {
    let state = EMPTY_SELECT_STATE;
    let heartsDuringTaps = 0;
    for (const tile of c.taps as string[]) {
      state = tapCharacter(state, tile);
      heartsDuringTaps += state.heartsSpentOnTaps;
    }
    expect(heartsDuringTaps, `${label} :: no heart on an intermediate tap`).toBe(0);
    const verdict = gradeCharacterSelect(toItem(c.item as Record<string, unknown>), state);
    expectSubset(verdict, c.expect as Record<string, unknown>, label);
  },

  listening(c, label) {
    const expected = c.expect as Record<string, unknown>;
    if (c.taught !== undefined) {
      const collisions = unitReadingCollisions(
        c.taught as { lexemeId: string; surface: string; reading: string }[],
      );
      expect(collisions.length, `${label} :: build gate`).toBe(expected.collisionCount);
      return;
    }
    const verdict = gradeListening({
      pack: packOf(c),
      unit: unitOf(c),
      item: toItem(c.item as Record<string, unknown>),
      answer: c.answer as string,
      learner: learnerOf(c),
    });
    expectSubset(verdict, expected, label);
  },

  highlight(c, label) {
    const pack = packOf(c);
    const spans = (c.rubySpans ?? []) as { start: number; end: number }[];
    const ranges = highlightRanges(c.answer as string, c.target as string, pack, spans);
    const expected = c.expect as Record<string, unknown>;
    if (expected.ranges !== undefined)
      expect(ranges, `${label} :: ranges`).toEqual(expected.ranges);
    for (const range of ranges) {
      for (const span of spans) {
        expect(
          range.start > span.start && range.start < span.end,
          `${label} :: start inside a ruby span`,
        ).toBe(false);
        expect(
          range.end > span.start && range.end < span.end,
          `${label} :: end inside a ruby span`,
        ).toBe(false);
      }
    }
  },
};

const owned: string[] = (JSON.parse(readFileSync(OWNED_PATH, 'utf8')) as { owned: string[] }).owned;

const files = readdirSync(FALSIFIER_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort();

describe('grading falsifiers', () => {
  it('every owned invariant has a committed falsifier input (falsifier registry)', () => {
    const present = new Set(files.map((name) => name.replace(/\.json$/, '')));
    const missing = owned.filter((id) => !present.has(id));
    expect(missing, 'ids in docs/owned/grading.json with no __falsifiers__ file').toEqual([]);
  });

  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(FALSIFIER_DIR, file), 'utf8')) as FalsifierFile;
    const id = file.replace(/\.json$/, '');

    it(`[${id}] falsifier: ${parsed.why}`, () => {
      expect(parsed.invariant, `${file} names a different invariant`).toBe(id);
      const harness = HARNESSES[parsed.kind];
      expect(harness, `${file} names an unknown kind: ${parsed.kind}`).toBeTypeOf('function');
      expect(parsed.cases.length, `${file} has no cases`).toBeGreaterThan(0);
      parsed.cases.forEach((c, index) => {
        harness!(c, `${id} case ${index} (${String(c.note ?? '')})`);
      });
    });
  }
});

/** Keeps `Verdict` imported for the type-level documentation above. */
export type FalsifierVerdict = Verdict;
