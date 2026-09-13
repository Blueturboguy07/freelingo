/** v12 durable mistake retention, 2026-09-13. Original legacy rows remain untouched.
 * These are graded-answer receipts, not FSRS transitions or word-retirement awards. */
export const MISTAKE_STATE_COURSE_TABLES = [
  'course_mistake_state',
  'course_mistake_encounter',
] as const;
const text = (name: string) => `${name} TEXT NOT NULL CHECK(length(trim(${name}))>0)`;
const integer = (name: string, min = 0) =>
  `${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name}>=${min})`;
const stamp = (name: string) =>
  `${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name} BETWEEN -8640000000000000 AND 8640000000000000)`;
const origin = `SELECT 1 FROM course_attempt p JOIN course_attempt_target t
 ON t.course_id=p.course_id AND t.session_id=p.session_id AND t.exercise_index=p.exercise_index
 WHERE p.course_id=NEW.course_id AND p.session_id=NEW.created_in_session_id
 AND p.exercise_index=NEW.created_exercise_index AND p.exercise_id=NEW.source_exercise_id
 AND p.pack_content_hash=NEW.pack_content_hash AND p.skipped=0 AND p.verdict='wrong'
 AND t.target_item_id=NEW.item_id AND t.grade=1`;
export const MISTAKE_STATE_SCHEMA_V12_DDL: readonly string[] = [
  `CREATE TABLE course_mistake_encounter (
 course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
 ${text('item_id')},${integer('sequence')},${text('session_id')},
 exercise_index INTEGER NOT NULL CHECK(typeof(exercise_index)='integer'),
 ${text('target_surface_id')},${text('exercise_id')},
 pack_content_hash TEXT NOT NULL CHECK(length(pack_content_hash)=64 AND pack_content_hash NOT GLOB '*[^0-9a-f]*'),
 ${text('concept_id')},correct INTEGER NOT NULL CHECK(correct IN (0,1)),
 creates_mistake INTEGER NOT NULL CHECK(creates_mistake IN (0,1) AND (creates_mistake=0 OR correct=0)),
 ${stamp('answered_at_utc_ms')},local_day TEXT NOT NULL CHECK(local_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 PRIMARY KEY(course_id,item_id,sequence),UNIQUE(course_id,item_id,session_id,exercise_index),
 FOREIGN KEY(session_id,exercise_index,item_id,target_surface_id)
 REFERENCES course_attempt_target(session_id,exercise_index,target_item_id,target_surface_id) ON DELETE CASCADE
)`,
  `CREATE TRIGGER course_mistake_encounter_source BEFORE INSERT ON course_mistake_encounter
 WHEN NOT EXISTS(SELECT 1 FROM course_attempt p JOIN course_attempt_target t
 ON t.course_id=p.course_id AND t.session_id=p.session_id AND t.exercise_index=p.exercise_index
 WHERE p.course_id=NEW.course_id AND p.session_id=NEW.session_id AND p.exercise_index=NEW.exercise_index
 AND p.exercise_id=NEW.exercise_id AND p.pack_content_hash=NEW.pack_content_hash AND p.skipped=0
 AND p.verdict IN ('correct','softCorrect','accepted','wrong') AND (NEW.creates_mistake=0 OR p.verdict='wrong')
 AND t.target_item_id=NEW.item_id AND t.target_surface_id=NEW.target_surface_id
 AND t.answered_at_utc_ms=NEW.answered_at_utc_ms AND ((t.grade=1 AND NEW.correct=0) OR (t.grade>1 AND NEW.correct=1)))
 BEGIN SELECT RAISE(ABORT,'mistake encounter has no actual graded target'); END`,
  `CREATE TRIGGER course_mistake_encounter_order BEFORE INSERT ON course_mistake_encounter
 WHEN NEW.sequence<>(SELECT COALESCE(MAX(sequence),-1)+1 FROM course_mistake_encounter WHERE course_id=NEW.course_id AND item_id=NEW.item_id)
 OR (NEW.sequence=0 AND NEW.creates_mistake<>1)
 BEGIN SELECT RAISE(ABORT,'mistake encounter sequence changed'); END`,
  `CREATE TRIGGER course_mistake_encounter_immutable_update BEFORE UPDATE ON course_mistake_encounter BEGIN SELECT RAISE(ABORT,'mistake encounter is immutable'); END`,
  `CREATE TRIGGER course_mistake_encounter_immutable_delete BEFORE DELETE ON course_mistake_encounter WHEN EXISTS(SELECT 1 FROM course_progress WHERE course_id=OLD.course_id) BEGIN SELECT RAISE(ABORT,'mistake encounter is immutable'); END`,
  `CREATE TABLE course_mistake_state (
 course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
 ${text('item_id')},${text('concept_id')},${text('created_in_session_id')},
 created_exercise_index INTEGER NOT NULL CHECK(typeof(created_exercise_index)='integer'),
 ${text('source_exercise_id')},pack_content_hash TEXT NOT NULL CHECK(length(pack_content_hash)=64 AND pack_content_hash NOT GLOB '*[^0-9a-f]*'),
 review_streak INTEGER NOT NULL CHECK(typeof(review_streak)='integer' AND review_streak BETWEEN 0 AND 2),
 ${integer('misses', 1)},${stamp('last_missed_at_utc_ms')},
 last_missed_local_day TEXT NOT NULL CHECK(last_missed_local_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 retired_at_utc_ms INTEGER CHECK(retired_at_utc_ms IS NULL OR (typeof(retired_at_utc_ms)='integer' AND retired_at_utc_ms BETWEEN -8640000000000000 AND 8640000000000000)),
 ${integer('last_sequence')},PRIMARY KEY(course_id,item_id),
 CHECK((review_streak<2 AND retired_at_utc_ms IS NULL) OR (review_streak=2 AND retired_at_utc_ms IS NOT NULL)),
 FOREIGN KEY(course_id,created_in_session_id,created_exercise_index) REFERENCES course_attempt(course_id,session_id,exercise_index) ON DELETE CASCADE,
 FOREIGN KEY(course_id,item_id,last_sequence) REFERENCES course_mistake_encounter(course_id,item_id,sequence) ON DELETE CASCADE
)`,
  ...(['INSERT', 'UPDATE'] as const).map(
    (operation) =>
      `CREATE TRIGGER course_mistake_state_origin_${operation.toLowerCase()} BEFORE ${operation} ON course_mistake_state WHEN NOT EXISTS(${origin}) BEGIN SELECT RAISE(ABORT,'mistake origin has no actual wrong target'); END`,
  ),
];
