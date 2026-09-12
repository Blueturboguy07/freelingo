/**
 * The read-only content pack: one DDL, one item-id rule, for both sides of the fence.
 *
 * A pack is a **read-only** SQLite file plus a content-addressed Opus bank plus a signed
 * manifest. It is written by `tools/coursekit` (Python, stage G9) and read by
 * `packages/core/src/packs/loader.ts` (TypeScript, on the device). Those are two
 * codebases in two languages that must agree on every column name, so the DDL is written
 * **once, here**, and coursekit *reads this file* at build time
 * (`coursekit.packbuild.sqlite.read_ts_string_array`). A second copy in Python would
 * drift, and the way it would drift is the expensive way: a pack that builds green,
 * installs green, and returns no rows for one query on a device.
 *
 * Three things live in this module and nothing else does:
 *
 * 1. `PACK_SCHEMA_DDL` — the statements, in order, that create a v1 pack.
 * 2. `SEMANTIC_ITEM_FIELDS` / `PRESENTATION_ITEM_FIELDS` — which side of the item hash
 *    each field is on, which is what makes a rebuild non-destructive (INV-PACK-41). The
 *    hash itself is in `packages/core/src/packs/loader.ts`; the lists are here because
 *    they belong to the schema and because three consumers read them.
 * 3. `packSchemaViolations()` — the gate that reads a real pack back through PRAGMA and
 *    says whether it is one.
 *
 * Placement (scope2/00 §2.5, deep/05 F8): the pack lives in the **cache** directory,
 * never in the backed-up one, so it counts against neither Android Auto Backup's 25 MB
 * per-app cap nor the iCloud blob. The mutable progress DB (`progress-schema.ts`) lives
 * alone in `Paths.document`. Nothing in a pack is ever written to by the app; that is
 * what "read-only" means here, and the loader takes a reader interface with no `run()`
 * on it so the rule has somewhere to be true.
 *
 * Specs: scope2/00-FRAMEWORK-ANSWER §2.5, deep/10 §S9, plan §Data model + §Signing,
 * docs/invariants.md INV-PACK-17, INV-PACK-40, INV-PACK-41. Screens: S001, S002, S137,
 * S151 (and S152, the credits surface, which the product map still owes a row — see
 * `CREDITS_SURFACE_SCREEN`).
 */
import type { Db } from './db.js';

/**
 * `PRAGMA user_version` of a pack this build can open. A pack declaring anything else is
 * not readable by this app, which is a different fact from "corrupt" and from
 * "unverified" — the installer decides which.
 */
export const PACK_SCHEMA_VERSION = 1;

/**
 * The twelve tables of `scope2/00` §2.5 plus the three Freelingo additions, in creation
 * order. `story`, `radio_episode` and `character_lesson` are **created and left empty at
 * v0**: Stories and Radio are P6 and the Japanese characters stage is P7, and a table
 * that appears in a later pack version is a schema migration on a file the app may not
 * write to. Creating them now costs nothing and removes that problem entirely.
 */
export const PACK_TABLE_NAMES = [
  'meta',
  'audio',
  'lexeme',
  'grammar_concept',
  'sentence',
  'unit',
  'unit_item',
  'exercise',
  'exercise_item_tag',
  'story',
  'radio_episode',
  'character_lesson',
] as const;
export type PackTableName = (typeof PACK_TABLE_NAMES)[number];

/** Present in the schema, empty in a v0 pack. Asserted, so "later" cannot become "never". */
export const PACK_TABLES_EMPTY_AT_V0: readonly PackTableName[] = [
  'story',
  'radio_episode',
  'character_lesson',
];

/**
 * The DDL. Read by coursekit at build time; executed by nobody else.
 *
 * Every statement is a single backtick template literal containing no backtick of its
 * own, because that is the contract the Python extractor parses and
 * `pack-schema.test.ts` pins. Keep it that way: a clever multi-statement string or a
 * concatenation would build fine here and return an empty table list over there.
 *
 * Two conventions that are load-bearing rather than stylistic:
 *
 * - **Attribution is a CHECK, not a convention.** `sentence` and `audio` both refuse a
 *   row that requires attribution and names no owner. INV-PACK-17 is a build gate, and a
 *   gate that lives only in the builder is one `--force` away from shipping; the database
 *   itself is the place no writer can route around.
 * - **`item_id` is not a primary key.** Several exercise shapes can practise the same
 *   item, and the FSRS row belongs to the item. EC-PACK-38's failure mode is precisely
 *   one word carrying two scheduler items.
 */
