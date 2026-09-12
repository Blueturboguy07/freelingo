import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createNodeDb } from '@freelingo/testkit';
import type { Db } from './db.js';
import {
  CREDITS_SURFACE_SCREEN,
  PACK_META_KEYS,
  PACK_SCHEMA_DDL,
  PACK_SCHEMA_VERSION,
  PACK_TABLES_EMPTY_AT_V0,
  PACK_TABLE_NAMES,
  PRESENTATION_ITEM_FIELDS,
  SEMANTIC_ITEM_FIELDS,
  createPackSchema,
  describePackSchema,
  packSchemaViolations,
} from './pack-schema.js';

/**
 * The pack schema is the one declaration two codebases share: `tools/coursekit` writes
 * packs with it and `packages/core`'s loader reads them. So most of this file is about
 * **agreement** rather than behaviour — with the Python that parses this file, and with
 * the committed pack that was built from it.
 *
 * The loader's half of the agreement is asserted in
 * `packages/core/src/packs/loader.test.ts`, against the real fixture pack, because core
 * cannot import this package (schema depends on core, not the other way round).
 */

const FIXTURE = new URL('../../core/src/packs/__fixtures__/es-mini/', import.meta.url);

function emptyPack(): Db {
  const db = createNodeDb();
  createPackSchema(db);
  return db;
}

describe('the pack DDL', () => {
  it('creates every table scope2/00 §2.5 names, plus the Freelingo additions', () => {
    const tables = describePackSchema(emptyPack());
    expect([...tables.keys()].sort()).toEqual([...PACK_TABLE_NAMES].sort());
  });

  it('stamps the schema version a device checks before opening anything', () => {
    const version = emptyPack().get<{ user_version: number }>(`PRAGMA user_version`);
    expect(version?.user_version).toBe(PACK_SCHEMA_VERSION);
  });

  it('creates story, radio_episode and character_lesson so P6 and P7 are not migrations', () => {
    const db = emptyPack();
    for (const table of PACK_TABLES_EMPTY_AT_V0) {
      // The pack is read-only on a device: a table that first appeared in a later pack
      // version would be a schema migration on a file the app may not write to.
      expect(db.all(`SELECT * FROM "${table}"`)).toEqual([]);
    }
  });

  it('reports a pack that is missing a table rather than throwing on the first one', () => {
    const db = createNodeDb();
    for (const statement of PACK_SCHEMA_DDL) {
      if (statement.startsWith('CREATE TABLE story')) continue;
      db.run(statement);
    }
    expect(packSchemaViolations(db)).toEqual(['pack table story is missing']);
  });

  it('reports a table nobody declared', () => {
    const db = emptyPack();
    db.run(`CREATE TABLE leftovers (id TEXT)`);
    expect(packSchemaViolations(db)).toEqual(['pack carries an undeclared table leftovers']);
  });

  it('is empty of violations for a pack this module built', () => {
    expect(packSchemaViolations(emptyPack())).toEqual([]);
  });

  it('notices a column a reader requires going away', () => {
    const missing = { sentence: ['attribution_owner', 'invented_column'] };
    expect(packSchemaViolations(emptyPack(), { requiredColumns: missing })).toEqual([
      'pack table sentence has no column invented_column',
    ]);
  });
});

describe('the DDL format coursekit parses', () => {
  /**
   * `tools/coursekit/src/coursekit/packbuild/sqlite.py` reads this array out of this file
   * so there is exactly one copy of the schema. The parser's contract is narrow, so it is
   * asserted here, where it is easy to break: one string literal per statement, no
   * backtick inside one, no concatenation, and the `= [` the extractor anchors on.
   */
  it('is one statement per element, each a plain string with no backtick in it', () => {
    for (const statement of PACK_SCHEMA_DDL) {
      expect(statement).not.toContain('`');
      const head = statement.trim();
      expect(head.startsWith('CREATE') || head.startsWith('PRAGMA')).toBe(true);
    }
  });

  it('declares the arrays in the shape the Python extractor anchors on', () => {
    const source = readFileSync(new URL('./pack-schema.ts', import.meta.url), 'utf8');
    // The extractor scans from the `=`, not from the name: `readonly string[]` puts a
    // `[` before the array literal, and opening the scan there reads `string[]` as an
    // empty array — a zero-statement DDL, i.e. a pack with no tables, built in silence.
    expect(source).toContain('export const PACK_SCHEMA_DDL: readonly string[] = [');
    expect(source).toContain('export const SEMANTIC_ITEM_FIELDS = [');
    expect(source).toContain('export const PRESENTATION_ITEM_FIELDS = [');
  });
});

