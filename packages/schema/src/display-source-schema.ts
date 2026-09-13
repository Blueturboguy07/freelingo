/** v13 exact source observations, 2026-09-13. The first full-surface exposure
 * remains the scheduler introduction; later source displays retain their own proof.
 * Neither migration nor source registration fabricates a display callback. */
export const DISPLAY_SOURCE_COURSE_TABLES = ['course_source_exposure'] as const;
const text = (name: string) => `${name} TEXT NOT NULL CHECK(length(trim(${name}))>0)`;
export const DISPLAY_SOURCE_SCHEMA_V13_DDL: readonly string[] = [
  `CREATE TABLE course_source_exposure (
 course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
 ${text('surface_id')},${text('surface')},${text('language')},${text('session_id')},${text('slot_id')},${text('exercise_id')},
 pack_content_hash TEXT NOT NULL CHECK(length(pack_content_hash)=64 AND pack_content_hash NOT GLOB '*[^0-9a-f]*'),
 display_role TEXT NOT NULL CHECK(display_role IN ('prompt','wrong-feedback')),
 observed_at_utc_ms INTEGER NOT NULL CHECK(typeof(observed_at_utc_ms)='integer' AND observed_at_utc_ms BETWEEN -8640000000000000 AND 8640000000000000),
 PRIMARY KEY(course_id,surface_id,exercise_id,pack_content_hash),
 FOREIGN KEY(course_id,surface_id) REFERENCES course_surface_exposure(course_id,surface_id) ON DELETE CASCADE
 )`,
  `CREATE TRIGGER course_source_exposure_identity BEFORE INSERT ON course_source_exposure
 WHEN NOT EXISTS(SELECT 1 FROM course_surface_exposure e WHERE e.course_id=NEW.course_id AND e.surface_id=NEW.surface_id AND e.surface=NEW.surface AND e.language=NEW.language)
 BEGIN SELECT RAISE(ABORT,'source observation changed surface identity'); END`,
  `CREATE TRIGGER course_source_exposure_immutable_update BEFORE UPDATE ON course_source_exposure BEGIN SELECT RAISE(ABORT,'source observation is immutable'); END`,
  `CREATE TRIGGER course_source_exposure_immutable_delete BEFORE DELETE ON course_source_exposure WHEN EXISTS(SELECT 1 FROM course_progress WHERE course_id=OLD.course_id) BEGIN SELECT RAISE(ABORT,'source observation is immutable'); END`,
];
