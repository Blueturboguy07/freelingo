// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { migrate, type Db } from '@freelingo/schema';
import {
  applyEncounter,
  asItemId,
  asSessionId,
  emptySchedulerState,
  introduce,
  registerRows,
  rowKeyOf,
  type SchedulerState,
} from '@freelingo/core/scheduler';
import type { Answer } from '@freelingo/core/session';
import { SqliteSchedulerStore, type SchedulerAnswerEvidence } from './SqliteSchedulerStore';

const files: string[] = [];
const opened: Db[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.length = 0;
  for (const dir of files) rmSync(dir, { recursive: true, force: true });
  files.length = 0;
});
const COURSE = 'en-es';
const ZONE = 'America/Chicago';
const item = asItemId('content-hashed-memory-item');
const epoch = Date.parse('2026-09-13T12:00:00.000Z');
function open(location = ':memory:') {
  const db = createNodeDb({ location });
  opened.push(db);
  migrate(db);
  return db;
}
function seed(db: Db) {
  db.run('INSERT INTO course_progress(course_id,added_at) VALUES(?,?)', [
    COURSE,
    new Date(epoch).toISOString(),
  ]);
  db.run('INSERT INTO course_item(course_id,item_id,countable) VALUES(?,?,1)', [COURSE, item]);
}
function state(): SchedulerState {
  let s = registerRows(emptySchedulerState(ZONE), [
    { itemId: item, surface: 'el niño', kind: 'lexeme', modalities: ['text', 'listening'] },
    { itemId: item, surface: 'la niña', kind: 'lexeme', modalities: ['speaking'] },
  ]);
  s = introduce(s, item, 'el niño', new Date(epoch));
  return s;
}
function evidence(index: number, at: number): SchedulerAnswerEvidence {
  const answer: Answer = {
    exerciseIndex: index,
    slotId: 'slot-' + index,
    itemId: item,
    type: 'meaningSelect',
    verdict: 'correct',
    softCorrected: false,
    wrong: false,
    costPaid: 0,
    skipped: false,
    scorable: true,
    queue: index < 0 ? 'mistakes' : 'main',
    note: null,
  };
  return {
    sessionId: 'run-1',
    exerciseId: 'exact-exercise-' + index,
    packContentHash: 'verified-pack-content-hash',
    answer,
    surface: 'el niño',
    role: 'recognition',
    rubyShown: false,
    answeredAtUtc: new Date(at).toISOString(),
    activeMs: 4000,
  };
}
function reviewed(s: SchedulerState, index: number, at: number) {
  return applyEncounter(s, {
    sessionId: asSessionId('run-1'),
    exerciseIndex: index,
    itemId: item,
    surface: 'el niño',
    role: 'recognition',
    grade: 3,
    at: new Date(at),
  }).state;
}
function comparable(s: SchedulerState) {
  return {
    rows: [...s.rows].map(([key, row]) => [
      key,
      {
        ...row,
        modalities: [...row.modalities].sort(),
        card: { ...row.card, last_review: row.card.last_review ?? null },
      },
    ]),
    attempts: [...s.attempts.rows],
    holds: new Set(s.holds),
    anomalies: s.anomalies,
    introductions: {
      records: s.introductions.records,
      firstIntroducedAt: [...s.introductions.firstIntroducedAt],
      firstExposuresByDay: [...s.introductions.firstExposuresByDay].map(([d, ids]) => [
        d,
        [...ids],
      ]),
    },
    score: {
      masteredItemIds: [...s.score.masteredItemIds],
      masteryHighWaterPoints: s.score.masteryHighWaterPoints,
    },
  };
}

