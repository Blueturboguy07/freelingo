// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { SqliteAppState } from './SqliteAppState';

const databases: ReturnType<typeof createNodeDb>[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});
const now = '2026-09-13T10:00:00.000Z';
function setup() {
  const db = createNodeDb();
  databases.push(db);
  migrate(db);
  const app = new SqliteAppState(db);
  app.initialize(17);
  return { db, app };
}
function install(db: ReturnType<typeof createNodeDb>, id: string, state = 'installed') {
  db.run('UPDATE course_progress SET pack_content_hash=?,pack_state=? WHERE course_id=?', [
    'hash:' + id,
    state,
    id,
  ]);
}
describe('durable application selection S001–S009 / S133', () => {
  it('starts without an invented course and keeps the one selection seed across restart', () => {
    const { db, app } = setup();
    expect(app.read()).toEqual({
      step: 'courses',
      completedAtUtc: null,
      selectionSeed: 17,
      activeCourseId: null,
      selectedCourse: null,
      courseIds: [],
    });
    new SqliteAppState(db).initialize(999);
    expect(app.read().selectionSeed).toBe(17);
    expect(db.all('SELECT * FROM course_progress')).toEqual([]);
  });
  it('persists an explicit undownloaded choice without claiming installation or activation', () => {
    const { db, app } = setup();
    app.selectCourse('en-es', now);
    const restored = new SqliteAppState(db).read();
    expect(restored.selectedCourse).toEqual({
      courseId: 'en-es',
      placementChoice: null,
      selfReportLevel: null,
      placementSectionIndex: null,
    });
    expect(restored.activeCourseId).toBeNull();
    expect(db.get('SELECT pack_state,pack_content_hash FROM course_progress')).toEqual({
      pack_state: 'not-downloaded',
      pack_content_hash: null,
    });
  });
  it('[INV-ECO-04] repeated selection never resets earned account or course state', () => {
    const { db, app } = setup();
    app.selectCourse('en-es', now);
    db.run('UPDATE account SET lifetime_xp=123,gems=7');
    db.run('UPDATE course_progress SET xp=33,score=3');
    install(db, 'en-es');
    app.selectCourse('en-es', '2026-09-14T10:00:00.000Z');
    expect(db.get('SELECT lifetime_xp,gems FROM account')).toEqual({ lifetime_xp: 123, gems: 7 });
    expect(db.get('SELECT xp,score,added_at,pack_content_hash FROM course_progress')).toEqual({
      xp: 33,
      score: 3,
      added_at: now,
      pack_content_hash: 'hash:en-es',
    });
  });
  it('a failed selection write rolls back creation and retains the prior selected course', () => {
    const { db, app } = setup();
    app.selectCourse('en-es', now);
    db.run(
      "CREATE TRIGGER fail_selection BEFORE INSERT ON course_selection WHEN NEW.course_id='en-fr' BEGIN SELECT RAISE(ABORT,'disk full'); END",
    );
    expect(() => app.selectCourse('en-fr', now)).toThrow('disk full');
    expect(app.read().selectedCourse?.courseId).toBe('en-es');
    expect(app.read().courseIds).toEqual(['en-es']);
  });
  it('rejects stale asynchronous onboarding transitions without overwriting the newer step', () => {
    const { app } = setup();
    app.selectCourse('en-es', now);
    expect(app.transition('courses', 'pack-detail')).toBe(true);
    expect(app.transition('courses', 'restore')).toBe(false);
    expect(app.read().step).toBe('pack-detail');
  });
  it('persists placement answers per course without turning a self report into passed placement', () => {
    const { db, app } = setup();
    app.selectCourse('en-es', now);
    app.choosePlacement('test');
    app.chooseLevel('basic');
    app.selectCourse('en-fr', now);
    app.choosePlacement('scratch');
    app.selectCourse('en-es', now);
    expect(new SqliteAppState(db).read().selectedCourse).toEqual({
      courseId: 'en-es',
      placementChoice: 'test',
      selfReportLevel: 'basic',
      placementSectionIndex: null,
    });
    expect(db.get("SELECT score_floor FROM course_progress WHERE course_id='en-es'")).toEqual({
      score_floor: 0,
    });
  });
  it.each(['not-downloaded', 'corrupt', 'unverified', 'withdrawn'])(
    'refuses onboarding entry for %s bytes',
    (state) => {
      const { db, app } = setup();
      app.selectCourse('en-es', now);
      install(db, 'en-es', state);
      expect(() => app.completeOnboarding('en-es', 'hash:en-es', now)).toThrow(
        /verified|playable/i,
      );
      expect(app.read().activeCourseId).toBeNull();
      expect(app.read().step).toBe('courses');
    },
  );
  it('[INV-PACK-04] partial audio retains verified course entry and completion survives restart', () => {
    const { db, app } = setup();
    app.selectCourse('en-es', now);
    install(db, 'en-es', 'partial');
    app.completeOnboarding('en-es', 'hash:en-es', now);
    const restored = new SqliteAppState(db).read();
    expect(restored).toMatchObject({
      activeCourseId: 'en-es',
      step: 'complete',
      completedAtUtc: now,
    });
    app.completeOnboarding('en-es', 'hash:en-es', '2026-09-14T10:00:00.000Z');
    expect(app.read().completedAtUtc).toBe(now);
  });
  it('rejects changed pack bytes and a stale selected course at entry', () => {
    const { db, app } = setup();
    app.selectCourse('en-es', now);
    install(db, 'en-es');
    expect(() => app.completeOnboarding('en-es', 'different', now)).toThrow(/identity/i);
    app.selectCourse('en-fr', now);
    install(db, 'en-fr');
    expect(() => app.completeOnboarding('en-es', 'hash:en-es', now)).toThrow(/selected/i);
    expect(app.read().activeCourseId).toBeNull();
  });
  it('completion failure cannot partially activate a course', () => {
    const { db, app } = setup();
    app.selectCourse('en-es', now);
    install(db, 'en-es');
    db.run(
      "CREATE TRIGGER fail_onboarding BEFORE UPDATE ON account_onboarding BEGIN SELECT RAISE(ABORT,'write failed'); END",
    );
    expect(() => app.completeOnboarding('en-es', 'hash:en-es', now)).toThrow('write failed');
    expect(app.read().activeCourseId).toBeNull();
  });
  it('switches among existing courses atomically, including unavailable packs for read-only settings', () => {
    const { db, app } = setup();
    app.selectCourse('en-es', now);
    install(db, 'en-es');
    app.completeOnboarding('en-es', 'hash:en-es', now);
    app.selectCourse('en-fr', now);
    db.run(
      "CREATE TRIGGER fail_switch BEFORE UPDATE ON course_selection WHEN NEW.course_id='en-fr' AND NEW.is_active=1 BEGIN SELECT RAISE(ABORT,'switch failed'); END",
    );
    expect(() => app.switchCourse('en-fr')).toThrow('switch failed');
    expect(app.read().activeCourseId).toBe('en-es');
    db.run('DROP TRIGGER fail_switch');
    app.switchCourse('en-fr');
    expect(app.read().activeCourseId).toBe('en-fr');
    expect(() => app.switchCourse('missing')).toThrow(/course/i);
    expect(app.read().activeCourseId).toBe('en-fr');
  });
  it('[INV-CRS-03] a removed course cannot be restored by a stale switch callback', () => {
    const { db, app } = setup();
    app.selectCourse('en-es', now);
    db.run('DELETE FROM course_progress');
    expect(() => app.switchCourse('en-es')).toThrow(/course/i);
    expect(app.read().selectedCourse).toBeNull();
    expect(app.read().courseIds).toEqual([]);
  });
  it('rejects corrupt persisted seed/enum values instead of resetting progress', () => {
    const { db, app } = setup();
    db.run('PRAGMA ignore_check_constraints=ON');
    db.run("UPDATE account_onboarding SET step='invented'");
    expect(() => app.read()).toThrow(/onboarding/i);
    db.run("UPDATE account_onboarding SET step='courses'");
    db.run('UPDATE account SET selection_seed=-1');
    expect(() => app.initialize(20)).toThrow(/seed/i);
  });
  it('[INV-SEC-01] binds course identifiers as values and rejects empty identifiers', () => {
    const { app } = setup();
    const id = "en-es'; DROP TABLE account; --";
    app.selectCourse(id, now);
    expect(app.read().courseIds).toEqual([id]);
    expect(() => app.selectCourse(' ', now)).toThrow(/course/i);
    expect(() => app.selectCourse('en-fr', 'invalid')).toThrow(/time/i);
  });
});
