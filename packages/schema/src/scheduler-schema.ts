/** P3/P4 durable scheduler carriers, 2026-09-13. UTC milliseconds and full per-surface
 * cards supplement the historical day-grained item rows; migration invents no learning
 * evidence. Staging receipts carry exact exercise identity until atomic completion. */
export const SCHEDULER_TABLES = [
  'course_item_surface',
  'course_item_surface_modality',
  'course_scheduler_mastery',
  'course_introduction',
  'course_session_answer_receipt',
  'course_scheduler_hold',
  'course_scheduler_anomaly',
] as const;

const reviewKinds = "'introduction','scheduled','early','rubyAssisted','uncredited'";
const role = "'recognition','production'";

function appendOnly(table: 'course_introduction' | 'course_scheduler_anomaly'): string[] {
  return [
    `CREATE TRIGGER ${table}_append_only_update BEFORE UPDATE ON ${table}
       BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
    `CREATE TRIGGER ${table}_append_only_delete BEFORE DELETE ON ${table}
       WHEN EXISTS (SELECT 1 FROM course_progress WHERE course_id=OLD.course_id)
       BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
  ];
}

export const SCHEDULER_SCHEMA_V5_DDL: readonly string[] = [
  `ALTER TABLE course_progress ADD COLUMN mastery_high_water_points INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(mastery_high_water_points)='integer' AND mastery_high_water_points>=0)`,
  `CREATE TABLE course_item_surface (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL CHECK(length(trim(item_id))>0),
    surface TEXT NOT NULL CHECK(length(trim(surface))>0),
    kind TEXT NOT NULL CHECK(kind IN ('lexeme','grapheme','grammarConcept')),
    due_utc_ms INTEGER NOT NULL CHECK(typeof(due_utc_ms)='integer'),
    last_review_utc_ms INTEGER CHECK(last_review_utc_ms IS NULL OR typeof(last_review_utc_ms)='integer'),
    stability REAL NOT NULL CHECK(stability BETWEEN 0 AND 1.7976931348623157e308),
    difficulty REAL NOT NULL CHECK(difficulty BETWEEN 0 AND 1.7976931348623157e308),
    elapsed_days REAL NOT NULL CHECK(elapsed_days BETWEEN 0 AND 1.7976931348623157e308),
    scheduled_days REAL NOT NULL CHECK(scheduled_days BETWEEN 0 AND 1.7976931348623157e308),
    learning_steps INTEGER NOT NULL CHECK(typeof(learning_steps)='integer' AND learning_steps>=0),
    reps INTEGER NOT NULL CHECK(typeof(reps)='integer' AND reps>=0),
    lapses INTEGER NOT NULL CHECK(typeof(lapses)='integer' AND lapses>=0),
    state INTEGER NOT NULL CHECK(state IN (0,1,2,3)),
    retrievability REAL NOT NULL CHECK(retrievability BETWEEN 0 AND 1),
    introduced_at_utc_ms INTEGER CHECK(introduced_at_utc_ms IS NULL OR typeof(introduced_at_utc_ms)='integer'),
    last_review_kind TEXT CHECK(last_review_kind IN (${reviewKinds})),
    PRIMARY KEY(course_id,item_id,surface),
    FOREIGN KEY(course_id,item_id) REFERENCES course_item(course_id,item_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE course_item_surface_modality (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    surface TEXT NOT NULL,
    modality TEXT NOT NULL CHECK(length(trim(modality))>0),
    PRIMARY KEY(course_id,item_id,surface,modality),
    FOREIGN KEY(course_id,item_id,surface) REFERENCES course_item_surface(course_id,item_id,surface) ON DELETE CASCADE
  )`,
  `CREATE TABLE course_scheduler_mastery (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    PRIMARY KEY(course_id,item_id),
    FOREIGN KEY(course_id,item_id) REFERENCES course_item(course_id,item_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE course_introduction (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    surface TEXT NOT NULL,
    introduced_at_utc_ms INTEGER NOT NULL CHECK(typeof(introduced_at_utc_ms)='integer'),
    local_day TEXT NOT NULL CHECK(length(trim(local_day))>0),
    sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>=0),
    PRIMARY KEY(course_id,item_id,surface),
    UNIQUE(course_id,sequence),
    FOREIGN KEY(course_id,item_id,surface) REFERENCES course_item_surface(course_id,item_id,surface) ON DELETE CASCADE
  )`,
  ...appendOnly('course_introduction'),
  `ALTER TABLE course_attempt ADD COLUMN surface TEXT CHECK(surface IS NULL OR length(trim(surface))>0)`,
  `ALTER TABLE course_attempt ADD COLUMN scheduler_grade INTEGER CHECK(scheduler_grade IN (1,2,3,4))`,
  `ALTER TABLE course_attempt ADD COLUMN encounter_role TEXT CHECK(encounter_role IN (${role}))`,
  `ALTER TABLE course_attempt ADD COLUMN scheduler_review_kind TEXT CHECK(scheduler_review_kind IN (${reviewKinds}))`,
  `ALTER TABLE course_attempt ADD COLUMN ruby_shown INTEGER CHECK(ruby_shown IN (0,1))`,
  `ALTER TABLE course_attempt ADD COLUMN slot_id TEXT CHECK(slot_id IS NULL OR length(trim(slot_id))>0)`,
  `ALTER TABLE course_attempt ADD COLUMN queue TEXT CHECK(queue IN ('main','mistakes'))`,
  `ALTER TABLE course_attempt ADD COLUMN soft_corrected INTEGER CHECK(soft_corrected IN (0,1))`,
  `ALTER TABLE course_attempt ADD COLUMN cost_paid INTEGER CHECK(cost_paid IS NULL OR (typeof(cost_paid)='integer' AND cost_paid>=0))`,
  `ALTER TABLE course_attempt ADD COLUMN skipped INTEGER CHECK(skipped IN (0,1))`,
  `ALTER TABLE course_attempt ADD COLUMN scorable INTEGER CHECK(scorable IN (0,1))`,
  `ALTER TABLE course_attempt ADD COLUMN note TEXT`,
  `ALTER TABLE course_attempt ADD COLUMN attempt_sequence INTEGER CHECK(attempt_sequence IS NULL OR (typeof(attempt_sequence)='integer' AND attempt_sequence>=0))`,
  `CREATE UNIQUE INDEX course_attempt_chronology ON course_attempt(course_id,attempt_sequence) WHERE attempt_sequence IS NOT NULL`,
  `CREATE TABLE course_session_answer_receipt (
    session_id TEXT NOT NULL CHECK(length(trim(session_id))>0),
    exercise_index INTEGER NOT NULL CHECK(typeof(exercise_index)='integer'),
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    receipt_sequence INTEGER NOT NULL CHECK(typeof(receipt_sequence)='integer' AND receipt_sequence>=0),
    slot_id TEXT NOT NULL CHECK(length(trim(slot_id))>0),
    item_id TEXT NOT NULL CHECK(length(trim(item_id))>0),
    exercise_id TEXT NOT NULL CHECK(length(trim(exercise_id))>0),
    surface TEXT CHECK(surface IS NULL OR length(trim(surface))>0),
    encounter_role TEXT CHECK(encounter_role IN (${role})),
    ruby_shown INTEGER CHECK(ruby_shown IN (0,1)),
    answered_at_utc_ms INTEGER NOT NULL CHECK(typeof(answered_at_utc_ms)='integer'),
    answered_local_day TEXT NOT NULL CHECK(length(trim(answered_local_day))>0),
    active_ms INTEGER NOT NULL CHECK(typeof(active_ms)='integer' AND active_ms>=0),
    PRIMARY KEY(session_id,exercise_index), UNIQUE(session_id,receipt_sequence)
  )`,
  `CREATE TABLE course_scheduler_hold (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    hold_id TEXT NOT NULL CHECK(length(trim(hold_id))>0),
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('item','modality')),
    item_id TEXT CHECK(item_id IS NULL OR length(trim(item_id))>0),
    modality TEXT CHECK(modality IS NULL OR length(trim(modality))>0),
    reason TEXT NOT NULL CHECK(reason IN ('report','modalityDisabled','modalitySuspended')),
    from_utc_ms INTEGER NOT NULL CHECK(typeof(from_utc_ms)='integer'),
    until_utc_ms INTEGER CHECK(until_utc_ms IS NULL OR (typeof(until_utc_ms)='integer' AND until_utc_ms>=from_utc_ms)),
    PRIMARY KEY(course_id,hold_id),
    CHECK((scope_kind='item' AND item_id IS NOT NULL AND modality IS NULL) OR (scope_kind='modality' AND item_id IS NULL AND modality IS NOT NULL)),
    FOREIGN KEY(course_id,item_id) REFERENCES course_item(course_id,item_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE course_scheduler_anomaly (
    course_id TEXT NOT NULL REFERENCES course_progress(course_id) ON DELETE CASCADE,
    anomaly_sequence INTEGER NOT NULL CHECK(typeof(anomaly_sequence)='integer' AND anomaly_sequence>=0),
    kind TEXT NOT NULL CHECK(kind IN ('negativeElapsed','implausibleElapsed','uncreditedSurface','heldItemEncounter','productionTooSoon')),
    item_id TEXT CHECK(item_id IS NULL OR length(trim(item_id))>0),
    surface TEXT CHECK(surface IS NULL OR length(trim(surface))>0),
    at_utc_ms INTEGER NOT NULL CHECK(typeof(at_utc_ms)='integer'),
    observed_ms REAL CHECK(observed_ms IS NULL OR observed_ms BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308),
    used_ms REAL CHECK(used_ms IS NULL OR used_ms BETWEEN 0 AND 1.7976931348623157e308),
    note TEXT NOT NULL,
    PRIMARY KEY(course_id,anomaly_sequence),
    CHECK((item_id IS NULL AND surface IS NULL) OR (item_id IS NOT NULL AND surface IS NOT NULL))
  )`,
  ...appendOnly('course_scheduler_anomaly'),
];
