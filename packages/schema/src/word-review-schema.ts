/** v11 ordered permanent review evidence, 2026-09-13 (INV-ECO-13/27).
 * SQL preserves chronology and parent identity. The completion runtime alone validates
 * actual FSRS transitions and writes these rows after the permanent session receipt.
 * Negative replay exercise indices live in evidence, never in chronological ordinals. */
export const WORD_REVIEW_ACCOUNT_TABLES = ['account_word_review'] as const;
export const WORD_REVIEW_SCHEMA_V11_DDL: readonly string[] = [
  `CREATE TABLE account_word_review (
    word_item_id TEXT NOT NULL REFERENCES account_word(word_item_id),
    word_sequence INTEGER NOT NULL CHECK(typeof(word_sequence)='integer' AND word_sequence>=0),
    source_session_id TEXT NOT NULL REFERENCES committed_session(session_id),
    answer_ordinal INTEGER NOT NULL CHECK(typeof(answer_ordinal)='integer' AND answer_ordinal>=0),
    target_position INTEGER NOT NULL CHECK(typeof(target_position)='integer' AND target_position>=0),
    reviewed_at_utc_ms INTEGER NOT NULL CHECK(typeof(reviewed_at_utc_ms)='integer'),
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='object'),
    PRIMARY KEY(word_item_id,word_sequence),
    UNIQUE(source_session_id,answer_ordinal,target_position)
  )`,
  `CREATE TRIGGER account_word_review_immutable_update BEFORE UPDATE ON account_word_review BEGIN SELECT RAISE(ABORT,'account_word_review is immutable'); END`,
  `CREATE TRIGGER account_word_review_immutable_delete BEFORE DELETE ON account_word_review BEGIN SELECT RAISE(ABORT,'account_word_review is immutable'); END`,
];
