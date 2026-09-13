import { expect, it } from 'vitest';
import { createNodeDb } from '@freelingo/testkit';
import { migrate, MIGRATIONS, currentUserVersion } from './migrations.js';
import { regionViolations } from './progress-schema.js';
function prior() {
  const db = createNodeDb();
  for (const migration of MIGRATIONS.filter((m) => m.userVersion <= 10)) {
    db.withExclusiveTransaction(() => {
      migration.up(db);
      db.run(`PRAGMA user_version=${migration.userVersion}`);
    });
  }
  return db;
}
const word = 'i_0123456789abcdef';
function seed(db: ReturnType<typeof createNodeDb>) {
  db.run('INSERT INTO account_word_state VALUES(1,100)');
  db.run('INSERT INTO account_word VALUES(?,?,?,?,?,1)', [word, '{}', 1, 100, '{}']);
  db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-es','2026-09-13')");
  db.run(
    "INSERT INTO committed_session(session_id,committed_at,outcome) VALUES('s1','2026-09-13','completed')",
  );
}
function review(db: ReturnType<typeof createNodeDb>, patch: Record<string, unknown> = {}) {
  const row = {
    word_item_id: word,
    word_sequence: 0,
    source_session_id: 's1',
    answer_ordinal: 0,
    target_position: 0,
    reviewed_at_utc_ms: 200,
    evidence_json: '{}',
    ...patch,
  };
  db.run(
    `INSERT INTO account_word_review(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
      .map(() => '?')
      .join(',')})`,
    Object.values(row),
  );
}
it('[INV-PER-03][INV-ECO-27] ordered word-review migration is atomic and does not invent prior reviews', () => {
  const db = prior();
  try {
    seed(db);
    const interrupted = {
      ...db,
      run(sql: string, params?: readonly unknown[]) {
        db.run(sql, params);
        if (sql.includes('CREATE TABLE account_word_review'))
          throw new Error('kill review migration');
      },
    };
    expect(() => migrate(interrupted)).toThrow('kill review migration');
    expect(currentUserVersion(db)).toBe(10);
    migrate(db);
    expect(db.all('SELECT * FROM account_word_review')).toEqual([]);
    expect(db.all('SELECT * FROM account_word')).toHaveLength(1);
    expect(regionViolations(db)).toEqual([]);
  } finally {
    db.close();
  }
});
it('[INV-ECO-27][INV-CER-01] reviews require permanent introduced and committed identities', () => {
  const db = prior();
  try {
    migrate(db);
    expect(() => review(db)).toThrow();
    seed(db);
    expect(() => review(db, { word_item_id: 'i_fedcba9876543210' })).toThrow();
    expect(() => review(db, { source_session_id: 'missing' })).toThrow();
    for (const bad of [
      { word_sequence: -1 },
      { answer_ordinal: -1 },
      { target_position: 0.5 },
      { evidence_json: '[]' },
      { reviewed_at_utc_ms: 1.5 },
    ])
      expect(() => review(db, bad)).toThrow();
    review(db);
  } finally {
    db.close();
  }
});
it('[INV-ECO-27][INV-CER-01] review chronology and target receipt cannot be reused or changed', () => {
  const db = prior();
  try {
    migrate(db);
    seed(db);
    review(db);
    expect(() => review(db, { word_sequence: 1 })).toThrow();
    expect(() => review(db, { answer_ordinal: 1 })).toThrow();
    review(db, { word_sequence: 1, answer_ordinal: 1 });
    expect(() => db.run('UPDATE account_word_review SET reviewed_at_utc_ms=201')).toThrow(
      'immutable',
    );
    expect(() => db.run('DELETE FROM account_word_review')).toThrow('immutable');
    expect(() => db.run("DELETE FROM committed_session WHERE session_id='s1'")).toThrow();
  } finally {
    db.close();
  }
});
it('[INV-ECO-13][INV-ECO-27] ordered reviews survive course removal and re-add without foreign-key orphans', () => {
  const db = prior();
  try {
    migrate(db);
    seed(db);
    review(db);
    const before = db.all('SELECT * FROM account_word_review');
    db.run('DELETE FROM course_progress');
    db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-es','2026-09-14')");
    expect(db.all('SELECT * FROM account_word_review')).toEqual(before);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});
