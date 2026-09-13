import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { readRepoFile } from '@freelingo/testkit';
import type { PackReader } from './loader.js';
import { canonicalJson } from './items.js';
import { sha256Hex } from './hashing.js';
import { readPathMetadata } from './path.js';
const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.length = 0;
});
const fixture = JSON.parse(
  readRepoFile('tools/coursekit/tests/fixtures/path/declared-input.json'),
) as { units: Record<string, unknown>[]; exercises: Record<string, unknown>[] };
const metadata = () =>
  JSON.parse(readRepoFile('tools/coursekit/tests/fixtures/path/produced-metadata.json'));
const identity = { packId: 'fixture-pack', courseId: 'en-es', version: '1.0.0', cefrChecked: true };
function setup(value: unknown = metadata()) {
  const db = new DatabaseSync(':memory:');
  opened.push(db);
  db.exec('CREATE TABLE meta(key TEXT,value TEXT)');
  db.prepare('INSERT INTO meta VALUES (?,?)').run('path:v1', JSON.stringify(value));
  for (const [table, rows] of [
    ['unit', fixture.units],
    ['exercise', fixture.exercises],
  ] as const) {
    const fields = Object.keys(rows[0]!);
    db.exec(
      `CREATE TABLE ${table}(${fields.map((field) => `${field} ${typeof rows[0]![field] === 'number' ? 'INTEGER' : 'TEXT'}`).join(',')})`,
    );
    for (const row of rows)
      db.prepare(`INSERT INTO ${table} VALUES (${fields.map(() => '?').join(',')})`).run(
        ...(fields.map((field) => row[field]) as never[]),
      );
  }
  const reader: PackReader = {
    all: <T>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
    get: <T>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).get(...(params as never[])) as T | undefined,
  };
  return { db, reader };
}
it('[INV-PACK-03][INV-PACK-56] decodes the actual Python-produced declaration without a six-node or 129-Score fallback', () => {
  const { reader } = setup();
  const path = readPathMetadata(reader, identity);
  expect(path.manifest.scoreCeiling).toBe(19);
  expect(path.manifest.sectionTitles).toEqual(['Original section 1', 'Original section 2']);
  expect(path.sections[0]!.units[0]!.nodes.map((n) => n.type)).toEqual([
    'lesson',
    'chest',
    'unitReview',
  ]);
  const found = path.forNode('u002:learn');
  expect(found).toMatchObject({ unitId: 'u002', unitIndex: 1, sectionIndex: 1 });
  expect(found.node.sessions[0]!.exerciseIds).toEqual(['e201-1', 'e201-2']);
  expect(() => path.forNode('unknown')).toThrow(/path/i);
  expect(Object.isFrozen(found.node.sessions[0]!.exerciseIds)).toBe(true);
});
it('missing optional path capability is a named error, not an invented legacy path', () => {
  const { db, reader } = setup();
  db.exec('DELETE FROM meta');
  expect(() => readPathMetadata(reader, identity)).toThrow(/path/i);
});
it.each(['packId', 'courseId', 'version', 'cefrChecked'] as const)(
  'rejects exact %s identity mismatch',
  (field) => {
    const { reader } = setup();
    expect(() =>
      readPathMetadata(reader, { ...identity, [field]: field === 'cefrChecked' ? false : 'other' }),
    ).toThrow(/path/i);
  },
);
it.each([
  "UPDATE exercise SET prompt='different' WHERE exercise_id='e101-1'",
  "UPDATE exercise SET accepted_answers_json='[\"different\"]' WHERE exercise_id='e101-1'",
  "UPDATE exercise SET source_sentence_id='different' WHERE exercise_id='e101-1'",
  "DELETE FROM exercise WHERE exercise_id='e101-1'",
  "UPDATE unit SET title='different' WHERE unit_id='u001'",
])('rejects stale same-ID or incomplete actual SQL source: %s', (sql) => {
  const { db, reader } = setup();
  db.exec(sql);
  expect(() => readPathMetadata(reader, identity)).toThrow(/path/i);
});
it.each([
  (m: ReturnType<typeof metadata>) => {
    m.scoreCeiling = 129;
  },
  (m: ReturnType<typeof metadata>) => {
    m.sections[0].units[0].nodes[0].sessions[0].exerciseIds.reverse();
  },
  (m: ReturnType<typeof metadata>) => {
    m.sections[0].units[0].nodes[0].sessions[0].exerciseIds.pop();
  },
  (m: ReturnType<typeof metadata>) => {
    m.sections[0].units[0].nodes[0].type = 'unitRewind';
  },
  (m: ReturnType<typeof metadata>) => {
    m.sections[0].units[0].nodes[0].type = 'story';
  },
  (m: ReturnType<typeof metadata>) => {
    m.sections[0].units[0].nodes[0] = null;
  },
  (m: ReturnType<typeof metadata>) => {
    m.sections[0].units[0].unitIndex = true;
  },
])('rejects altered or malformed signed declaration even if it parses as JSON', (change) => {
  const m = metadata();
  change(m);
  const declaration = Object.fromEntries(
    Object.entries(m).filter(([key]) => key !== 'proof' && key !== 'lessonsPerLevel'),
  );
  m.proof.declarationSha256 = sha256Hex(canonicalJson(declaration));
  const { reader } = setup(m);
  expect(() => readPathMetadata(reader, identity)).toThrow(/path/i);
});