export const PACK_SCHEMA_DDL: readonly string[] = [
  // `meta` is key/value so a pack can carry a fact the app does not know about yet
  // without a schema bump. The credits rows live here too, under the
  // `attribution:<source_id>` prefix (see `CREDITS_META_PREFIX`): a derived list — the
  // hermitdave-derived frequency ordering, share-alike — is not a sentence and not a
  // voice, and INV-PACK-17 covers all three.
  `CREATE TABLE meta (
     key TEXT PRIMARY KEY NOT NULL,
     value TEXT NOT NULL
   )`,
  // Content-addressed: `clip_hash` is the identity, `path` is where the bytes sit
  // relative to the pack root. A line edit re-renders one file and the rest of the bank
  // is untouched, which is also why `audio_id` may never enter an item hash.
  `CREATE TABLE audio (
     audio_id TEXT PRIMARY KEY NOT NULL,
     clip_hash TEXT NOT NULL,
     path TEXT NOT NULL,
     voice_id TEXT NOT NULL,
     engine TEXT NOT NULL,
     codec TEXT NOT NULL,
     bitrate_kbps INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL,
     bytes INTEGER NOT NULL,
     pipeline TEXT NOT NULL CHECK (pipeline IN ('lesson', 'story', 'radio')),
     licence TEXT NOT NULL,
     attribution_required INTEGER NOT NULL CHECK (attribution_required IN (0, 1)),
     attribution_owner TEXT,
     CHECK (
       attribution_required = 0
       OR (attribution_owner IS NOT NULL AND trim(attribution_owner) <> '')
     )
   )`,
  `CREATE TABLE lexeme (
     lexeme_id TEXT PRIMARY KEY NOT NULL,
     lemma TEXT NOT NULL,
     pos TEXT NOT NULL,
     rank INTEGER,
     frequency INTEGER,
     decile INTEGER,
     band TEXT NOT NULL,
     band_source TEXT NOT NULL CHECK (band_source IN ('cefrlex', 'frequency_decile')),
     band_source_licence TEXT,
     gloss TEXT
   )`,
  `CREATE TABLE grammar_concept (
     concept_id TEXT PRIMARY KEY NOT NULL,
     name TEXT NOT NULL,
     description TEXT NOT NULL,
     register_slot TEXT NOT NULL
   )`,
  // `provenance` is the learner-facing number on S001 and S137: what share of this pack
  // a machine wrote. The artefact contract calls the authored case `llm`; the pack calls
  // it `machine_authored`, because that is the string a credits screen can render and
  // the one the README honesty block uses.
  `CREATE TABLE sentence (
     sentence_id TEXT PRIMARY KEY NOT NULL,
     lang TEXT NOT NULL,
     text TEXT NOT NULL,
     translation TEXT NOT NULL,
     provenance TEXT NOT NULL CHECK (provenance IN ('corpus', 'machine_authored')),
     source_id TEXT NOT NULL,
     corpus TEXT,
     corpus_version TEXT,
     licence TEXT NOT NULL,
     attribution_required INTEGER NOT NULL CHECK (attribution_required IN (0, 1)),
     attribution_owner TEXT,
     audio_id TEXT REFERENCES audio(audio_id),
     CHECK (
       attribution_required = 0
       OR (attribution_owner IS NOT NULL AND trim(attribution_owner) <> '')
     )
   )`,
  `CREATE TABLE unit (
     unit_id TEXT PRIMARY KEY NOT NULL,
     section_index INTEGER NOT NULL,
     section_cefr TEXT NOT NULL,
     unit_index INTEGER NOT NULL,
     title TEXT NOT NULL,
     "function" TEXT NOT NULL,
     grammar_concept TEXT NOT NULL REFERENCES grammar_concept(concept_id),
     register_slot TEXT NOT NULL,
     level_count INTEGER NOT NULL
   )`,
  // The introduction schedule. V1 ("no lemma before its introduction unit") is checked
  // against this, so the order is stored rather than inferred from a row order nobody
  // promised.
  `CREATE TABLE unit_item (
     unit_id TEXT NOT NULL REFERENCES unit(unit_id),
     item_kind TEXT NOT NULL CHECK (item_kind IN ('lexeme', 'grammar_concept')),
     item_ref TEXT NOT NULL,
     introduction_order INTEGER NOT NULL,
     PRIMARY KEY (unit_id, item_kind, item_ref)
   )`,
  // Presentation columns (ruby_json, illustration_ref, audio_id, distractors_json,
  // accepted_answers_json, alignment_json) sit beside semantic ones on purpose: they are
  // the same row, and what keeps them out of `item_id` is the hash's projection
  // (`packItemId` in the loader), not a second table somebody would forget to join.
  `CREATE TABLE exercise (
     exercise_id TEXT PRIMARY KEY NOT NULL,
     item_id TEXT NOT NULL,
     unit_id TEXT NOT NULL REFERENCES unit(unit_id),
     lesson_index INTEGER NOT NULL,
     slot_index INTEGER NOT NULL,
     type TEXT NOT NULL,
     prompt TEXT NOT NULL,
     preferred_surface TEXT NOT NULL,
     register TEXT NOT NULL,
     accepted_answers_json TEXT NOT NULL,
     distractors_json TEXT NOT NULL DEFAULT '[]',
     alignment_json TEXT NOT NULL DEFAULT '[]',
     ruby_json TEXT,
     illustration_ref TEXT,
     audio_id TEXT REFERENCES audio(audio_id),
     source_sentence_id TEXT REFERENCES sentence(sentence_id)
   )`,
  // D1's join, and the whole hybrid model. A wrong tag here silently corrupts the memory
  // model — V4 is the validator that exists because of it.
  `CREATE TABLE exercise_item_tag (
     exercise_id TEXT NOT NULL REFERENCES exercise(exercise_id),
     item_kind TEXT NOT NULL CHECK (item_kind IN ('lexeme', 'grammar_concept', 'grapheme')),
     item_ref TEXT NOT NULL,
     is_new INTEGER NOT NULL DEFAULT 0 CHECK (is_new IN (0, 1)),
     PRIMARY KEY (exercise_id, item_kind, item_ref)
   )`,
  `CREATE TABLE story (
     story_id TEXT PRIMARY KEY NOT NULL,
     unit_id TEXT NOT NULL REFERENCES unit(unit_id),
     title TEXT NOT NULL,
     cover_ref TEXT,
     part_count INTEGER NOT NULL,
     lines_json TEXT NOT NULL
   )`,
  `CREATE TABLE radio_episode (
     episode_id TEXT PRIMARY KEY NOT NULL,
     title TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     audio_id TEXT REFERENCES audio(audio_id),
     transcript_json TEXT NOT NULL,
     anchors_json TEXT NOT NULL
   )`,
  `CREATE TABLE character_lesson (
     character_lesson_id TEXT PRIMARY KEY NOT NULL,
     script TEXT NOT NULL,
     grapheme TEXT NOT NULL,
     reading TEXT NOT NULL,
     stroke_source TEXT,
     stroke_paths_json TEXT,
     unit_id TEXT REFERENCES unit(unit_id),
     audio_id TEXT REFERENCES audio(audio_id)
   )`,
  `CREATE INDEX exercise_by_lesson ON exercise (unit_id, lesson_index, slot_index)`,
  `CREATE INDEX exercise_by_item ON exercise (item_id)`,
  `CREATE INDEX exercise_item_tag_by_item ON exercise_item_tag (item_kind, item_ref)`,
  `CREATE INDEX unit_item_by_order ON unit_item (unit_id, introduction_order)`,
  `CREATE INDEX sentence_by_owner ON sentence (attribution_required, attribution_owner)`,
  `PRAGMA user_version = 1`,
];

