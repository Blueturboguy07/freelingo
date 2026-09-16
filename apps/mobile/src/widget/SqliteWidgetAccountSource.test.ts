// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { migrate } from '@freelingo/schema';
import { openPack, type PackReader, type PackState } from '@freelingo/core/packs';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { SqliteWordStore } from '../db/SqliteWordStore';
import type { ResumeInspection } from '../db/learningResume';
import { SqliteAppState } from '../services/SqliteAppState';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import { SqliteWidgetAccountSource } from './SqliteWidgetAccountSource';
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
const now = Date.parse('2026-09-14T12:00:00Z');
const hash = 'a'.repeat(64);
const clock = { nowMs: now, zone: 'UTC' };
function fixture(fresh = true, knownPath = true) {
  const db = createNodeDb();
  migrate(db);
  closers.push(() => db.close());
  if (fresh)
    new SqliteWordStore(db).initializeFreshHistory(now - 86400000, { databaseWasCreated: true });
  const state = new SqliteAppState(db);
  state.initialize(7);
  if (!knownPath)
    db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-es','2026-09-13')");
  state.selectCourse('en-es', new Date(now - 86400000).toISOString());
  db.run(
    "UPDATE course_progress SET pack_state='installed',pack_content_hash=? WHERE course_id='en-es'",
    [hash],
  );
  state.completeOnboarding('en-es', hash, new Date(now - 86400000).toISOString());
  db.run("UPDATE account SET last_processed_day='2026-09-13'");
  db.run("INSERT INTO account_day(local_day,goal_xp) VALUES('2026-09-14',20)");
  const source = new DatabaseSync(
    new URL('../../../../tools/coursekit/tests/fixtures/path/loader-pack.sqlite', import.meta.url),
    { readOnly: true },
  );
  closers.push(() => source.close());
  const reader: PackReader = {
    all: <T>(sql: string, p: readonly unknown[] = []) =>
      source.prepare(sql).all(...(p as never[])) as T[],
    get: <T>(sql: string, p: readonly unknown[] = []) =>
      source.prepare(sql).get(...(p as never[])) as T | undefined,
  };
  const pack = openPack(reader, { packRoot: '/test-only-pack' });
  const verified = { courseId: 'en-es', contentHash: hash, pack } as VerifiedInstalledPack;
  let selected: VerifiedInstalledPack | null = verified;
  let packState: PackState = 'installed';
  const packs = {
    get: vi.fn((id: string) => (id === 'en-es' ? selected : null)),
    state: vi.fn(() => packState),
  };
  const resume = vi.fn<(_courseId: string) => ResumeInspection>(() => ({ status: 'none' }));
  const result = new SqliteWidgetAccountSource(db, packs, { readResumableCourse: resume });
  return {
    db,
    result,
    packs,
    verified,
    resume,
    setPack: (v: VerifiedInstalledPack | null) => {
      selected = v;
    },
    setPackState: (v: PackState) => {
      packState = v;
    },
  };
}
function unchanged(f: ReturnType<typeof fixture>) {
  return f.db.get('SELECT total_changes() AS n');
}
it('[INV-WID-01][INV-WID-05][INV-WID-09] actual fresh account, path and day facts produce an exact course snapshot without source writes', async () => {
  const f = fixture(),
    before = unchanged(f);
  expect(await f.result.readCommitted(clock)).toMatchObject({
    kind: 'known',
    localDay: '2026-09-14',
    lifetimeSessions: 0,
    streak: 0,
    goalXp: 20,
    course: { courseId: 'en-es', activeNodeId: 'u001:learn', hasResumableSession: false },
  });
  expect(f.resume).toHaveBeenCalledExactlyOnceWith('en-es');
  expect(unchanged(f)).toEqual(before);
  expect(f.db.all('SELECT * FROM course_node')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_session_state')).toEqual([]);
});
it('[INV-WID-10] migration zeros and a known path cannot manufacture global lifetime evidence', async () => {
  const f = fixture(false),
    before = unchanged(f);
  expect(await f.result.readCommitted(clock)).toEqual({
    kind: 'unavailable',
    reason: 'unknown-history',
  });
  expect(unchanged(f)).toEqual(before);
});
it('[INV-WID-09][INV-WID-10] only the exact current-course and current-pack resume proof may set the resumable flag', async () => {
  const f = fixture();
  const ready = {
    status: 'ready',
    candidate: {
      courseId: 'en-es',
      sessionId: 'saved-hub',
      nodeRef: '2026-09-13/en-es/today/',
      packContentHash: hash,
    },
  } as const;
  // Explicit boundary doubles here; the concrete runtime owns validation of the saved rows.
  f.resume.mockReturnValue(ready);
  expect(await f.result.readCommitted(clock)).toMatchObject({
    kind: 'known',
    course: { hasResumableSession: true },
  });
  for (const candidate of [
    { ...ready.candidate, courseId: 'en-fr' },
    { ...ready.candidate, packContentHash: 'b'.repeat(64) },
  ]) {
    f.resume.mockReturnValue({ status: 'ready', candidate });
    expect((await f.result.readCommitted(clock)).kind).toBe('unavailable');
  }
});
it('[INV-WID-09] ambiguous or unsupported saved sources stay unknown instead of claiming no live session', async () => {
  const f = fixture();
  f.resume.mockReturnValue({ status: 'unavailable', reason: 'multiple-parked-sessions' });
  const before = unchanged(f);
  expect((await f.result.readCommitted(clock)).kind).toBe('unavailable');
  expect(unchanged(f)).toEqual(before);
});
it('[INV-WID-02][INV-WID-10] a removed active course or unavailable verified pack never substitutes another installed course', async () => {
  const f = fixture();
  f.db.run('UPDATE course_selection SET is_active=0');
  expect(await f.result.readCommitted(clock)).toEqual({
    kind: 'unavailable',
    reason: 'no-active-course',
  });
  f.db.run("UPDATE course_selection SET is_active=1 WHERE course_id='en-es'");
  f.setPack(null);
  expect((await f.result.readCommitted(clock)).kind).toBe('unavailable');
  f.setPack({ ...f.verified, courseId: 'en-fr' });
  expect((await f.result.readCommitted(clock)).kind).toBe('unavailable');
});
it('[INV-WID-10][INV-PACK-04] partial audio preserves a verified path while corrupt, unsigned and withdrawn packs remain unavailable', async () => {
  const f = fixture();
  f.setPackState('partial');
  expect((await f.result.readCommitted(clock)).kind).toBe('known');
  for (const state of ['corrupt', 'unverified', 'withdrawn', 'not-downloaded'] as const) {
    f.setPackState(state);
    expect((await f.result.readCommitted(clock)).kind).toBe('unavailable');
  }
});
it('[INV-WID-10][INV-PATH-06] stale day, legacy path history and changed pack identity cannot produce a current snapshot', async () => {
  const f = fixture();
  expect((await f.result.readCommitted({ ...clock, nowMs: now + 86400000 })).kind).toBe(
    'unavailable',
  );
  expect((await f.result.readCommitted({ ...clock, zone: 'not/a/zone' })).kind).toBe('unavailable');
  f.setPack({ ...f.verified, contentHash: 'b'.repeat(64) });
  expect((await f.result.readCommitted(clock)).kind).toBe('unavailable');
  const legacy = fixture(true, false);
  const before = unchanged(legacy);
  expect((await legacy.result.readCommitted(clock)).kind).toBe('unavailable');
  expect(unchanged(legacy)).toEqual(before);
});
it('[INV-PATH-01][INV-PATH-09][INV-WID-02] completed first unit moves the link to the exact next node without writing progress or changing the viewport', async () => {
  const f = fixture();
  f.db.run(
    "INSERT INTO course_node VALUES('en-es','u001:learn','u001','1','lesson',0,2,2,'2026-09-13T00:00:00Z',NULL)",
  );
  const before = unchanged(f);
  expect(await f.result.readCommitted(clock)).toMatchObject({
    kind: 'known',
    course: { activeNodeId: 'u002:learn' },
  });
  expect(unchanged(f)).toEqual(before);
});
it('[INV-WID-05][INV-WID-10] onboarding, unsettled or invalid runtime reads never publish a fabricated ready account', async () => {
  const f = fixture();
  f.db.run("UPDATE account_onboarding SET step='goal',completed_at_utc=NULL");
  expect((await f.result.readCommitted(clock)).kind).toBe('unavailable');
  f.db.run("UPDATE account_onboarding SET step='complete',completed_at_utc='2026-09-13T00:00:00Z'");
  f.resume.mockImplementation(() => {
    throw Error('saved evidence unavailable');
  });
  expect((await f.result.readCommitted(clock)).kind).toBe('unavailable');
});

it('[INV-WID-02][INV-PATH-09] a completed declared path yields no fabricated next node', async () => {
  const f = fixture();
  f.db.run(
    "INSERT INTO course_node VALUES('en-es','u001:learn','u001','1','lesson',0,2,2,'2026-09-13T00:00:00Z',NULL)",
  );
  f.db.run(
    "INSERT INTO course_node VALUES('en-es','u002:learn','u002','1','lesson',1,2,2,'2026-09-14T00:00:00Z',NULL)",
  );
  expect(await f.result.readCommitted(clock)).toMatchObject({
    kind: 'known',
    course: { activeNodeId: null },
  });
});

// Preserved independent source/ceremony witnesses; imports adjusted only for repository paths.
import { rowAt } from '../../../../packages/core/src/day/__testsupport__';
import { readResumeCandidate } from '../db/learningResume';
import { SqliteCeremonyStore } from '../db/SqliteCeremonyStore';
import { ceremonyState } from '../../../../packages/core/src/ceremony/__falsifiers__/fixtures';
import { runCeremony } from '@freelingo/core/ceremony';
function committed(f: ReturnType<typeof fixture>, id = 'jump', flavour = 'jumpHere') {
  const r = rowAt({
    sessionId: id,
    startUtc: '2026-09-14T10:00:00Z',
    durationMs: 60000,
    tzId: 'UTC',
    xp: 13,
  });
  const v = {
    session_id: r.sessionId,
    committed_at: new Date(r.derivedCompletionUtcMs).toISOString(),
    flavour,
    outcome: 'completed',
    graded_attempts: 1,
    xp_awarded: 13,
    gems_awarded: 0,
    started_at_utc_ms: r.startedAtUtcMs,
    start_tz_id: r.startZone.tzId,
    start_utc_offset_minutes: r.startZone.utcOffsetMinutes,
    start_tz_source: r.startZone.tzSource,
    started_local_day: r.startedLocalDay,
    completed_at_utc_ms: r.completedAtUtcMs,
    completion_tz_id: r.completionZone.tzId,
    completion_utc_offset_minutes: r.completionZone.utcOffsetMinutes,
    completion_tz_source: r.completionZone.tzSource,
    completed_local_day: r.completedLocalDay,
    derived_completion_utc_ms: r.derivedCompletionUtcMs,
    credited_local_day: r.creditedLocalDay,
    reward_local_day: r.rewardLocalDay,
    credited_by_grace: Number(r.creditedByGrace),
    day_keying_deferred: Number(r.dayKeyingDeferred),
  };
  f.db.run(
    'INSERT INTO committed_session(' +
      Object.keys(v).join(',') +
      ') VALUES(' +
      Object.keys(v)
        .map(() => '?')
        .join(',') +
      ')',
    Object.values(v),
  );
  f.db.run('INSERT INTO course_session_commit_link VALUES(?,?,?,?,NULL,NULL)', [
    id,
    'en-es',
    'u002:learn',
    flavour,
  ]);
  f.db.run('UPDATE account SET streak=1');
  f.db.run("UPDATE account_day SET earned_xp=13,streak_satisfied=1 WHERE local_day='2026-09-14'");
}
it('[INV-WID-02][INV-PATH-09] independent passed jump advances exact widget target without completing earlier unit', async () => {
  const f = fixture();
  committed(f);
  f.db.run("INSERT INTO course_path_jump VALUES('en-es','u002','jump')");
  const before = unchanged(f);
  expect(await f.result.readCommitted(clock)).toMatchObject({
    kind: 'known',
    course: { activeNodeId: 'u002:learn' },
  });
  expect(unchanged(f)).toEqual(before);
  expect(f.db.all('SELECT * FROM course_node')).toEqual([]);
});
it('[INV-WID-02][INV-PATH-09] completed final jumped frontier never redirects to intentionally skipped earlier lessons', async () => {
  const f = fixture();
  committed(f);
  f.db.run("INSERT INTO course_path_jump VALUES('en-es','u002','jump')");
  f.db.run(
    "INSERT INTO course_node VALUES('en-es','u002:learn','u002','1','lesson',1,2,2,'2026-09-14T10:01:00Z',NULL)",
  );
  const before = unchanged(f);
  expect(await f.result.readCommitted(clock)).toMatchObject({
    kind: 'known',
    course: { activeNodeId: null },
  });
  expect(unchanged(f)).toEqual(before);
});
it('[INV-WID-10][INV-PATH-09] wrong jump source binding cannot create a later frontier', async () => {
  const f = fixture();
  committed(f);
  f.db.run("INSERT INTO course_path_jump VALUES('en-es','u001','jump')");
  const before = unchanged(f);
  expect((await f.result.readCommitted(clock)).kind).toBe('unavailable');
  expect(unchanged(f)).toEqual(before);
});
it('[INV-CER-01][INV-WID-05] actual committed pending ceremony preserves known earned streak with no resumable lesson', async () => {
  const f = fixture();
  committed(f, 'ceremony', 'lesson');
  const state = ceremonyState({}, { courseId: 'en-es' }, { sessionId: 'ceremony', xp: 13 });
  const receipt = {
    schemaVersion: 1 as const,
    state,
    result: runCeremony(state),
    facts: {
      courseName: 'Spanish',
      combo: 1,
      accuracy: 1,
      xpExplanation: '',
      unitIndex: 1,
      unitName: 'Basics',
      sectionName: 'A1',
      score: 1,
    },
  };
  const store = new SqliteCeremonyStore(f.db, () => new Date(now).toISOString());
  store.insert(receipt);
  expect(store.pending()?.receipt).toEqual(receipt);
  const reader = {
    readResumableCourse: (id: string) =>
      readResumeCandidate(f.db, id, () => {
        throw Error('terminal ceremony must not resolve a source');
      }),
  };
  expect(reader.readResumableCourse('en-es')).toMatchObject({
    status: 'unavailable',
    reason: 'pending-ceremony',
  });
  const account = new SqliteWidgetAccountSource(f.db, f.packs, reader),
    before = unchanged(f);
  expect(await account.readCommitted(clock)).toMatchObject({
    kind: 'known',
    streak: 1,
    earnedXp: 13,
    course: { hasResumableSession: false },
  });
  expect(unchanged(f)).toEqual(before);
  expect(store.pending()?.index).toBe(0);
});
it('[INV-WID-10] malformed declared node completion cannot be hidden by a valid origin marker', async () => {
  const f = fixture();
  f.db.run(
    "INSERT INTO course_node VALUES('en-es','u001:learn','u001','1','lesson',0,2,1,'2026-09-14T10:01:00Z',NULL)",
  );
  const before = unchanged(f);
  expect((await f.result.readCommitted(clock)).kind).toBe('unavailable');
  expect(unchanged(f)).toEqual(before);
});
it('[INV-WID-10] explicit unreliable clock cannot publish a ready account from valid cached day rows', async () => {
  const f = fixture();
  f.db.run('UPDATE account SET clock_unreliable=1');
  const before = unchanged(f);
  expect(await f.result.readCommitted(clock)).toEqual({
    kind: 'unavailable',
    reason: 'unreliable-clock',
  });
  expect(unchanged(f)).toEqual(before);
});