describe('attribution is a property of the database (INV-PACK-17)', () => {
  /**
   * The build gate is in coursekit and the reachability check is in the loader. This is
   * the line between them: the pack file itself refuses a row that requires attribution
   * and names no owner, so no future build script can ship one by routing around the
   * gate.
   */
  it('[INV-PACK-17] refuses a sentence that requires attribution and names no owner', () => {
    const db = emptyPack();
    const insert = (owner: string | null) =>
      db.run(
        `INSERT INTO sentence (sentence_id, lang, text, translation, provenance, source_id,
           licence, attribution_required, attribution_owner)
         VALUES ('s1', 'es', 'Hola.', 'Hi.', 'corpus', 'tatoeba', 'CC-BY-2.0-FR', 1, ?)`,
        [owner],
      );
    expect(() => insert(null)).toThrow();
    expect(() => insert('   ')).toThrow();
    expect(() => insert('Tatoeba contributors')).not.toThrow();
  });

  it('[INV-PACK-17] refuses a voice clip that requires attribution and names no owner', () => {
    const db = emptyPack();
    const insert = (owner: string | null) =>
      db.run(
        `INSERT INTO audio (audio_id, clip_hash, path, voice_id, engine, codec, bitrate_kbps,
           duration_ms, bytes, pipeline, licence, attribution_required, attribution_owner)
         VALUES ('a1', 'h', 'audio/h.opus', 'v', 'piper', 'opus', 20, 1000, 100, 'lesson',
           'CC-BY-SA-4.0', 1, ?)`,
        [owner],
      );
    // Review R7: Piper is GPL-3.0 code whose one Japanese voice is CC BY-NC-SA, so a
    // voice licence is never inherited from its engine and the owner is never implied.
    expect(() => insert(null)).toThrow();
    expect(() => insert('Voice author')).not.toThrow();
  });

  it('records the credits screen id even though the product map has no S152 row', () => {
    // `deep/00-PRODUCT-MAP.md` stops at S151. S152 exists only in the plan's §Data model
    // and in INV-PACK-17's own text; the map owes it a row before P4 renders it.
    expect(CREDITS_SURFACE_SCREEN).toBe('S152');
  });
});

describe('the item-hash field lists (INV-PACK-41)', () => {
  it('[INV-PACK-41] are EC-PACK-38’s two halves, and nothing has slipped between them', () => {
    expect([...SEMANTIC_ITEM_FIELDS]).toEqual([
      'prompt',
      'preferredSurface',
      'register',
      'lexemes',
      'grammarConcepts',
      'graphemes',
    ]);
    expect([...PRESENTATION_ITEM_FIELDS]).toEqual([
      'ruby',
      'audioHash',
      'strokePaths',
      'illustration',
      'acceptedAlternates',
      'distractors',
    ]);
    const semantic = new Set<string>(SEMANTIC_ITEM_FIELDS);
    expect(PRESENTATION_ITEM_FIELDS.filter((field) => semantic.has(field))).toEqual([]);
  });
});

describe('the committed es fixture is a pack this schema describes', () => {
  /**
   * Built by coursekit's G9 from `__fixtures__/es-mini/seed.json`, and opened here
   * read-only through `node:sqlite` rather than through `createNodeDb`, because the claim
   * is "the app can open the file that shipped" — not "the app can open a database we
   * just created from the same DDL".
   */
  const handle = new DatabaseSync(new URL('pack.sqlite', FIXTURE).pathname, { readOnly: true });
  const db: Db = {
    run() {
      throw new Error('a pack is read-only');
    },
    all: (sql, params = []) => handle.prepare(sql).all(...(params as never[])) as never,
    get: (sql, params = []) => handle.prepare(sql).get(...(params as never[])) as never,
    withExclusiveTransaction<T>(fn: () => T): T {
      return fn();
    },
    close: () => handle.close(),
  };

  it('has no schema violations and declares every meta key', () => {
    expect(packSchemaViolations(db, { checkMetaKeys: true })).toEqual([]);
  });

  it('carries every meta key the app reads without its manifest', () => {
    const keys = new Set(db.all<{ key: string }>(`SELECT key FROM meta`).map((row) => row.key));
    for (const key of PACK_META_KEYS) expect(keys.has(key)).toBe(true);
  });
});
