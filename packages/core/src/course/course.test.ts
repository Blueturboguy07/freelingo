import { expect, it } from 'vitest';
import { courseActionPlan, preferenceChange } from './index.js';
const request = {
  courseId: 'en-es',
  installedCourseIds: ['en-es', 'en-fr'],
  activeCourseId: 'en-es',
  importedAtUtc: null,
  nowUtc: '2026-09-13T12:00:00Z',
};
it('[INV-CRS-01] removal names only the course region and explicitly preserves account state', () => {
  expect(courseActionPlan({ ...request, action: 'remove' })).toMatchObject({
    allowed: true,
    deleteProgress: true,
    deletePack: true,
    affectsAccount: false,
    nextActiveCourseId: 'en-fr',
  });
});
it('[INV-CRS-02] reset and removal are blocked throughout the full post-import day', () => {
  for (const action of ['remove', 'reset'] as const)
    expect(
      courseActionPlan({ ...request, action, importedAtUtc: '2026-09-12T12:00:01Z' }).allowed,
    ).toBe(false);
  expect(
    courseActionPlan({ ...request, action: 'reset', importedAtUtc: '2026-09-12T12:00:00Z' })
      .allowed,
  ).toBe(true);
});
it('[INV-CRS-03] reset deletes the session/progress set but keeps installed pack and account', () => {
  expect(courseActionPlan({ ...request, action: 'reset' })).toMatchObject({
    allowed: true,
    deleteProgress: true,
    deleteSession: true,
    deletePack: false,
    affectsAccount: false,
  });
});
it('[INV-SESS-07] course switch parks the current session and unknown courses reject', () => {
  expect(courseActionPlan({ ...request, action: 'switch', courseId: 'en-fr' })).toMatchObject({
    deleteSession: false,
    nextActiveCourseId: 'en-fr',
  });
  expect(courseActionPlan({ ...request, action: 'switch', courseId: 'en-de' }).allowed).toBe(false);
});
it('[INV-HUB-09] enabling listening clears suspension; disabling does not create a timer', () => {
  expect(preferenceChange('listening', true)).toEqual({
    key: 'listening',
    value: true,
    clearSuspension: 'listening',
  });
  expect(preferenceChange('listening', false)).toEqual({
    key: 'listening',
    value: false,
    clearSuspension: null,
  });
});
