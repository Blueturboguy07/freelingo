import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openPack, PackFormatError, type PackReader } from './loader.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'path-loader-'));
  const file = join(root, 'pack.sqlite');
  copyFileSync(
    new URL('../../../../tools/coursekit/tests/fixtures/path/loader-pack.sqlite', import.meta.url),
    file,
  );
  const db = new DatabaseSync(file);
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const all = vi.fn(
    <T>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  );
  const reader: PackReader = {
    all: <T>(sql: string, params: readonly unknown[] = []) => all(sql, params) as T[],
    get: <T>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).get(...(params as never[])) as T | undefined,
  };
  return { db, reader, all, pack: openPack(reader, { packRoot: root }) };
}
it('[INV-PACK-03] actual Python G9 writer output reaches the public optional path accessor with zero-based SQL slots', () => {
  const { pack, all } = setup();
  expect(all.mock.calls.some(([sql]) => sql.includes('WHERE key=?'))).toBe(false);
  const path = pack.path();
  const first = path.forNode('u001:learn');
  expect(first.node.sessions[0]!.exerciseIds).toEqual(
    pack.lesson(first.unitId, 1).map((e) => e.exerciseId),
  );
  expect(pack.lesson(first.unitId, 1)[0]!.slotIndex).toBe(0);
  expect(path.forNode('u002:learn').node.sessions.map((s) => s.lessonIndex)).toEqual([3, 4]);
  all.mockClear();
  expect(pack.path()).toBe(path);
  expect(all).not.toHaveBeenCalled();
});
it('missing optional path remains browseable and failures never poison the lazy cache', () => {
  const { db, pack } = setup();
  const value = db.prepare("SELECT value FROM meta WHERE key='path:v1'").get()!['value'];
  db.exec("DELETE FROM meta WHERE key='path:v1'");
  expect(pack.units()).toHaveLength(2);
  expect(pack.credits().length).toBeGreaterThan(0);
  expect(() => pack.path()).toThrow(PackFormatError);
  db.prepare('INSERT INTO meta VALUES (?,?)').run('path:v1', value!);
  expect(pack.path().sections[0]!.units).toHaveLength(2);
});
it('each separately opened reader rechecks its own exact source proof', () => {
  const a = setup();
  a.pack.path();
  const b = setup();
  b.db.exec("UPDATE exercise SET prompt='same-ID changed source'");
  expect(() => b.pack.path()).toThrow(/exercise source proof/);
  expect(a.pack.path().manifest.scoreCeiling).toBe(9);
});
