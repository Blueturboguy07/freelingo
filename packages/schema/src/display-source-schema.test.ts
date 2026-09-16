import { afterEach, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeDb } from '@freelingo/testkit';
import type { Db } from './db.js';
import { migrate, MIGRATIONS, currentUserVersion } from './migrations.js';
import { regionViolations } from './progress-schema.js';
const opened: Db[] = [];
const directories: string[] = [];
afterEach(() => {
  opened.splice(0).forEach((db) => db.close());
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
const hash = 'a'.repeat(64),
  at = 1789300800000;
function setup(version = 13) {
  const db = createNodeDb();
  opened.push(db);
  for (const m of MIGRATIONS.filter((m) => m.userVersion <= version))
    db.withExclusiveTransaction(() => {
      m.up(db);
      db.run('PRAGMA user_version=' + m.userVersion);
    });
  db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-es','2026-09-13')");
  db.run(
    "INSERT INTO course_surface_exposure VALUES('en-es','sf-cat','gato','es','s-first','slot-first','ex-first',?,'prompt',?)",
    [hash, at],
  );
  return db;
}
function observed(db: Db, exercise = 'ex-second', language = 'es', surface = 'gato') {
  db.run(
    "INSERT INTO course_source_exposure VALUES('en-es','sf-cat',?,?,'s-second','slot-second',?,?,'prompt',?)",
    [surface, language, exercise, hash, at + 1000],
  );
}
it('[INV-ECO-27][INV-SCH-11] exact later sources can preserve their actual receipt without rewriting the first surface introduction', () => {
  const db = setup();
  const first = db.get('SELECT * FROM course_surface_exposure');
  observed(db);
  observed(db, 'ex-third');
  expect(db.all('SELECT exercise_id FROM course_source_exposure ORDER BY exercise_id')).toEqual([
    { exercise_id: 'ex-second' },
    { exercise_id: 'ex-third' },
  ]);
  expect(db.get('SELECT * FROM course_surface_exposure')).toEqual(first);
  expect(regionViolations(db)).toEqual([]);
});
it('[INV-ECO-27][INV-PER-03] source observations require the same real surface and remain immutable until course removal', () => {
  const db = setup();
  observed(db);
  expect(() => observed(db)).toThrow();
  expect(() => observed(db, 'ex-new', 'en')).toThrow();
  expect(() => observed(db, 'ex-new', 'es', 'perro')).toThrow();
  expect(() => db.run("UPDATE course_source_exposure SET exercise_id='altered'")).toThrow();
  expect(() => db.run('DELETE FROM course_source_exposure')).toThrow();
  db.run("DELETE FROM course_progress WHERE course_id='en-es'");
  expect(db.all('SELECT * FROM course_source_exposure')).toEqual([]);
});
it('[INV-PER-03][INV-ECO-27] migration preserves actual earlier receipts and invents no later source display', () => {
  const db = setup(12),
    first = db.get('SELECT * FROM course_surface_exposure');
  migrate(db);
  expect(currentUserVersion(db)).toBe(13);
  expect(db.get('SELECT * FROM course_surface_exposure')).toEqual(first);
  expect(db.all('SELECT * FROM course_source_exposure')).toEqual([]);
});
it('[INV-PER-03] interruption while creating exact display evidence leaves the earlier schema version intact', () => {
  const db = setup(12),
    first = db.get('SELECT * FROM course_surface_exposure');
  const broken: Db = {
    ...db,
    run(sql, p) {
      if (sql.includes('CREATE TRIGGER course_source_exposure'))
        throw new Error('interrupted display migration');
      db.run(sql, p);
    },
  };
  expect(() => migrate(broken)).toThrow('interrupted display migration');
  expect(currentUserVersion(db)).toBe(12);
  expect(
    db.get("SELECT name FROM sqlite_master WHERE name='course_source_exposure'"),
  ).toBeUndefined();
  expect(db.get('SELECT * FROM course_surface_exposure')).toEqual(first);
});

it('[INV-ECO-27][INV-PER-03] SQLite REPLACE cannot rewrite an exact source receipt when recursive triggers are disabled', () => {
  const db = setup();
  observed(db);
  db.run('PRAGMA recursive_triggers=OFF');
  const before = db.get('SELECT * FROM course_source_exposure');
  expect(() =>
    db.run(
      "INSERT OR REPLACE INTO course_source_exposure VALUES('en-es','sf-cat','gato','es','rewritten','slot-second','ex-second',?,'prompt',?)",
      [hash, at + 2000],
    ),
  ).toThrow();
  expect(db.get('SELECT * FROM course_source_exposure')).toEqual(before);
});
it.each([
  ['account_word_state', 'initialized_at_utc_ms'],
  ['account_word', 'introduced_at_utc_ms'],
  ['account_word_learning', 'learned_at_utc_ms'],
  ['account_word_review', 'reviewed_at_utc_ms'],
  ['account_word_review', 'word_sequence'],
] as const)(
  '[INV-ECO-27][INV-PER-03] permanent %s cannot replace its existing evidence through %s',
  (table, field) => {
    const dir = mkdtempSync(join(tmpdir(), 'freelingo-replace-history-'));
    directories.push(dir);
    const path = join(dir, 'progress.db');
    copyFileSync(new URL('../fixtures/golden/v12.db', import.meta.url), path);
    const db = createNodeDb({ location: path });
    opened.push(db);
    migrate(db);
    db.run('PRAGMA recursive_triggers=OFF');
    const all = db.all('SELECT * FROM ' + table),
      original = all[0]!;
    const changed = { ...original, [field]: (original[field] as number) + 1 };
    const names = Object.keys(changed);
    expect(() =>
      db.run(
        'INSERT OR REPLACE INTO ' +
          table +
          '(' +
          names.join(',') +
          ') VALUES(' +
          names.map(() => '?').join(',') +
          ')',
        Object.values(changed),
      ),
    ).toThrow();
    expect(db.all('SELECT * FROM ' + table)).toEqual(all);
  },
);

it('[INV-ECO-27][INV-SCH-11] REPLACE cannot move the first teaching instant even without a later source child', () => {
  const db = setup();
  db.run('PRAGMA recursive_triggers=OFF');
  const before = db.get('SELECT * FROM course_surface_exposure');
  expect(() =>
    db.run(
      "INSERT OR REPLACE INTO course_surface_exposure VALUES('en-es','sf-cat','gato','es','s-new','slot-new','ex-new',?,'prompt',?)",
      [hash, at + 1000],
    ),
  ).toThrow();
  expect(db.get('SELECT * FROM course_surface_exposure')).toEqual(before);
});
