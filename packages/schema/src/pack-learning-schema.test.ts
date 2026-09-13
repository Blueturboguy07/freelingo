import { describe, expect, it } from 'vitest';
import { createNodeDb } from '@freelingo/testkit';
import { createPackSchema, createPackLearningSchema, packSchemaViolations } from './pack-schema.js';

function pack() {
  const db = createNodeDb();
  createPackSchema(db);
  createPackLearningSchema(db);
  db.run("INSERT INTO grammar_concept VALUES ('g1','One','First concept','neutral')");
  db.run("INSERT INTO unit VALUES ('u1',1,'A1',1,'One','greet','g1','neutral',1)");
  db.run(
    "INSERT INTO exercise (exercise_id,item_id,unit_id,lesson_index,slot_index,type,prompt,preferred_surface,register,accepted_answers_json) VALUES ('e1','i1','u1',1,1,'translate','Hi','Hola','neutral','[\"Hola\"]')",
  );
  return db;
}

describe('optional signed learning pack extension', () => {
  it('[INV-PACK-35] retains the readable legacy pack schema and accepts the complete learning extension', () => {
    const legacy = createNodeDb();
    createPackSchema(legacy);
    expect(packSchemaViolations(legacy)).toEqual([]);
    const db = pack();
    expect(packSchemaViolations(db)).toEqual([]);
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(1);
    legacy.close();
    db.close();
  });
  it('[INV-PACK-35] rejects an incomplete declared learning capability', () => {
    const db = pack();
    db.run('DROP TABLE exercise_runtime');
    expect(packSchemaViolations(db)).toContain('pack learning table exercise_runtime is missing');
    db.close();
  });
  it('[INV-PACK-35] indexes exact profile words without merging language profiles or duplicate keys', () => {
    const db = pack();
    db.run("INSERT INTO grading_word VALUES ('es','a'),('en','a')");
    expect(() => db.run("INSERT INTO grading_word VALUES ('es','a')")).toThrow();
    expect(() => db.run("INSERT INTO grading_word VALUES ('','hola')")).toThrow();
    expect(() => db.run("INSERT INTO grading_word VALUES ('es','')")).toThrow();
    expect(db.all("SELECT surface FROM grading_word WHERE profile_id='es'")).toEqual([
      { surface: 'a' },
    ]);
    const plan = db.all<{ detail: string }>(
      'EXPLAIN QUERY PLAN SELECT 1 FROM grading_word WHERE profile_id=? AND surface=?',
      ['es', 'a'],
    );
    expect(plan.some((row) => /SEARCH.*PRIMARY KEY/i.test(row.detail))).toBe(true);
    db.close();
  });
  it('[INV-PACK-35] binds each runtime payload to an actual exercise and valid exact-byte digest carrier', () => {
    const db = pack();
    const insert = (id: string, payload: string, hash: string) =>
      db.run('INSERT INTO exercise_runtime VALUES (?,?,?)', [id, payload, hash]);
    expect(() => insert('absent', '{}', 'a'.repeat(64))).toThrow();
    expect(() => insert('e1', 'broken', 'a'.repeat(64))).toThrow();
    expect(() => insert('e1', '{}', 'g'.repeat(64))).toThrow();
    expect(() => insert('e1', '{}', 'a'.repeat(63))).toThrow();
    insert('e1', '{}', 'a'.repeat(64));
    expect(() => insert('e1', '{}', 'b'.repeat(64))).toThrow();
    db.run("DELETE FROM exercise WHERE exercise_id='e1'");
    expect(db.all('SELECT * FROM exercise_runtime')).toEqual([]);
    db.close();
  });
});
