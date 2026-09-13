// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { migrate } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import type { OnboardingCourse } from '../onboarding/ports';
import { SqliteAppState } from './SqliteAppState';
import { createOnboardingFlow, type OnboardingFlowPorts } from './onboarding';
const dbs: ReturnType<typeof createNodeDb>[] = [];
afterEach(() => {
  for (const db of dbs) db.close();
  dbs.length = 0;
});
const now = '2026-09-13T10:00:00.000Z';
const card: OnboardingCourse = {
  id: 'en-es',
  language: 'es',
  languageName: 'Spanish',
  packState: 'partial',
  sizeMb: 12,
  itemCount: 37,
  alignment: 'cefr',
  levelLabel: 'A1',
  machineAuthoredPercent: null,
  wrongItemPercent: null,
  nativeReview: 'unreviewed',
  beta: true,
  download: { kind: 'idle' },
  validatorSummary: 'No scored review has been recorded.',
};
function setup() {
  const db = createNodeDb();
  dbs.push(db);
  migrate(db);
  const state = new SqliteAppState(db);
  state.initialize(7);
  const ports: OnboardingFlowPorts = {
    state,
    nowUtc: () => now,
    catalogue: {
      read: () => [card],
      download: vi.fn(async () => {}),
      pauseDownload: vi.fn(async () => {}),
      playSample: vi.fn(async () => {}),
    },
    packs: {
      refresh: vi.fn(async () => {}),
      state: () => card.packState,
      get: () => ({ contentHash: 'real-test-boundary-hash' }),
    },
    goal: { read: () => 'regular', choose: vi.fn(async () => {}) },
    notifications: {
      read: () => ({
        permission: 'undetermined',
        requestedPermission: false,
        undeterminedForegrounds: 0,
      }),
      requestPermission: vi.fn(async () => {}),
      openSettings: vi.fn(async () => {}),
    },
    restore: {
      read: () => ({ kind: 'offered' }),
      pick: vi.fn(async () => {}),
      confirm: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    },
    placement: { active: () => false, start: vi.fn(async () => {}) },
  };
  const flow = createOnboardingFlow(ports);
  function selected() {
    state.selectCourse(card.id, now);
    db.run('UPDATE course_progress SET pack_state=?,pack_content_hash=?', [
      card.packState,
      'real-test-boundary-hash',
    ]);
  }
  return { db, state, ports, flow, selected };
}
it('S001 preserves unknown rates and original catalogue facts instead of inventing a course or native approval', () => {
  const { flow, ports } = setup();
  expect(flow.read()).toEqual({ screen: 'courses', courses: [card], selectedCourseId: null });
  expect(ports.packs.refresh).not.toHaveBeenCalled();
  expect(ports.notifications.requestPermission).not.toHaveBeenCalled();
});
it('S001 rejects arbitrary IDs before creating progress rows', async () => {
  const { flow, state } = setup();
  await expect(flow.dispatch({ type: 'selectCourse', courseId: 'unknown' })).rejects.toThrow(
    /catalogue/i,
  );
  expect(state.read().courseIds).toEqual([]);
});
it('S001 selects an existing undownloaded catalogue row without starting a download', async () => {
  const { flow, state, ports } = setup();
  await flow.dispatch({ type: 'selectCourse', courseId: card.id });
  expect(state.read().selectedCourse?.courseId).toBe(card.id);
  expect(ports.catalogue.download).not.toHaveBeenCalled();
});
it('S001/S002 refreshes verification before continuing and refuses stale card installation claims', async () => {
  const { flow, state, ports, selected } = setup();
  selected();
  ports.packs.get = () => null;
  await expect(flow.dispatch({ type: 'continue' })).rejects.toThrow(/verified/i);
  expect(ports.packs.refresh).toHaveBeenCalledWith([card.id]);
  expect(state.read().step).toBe('courses');
});
it('[INV-PACK-04] partial audio permits the verified onboarding choice', async () => {
  const { flow, state, selected } = setup();
  selected();
  await flow.dispatch({ type: 'continue' });
  expect(state.read().step).toBe('placement-choice');
  expect(flow.read()).toEqual({
    screen: 'placement-choice',
    languageName: 'Spanish',
    choice: null,
  });
});
it('S003 import remains reachable before selecting a course and returns without invented progress', async () => {
  const { flow, state, ports } = setup();
  await flow.dispatch({ type: 'restore' });
  await flow.dispatch({ type: 'pickRestore' });
  expect(flow.read()).toEqual({ screen: 'restore', restore: { kind: 'offered' } });
  expect(ports.restore.pick).toHaveBeenCalledOnce();
  await flow.dispatch({ type: 'cancelRestore' });
  expect(state.read().step).toBe('courses');
  expect(state.read().courseIds).toEqual([]);
});
it('S004–S009 scratch route persists each choice and enters only after the explicit final action', async () => {
  const { flow, state, ports, selected } = setup();
  selected();
  await flow.dispatch({ type: 'continue' });
  await flow.dispatch({ type: 'choosePlacement', choice: 'scratch' });
  await flow.dispatch({ type: 'continue' });
  expect(state.read().step).toBe('goal');
  expect(state.read().activeCourseId).toBeNull();
  await flow.dispatch({ type: 'chooseGoal', goal: 'serious' });
  expect(ports.goal.choose).toHaveBeenCalledWith('serious');
  await flow.dispatch({ type: 'continue' });
  await flow.dispatch({ type: 'continue' });
  expect(state.read().step).toBe('entering');
  expect(state.read().activeCourseId).toBeNull();
  await flow.dispatch({ type: 'continue' });
  expect(flow.read()).toBeNull();
  expect(state.read().activeCourseId).toBe(card.id);
});
it('S005 self-report does not fabricate a section result or completion if placement launch fails', async () => {
  const { flow, state, ports, selected } = setup();
  selected();
  await flow.dispatch({ type: 'continue' });
  await flow.dispatch({ type: 'choosePlacement', choice: 'test' });
  await flow.dispatch({ type: 'continue' });
  await flow.dispatch({ type: 'chooseLevel', level: 'detailed' });
  ports.placement.start = vi.fn(async () => {
    throw new Error('No reviewed placement population');
  });
  await expect(flow.dispatch({ type: 'continue' })).rejects.toThrow(
    'No reviewed placement population',
  );
  expect(state.read().step).toBe('self-report');
  expect(state.read().selectedCourse?.placementSectionIndex).toBeNull();
});
it('[INV-NOT-13] permission request starts separately so the subsequent Continue has no OS callback dependency', async () => {
  const { flow, state, ports, selected } = setup();
  selected();
  state.transition('courses', 'notifications');
  ports.notifications.read = () => ({
    permission: 'undetermined',
    requestedPermission: true,
    undeterminedForegrounds: 0,
  });
  await flow.dispatch({ type: 'requestNotifications' });
  expect(flow.read()).toEqual({ screen: 'notifications', permission: 'requesting' });
  await flow.dispatch({ type: 'continue' });
  expect(state.read().step).toBe('entering');
});
it('S002 an async refresh cannot advance a different newer course selection', async () => {
  const { flow, state, ports, selected } = setup();
  selected();
  let release!: () => void;
  ports.packs.refresh = () =>
    new Promise<void>((r) => {
      release = r;
    });
  const pending = flow.dispatch({ type: 'continue' });
  state.selectCourse('en-fr', now);
  release();
  await expect(pending).rejects.toThrow(/selection changed/i);
  expect(state.read().step).toBe('courses');
});
it('S005 a missing placement session is an explicit error, not an endless entering state', () => {
  const { flow, state, selected } = setup();
  selected();
  state.transition('courses', 'placement-test');
  expect(() => flow.read()).toThrow(/placement.*unavailable/i);
});
it('S001 a removed or no-longer-catalogued selection renders the real picker', () => {
  const { flow, state, ports, selected } = setup();
  selected();
  state.transition('courses', 'pack-detail');
  ports.catalogue.read = () => [];
  expect(flow.read()).toEqual({ screen: 'courses', courses: [], selectedCourseId: null });
});
