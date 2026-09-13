/** v9 path facts, 2026-09-13. No legacy row is inferred. A fresh course's owner
 * explicitly creates the known-empty header; missing header means unknown history.
 * Runtime validates archived node/script-unit membership against the signed path.
 * These FKs preserve the independent completion/display evidence it validated. */
export const PATH_STATE_COURSE_TABLES = [
  'course_path_state',
  'course_path_jump',
  'course_script_introduction',
] as const;
const text = (name: string) => `${name} TEXT NOT NULL CHECK(length(trim(${name}))>0)`;
function immutable(table: string): string[] {
  return [
    `CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} is append-only'); END`,
    `CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} WHEN EXISTS(SELECT 1 FROM course_progress WHERE course_id=OLD.course_id) BEGIN SELECT RAISE(ABORT,'${table} is append-only'); END`,
  ];
}
export const PATH_STATE_SCHEMA_V9_DDL: readonly string[] = [
  `CREATE TABLE course_path_state (
    course_id TEXT PRIMARY KEY NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    initialized_at_utc_ms INTEGER NOT NULL CHECK(typeof(initialized_at_utc_ms)='integer'),
    viewing_section INTEGER NOT NULL CHECK(typeof(viewing_section)='integer' AND viewing_section>=0),
    daily_refresh_unlocked INTEGER NOT NULL CHECK(daily_refresh_unlocked IN (0,1))
  )`,
  `CREATE TRIGGER course_path_state_monotone BEFORE UPDATE ON course_path_state
    WHEN NEW.course_id IS NOT OLD.course_id OR NEW.initialized_at_utc_ms IS NOT OLD.initialized_at_utc_ms OR NEW.daily_refresh_unlocked<OLD.daily_refresh_unlocked
    BEGIN SELECT RAISE(ABORT,'path initialization and completion latch are permanent'); END`,
  `CREATE TRIGGER course_path_state_no_forget BEFORE DELETE ON course_path_state
    WHEN EXISTS(SELECT 1 FROM course_progress WHERE course_id=OLD.course_id)
    BEGIN SELECT RAISE(ABORT,'known path state cannot become unknown'); END`,
  'CREATE UNIQUE INDEX course_session_commit_link_owner ON course_session_commit_link(session_id,course_id)',
  `CREATE TABLE course_path_jump (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    ${text('unit_id')},${text('source_session_id')},
    PRIMARY KEY(course_id,unit_id),
    FOREIGN KEY(source_session_id,course_id) REFERENCES course_session_commit_link(session_id,course_id)
  )`,
  `CREATE TRIGGER course_path_jump_proof BEFORE INSERT ON course_path_jump
    WHEN NOT EXISTS(SELECT 1 FROM course_session_commit_link link JOIN committed_session receipt ON receipt.session_id=link.session_id
      WHERE link.session_id=NEW.source_session_id AND link.course_id=NEW.course_id
      AND link.node_id IS NOT NULL AND length(trim(link.node_id))>0
      AND link.economy_flavour IN ('placement','jumpHere','sectionTest') AND receipt.outcome='completed')
    BEGIN SELECT RAISE(ABORT,'jump requires a successful same-course committed assessment'); END`,
  ...immutable('course_path_jump'),
  `CREATE TRIGGER course_path_jump_link_immutable BEFORE UPDATE ON course_session_commit_link
    WHEN EXISTS(SELECT 1 FROM course_path_jump WHERE source_session_id=OLD.session_id)
      AND (NEW.session_id IS NOT OLD.session_id OR NEW.course_id IS NOT OLD.course_id OR NEW.node_id IS NOT OLD.node_id OR NEW.economy_flavour IS NOT OLD.economy_flavour)
    BEGIN SELECT RAISE(ABORT,'claimed jump source is immutable'); END`,
  `CREATE TRIGGER course_path_jump_outcome_immutable BEFORE UPDATE ON committed_session
    WHEN EXISTS(SELECT 1 FROM course_path_jump WHERE source_session_id=OLD.session_id)
      AND (NEW.session_id IS NOT OLD.session_id OR NEW.outcome IS NOT OLD.outcome)
    BEGIN SELECT RAISE(ABORT,'claimed jump outcome is immutable'); END`,
  `CREATE TABLE course_script_introduction (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    ${text('script_unit_id')},${text('source_surface_id')},
    PRIMARY KEY(course_id,script_unit_id),
    FOREIGN KEY(course_id,source_surface_id) REFERENCES course_surface_exposure(course_id,surface_id)
  )`,
  ...immutable('course_script_introduction'),
];
