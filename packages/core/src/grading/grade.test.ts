/**
 * The three-tier checker end to end: INV-GRD-03, 04, 05, 13, 14, 17, 20, 27.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';

import { attemptRowFor, correctFirstTry } from './attempt.js';
import { accuracyOf, isPerfectLesson } from './accuracy.js';
import { WRONG_WORD_HEADLINE } from './config.js';
import { gradeMultiGap, gradeTypedAnswer, NO_SURFACES_INTRODUCED, wrongHeadline } from './grade.js';
import { tier1Normalise } from './normalise.js';
import { DE_PACK, DE_UNIT } from './packs/de.js';
import { ES_PACK, ES_UNIT } from './packs/es.js';
import { JA_PACK, JA_UNIT } from './packs/ja.js';
import { GRADING_FIXTURE_PACKS } from './packs/index.js';
import { arbAnyText, arbNearMiss } from './testing/arbitraries.js';
import type { AttemptRow, GradableItem } from './types.js';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

function sources(): { file: string; text: string }[] {
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

/** Strip comments, so a doc comment that names a path is not read as an import. */
function executableCodeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const NEKO: GradableItem = {
  itemId: 'neko',
  family: 'typed-translate',
  targetLexemeId: 'neko',
  accepted: [
    { surface: 'ねこ', rank: 1, surfaceId: 'kana' },
    { surface: '猫', rank: 2, surfaceId: 'kanji' },
  ],
};

const ES_ITEM: GradableItem = {
  itemId: 'es-1',
  family: 'typed-translate',
  targetLexemeId: 'gato',
  targetLexemeSurface: 'gato',
  accepted: [{ surface: 'el gato', rank: 1, surfaceId: 's1' }],
};

