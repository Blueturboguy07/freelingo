// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, type Db } from '@freelingo/schema';
import {
  toLocalDay,
  newDayEngineState,
  rolloverTo,
  armChallenge,
  recordChallengeLesson,
  grantFreezes,
  repairStreak,
  type DayEngineState,
} from '@freelingo/core/day';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { SqliteDayStore, type PersistedDayState } from './SqliteDayStore';
const dbs: Db[] = [],
  dirs: string[] = [];
afterEach(() => {
  for (const db of dbs) db.close();
  dbs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});
const d = (n: number) => toLocalDay('2026-09-' + String(n).padStart(2, '0'));
function open(path = ':memory:') {
  const db = createNodeDb({ location: path });
  dbs.push(db);
  migrate(db);
  return db;
}
function initial(): DayEngineState {
  return {
    ...newDayEngineState({ freezesOwnedFrom: d(8) }),
    lastProcessedDay: d(9),
    maxLocalDaySeen: d(9),
    lastProcessedMonth: '2026-09',
    dispositions: new Map([[d(9), 'completed']]),
    longestStreak: 1,
    settlements: [{ month: '2026-09', settledMonth: null, atDay: d(9) }],
  };
}
function snap(engine: DayEngineState): PersistedDayState {
  return {
    engine,
    satisfiedDays: new Set([d(9)]),
    guard: {
      maxLocalDaySeen: engine.maxLocalDaySeen,
      lastCompletedAtUtcMs: Date.parse('2026-09-09T12:00:00Z'),
      lastZone: { tzId: 'America/Chicago', utcOffsetMinutes: -300, tzSource: 'iana' },
    },
  };
}
function comparable(s: PersistedDayState) {
  return {
    ...s,
    engine: {
      ...s.engine,
      dispositions: [...s.engine.dispositions],
      graceCreditedDays: [...s.engine.graceCreditedDays],
    },
    satisfiedDays: [...s.satisfiedDays],
  };
}
it('[INV-DAY-06][INV-FRZ-05] reloads the actual rollover decisions, consumed freeze dates and recovery progress', () => {
  const dir = mkdtempSync(join(tmpdir(), 'freelingo-day-'));
  dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const db = open(path),
    store = new SqliteDayStore(db);
  store.save(snap(initial()));
  let engine = rolloverTo(initial(), d(13), { completedDays: new Set([d(9)]) }).state;
  engine = recordChallengeLesson(armChallenge(engine, d(13)), d(13));
  const expected = snap(engine);
  store.save(expected);
  expect(engine.ledger.consumptions).toEqual([
    { consumedForDay: d(10), consumedOnDay: d(13) },
    { consumedForDay: d(11), consumedOnDay: d(13) },
  ]);
  db.close();
  dbs.splice(dbs.indexOf(db), 1);
  const restored = new SqliteDayStore(open(path)).load();
  expect(comparable(restored)).toEqual(comparable(expected));
  expect(restored.engine.challenge?.lessonsDone).toBe(1);
  expect(
    rolloverTo(restored.engine, d(13), { completedDays: restored.satisfiedDays }).freezesConsumed,
  ).toBe(0);
});
it('[INV-FRZ-03] a capped zero-effect grant survives reload and never turns into a later real gift', () => {
  const db = open(),
    store = new SqliteDayStore(db);
  let engine = initial();
  engine = {
    ...engine,
    ledger: grantFreezes(engine.ledger, {
      grantKey: 'full-chest',
      channel: 'reward_chest',
      ownedFromDay: d(9),
      amount: 2,
    }).ledger,
  };
  store.save(snap(engine));
  const later = rolloverTo(store.load().engine, d(11), { completedDays: new Set([d(9)]) }).state;
  store.save(snap(later));
  const replay = grantFreezes(store.load().engine.ledger, {
    grantKey: 'full-chest',
    channel: 'reward_chest',
    ownedFromDay: d(11),
    amount: 2,
  });
  expect(replay.applied).toBe(0);
  expect(
    db.get("SELECT applied FROM account_freeze_grant WHERE grant_key='full-chest'")?.applied,
  ).toBe(0);
});
it('[INV-DAY-01][INV-DAY-08] current-day streak satisfaction stays distinct from decided dispositions and goal XP', () => {
  const db = open(),
    store = new SqliteDayStore(db);
  const s = snap(initial());
  store.save({ ...s, satisfiedDays: new Set([d(9), d(10)]) });
  expect(store.load().engine.dispositions.has(d(10))).toBe(false);
  expect(store.load().satisfiedDays.has(d(10))).toBe(true);
  expect(
    db.get(
      'SELECT disposition,streak_satisfied,earned_xp,goal_met FROM account_day WHERE local_day=?',
      [d(10)],
    ),
  ).toEqual({ disposition: null, streak_satisfied: 1, earned_xp: 0, goal_met: 0 });
});
it('[INV-DAY-08] day persistence preserves existing goal amounts, XP and chest provenance', () => {
  const db = open(),
    store = new SqliteDayStore(db);
  db.run(
    'INSERT INTO account_day(local_day,goal_xp,earned_xp,goal_met,chest_granted_at,goal_xp_at_grant) VALUES(?,20,45,1,?,20)',
    [d(9), '2026-09-09T12:00:00Z'],
  );
  db.run('UPDATE account SET daily_goal_xp=50');
  store.save(snap(initial()));
  expect(
    db.get(
      'SELECT goal_xp,earned_xp,goal_met,chest_granted_at,goal_xp_at_grant FROM account_day WHERE local_day=?',
      [d(9)],
    ),
  ).toEqual({
    goal_xp: 20,
    earned_xp: 45,
    goal_met: 1,
    chest_granted_at: '2026-09-09T12:00:00Z',
    goal_xp_at_grant: 20,
  });
});
it('[INV-CER-01] a final account-marker write failure rolls back freeze consumption and decided dates', () => {
  const db = open(),
    store = new SqliteDayStore(db);
  store.save(snap(initial()));
  const before = comparable(store.load());
  const engine = rolloverTo(initial(), d(13), { completedDays: new Set([d(9)]) }).state;
  const broken: Db = {
    ...db,
    run(sql, params) {
      db.run(sql, params);
      if (sql.startsWith('UPDATE account SET last_processed_day'))
        throw Error('kill after day markers');
    },
  };
  expect(() => new SqliteDayStore(broken).save(snap(engine))).toThrow('kill after day markers');
  expect(comparable(store.load())).toEqual(before);
  expect(db.all('SELECT consumed_for_day FROM account_freeze')).toEqual([
    { consumed_for_day: null },
    { consumed_for_day: null },
  ]);
});
it('[INV-FRZ-01] a grant bought after a missed day cannot be assigned to that historical consumption', () => {
  const db = open(),
    store = new SqliteDayStore(db);
  const engine = {
    ...initial(),
    ledger: {
      cap: 2,
      grants: [
        {
          grantKey: 'late',
          channel: 'reward_chest' as const,
          subtype: null,
          ownedFromDay: d(12),
          requested: 1,
          applied: 1,
        },
      ],
      consumptions: [{ consumedForDay: d(10), consumedOnDay: d(13) }],
    },
  };
  expect(() => store.save(snap(engine))).toThrow(/owned/);
  expect(db.all('SELECT * FROM account_freeze_grant')).toEqual([]);
});
it('[INV-DAY-06] decided history and high-water markers cannot be erased by stale state', () => {
  const db = open(),
    store = new SqliteDayStore(db);
  store.save(snap(initial()));
  const engine = rolloverTo(initial(), d(13), { completedDays: new Set([d(9)]) }).state;
  store.save(snap(engine));
  expect(() => store.save(snap(initial()))).toThrow(/history|backward/);
  expect(store.load().engine.lastProcessedDay).toBe(d(12));
});
it('[INV-DAT-03] unknown legacy freeze provenance remains present and raises a recoverable error', () => {
  const db = open(),
    store = new SqliteDayStore(db);
  db.run(
    "INSERT INTO account_freeze(freeze_id,acquired_on_day,consumed_for_day) VALUES('legacy','2026-09-08','2026-09-10')",
  );
  const before = db.all('SELECT * FROM account_freeze');
  expect(() => store.load()).toThrow(/legacy/i);
  expect(() => store.save(snap(initial()))).toThrow(/legacy/i);
  expect(db.all('SELECT * FROM account_freeze')).toEqual(before);
});
it('[INV-DAY-04] partial last-completion zone metadata is rejected without being filled from the current device', () => {
  const db = open(),
    store = new SqliteDayStore(db);
  db.run("UPDATE account SET last_completed_at_utc_ms=123,last_tz_id='America/Chicago'");
  expect(() => store.load()).toThrow(/zone|guard/);
  expect(db.get('SELECT last_utc_offset_minutes FROM account')?.last_utc_offset_minutes).toBeNull();
});

