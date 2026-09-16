// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import type { Db } from '@freelingo/schema';
import { buildHub, nextHubChoice } from '@freelingo/core/hub';
import { SqlitePoolStore } from './SqlitePoolStore';
import { toLocalDay } from '@freelingo/core/day';
import { hubFixture } from './learningHub.fixtures';
import { SqliteHubReadModel } from './SqliteHubReadModel';
const opened: Db[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
const at = Date.parse('2026-09-13T12:00:00Z');
function setup() {
  const f = hubFixture();
  opened.push(f.db);
  return f;
}
it('[INV-HUB-04][INV-SCH-11] merely loading registered pack sources does not introduce a word or offer a practice session', () => {
  const f = setup(),
    before = f.db.get('SELECT total_changes() AS n');
  const input = f.model.read('en-es');
  expect(input.items).toEqual([]);
  expect(input.practiceItems).toEqual([]);
  expect(buildHub(input).hero).toBeNull();
  expect(f.db.get('SELECT total_changes() AS n')).toEqual(before);
});
it('[INV-HUB-11][INV-HUB-03] actual exposure projects one lexical row and its distinct exercise source without incrementing counters', () => {
  const f = setup();
  f.teach();
  const before = f.db.get('SELECT total_changes() AS n'),
    input = f.model.read('en-es');
  expect(input.items).toHaveLength(1);
  expect(input.items[0]).toMatchObject({
    itemId: 'word-cat',
    kind: 'lexeme',
    text: 'gato',
    introducedAtUtc: new Date(at - 86400000).toISOString(),
  });
  expect(input.items[0]!.gloss.trim()).not.toBe('');
  expect(input.items[0]!.example.trim()).not.toBe('');
  expect(input.practiceItems?.[0]).toMatchObject({
    itemId: 'aggregate-cat',
    targetItemIds: ['word-cat'],
  });
  expect(buildHub(input).modes.find((m) => m.kind === 'today')!.offer?.itemIds).toEqual([
    'aggregate-cat',
  ]);
  expect(f.db.get('SELECT total_changes() AS n')).toEqual(before);
});
it('[INV-SCH-10][INV-HUB-09] newly introduced words remain visible while production practice waits four hours', () => {
  const f = setup();
  f.teach(at - 1000);
  const input = f.model.read('en-es');
  expect(input.items).toHaveLength(1);
  expect(input.practiceItems).toEqual([]);
  expect(buildHub(input).hero).toBeNull();
  f.setNow(at + 4 * 3600000);
  expect(f.model.read('en-es').practiceItems).toHaveLength(1);
});
it('[INV-SCH-05][INV-HUB-05] entry freezes the actual shared pool once and reflects another surface spending it', () => {
  const f = setup();
  f.teach();
  const input = f.model.read('en-es');
  f.model.save(buildHub(input).daily);
  expect(f.model.read('en-es').daily).toEqual(buildHub(input).daily);
  const day = toLocalDay('2026-09-13');
  new SqlitePoolStore(f.db).reserve('en-es', day, 'dailyRefresh', ['aggregate-cat' as never]);
  expect(buildHub(f.model.read('en-es')).modes.find((m) => m.kind === 'today')!.offer).toBeNull();
  expect(f.model.read('en-es').items).toHaveLength(1);
});
it('[INV-HUB-10][INV-HUB-05] a cross-midnight callback rolls back new day/menu/pool writes', () => {
  const f = setup();
  f.teach();
  const requested = nextHubChoice(buildHub(f.model.read('en-es'))).daily;
  f.setNow(at + 86400000);
  expect(() => f.model.save(requested)).toThrow();
  expect(f.db.all('SELECT * FROM course_hub_day')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_review_pool_day')).toEqual([]);
});
it('[INV-SCH-07][INV-HUB-11] quarantine removes an introduced target and every practice source that includes it', () => {
  const f = setup();
  f.teach();
  f.db.run("UPDATE course_item SET quarantined=1 WHERE item_id='word-cat'");
  const input = f.model.read('en-es');
  expect(input.items).toEqual([]);
  expect(input.practiceItems).toEqual([]);
});
it('[INV-HUB-11] missing reviewed lexical metadata is an explicit data error, never an invented gloss', () => {
  const f = setup();
  f.teach();
  f.setPack({ ...f.pack, runtimeItem: () => ({ ...f.item, lexicalBindings: [] }) });
  expect(() => f.model.read('en-es')).toThrow(/lexical/);
});

it('[INV-HUB-07] a timezone change preserves the actual recorded last-seen local day', () => {
  const f = setup();
  f.teach(Date.parse('2026-09-12T02:00:00Z'));
  const changed = new SqliteHubReadModel(f.db, {
    ...f.ports,
    clock: () => ({
      ...f.ports.clock(),
      zone: { tzId: 'Pacific/Honolulu', utcOffsetMinutes: -600, tzSource: 'iana' },
    }),
  });
  expect(changed.read('en-es').items[0]!.lastSeenLocalDay).toBe('2026-09-12');
});
it('[INV-HUB-04][INV-HUB-09] actual typed-only pack keeps its Words list but never advertises matching practice', () => {
  const f = setup();
  f.teach();
  const input = f.model.read('en-es'),
    hub = buildHub(input);
  expect(input.items).toHaveLength(1);
  expect(hub.modes.find((m) => m.kind === 'words')!.offer).toBeNull();
  expect(input.practiceItems![0]!.practiceModes).toContain('today');
  expect(input.practiceItems![0]!.practiceModes).not.toContain('words');
});