describe('real SQLite scheduler boundary', () => {
  it('[INV-SCH-11] restores independent accepted-surface cards and introduction proof after close/reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'freelingo-scheduler-'));
    files.push(dir);
    const path = join(dir, 'progress.sqlite');
    const db = open(path);
    seed(db);
    let s = reviewed(state(), 0, epoch + 86400000);
    s = { ...s, score: { masteredItemIds: new Set([item]), masteryHighWaterPoints: 9 } };
    new SqliteSchedulerStore(db).save(COURSE, s, [evidence(0, epoch + 86400000)]);
    db.close();
    opened.splice(opened.indexOf(db), 1);
    const reloaded = new SqliteSchedulerStore(open(path)).load(COURSE, ZONE);
    expect(comparable(reloaded)).toEqual(comparable(s));
    expect(reloaded.rows.get(rowKeyOf(item, 'la niña'))?.introducedAt).toBeNull();
    expect(reloaded.rows.get(rowKeyOf(item, 'el niño'))?.card.last_review).toBeInstanceOf(Date);
    expect(reloaded.rows.get(rowKeyOf(item, 'el niño'))?.card.due).toBeInstanceOf(Date);
  });
  it('[INV-SCH-03] retains real chronological insertion order including negative replay indices and backward wall time', () => {
    const db = open();
    seed(db);
    const store = new SqliteSchedulerStore(db);
    let s = reviewed(state(), 0, epoch + 86400000);
    s = reviewed(s, -2, epoch + 86400001);
    s = reviewed(s, 1, epoch + 86399999);
    const receipts = [
      evidence(0, epoch + 86400000),
      evidence(-2, epoch + 86400001),
      evidence(1, epoch + 86399999),
    ];
    store.save(COURSE, s, receipts);
    const before = db.all('SELECT * FROM course_attempt');
    store.save(COURSE, s, receipts);
    expect(db.all('SELECT * FROM course_attempt')).toEqual(before);
    expect(
      [...store.load(COURSE, ZONE).attempts.rows.values()].map((a) => a.exerciseIndex),
    ).toEqual([0, -2, 1]);
    expect(comparable(store.load(COURSE, ZONE))).toEqual(comparable(s));
  });
  it('[INV-SCH-07] preserves closed and open hold windows and their actual resumed FSRS effect', () => {
    const db = open();
    seed(db);
    const store = new SqliteSchedulerStore(db);
    let s = reviewed(state(), 0, epoch + 86400000);
    s = {
      ...s,
      holds: [
        {
          scope: { kind: 'modality', modality: 'listening' },
          reason: 'modalityDisabled',
          from: new Date(epoch),
          until: null,
        },
        {
          scope: { kind: 'item', itemId: item },
          reason: 'report',
          from: new Date(epoch + 86400000),
          until: new Date(epoch + 3 * 86400000),
        },
      ],
    };
    store.save(COURSE, s, [evidence(0, epoch + 86400000)]);
    const reloaded = store.load(COURSE, ZONE);
    expect(new Set(reloaded.holds)).toEqual(new Set(s.holds));
    expect(comparable(reviewed(reloaded, 1, epoch + 4 * 86400000))).toEqual(
      comparable(reviewed(s, 1, epoch + 4 * 86400000)),
    );
  });
  it('[INV-SCH-02] persists negative elapsed evidence without losing absent-row anomalies', () => {
    const db = open();
    seed(db);
    const store = new SqliteSchedulerStore(db);
    const s = {
      ...state(),
      anomalies: [
        {
          kind: 'negativeElapsed' as const,
          rowKey: rowKeyOf(item, 'el niño'),
          at: new Date(epoch),
          observedMs: -999,
          usedMs: 0,
          note: 'clock moved back',
        },
        {
          kind: 'uncreditedSurface' as const,
          rowKey: rowKeyOf(item, 'not introduced'),
          at: new Date(epoch),
          observedMs: null,
          usedMs: null,
          note: 'absent surface',
        },
      ],
    };
    store.save(COURSE, s);
    expect(store.load(COURSE, ZONE).anomalies).toEqual(s.anomalies);
  });
  it('[INV-PER-07] rolls back cards, introductions, attempts and mastery if the last write fails', () => {
    const db = open();
    seed(db);
    const store = new SqliteSchedulerStore(db);
    db.run(
      "CREATE TRIGGER fail_mastery BEFORE INSERT ON course_scheduler_mastery BEGIN SELECT RAISE(ABORT,'injected disk failure'); END",
    );
    const s = {
      ...reviewed(state(), 0, epoch + 86400000),
      score: { masteredItemIds: new Set([item]), masteryHighWaterPoints: 5 },
    };
    expect(() => store.save(COURSE, s, [evidence(0, epoch + 86400000)])).toThrow(
      'injected disk failure',
    );
    expect(db.all('SELECT * FROM course_item_surface')).toEqual([]);
    expect(db.all('SELECT * FROM course_introduction')).toEqual([]);
    expect(db.all('SELECT * FROM course_attempt')).toEqual([]);
    expect(
      db.get('SELECT mastery_high_water_points FROM course_progress')?.mastery_high_water_points,
    ).toBe(0);
  });
  it('[INV-SCH-03] refuses a new scheduler attempt with missing or mismatched exact answer evidence', () => {
    const db = open();
    seed(db);
    const store = new SqliteSchedulerStore(db);
    const s = reviewed(state(), 0, epoch + 86400000);
    expect(() => store.save(COURSE, s)).toThrow(/evidence/i);
    expect(() =>
      store.save(COURSE, s, [{ ...evidence(0, epoch + 86400000), surface: 'la niña' }]),
    ).toThrow(/surface/i);
    expect(db.all('SELECT * FROM course_attempt')).toEqual([]);
    expect(db.all('SELECT * FROM course_item_surface')).toEqual([]);
  });
  it('[INV-SCH-11] does not invent a surface introduction or full FSRS card from the legacy item summary', () => {
    const db = open();
    seed(db);
    db.run('UPDATE course_item SET stability=99,difficulty=5,reps=20,introduced_at=?,due_day=?', [
      new Date(epoch).toISOString(),
      '2026-10-01',
    ]);
    const s = new SqliteSchedulerStore(db).load(COURSE, ZONE);
    expect(s.rows.size).toBe(0);
    expect(s.introductions.records).toEqual([]);
  });
  it('[INV-CRS-03] refuses stale writes after course removal without recreating an account or course', () => {
    const db = open();
    seed(db);
    db.run('DELETE FROM course_progress WHERE course_id=?', [COURSE]);
    expect(() => new SqliteSchedulerStore(db).save(COURSE, state())).toThrow(/course/i);
    expect(db.all('SELECT * FROM course_progress')).toEqual([]);
    expect(db.get('SELECT lifetime_xp FROM account')?.lifetime_xp).toBe(0);
  });
  it('[INV-SCH-10] rejects a gapped durable introduction sequence before it can reorder a future append', () => {
    const db = open();
    seed(db);
    db.run(
      `INSERT INTO course_item_surface VALUES(?,?,?,'lexeme',?,NULL,0,0,0,0,0,0,0,0,0,?,'introduction')`,
      [COURSE, item, 'el niño', epoch, epoch],
    );
    db.run('INSERT INTO course_introduction VALUES(?,?,?,?,?,7)', [
      COURSE,
      item,
      'el niño',
      epoch,
      '2026-09-13',
    ]);
    const before = db.all('SELECT * FROM course_introduction');
    const store = new SqliteSchedulerStore(db);
    expect(() => store.load(COURSE, ZONE)).toThrow(/introduction sequence/i);
    expect(() => store.save(COURSE, state())).toThrow(/introduction sequence/i);
    expect(db.all('SELECT * FROM course_introduction')).toEqual(before);
  });
  it('[INV-SCH-02] rejects gapped anomaly order while preserving the original diagnostic bytes', () => {
    const db = open();
    seed(db);
    const store = new SqliteSchedulerStore(db);
    store.save(COURSE, state());
    db.run(
      "INSERT INTO course_scheduler_anomaly VALUES(?,7,'negativeElapsed',NULL,NULL,?,-5,0,'historical anomaly')",
      [COURSE, epoch],
    );
    const before = db.all('SELECT * FROM course_scheduler_anomaly');
    expect(() => store.load(COURSE, ZONE)).toThrow(/anomaly sequence/i);
    expect(() => store.save(COURSE, state())).toThrow(/anomaly sequence/i);
    expect(db.all('SELECT * FROM course_scheduler_anomaly')).toEqual(before);
  });
  it('[INV-SESS-21] retains the exact graded exercise variant and frozen pack hash after receipts are consumed', () => {
    const db = open();
    seed(db);
    const s = reviewed(state(), 0, epoch + 86400000);
    new SqliteSchedulerStore(db).save(COURSE, s, [evidence(0, epoch + 86400000)]);
    expect(db.get('SELECT exercise_id,pack_content_hash FROM course_attempt')).toEqual({
      exercise_id: 'exact-exercise-0',
      pack_content_hash: 'verified-pack-content-hash',
    });
  });
  it('[INV-SESS-21] missing pack-content evidence cannot append a new attempt or move a card', () => {
    const db = open();
    seed(db);
    const store = new SqliteSchedulerStore(db);
    const s = reviewed(state(), 0, epoch + 86400000);
    expect(() =>
      store.save(COURSE, s, [{ ...evidence(0, epoch + 86400000), packContentHash: '' }]),
    ).toThrow(/pack/i);
    expect(db.all('SELECT * FROM course_attempt')).toEqual([]);
    expect(db.all('SELECT * FROM course_item_surface')).toEqual([]);
  });
});
