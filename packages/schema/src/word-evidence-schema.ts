/** v10 permanent lexical evidence, 2026-09-13 (INV-ECO-13/27).
 * The runtime verifies authored semantic hashes, actual display receipts and two-review
 * retirement evidence. SQL keeps accepted evidence immutable and independent of course
 * deletion. No legacy scalar total is converted into invented lexical identities. */
export const WORD_EVIDENCE_ACCOUNT_TABLES = [
  'account_word_state',
  'account_word',
  'account_word_learning',
] as const;
const object = (name: string) =>
  `${name} TEXT NOT NULL CHECK(json_valid(${name}) AND json_type(${name})='object')`;
const integer = (name: string) => `${name} INTEGER NOT NULL CHECK(typeof(${name})='integer')`;
function immutable(table: string): string[] {
  return [
    `CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} is immutable'); END`,
    `CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} is immutable'); END`,
  ];
}
export const WORD_EVIDENCE_SCHEMA_V10_DDL: readonly string[] = [
  `CREATE TABLE account_word_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    ${integer('initialized_at_utc_ms')}
  )`,
  ...immutable('account_word_state'),
  `CREATE TABLE account_word (
    word_item_id TEXT PRIMARY KEY NOT NULL CHECK(length(word_item_id)=18 AND substr(word_item_id,1,2)='i_' AND substr(word_item_id,3) NOT GLOB '*[^0-9a-f]*'),
    ${object('semantic_json')},
    countable INTEGER NOT NULL CHECK(countable IN (0,1)),
    ${integer('introduced_at_utc_ms')},
    ${object('introduction_evidence_json')},
    history_id INTEGER NOT NULL DEFAULT 1 CHECK(history_id=1) REFERENCES account_word_state(id)
  )`,
  ...immutable('account_word'),
  `CREATE TABLE account_word_learning (
    word_item_id TEXT PRIMARY KEY NOT NULL REFERENCES account_word(word_item_id),
    ${integer('learned_at_utc_ms')},
    source_session_id TEXT NOT NULL REFERENCES committed_session(session_id),
    ${object('evidence_json')}
  )`,
  ...immutable('account_word_learning'),
];
