/** v8 observed teaching and per-answer FSRS targets, 2026-09-13. An exposure is
 * independent of a scheduler item; MATCH has one accuracy answer and several targets. */
export const LEARNING_EVIDENCE_COURSE_TABLES = [
  'course_surface_exposure',
  'course_session_answer_target',
  'course_attempt_target',
] as const;
const text = (name: string) => `${name} TEXT NOT NULL CHECK(length(trim(${name}))>0)`;
const role = "'recognition','production'";
const reviewKinds = "'introduction','scheduled','early','rubyAssisted','uncredited'";
function immutable(table: string, staged = false): string[] {
  return [
    `CREATE TRIGGER ${table}_append_only_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} is append-only'); END`,
    `CREATE TRIGGER ${table}_append_only_delete BEFORE DELETE ON ${table} WHEN EXISTS(SELECT 1 FROM course_progress WHERE course_id=OLD.course_id) ${staged ? 'AND EXISTS(SELECT 1 FROM course_session_answer_receipt WHERE session_id=OLD.session_id AND exercise_index=OLD.exercise_index)' : ''} BEGIN SELECT RAISE(ABORT,'${table} is append-only'); END`,
  ];
}
const targets = (table: string, parent: string, committed: boolean) => `CREATE TABLE ${table} (
 course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
 ${text('session_id')},exercise_index INTEGER NOT NULL CHECK(typeof(exercise_index)='integer'),
 ${text('target_item_id')},${text('target_surface_id')},${text('target_surface')},
 encounter_role TEXT NOT NULL CHECK(encounter_role IN (${role})),
 ruby_shown INTEGER NOT NULL CHECK(ruby_shown IN (0,1)),
 grade INTEGER NOT NULL CHECK(grade IN (1,2,3,4)),
 position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),
 ${committed ? `review_kind TEXT NOT NULL CHECK(review_kind IN (${reviewKinds})),answered_at_utc_ms INTEGER NOT NULL CHECK(typeof(answered_at_utc_ms)='integer'),` : ''}
 PRIMARY KEY(session_id,exercise_index,target_item_id,target_surface_id),
 UNIQUE(session_id,exercise_index,position),
 FOREIGN KEY(course_id,session_id,exercise_index) REFERENCES ${parent}(course_id,session_id,exercise_index) ON DELETE CASCADE
)`;
export const LEARNING_EVIDENCE_SCHEMA_V8_DDL: readonly string[] = [
  `CREATE TABLE course_surface_exposure (
 course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
 ${text('surface_id')},${text('surface')},${text('language')},${text('session_id')},${text('slot_id')},${text('exercise_id')},
 pack_content_hash TEXT NOT NULL CHECK(length(pack_content_hash)=64 AND pack_content_hash NOT GLOB '*[^0-9a-f]*'),
 display_role TEXT NOT NULL CHECK(display_role IN ('prompt','wrong-feedback')),
 observed_at_utc_ms INTEGER NOT NULL CHECK(typeof(observed_at_utc_ms)='integer'),
 PRIMARY KEY(course_id,surface_id)
 )`,
  ...immutable('course_surface_exposure'),
  'CREATE UNIQUE INDEX course_session_answer_receipt_owner ON course_session_answer_receipt(course_id,session_id,exercise_index)',
  'CREATE UNIQUE INDEX course_attempt_owner ON course_attempt(course_id,session_id,exercise_index)',
  targets('course_session_answer_target', 'course_session_answer_receipt', false),
  ...immutable('course_session_answer_target', true),
  targets('course_attempt_target', 'course_attempt', true),
  ...immutable('course_attempt_target'),
];