describe('the three-tier checker', () => {
  // -------------------------------------------------------------------------
  // INV-GRD-03 — authored alternates, never generated
  // -------------------------------------------------------------------------

  it('[INV-GRD-03] nothing in the package generates an alternate at runtime', () => {
    const forbidden =
      /generateAlternat|deriveAlternat|expandAlternat|synthesiseAlternat|inflectSurface/i;
    const offenders = sources().filter(({ text }) => forbidden.test(text));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("[INV-GRD-03] the fixture packs are not on the engine's public surface", () => {
    // `packs/index.ts`: "These are FIXTURES, not content." A barrel export would ship the
    // es/ja/de word lists in the app bundle and — the part that matters — make them
    // importable, which is how a fixture becomes what an app reads when the real pack is
    // late. Test support is imported by relative path, the way `testing/arbitraries.ts` is.
    const barrel = sources().find(({ file }) => file === 'index.ts');
    expect(barrel, 'grading/index.ts must exist').toBeDefined();
    expect(executableCodeOf(barrel!.text)).not.toMatch(/\.\/packs\//);
    expect(executableCodeOf(barrel!.text)).not.toMatch(/\.\/testing\//);

    // Every OTHER module in this directory is exported, so the barrel cannot rot the other
    // way either: a module nobody re-exports is a module nobody outside can reach.
    const modules = sources()
      .filter(({ file }) => !file.includes('/') && file !== 'index.ts')
      .map(({ file }) => file.replace(/\.ts$/, ''));
    for (const name of modules) {
      expect(barrel!.text, `grading/index.ts must export ${name}`).toContain(`'./${name}.js'`);
    }
  });

  it('[INV-GRD-03] tier 1 accepts EXACTLY the authored set, modulo tier-1 normalisation', () => {
    for (const { pack, unit } of GRADING_FIXTURE_PACKS) {
      fc.assert(
        fc.property(arbAnyText(), (answer) => {
          const item: GradableItem = {
            ...ES_ITEM,
            accepted: [
              { surface: 'el gato', rank: 1, surfaceId: 's1' },
              { surface: 'ねこ', rank: 1, surfaceId: 's2' },
            ],
          };
          const verdict = gradeTypedAnswer({
            pack,
            unit,
            item,
            answer,
            learner: NO_SURFACES_INTRODUCED,
          });
          if (verdict.tier !== 1) return;
          const normalised = tier1Normalise(answer, pack);
          const authored = item.accepted.map((f) => tier1Normalise(f.surface, pack));
          expect(authored, `${pack.label} accepted "${answer}" at tier 1`).toContain(normalised);
        }),
        { numRuns: PROPERTY_RUNS },
      );
    }
  });

  // -------------------------------------------------------------------------
  // INV-GRD-27 — the alternate note fires IFF a higher-ranked introduced surface exists
  // -------------------------------------------------------------------------

  it('[INV-GRD-27] the alternate note fires iff an introduced surface outranks the match', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ねこ', '猫'),
        fc.subarray(['kana', 'kanji']),
        (answer, introduced) => {
          const verdict = gradeTypedAnswer({
            pack: JA_PACK,
            unit: JA_UNIT,
            item: NEKO,
            answer,
            learner: { introducedSurfaceIds: new Set(introduced) },
          });
          const matched = NEKO.accepted.find((f) => f.surfaceId === verdict.matchedSurfaceId);
          const shouldFire =
            matched !== undefined &&
            NEKO.accepted.some((f) => f.rank > matched.rank && introduced.includes(f.surfaceId));
          expect(verdict.alternateSolution !== null).toBe(shouldFire);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-27] a Section-1 kana answer never displays a kanji the learner has not been taught', () => {
    const verdict = gradeTypedAnswer({
      pack: JA_PACK,
      unit: JA_UNIT,
      item: NEKO,
      answer: 'ねこ',
      learner: { introducedSurfaceIds: new Set(['kana']) },
    });
    expect(verdict.alternateSolution).toBeNull();
  });

  // -------------------------------------------------------------------------
  // INV-GRD-04 — two independent flags
  // -------------------------------------------------------------------------

  it('[INV-GRD-04] soft_corrected and wrong are independent, and never both true', () => {
    for (const { pack, unit } of GRADING_FIXTURE_PACKS) {
      fc.assert(
        fc.property(arbNearMiss(pack), ({ target, answer }) => {
          const item: GradableItem = {
            ...ES_ITEM,
            accepted: [{ surface: target, rank: 1, surfaceId: 's1' }],
          };
          const verdict = gradeTypedAnswer({
            pack,
            unit,
            item,
            answer,
            learner: NO_SURFACES_INTRODUCED,
          });
          expect(verdict.softCorrected && verdict.wrong).toBe(false);
          expect(verdict.softCorrected).toBe(verdict.tier === 2);
          // A soft correct never creates a mistake row, and never costs a heart.
          if (verdict.softCorrected) {
            expect(verdict.mistakeLexemeIds).toEqual([]);
            expect(verdict.heartCost).toBe(0);
            expect(verdict.comboReset).toBe(false);
          }
          const row = attemptRowFor(item, verdict);
          if (row !== null) expect(correctFirstTry(row)).toBe(!verdict.wrong);
        }),
        { numRuns: PROPERTY_RUNS },
      );
    }
  });

  it('[INV-GRD-04] Perfect lesson! fires iff no attempt is wrong — soft corrects do not block it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('el gato', 'El gato', 'perro', 'el ga to'), {
          minLength: 1,
          maxLength: 8,
        }),
        (answers) => {
          const rows: AttemptRow[] = [];
          answers.forEach((answer, index) => {
            const item: GradableItem = { ...ES_ITEM, itemId: `i${index}` };
            const verdict = gradeTypedAnswer({
              pack: ES_PACK,
              unit: ES_UNIT,
              item,
              answer,
              learner: NO_SURFACES_INTRODUCED,
            });
            const row = attemptRowFor(item, verdict);
            if (row !== null) rows.push(row);
          });
          const anyHardWrong = answers.includes('perro');
          expect(isPerfectLesson(rows)).toBe(!anyHardWrong);
          const summary = accuracyOf(rows);
          expect(summary.correctFirstTry).toBe(rows.filter((r) => !r.wrong).length);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // INV-GRD-05 — multi-gap, all or nothing
  // -------------------------------------------------------------------------

  it('[INV-GRD-05] a multi-gap item is correct iff every gap is, and costs at most one heart', () => {
    const item: GradableItem = {
      itemId: 'gaps',
      family: 'gap-fill',
      targetLexemeId: 'gato',
      targetLexemeSurface: 'gato',
      accepted: [],
      gaps: [
        { gapId: 'g1', accepted: [{ surface: 'el', rank: 1, surfaceId: 'a' }] },
        { gapId: 'g2', accepted: [{ surface: 'gato', rank: 1, surfaceId: 'b' }] },
        { gapId: 'g3', accepted: [{ surface: 'come', rank: 1, surfaceId: 'c' }] },
      ],
    };
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('el', 'gato', 'come', 'El', 'zzz'), {
          minLength: 3,
          maxLength: 3,
        }),
        (answers) => {
          const { verdict, perGap } = gradeMultiGap({
            pack: ES_PACK,
            unit: ES_UNIT,
            item,
            answers,
            learner: NO_SURFACES_INTRODUCED,
          });
          expect(verdict.wrong).toBe(perGap.some((g) => g.wrong));
          expect(verdict.heartCost).toBeLessThanOrEqual(1);
          expect(verdict.mistakeLexemeIds.length).toBeLessThanOrEqual(1);
          // No partial credit anywhere: two right gaps and one wrong is exactly as wrong
          // as three wrong ones.
          if (verdict.wrong) expect(verdict.tier).toBe(3);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // INV-GRD-13 — orthographic equivalences come from the ACTIVE pack
  // -------------------------------------------------------------------------

  it("[INV-GRD-13] the equivalence table is the active pack's, and es has none", () => {
    // No module-level map: the only way a fold can happen is through a pack argument.
    const offenders = sources().filter(
      ({ file, text }) =>
        !file.startsWith('packs/') &&
        /(ORTHOGRAPHIC_EQUIVALENCES|EQUIVALENCE_MAP|const\s+\w*[Ee]quivalences\s*[:=]\s*[[{])/.test(
          text,
        ),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
    expect(ES_PACK.orthographicEquivalences).toEqual([]);
    expect(DE_PACK.orthographicEquivalences.length).toBeGreaterThan(0);
  });

  it('[INV-GRD-13] heisst passes for de while ano fails against año for es', () => {
    const de = gradeTypedAnswer({
      pack: DE_PACK,
      unit: DE_UNIT,
      item: {
        itemId: 'de',
        family: 'typed-translate',
        accepted: [{ surface: 'heißt', rank: 1, surfaceId: 's' }],
      },
      answer: 'heisst',
      learner: NO_SURFACES_INTRODUCED,
    });
    expect(de.tier).toBe(1);
    expect(de.note).toBeNull();

    const es = gradeTypedAnswer({
      pack: ES_PACK,
      unit: ES_UNIT,
      item: {
        itemId: 'es',
        family: 'typed-translate',
        targetLexemeId: 'ano',
        accepted: [{ surface: 'año', rank: 1, surfaceId: 's' }],
      },
      answer: 'ano',
      learner: NO_SURFACES_INTRODUCED,
    });
    expect(es.tier).toBe(3);
  });

  it('[INV-GRD-13] the de table never leaks into es: the same answer grades differently', () => {
    fc.assert(
      fc.property(fc.constantFrom('heisst', 'Maedchen', 'ano'), (answer) => {
        const item: GradableItem = {
          itemId: 'x',
          family: 'typed-translate',
          accepted: [
            { surface: 'heißt', rank: 1, surfaceId: 'a' },
            { surface: 'Mädchen', rank: 1, surfaceId: 'b' },
            { surface: 'año', rank: 1, surfaceId: 'c' },
          ],
        };
        const withDe = gradeTypedAnswer({
          pack: DE_PACK,
          unit: DE_UNIT,
          item,
          answer,
          learner: NO_SURFACES_INTRODUCED,
        });
        const withEs = gradeTypedAnswer({
          pack: ES_PACK,
          unit: ES_UNIT,
          item,
          answer,
          learner: NO_SURFACES_INTRODUCED,
        });
        if (answer === 'ano') expect(withEs.tier).toBe(3);
        else {
          expect(withDe.tier).toBe(1);
          expect(withEs.tier).not.toBe(1);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // INV-GRD-14 — zero target-script characters
  // -------------------------------------------------------------------------

  it('[INV-GRD-14] an answer with no target script writes nothing and offers the word bank', () => {
    fc.assert(
      fc.property(
        fc
          .string({ maxLength: 16 })
          .filter((s) => !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(s)),
        (answer) => {
          const verdict = gradeTypedAnswer({
            pack: JA_PACK,
            unit: JA_UNIT,
            item: NEKO,
            answer,
            learner: NO_SURFACES_INTRODUCED,
          });
          expect(verdict.tier).toBe(0);
          expect(verdict.verdictClass).toBe('no-verdict');
          expect(verdict.writesAttemptRow).toBe(false);
          expect(verdict.heartCost).toBe(0);
          expect(verdict.comboReset).toBe(false);
          expect(verdict.mistakeLexemeIds).toEqual([]);
          expect(verdict.escape).toBe('word-bank');
          expect(attemptRowFor(NEKO, verdict)).toBeNull();
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // INV-GRD-17 — reading matches, surface does not
  // -------------------------------------------------------------------------

  it('[INV-GRD-17] a homophone is tier 2 on EVERY occurrence, with no stateful escalation', () => {
    const item: GradableItem = {
      itemId: 'kaeru',
      family: 'typed-translate',
      targetLexemeId: 'kaeru',
      readingSurfaceNote: '正しい漢字は「帰る」です。',
      accepted: [
        { surface: '帰る', rank: 2, surfaceId: 'kanji' },
        { surface: 'かえる', rank: 1, surfaceId: 'kana' },
      ],
    };
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (repeats) => {
        const verdicts = Array.from({ length: repeats }, () =>
          gradeTypedAnswer({
            pack: JA_PACK,
            unit: JA_UNIT,
            item,
            answer: '変える',
            learner: NO_SURFACES_INTRODUCED,
          }),
        );
        for (const verdict of verdicts) {
          expect(verdict.tier).toBe(2);
          expect(verdict.channel).toBe('reading-surface');
          expect(verdict.note).toBe(item.readingSurfaceNote);
          expect(verdict.wrong).toBe(false);
          expect(verdict.heartCost).toBe(0);
          expect(verdict.mistakeLexemeIds).toEqual([]);
        }
        expect(new Set(verdicts.map((v) => JSON.stringify(v))).size).toBe(1);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // INV-GRD-20 — the register class
  // -------------------------------------------------------------------------

  it('[INV-GRD-20] a register mismatch never renders the wrong-word headline', () => {
    const item: GradableItem = {
      itemId: 'reg',
      family: 'typed-translate',
      targetLexemeId: 'taberu',
      accepted: [{ surface: 'すしを食べます', rank: 1, surfaceId: 's' }],
    };
    const verdict = gradeTypedAnswer({
      pack: JA_PACK,
      unit: JA_UNIT,
      item,
      answer: 'すしを食べる',
      learner: NO_SURFACES_INTRODUCED,
    });
    expect(verdict.verdictClass).toBe('register');
    expect(verdict.wrong).toBe(true);
    expect(verdict.heartCost).toBe(1);
    expect(wrongHeadline('すしを食べる', 'すしを食べます', JA_PACK)).not.toBe(WRONG_WORD_HEADLINE);
  });

  it('[INV-GRD-20] the register class needs a unit that declares one: no unit, no class', () => {
    const item: GradableItem = {
      itemId: 'reg',
      family: 'typed-translate',
      targetLexemeId: 'taberu',
      accepted: [{ surface: 'すしを食べます', rank: 1, surfaceId: 's' }],
    };
    const verdict = gradeTypedAnswer({
      pack: JA_PACK,
      unit: { ...JA_UNIT, register: null },
      item,
      answer: 'すしを食べる',
      learner: NO_SURFACES_INTRODUCED,
    });
    expect(verdict.verdictClass).toBe('wrong');
  });
});