/* ======================================================== meta and credits keys */

/** The `meta` keys every pack declares. A missing one fails `packSchemaViolations`. */
export const PACK_META_KEYS = [
  'pack_id',
  'course_id',
  'lang',
  'major',
  'version',
  'schema_version',
  /**
   * INV-PACK-40 / EC-PACK-37: "token" means the language adapter's unit — a Mode-A
   * morpheme for `ja`, a lemma otherwise — declared **exactly once per pack** and read
   * by every consumer. It is in the manifest, and it is mirrored here so a pack that is
   * opened without its manifest still answers the question with the same string.
   */
  'ledger_unit',
  'provenance_corpus_pct',
  'provenance_machine_authored_pct',
  'defect_rate',
  'cefr_claim',
] as const;
export type PackMetaKey = (typeof PACK_META_KEYS)[number];

/**
 * Credits rows live in `meta` under this prefix, one per attributed source.
 *
 * A sentence carries its own owner and a voice carries its own owner, but a **derived
 * list** — the frequency ordering derived from hermitdave's CC BY-SA-4.0 data, which is
 * share-alike and reaches the learner as the order units are taught in — is neither. It
 * has no row of its own anywhere else, and INV-PACK-17 covers it explicitly.
 */
export const CREDITS_META_PREFIX = 'attribution:';

/**
 * The screen the credits render on.
 *
 * **This id is not in `deep/00-PRODUCT-MAP.md`.** The map stops at S151 and S152 appears
 * only in the plan (§Data model, "Per-sentence credits (S152, new)") and in
 * INV-PACK-17's own text. The map owes a row — states, copy slots, and the two routes in
 * (the report sheet S045 and About S137) — before P4 renders it. Recorded here rather
 * than in a comment on a pull request because this constant is what P4 will grep for.
 */
