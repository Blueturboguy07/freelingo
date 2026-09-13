import { expect, it } from 'vitest';
import { createNodeDb } from '@freelingo/testkit';
import { migrate, MIGRATIONS, currentUserVersion } from './migrations.js';
import { regionViolations } from './progress-schema.js';
function prior() {
  const db = createNodeDb();
  for (const m of MIGRATIONS.filter((m) => m.userVersion <= 8))
    db.withExclusiveTransaction(() => {
      m.up(db);
      db.run(`PRAGMA user_version=${m.userVersion}`);
    });
  db.run(
    "INSERT INTO course_progress(course_id,added_at,xp,score) VALUES('en-es','2026-09-13',123,3),('en-fr','2026-09-13',7,0)",
  );
  return db;
}
function context(
  db: ReturnType<typeof prior>,
  id: string,
  course = 'en-es',
  flavour = 'jumpHere',
  completed = true,
) {
  db.run(
    "INSERT INTO committed_session(session_id,committed_at,outcome) VALUES (?,'2026-09-13T00:00:00Z',?)",
    [id, completed ? 'completed' : 'failed'],
  );
  db.run('INSERT INTO course_session_commit_link VALUES (?,?,?,?,NULL,NULL)', [
    id,
    course,
    'target-node',
    flavour,
  ]);
}
it('[INV-PER-03][INV-PATH-06] interrupted v9 keeps v8 and never manufactures prior jumps or script teaching', () => {
  const db = prior();
  try {
    const before = db.all('SELECT * FROM course_progress');
    const wrapper = {
      ...db,
      run(sql: string, params?: readonly unknown[]) {
        db.run(sql, params);
        if (sql.includes('CREATE TABLE course_path_state')) throw Error('kill path migration');
      },
    };
    expect(() => migrate(wrapper)).toThrow('kill path migration');
    expect(currentUserVersion(db)).toBe(8);
    expect(db.all('SELECT * FROM course_progress')).toEqual(before);
    migrate(db);
    expect(db.all('SELECT * FROM course_path_state')).toEqual([]);
    expect(db.all('SELECT * FROM course_path_jump')).toEqual([]);
    expect(db.all('SELECT * FROM course_script_introduction')).toEqual([]);
    expect(regionViolations(db)).toEqual([]);
  } finally {
    db.close();
  }
});
it('[INV-PATH-21] known path header permits viewport changes but never erases initialization or the shown completion latch', () => {
  const db = prior();
  try {
    migrate(db);
    db.run("INSERT INTO course_path_state VALUES ('en-es',100,0,0)");
    db.run('UPDATE course_path_state SET viewing_section=2,daily_refresh_unlocked=1');
    expect(() => db.run('UPDATE course_path_state SET daily_refresh_unlocked=0')).toThrow();
    expect(() => db.run('UPDATE course_path_state SET initialized_at_utc_ms=200')).toThrow();
    expect(() => db.run('DELETE FROM course_path_state')).toThrow();
    expect(() => db.run('UPDATE course_path_state SET viewing_section=-1')).toThrow();
    expect(db.get('SELECT viewing_section,daily_refresh_unlocked FROM course_path_state')).toEqual({
      viewing_section: 2,
      daily_refresh_unlocked: 1,
    });
    db.run("DELETE FROM course_progress WHERE course_id='en-es'");
    expect(db.all('SELECT * FROM course_path_state')).toEqual([]);
  } finally {
    db.close();
  }
});
it('[INV-PATH-06] jump targets require successful same-course committed assessment evidence and remain append-only', () => {
  const db = prior();
  try {
    migrate(db);
    context(db, 'pass');
    context(db, 'unfinished', 'en-es', 'jumpHere', false);
    context(db, 'ordinary', 'en-es', 'lesson');
    const add = (course: string, unit: string, source: string) =>
      db.run('INSERT INTO course_path_jump VALUES (?,?,?)', [course, unit, source]);
    expect(() => add('en-es', 'u2', 'unfinished')).toThrow();
    expect(() => add('en-es', 'u2', 'ordinary')).toThrow();
    expect(() => add('en-fr', 'u2', 'pass')).toThrow();
    add('en-es', 'u2', 'pass');
    expect(() => db.run("UPDATE course_path_jump SET unit_id='u3'")).toThrow();
    expect(() => db.run('DELETE FROM course_path_jump')).toThrow();
    expect(() =>
      db.run(
        "UPDATE course_session_commit_link SET node_id='another-target' WHERE session_id='pass'",
      ),
    ).toThrow();
    expect(() =>
      db.run("UPDATE committed_session SET outcome='failed' WHERE session_id='pass'"),
    ).toThrow();
    db.run("DELETE FROM course_progress WHERE course_id='en-es'");
    expect(db.all('SELECT * FROM course_path_jump')).toEqual([]);
  } finally {
    db.close();
  }
});
it('[INV-PATH-15][INV-GRD-11] script teaching requires an exact same-course observed surface receipt and survives until explicit course removal', () => {
  const db = prior();
  try {
    migrate(db);
    const add = (course: string, unit: string, surface: string) =>
      db.run('INSERT INTO course_script_introduction VALUES (?,?,?)', [course, unit, surface]);
    expect(() => add('en-es', 'kana-a', 'missing')).toThrow();
    db.run('INSERT INTO course_surface_exposure VALUES (?,?,?,?,?,?,?,?,?,?)', [
      'en-es',
      'surface-a',
      'あ',
      'ja',
      's',
      'slot',
      'ex',
      'a'.repeat(64),
      'prompt',
      100,
    ]);
    expect(() => add('en-fr', 'kana-a', 'surface-a')).toThrow();
    add('en-es', 'kana-a', 'surface-a');
    expect(() =>
      db.run("UPDATE course_script_introduction SET script_unit_id='kana-ka'"),
    ).toThrow();
    expect(() => db.run('DELETE FROM course_script_introduction')).toThrow();
    db.run("DELETE FROM course_progress WHERE course_id='en-es'");
    expect(db.all('SELECT * FROM course_script_introduction')).toEqual([]);
  } finally {
    db.close();
  }
});
