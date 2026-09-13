import { expect, it } from 'vitest';
import { createNodeDb } from '@freelingo/testkit';
import { migrate, MIGRATIONS, currentUserVersion } from './migrations.js';
import { regionViolations } from './progress-schema.js';
function prior() {
  const db = createNodeDb();
  for (const m of MIGRATIONS.filter((m) => m.userVersion <= 9))
    db.withExclusiveTransaction(() => {
      m.up(db);
      db.run(`PRAGMA user_version=${m.userVersion}`);
    });
  db.run(
    "INSERT INTO course_progress(course_id,added_at) VALUES ('en-es','2026-09-13'),('en-fr','2026-09-13')",
  );
  return db;
}
const semantic = JSON.stringify({
  prompt: 'cat',
  preferredSurface: 'gato',
  lexemes: ['gato'],
  grammarConcepts: [],
  graphemes: [],
  register: 'neutral',
});
const word = 'i_0123456789abcdef';
function introduce(db: ReturnType<typeof createNodeDb>, id = word, countable = 1) {
  db.run('INSERT INTO account_word VALUES(?,?,?,?,?,?)', [
    id,
    semantic,
    countable,
    100,
    JSON.stringify({
      sourceLanguage: 'es',
      lexemeId: 'lx:gato:NOUN',
      packContentHash: 'a'.repeat(64),
      exerciseId: 'ex1',
      slotId: 'slot1',
      surfaceId: 'sf1',
    }),
    1,
  ]);
}
it('[INV-PER-03][INV-ECO-13] word migration rolls back wholly and invents no legacy identities', () => {
  const db = prior();
  try {
    db.run('UPDATE account SET words_introduced=20,words_learned=8');
    const interrupted = {
      ...db,
      run(sql: string, params?: readonly unknown[]) {
        db.run(sql, params);
        if (sql.includes('CREATE TABLE account_word (')) throw new Error('kill word migration');
      },
    };
    expect(() => migrate(interrupted)).toThrow('kill word migration');
    expect(currentUserVersion(db)).toBe(9);
    migrate(db);
    expect(db.get('SELECT words_introduced,words_learned FROM account')).toEqual({
      words_introduced: 20,
      words_learned: 8,
    });
    expect(db.all('SELECT * FROM account_word_state')).toEqual([]);
    expect(db.all('SELECT * FROM account_word')).toEqual([]);
    expect(regionViolations(db)).toEqual([]);
  } finally {
    db.close();
  }
});
it('[INV-ECO-13][INV-ECO-27] lexical union and learned proof survive course removal and re-add', () => {
  const db = prior();
  try {
    migrate(db);
    db.run('INSERT INTO account_word_state VALUES(1,100)');
    introduce(db);
    expect(() => introduce(db)).toThrow();
    db.run(
      "INSERT INTO committed_session(session_id,committed_at,outcome) VALUES('s1','2026-09-13','completed')",
    );
    db.run('INSERT INTO account_word_learning VALUES(?,?,?,?)', [
      word,
      200,
      's1',
      JSON.stringify({
        reviews: [
          { sessionId: 'earlier', strength: 0.96 },
          { sessionId: 's1', strength: 0.97 },
        ],
      }),
    ]);
    introduce(db, 'i_fedcba9876543210', 0);
    const counters = () =>
      db.get(
        'SELECT count(*) AS introduced, count(learned.word_item_id) AS learned FROM account_word word LEFT JOIN account_word_learning learned ON learned.word_item_id=word.word_item_id WHERE word.countable=1',
      );
    expect(counters()).toEqual({ introduced: 1, learned: 1 });
    db.run('DELETE FROM course_progress');
    db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-es','2026-09-14')");
    expect(counters()).toEqual({ introduced: 1, learned: 1 });
    expect(() => introduce(db)).toThrow();
  } finally {
    db.close();
  }
});
it('[INV-ECO-27] words need known history and a well-formed declared identity', () => {
  const db = prior();
  try {
    migrate(db);
    expect(() => introduce(db)).toThrow();
    db.run('INSERT INTO account_word_state VALUES(1,100)');
    expect(() => introduce(db, 'lx:gato:NOUN')).toThrow();
    expect(() => introduce(db, word, 2)).toThrow();
    expect(() =>
      db.run('INSERT INTO account_word VALUES(?,?,?,?,?,?)', [word, '[]', 1, 100, '{}', 1]),
    ).toThrow();
    expect(() =>
      db.run('INSERT INTO account_word VALUES(?,?,?,?,?,?)', [word, semantic, 1, 100, 'null', 1]),
    ).toThrow();
    introduce(db);
    expect(() => db.run('UPDATE account_word SET countable=0')).toThrow('immutable');
    expect(() => db.run('DELETE FROM account_word')).toThrow('immutable');
    expect(() => db.run('DELETE FROM account_word_state')).toThrow('immutable');
    expect(() => db.run('UPDATE account_word_state SET initialized_at_utc_ms=101')).toThrow(
      'immutable',
    );
  } finally {
    db.close();
  }
});
it('[INV-ECO-27][INV-CER-01] learned claims require introduced identity and permanent commit receipt', () => {
  const db = prior();
  try {
    migrate(db);
    db.run('INSERT INTO account_word_state VALUES(1,100)');
    const learn = (id = word, session = 's1', proof = '{}') =>
      db.run('INSERT INTO account_word_learning VALUES(?,?,?,?)', [id, 200, session, proof]);
    expect(() => learn()).toThrow();
    introduce(db);
    expect(() => learn()).toThrow();
    db.run(
      "INSERT INTO committed_session(session_id,committed_at,outcome) VALUES('s1','2026-09-13','completed')",
    );
    expect(() => learn(word, 's1', '[]')).toThrow();
    learn();
    expect(() => learn()).toThrow();
    expect(() => db.run('UPDATE account_word_learning SET learned_at_utc_ms=300')).toThrow(
      'immutable',
    );
    expect(() => db.run('DELETE FROM account_word_learning')).toThrow('immutable');
    expect(() => db.run("DELETE FROM committed_session WHERE session_id='s1'")).toThrow();
  } finally {
    db.close();
  }
});
