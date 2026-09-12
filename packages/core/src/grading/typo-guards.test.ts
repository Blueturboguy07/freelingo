/**
 * INV-GRD-02 and INV-GRD-15 — the three typo guards.
 *
 * > "The three typo guards (not a target-language word · not on the target lexeme ·
 * > ≥5 chars) are **named config constants**, and flipping any one of them changes the
 * > verdict on the two recorded failures (`caso`/`casa`, `gatto`/`gato`). A build where
 * > the guards are inlined fails this test." (INV-GRD-02)
 *
 * ## What "flipping any one changes the verdict" is asserted as
 *
 * The two recorded failures are both hard wrong under the shipped config, and each guard
 * refuses at least one of them ON ITS OWN. So the claim is checked from the all-off
 * baseline, where both are soft corrects: turning any single guard back on changes the
 * verdict on at least one recorded failure, and no guard is dead code. The full five-row
 * table is a golden in `__falsifiers__/INV-GRD-02.json`, because the interesting fact is
 * that guard 1 explains `caso` and NOT `gatto` — which is precisely why EC-GRD-05 is still
 * open and why the guards ship as config.
 *
 * ## What "a build where the guards are inlined fails this test" is asserted as
 *
 * Two independent gates, one mechanical and one behavioural:
 *
 *  - `typo-guards.ts` is the only file that reads a guard field, and its executable code
 *    holds no numeric literal — so a threshold cannot be written there;
 *  - the verdict MOVES when a pack changes a guard. An inlined build passes the first gate
 *    by accident and fails the second, and vice versa.
 *
 * ## The copy-string gate
 *
 * `config.ts`'s header promises the same discipline for the note, banner and re-prompt
 * strings: "Nothing in this package may inline one of these values." That is asserted here
 * rather than in `banner.test.ts` because it is the same gate over the same file set — the
 * executable code of every non-test source in this directory, comments stripped, must spell
 * none of them. A comment may quote a note (several do, and should); a string literal may
 * not. Without this, `TIER2_NOTE_POOL` is a list that documents the notes rather than the
 * list that produces them, and the six-note pool of INV-GRD-01 can quietly become seven.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';

import {
  ANOTHER_CORRECT_SOLUTION,
  BELOW_GATE_REPROMPT,
  CONSOLATION_COPY,
  CORRECT_HEADLINES,
  PROMPT_COPY_REPROMPT,
  REGISTER_HEADLINE,
  TIER2_NOTE_POOL,
  TYPO_GUARD_MIN_LENGTH_CHARACTERS,
  TYPO_GUARD_MIN_LENGTH_MORA,
  TYPO_GUARD_REJECT_EDIT_ON_TARGET_LEXEME,
  TYPO_GUARD_REJECT_REAL_TARGET_WORD,
  WRONG_HEADLINE,
  WRONG_WORD_HEADLINE,
} from './config.js';
import { gradeTypedAnswer, NO_SURFACES_INTRODUCED } from './grade.js';
import { applyTypoGuards, type TypoGuardName } from './typo-guards.js';
import { DE_PACK, DE_UNIT } from './packs/de.js';
import { ES_PACK, ES_UNIT } from './packs/es.js';
import { JA_PACK, JA_UNIT } from './packs/ja.js';
import type { GradableItem, GradingPack, GradingUnit, TypoGuards } from './types.js';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));
const GUARD_FILE = 'typo-guards.ts';

/** Strip comments so an edge-case id like `EC-GRD-26` is not read as a numeric literal. */
function executableCode(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
        out.push({ file: full.slice(SRC_DIR.length), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(SRC_DIR);
  return out;
}

/** The two recorded failures (`scope/09`, 2026-09-10, web guest EN→ES). */
const RECORDED_FAILURES = [
  { answer: 'caso', target: 'casa', editOffset: 3 },
  { answer: 'gatto', target: 'gato', editOffset: 3 },
] as const;

function guardOutcome(
  failure: (typeof RECORDED_FAILURES)[number],
  guards: TypoGuards,
): readonly TypoGuardName[] {
  return applyTypoGuards(
    {
      mistypedWord: failure.answer,
      targetWord: failure.target,
      targetReading: null,
      answerReading: null,
      editOffsetInTarget: failure.editOffset,
      targetString: failure.target,
      targetLexemeSurface: failure.target,
      targetLanguageWords: ES_PACK.targetLanguageWords,
    },
    guards,
  ).rejectedBy;
}

const ALL_OFF: TypoGuards = {
  ...ES_PACK.typoGuards,
  rejectRealTargetWord: false,
  rejectEditOnTargetLexeme: false,
  minimumLength: 0,
};

describe('the three typo guards', () => {
  it('[INV-GRD-02] the guards are NAMED constants, referenced by the packs', () => {
    expect(TYPO_GUARD_REJECT_REAL_TARGET_WORD).toBe(true);
    expect(TYPO_GUARD_REJECT_EDIT_ON_TARGET_LEXEME).toBe(true);
    expect(TYPO_GUARD_MIN_LENGTH_CHARACTERS).toBe(5);
    expect(TYPO_GUARD_MIN_LENGTH_MORA).toBe(4);
    const packs = sourceFiles().filter(({ file }) => file.startsWith('packs/'));
    for (const { file, text } of packs) {
      if (!/typoGuards/.test(text)) continue;
      expect(text, `${file} must name its guard constants`).toMatch(/TYPO_GUARD_/);
    }
  });

  it('[INV-GRD-02] a build with the guards inlined fails: no threshold lives outside the config', () => {
    const guardSource = sourceFiles().find(({ file }) => file === GUARD_FILE);
    expect(guardSource, 'typo-guards.ts must exist').toBeDefined();
    // No threshold literal, and no bare numeric comparison. `0` is the single exception
    // and it is not a threshold: it means "empty" (`lexeme.length === 0`, "no guard
    // refused"). The second assertion closes the loophole that exception would otherwise
    // open — `length >= 0` and friends are still a refusal to name a constant.
    const code = executableCode(guardSource!.text);
    const numerals = (code.match(/(?<![\w$])\d+(?![\w$])/g) ?? []).filter((n) => n !== '0');
    expect(numerals, 'a numeric literal in typo-guards.ts is an inlined guard').toEqual([]);
    expect(code, 'a numeric comparison in typo-guards.ts is an inlined guard').not.toMatch(
      /[<>]=?\s*\d/,
    );
    expect(guardSource!.text).toMatch(/guards\.rejectRealTargetWord/);
    expect(guardSource!.text).toMatch(/guards\.rejectEditOnTargetLexeme/);
    expect(guardSource!.text).toMatch(/guards\.minimumLength/);

    // And no other module reads a guard field, so there is nowhere else to inline one.
    const readers = sourceFiles().filter(
      ({ file, text }) =>
        file !== GUARD_FILE &&
        /\.(rejectRealTargetWord|rejectEditOnTargetLexeme|minimumLength)\b/.test(text),
    );
    expect(readers.map((r) => r.file)).toEqual([]);
  });

  it('[INV-GRD-01] no copy string lives outside the config: the note pool is the only pool', () => {
    // Built from the exported constants, so a string that is renamed in `config.ts` is
    // renamed here too and a constant that is deleted stops being scanned. `null` is
    // skipped: `capitalisation` is the silent class and has no note by design.
    const copy: string[] = [
      ...Object.values(TIER2_NOTE_POOL).filter((n): n is string => n !== null),
      ...CORRECT_HEADLINES,
      WRONG_HEADLINE,
      WRONG_WORD_HEADLINE,
      REGISTER_HEADLINE,
      CONSOLATION_COPY,
      ANOTHER_CORRECT_SOLUTION,
      PROMPT_COPY_REPROMPT,
      BELOW_GATE_REPROMPT,
    ];
    // The pool is six classes and five notes; `capitalisation` is silent (INV-GRD-01).
    expect(Object.keys(TIER2_NOTE_POOL)).toHaveLength(6);
    expect(Object.values(TIER2_NOTE_POOL).filter((n) => n !== null)).toHaveLength(5);

    const offenders: string[] = [];
    for (const { file, text } of sourceFiles()) {
      if (file === 'config.ts') continue;
      const code = executableCode(text);
      for (const string of copy) {
        if (code.includes(string)) offenders.push(`${file} inlines ${JSON.stringify(string)}`);
      }
    }
    expect(offenders, 'a copy string in executable code is an inlined note').toEqual([]);

    // And the gate is not vacuous: config.ts itself spells every one of them.
    const config = sourceFiles().find(({ file }) => file === 'config.ts');
    expect(config, 'config.ts must exist').toBeDefined();
    for (const string of copy) expect(executableCode(config!.text)).toContain(string);
  });

  it('[INV-GRD-02] the shipped config makes both recorded failures hard wrong', () => {
    for (const failure of RECORDED_FAILURES) {
      expect(guardOutcome(failure, ES_PACK.typoGuards).length, failure.answer).toBeGreaterThan(0);
    }
  });

  it('[INV-GRD-02] flipping any one guard changes the verdict on a recorded failure', () => {
    // From the all-off baseline both failures are forgiven.
    for (const failure of RECORDED_FAILURES) {
      expect(guardOutcome(failure, ALL_OFF), failure.answer).toEqual([]);
    }
    const flips: { name: TypoGuardName; guards: TypoGuards }[] = [
      { name: 'real-target-word', guards: { ...ALL_OFF, rejectRealTargetWord: true } },
      { name: 'edit-on-target-lexeme', guards: { ...ALL_OFF, rejectEditOnTargetLexeme: true } },
      {
        name: 'minimum-length',
        guards: { ...ALL_OFF, minimumLength: TYPO_GUARD_MIN_LENGTH_CHARACTERS },
      },
    ];
    for (const flip of flips) {
      const changed = RECORDED_FAILURES.filter(
        (failure) => guardOutcome(failure, flip.guards).length > 0,
      );
      expect(changed.length, `guard ${flip.name} is dead code`).toBeGreaterThan(0);
      for (const failure of changed) {
        expect(guardOutcome(failure, flip.guards)).toEqual([flip.name]);
      }
    }
  });

  it('[INV-GRD-02] the verdict follows the PACK, not the code: a changed guard moves it', () => {
    const item: GradableItem = {
      itemId: 'casa',
      family: 'typed-translate',
      targetLexemeId: 'casa',
      targetLexemeSurface: 'casa',
      accepted: [{ surface: 'casa', rank: 1, surfaceId: 's' }],
    };
    const strict = gradeTypedAnswer({
      pack: ES_PACK,
      unit: ES_UNIT,
      item,
      answer: 'caso',
      learner: NO_SURFACES_INTRODUCED,
    });
    const lenient = gradeTypedAnswer({
      pack: { ...ES_PACK, typoGuards: ALL_OFF },
      unit: ES_UNIT,
      item,
      answer: 'caso',
      learner: NO_SURFACES_INTRODUCED,
    });
    expect(strict.tier).toBe(3);
    expect(lenient.tier).toBe(2);
    expect(lenient.channel).toBe('typo');
  });

  // -------------------------------------------------------------------------
  // INV-GRD-15 — per-pack resolution and reachability
  // -------------------------------------------------------------------------

  /** A witness that `You have a typo.` can fire in this pack at all. */
  const REACHABILITY_WITNESSES: {
    pack: GradingPack;
    unit: GradingUnit;
    item: GradableItem;
    answer: string;
  }[] = [
    {
      pack: ES_PACK,
      unit: ES_UNIT,
      item: {
        itemId: 'es',
        family: 'typed-translate',
        targetLexemeId: 'carta',
        targetLexemeSurface: 'carta',
        accepted: [{ surface: 'ella escribe una carta', rank: 1, surfaceId: 's' }],
      },
      answer: 'ella escrribe una carta',
    },
    {
      pack: JA_PACK,
      unit: JA_UNIT,
      item: {
        itemId: 'ja',
        family: 'typed-translate',
        targetLexemeId: 'iku',
        targetLexemeSurface: 'いき',
        accepted: [{ surface: 'がっこうへいきます', rank: 1, surfaceId: 's' }],
      },
      answer: 'がつこうへいきます',
    },
    {
      pack: DE_PACK,
      unit: DE_UNIT,
      item: {
        itemId: 'de',
        family: 'typed-translate',
        targetLexemeId: 'maedchen',
        targetLexemeSurface: 'Mädchen',
        accepted: [{ surface: 'das Mädchen schreibt', rank: 1, surfaceId: 's' }],
      },
      answer: 'das Mädchen schrreibt',
    },
  ];

  it('[INV-GRD-15] every shipped pack can reach `You have a typo.` — a dead channel fails', () => {
    for (const witness of REACHABILITY_WITNESSES) {
      const verdict = gradeTypedAnswer({
        pack: witness.pack,
        unit: witness.unit,
        item: witness.item,
        answer: witness.answer,
        learner: NO_SURFACES_INTRODUCED,
      });
      expect(verdict.channel, `${witness.pack.label} cannot reach the typo channel`).toBe('typo');
      expect(verdict.note).toBe(TIER2_NOTE_POOL.typo);
    }
  });

  it('[INV-GRD-15] the guards resolve PER PACK: ja measures mora, es measures characters', () => {
    expect(ES_PACK.typoGuards.lengthUnit).toBe('characters');
    expect(JA_PACK.typoGuards.lengthUnit).toBe('mora');
    // EC-GRD-26: a five-CHARACTER guard is structurally dead in a Japanese pack, so the
    // ja pack must not be carrying the Latin number.
    expect(JA_PACK.typoGuards.minimumLength).toBe(TYPO_GUARD_MIN_LENGTH_MORA);
    expect(JA_PACK.typoGuards.minimumLength).toBeLessThan(TYPO_GUARD_MIN_LENGTH_CHARACTERS);
  });

  it('[INV-GRD-15] a length-losing ja edit is never forgiven, whatever the other guards say', () => {
    fc.assert(
      fc.property(fc.constantFrom('コヒー', 'がこう', 'がっこ'), (answer) => {
        const outcome = applyTypoGuards(
          {
            mistypedWord: answer,
            targetWord: answer === 'コヒー' ? 'コーヒー' : 'がっこう',
            targetReading: null,
            answerReading: null,
            editOffsetInTarget: 1,
            targetString: answer === 'コヒー' ? 'コーヒー' : 'がっこう',
            targetLexemeSurface: null,
            targetLanguageWords: new Set<string>(),
          },
          JA_PACK.typoGuards,
        );
        expect(outcome.forgiven, `${answer} lost a mora and was forgiven`).toBe(false);
        expect(outcome.rejectedBy).toContain('minimum-length');
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
