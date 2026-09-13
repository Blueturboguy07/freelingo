import { expect, it } from 'vitest';
import { createNodeDb } from '@freelingo/testkit';
import { migrate, MIGRATIONS, currentUserVersion } from './migrations.js';
import { regionViolations } from './progress-schema.js';
function prior() {
  const db = createNodeDb();
  for (const m of MIGRATIONS.filter((m) => m.userVersion <= 7))
    db.withExclusiveTransaction(() => {
      m.up(db);
      db.run(`PRAGMA user_version=${m.userVersion}`);
    });
  db.run(
    "INSERT INTO course_progress(course_id,added_at) VALUES ('en-es','2026-09-13'),('en-fr','2026-09-13')",
  );
  return db;
}
it('[INV-PER-03] interrupted introduction migration retains v7 and all prior learner facts', () => {
  const db = prior();
  try {
    const wrapper = {
      ...db,
      run(sql: string, params?: readonly unknown[]) {
        db.run(sql, params);
        if (sql.includes('CREATE TABLE course_surface_exposure'))
          throw new Error('kill exposure migration');
      },
    };
    expect(() => migrate(wrapper)).toThrow('kill exposure migration');
    expect(currentUserVersion(db)).toBe(7);
    expect(db.all('SELECT course_id FROM course_progress')).toHaveLength(2);
    migrate(db);
    expect(regionViolations(db)).toEqual([]);
  } finally {
    db.close();
  }
});
it('[INV-GRD-11][INV-SCH-11] first visible surface receipt is immutable and does not invent an item encounter', () => {
  const db = prior();
  try {
    migrate(db);
    const hash = 'a'.repeat(64);
    db.run('INSERT INTO course_surface_exposure VALUES (?,?,?,?,?,?,?,?,?,?)', [
      'en-es',
      'sf:a',
      'gato',
      'es',
      's1',
      'slot1',
      'ex1',
      hash,
      'prompt',
      100,
    ]);
    expect(db.all('SELECT * FROM course_attempt')).toEqual([]);
    expect(db.all('SELECT * FROM course_item_surface')).toEqual([]);
    expect(() => db.run("UPDATE course_surface_exposure SET surface='perro'")).toThrow(
      'append-only',
    );
    expect(() => db.run('DELETE FROM course_surface_exposure')).toThrow('append-only');
    expect(() =>
      db.run('INSERT INTO course_surface_exposure VALUES (?,?,?,?,?,?,?,?,?,?)', [
        'en-es',
        'sf:a',
        'gato',
        'es',
        's2',
        'slot2',
        'ex2',
        hash,
        'wrong-feedback',
        200,
      ]),
    ).toThrow();
    db.run("DELETE FROM course_progress WHERE course_id='en-es'");
    expect(db.all('SELECT * FROM course_surface_exposure')).toEqual([]);
  } finally {
    db.close();
  }
});
it('[INV-SCH-11][INV-SESS-13] five semantic targets belong to one staged answer with exact course ownership', () => {
  const db = prior();
  try {
    migrate(db);
    db.run(
      "INSERT INTO course_session_answer_receipt(session_id,exercise_index,course_id,receipt_sequence,slot_id,item_id,exercise_id,answered_at_utc_ms,answered_local_day,active_ms) VALUES('s',0,'en-es',0,'slot','grid','ex',100,'2026-09-13',1000)",
    );
    const insert = (course: string, item: string, pos: number) =>
      db.run('INSERT INTO course_session_answer_target VALUES(?,?,?,?,?,?,?,?,?,?)', [
        course,
        's',
        0,
        item,
        'sf:' + item,
        item,
        'recognition',
        0,
        3,
        pos,
      ]);
    // Explicit column count below also catches drift between the approved carrier and SQL.
    for (let i = 0; i < 5; i++)
      db.run(
        'INSERT INTO course_session_answer_target(course_id,session_id,exercise_index,target_item_id,target_surface_id,target_surface,encounter_role,ruby_shown,grade,position) VALUES(?,?,?,?,?,?,?,?,?,?)',
        ['en-es', 's', 0, 'lx:' + i, 'sf:' + i, 'word' + i, 'recognition', 0, 3, i],
      );
    expect(db.all('SELECT * FROM course_session_answer_receipt')).toHaveLength(1);
    expect(db.all('SELECT * FROM course_session_answer_target')).toHaveLength(5);
    expect(() => insert('en-fr', 'foreign', 9)).toThrow();
    expect(() => db.run('UPDATE course_session_answer_target SET grade=1')).toThrow('append-only');
    db.run("DELETE FROM course_session_answer_receipt WHERE session_id='s'");
    expect(db.all('SELECT * FROM course_session_answer_target')).toEqual([]);
  } finally {
    db.close();
  }
});
it('[INV-SCH-11] committed targets cannot attach to a different course or change an awarded encounter', () => {
  const db = prior();
  try {
    migrate(db);
    db.run(
      "INSERT INTO course_attempt(session_id,exercise_index,course_id,item_id,exercise_type,verdict,first_try,answered_at,active_ms) VALUES('s',0,'en-es','grid','match','correct',1,'2026-09-13T00:00:00Z',1000)",
    );
    const insert = (course: string) =>
      db.run(
        'INSERT INTO course_attempt_target(course_id,session_id,exercise_index,target_item_id,target_surface_id,target_surface,encounter_role,ruby_shown,grade,position,review_kind,answered_at_utc_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        [course, 's', 0, 'lx:a', 'sf:a', 'gato', 'recognition', 0, 3, 0, 'scheduled', 100],
      );
    expect(() => insert('en-fr')).toThrow('FOREIGN KEY');
    insert('en-es');
    expect(() => db.run('UPDATE course_attempt_target SET grade=1')).toThrow('append-only');
    expect(() => db.run('DELETE FROM course_attempt_target')).toThrow('append-only');
    db.run("DELETE FROM course_progress WHERE course_id='en-es'");
    expect(db.all('SELECT * FROM course_attempt_target')).toEqual([]);
  } finally {
    db.close();
  }
});