export const CREDITS_SURFACE_SCREEN = 'S152';

/* ============================================= item identity (INV-PACK-41) */

/**
 * The fields an item id is hashed over, and the fields it is deliberately blind to.
 *
 * EC-PACK-38 names both halves: hash over *"prompt, preferred surface,
 * lexeme/concept/grapheme tags and register only"*; ruby spans, audio hashes, stroke
 * paths, illustration refs, the accepted-alternate set and the distractor pool are
 * **outside** it.
 *
 * The cost of getting this wrong is not an incorrect id, it is a silently orphaned
 * learner: a monthly JmdictFurigana release re-solves one word's ruby, every id under it
 * changes, and twelve weeks of FSRS history stops resolving — the strength meter empties
 * and `NEW WORD` comes back on a word the learner knows.
 *
 * Both lists are read by coursekit out of this file, so the two implementations cannot
 * disagree about which side a field is on.
 */
export const SEMANTIC_ITEM_FIELDS = [
  'prompt',
  'preferredSurface',
  'register',
  'lexemes',
  'grammarConcepts',
  'graphemes',
] as const;

export const PRESENTATION_ITEM_FIELDS = [
  'ruby',
  'audioHash',
  'strokePaths',
  'illustration',
  'acceptedAlternates',
  'distractors',
] as const;

/**
 * The projection and the hash itself live in `packages/core/src/packs/loader.ts`, beside
 * `contentHashItemId`, because that is the code that ships and because the dependency
 * arrow points one way: schema depends on core, never the reverse, and core's public
 * entry point does not re-export `packs/`. What lives HERE is the two field lists, which
 * are data — `tools/coursekit` parses them out of this file, and
 * `packages/core/src/packs/loader.test.ts` fails if its own copy disagrees with this one.
 * Three consumers, one declaration.
 */

/* ================================================================== the gate */

/** One table's shape, as SQLite actually built it. */
export interface PackTableInfo {
  readonly name: string;
  readonly columns: readonly string[];
}

/** What a pack file actually contains, read back through PRAGMA. */
export function describePackSchema(db: Db): Map<string, PackTableInfo> {
  const names = db
    .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_'));

  const out = new Map<string, PackTableInfo>();
  for (const name of names) {
    // PRAGMA takes no bound parameters; `name` comes from sqlite_master, never a user.
    const columns = db
      .all<{ name: string }>(`PRAGMA table_info("${name.replaceAll('"', '""')}")`)
      .map((row) => row.name);
    out.set(name, { name, columns });
  }
  return out;
}

/** Create an empty pack in `db`. The only writer of this DDL on the TypeScript side. */
export function createPackSchema(db: Db): void {
  for (const statement of PACK_SCHEMA_DDL) db.run(statement);
}

export interface PackSchemaCheck {
  /** Columns a reader requires, per table. The loader declares its own; see its docs. */
  readonly requiredColumns?: Readonly<Record<string, readonly string[]>>;
  /** Skip the meta-key check for a schema-only database with no rows yet. */
  readonly checkMetaKeys?: boolean;
}

/**
 * Returns one string per violation; an empty array is a readable pack.
 *
 * Deliberately a list rather than a throw: a pack that is wrong in four ways should say
 * so once, in CI, not four times over four builds.
 */
export function packSchemaViolations(db: Db, options: PackSchemaCheck = {}): string[] {
  const actual = describePackSchema(db);
  const violations: string[] = [];

  for (const table of PACK_TABLE_NAMES) {
    if (!actual.has(table)) violations.push(`pack table ${table} is missing`);
  }
  for (const name of actual.keys()) {
    if (!(PACK_TABLE_NAMES as readonly string[]).includes(name)) {
      violations.push(`pack carries an undeclared table ${name}`);
    }
  }

  const version = db.get<{ user_version: number }>(`PRAGMA user_version`);
  if (version?.user_version !== PACK_SCHEMA_VERSION) {
    violations.push(
      `pack user_version is ${String(version?.user_version)}, not ${PACK_SCHEMA_VERSION}`,
    );
  }

  for (const [table, columns] of Object.entries(options.requiredColumns ?? {})) {
    const info = actual.get(table);
    if (info === undefined) continue; // already reported as missing
    for (const column of columns) {
      if (!info.columns.includes(column)) {
        violations.push(`pack table ${table} has no column ${column}`);
      }
    }
  }

  if (options.checkMetaKeys === true && actual.has('meta')) {
    const present = new Set(db.all<{ key: string }>(`SELECT key FROM meta`).map((row) => row.key));
    for (const key of PACK_META_KEYS) {
      if (!present.has(key)) violations.push(`pack meta has no ${key} row`);
    }
  }

  return violations.sort();
}