it('[INV-DAY-06] legacy nonzero streak without a processed disposition ledger remains recoverable unknown history', () => {
  const db = open(),
    store = new SqliteDayStore(db);
  db.run('UPDATE account SET streak=22,longest_streak=22');
  db.run(
    "INSERT INTO account_day(local_day,goal_xp,earned_xp,goal_met) VALUES('2026-09-09',20,25,1)",
  );
  const before = db.all('SELECT * FROM account_day');
  expect(() => store.load()).toThrow(/legacy.*streak/i);
  expect(() => store.save(snap(initial()))).toThrow(/legacy.*streak/i);
  expect(db.all('SELECT * FROM account_day')).toEqual(before);
  expect(db.get('SELECT streak FROM account')?.streak).toBe(22);
});

it('[INV-REC-01][INV-DAY-06] an actual monthly repair retains exactly its repainted days after reload', () => {
  const db = open(),
    store = new SqliteDayStore(db);
  store.save(snap(initial()));
  const broken = rolloverTo(initial(), d(13), { completedDays: new Set([d(9)]) }).state;
  store.save(snap(broken));
  const repaired = repairStreak(store.load().engine, d(13));
  expect(repaired.restored).toBe(true);
  store.save(snap(repaired.state));
  expect(store.load().engine.repairs).toEqual(repaired.state.repairs);
  expect(store.load().engine.dispositions.get(d(12))).toBe('recovered');
  expect(store.load().satisfiedDays.has(d(13))).toBe(false);
  expect(repairStreak(store.load().engine, d(13)).restored).toBe(false);
});
it('[INV-DAY-07][INV-DAY-16] a collapsed absence and its exact month settlements survive reload', () => {
  const db = open(),
    store = new SqliteDayStore(db);
  store.save(snap(initial()));
  const result = rolloverTo(initial(), toLocalDay('2026-11-20'), {
    completedDays: new Set([d(9)]),
  });
  expect(result.state.longAbsences.length).toBeGreaterThan(0);
  store.save(snap(result.state));
  const loaded = store.load();
  expect(loaded.engine.longAbsences).toEqual(result.state.longAbsences);
  expect(loaded.engine.settlements).toEqual(result.state.settlements);
  expect(
    rolloverTo(loaded.engine, toLocalDay('2026-11-20'), { completedDays: loaded.satisfiedDays })
      .events,
  ).toEqual([]);
});

it('[INV-FRZ-05] a consumed freeze and its decided calendar cell must agree on reload', () => {
  const db = open(),
    store = new SqliteDayStore(db);
  store.save(snap(initial()));
  const rolled = rolloverTo(initial(), d(11), { completedDays: new Set([d(9)]) }).state;
  store.save(snap(rolled));
  db.run("UPDATE account_day SET disposition='missed' WHERE local_day=?", [d(10)]);
  expect(() => store.load()).toThrow(/freeze.*disposition/);
  expect(
    db.get('SELECT consumed_for_day FROM account_freeze WHERE consumed_for_day IS NOT NULL')
      ?.consumed_for_day,
  ).toBe(d(10));
});
it('[INV-FRZ-01] a frozen calendar day without an actual consumed unit cannot preserve a streak', () => {
  const db = open(),
    store = new SqliteDayStore(db);
  store.save(snap(initial()));
  db.run("INSERT INTO account_day(local_day,goal_xp,disposition) VALUES(?,20,'frozen')", [d(10)]);
  expect(() => store.load()).toThrow(/freeze.*disposition/);
});
