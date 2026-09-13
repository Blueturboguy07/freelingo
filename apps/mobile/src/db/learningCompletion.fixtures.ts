/** Deterministic declared source fixtures; no production pack/reviewer claim. */
import type { Db } from '@freelingo/schema';
import { contentHashItemId } from '../../../../packages/core/src/packs/items';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import { SqliteWordStore } from './SqliteWordStore';
const hash = 'a'.repeat(64);
export function fixtureLexemes(item: VerifiedRuntimeItem): VerifiedRuntimeItem {
  return {
    ...item,
    proof: { ...item.proof, sourceSha256: hash, approvalSha256: hash, draftSha256: hash },
    lexicalBindings: item.schedulerSurfaces
      .filter((s) => s.kind === 'lexeme')
      .map((s) => {
        const semantic = {
          prompt: s.itemRef,
          preferredSurface: s.surface,
          register: 'neutral',
          lexemes: [s.itemRef],
          grammarConcepts: [],
          graphemes: [],
        };
        return {
          schedulerItemId: s.itemId,
          surfaceId: s.surfaceId,
          surface: s.surface,
          language: s.language,
          lexemeId: s.itemRef,
          lemma: s.itemRef,
          pos: 'NOUN',
          wordItemId: contentHashItemId(semantic),
          semantic,
          countable: true,
          classification: 'word' as const,
          proof: {
            sourceId: item.proof.sourceId,
            sourceSha256: hash,
            declarationSha256: hash,
            bindingSha256: hash,
          },
        };
      }),
  };
}
/** Prior explicitly observed teaching fixtures, written through the real WordStore. */
export function observeFixtureLexemes(db: Db, item: VerifiedRuntimeItem, at: number): void {
  const words = new SqliteWordStore(db);
  db.run('INSERT OR IGNORE INTO course_item(course_id,item_id,countable) VALUES(?,?,0)', [
    'en-es',
    item.itemId,
  ]);
  for (const b of item.lexicalBindings) {
    db.run('INSERT OR IGNORE INTO course_item(course_id,item_id,countable) VALUES(?,?,?)', [
      'en-es',
      b.schedulerItemId,
      Number(b.schedulerItemId !== item.itemId && b.countable),
    ]);
    const intro: VerifiedRuntimeItem = {
      ...item,
      exerciseId: 'prior-intro:' + item.exerciseId + ':' + b.surfaceId,
      gradable: {
        itemId: item.itemId,
        family: 'typed-translate',
        accepted: [{ surfaceId: b.surfaceId, surface: b.surface, rank: 1 }],
      },
      presentation: {
        ...item.presentation,
        type: 'typedTranslate',
        prompt: b.surface,
        promptLanguage: b.language,
      },
      introductions: [
        { surfaceId: b.surfaceId, surface: b.surface, language: b.language, when: 'prompt' },
      ],
    };
    if (
      !db.get('SELECT 1 FROM course_surface_exposure WHERE course_id=? AND surface_id=?', [
        'en-es',
        b.surfaceId,
      ])
    )
      db.run('INSERT INTO course_surface_exposure VALUES(?,?,?,?,?,?,?,?,?,?)', [
        'en-es',
        b.surfaceId,
        b.surface,
        b.language,
        'prior-observed-session',
        'prior-slot',
        intro.exerciseId,
        hash,
        'prompt',
        at,
      ]);
    words.recordIntroduction({
      courseId: 'en-es',
      packContentHash: hash,
      item: intro,
      surfaceId: b.surfaceId,
    });
  }
}
