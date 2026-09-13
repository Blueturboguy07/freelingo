// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { runCeremony } from '@freelingo/core/ceremony';
import { ceremonyState } from '../../../../packages/core/src/ceremony/__falsifiers__/fixtures';
import {
  parseCeremonyReceipt,
  serialiseCeremonyReceipt,
  type CeremonyReceipt,
  type CeremonyRowBinding,
} from './ceremonyCodec';
function receipt(skipAll = false): CeremonyReceipt {
  const state = ceremonyState(
    {
      streak: 7,
      achievementCrossings: [{ achievementId: 'sage', achievementName: 'Sage', tier: 1, gems: 5 }],
      bundle: {
        gems: 3,
        freezes: 1,
        boost: { multiplier: 2, durationMinutes: 15 },
        tierGrant: 'Bronze',
      },
    },
    {
      scoreEntries: [{ slot: 'S068_scoreUnlock', bandBeats: 0 }],
      nodeCompletedThisSession: true,
      nodeIsComplete: true,
      unitCompleted: true,
    },
    { xp: 28 },
  );
  return {
    schemaVersion: 1,
    state,
    result: runCeremony(state, { skipAll }),
    facts: {
      courseName: 'Spanish',
      combo: 5,
      accuracy: 0.8,
      xpExplanation: 'Captured boost',
      unitIndex: 1,
      unitName: 'Basics',
      sectionName: 'A1',
      score: 2,
    },
  };
}
function key(r: CeremonyReceipt): CeremonyRowBinding {
  return {
    sessionId: r.state.session.sessionId,
    courseId: r.state.course.courseId,
    cursor: 0,
    xpAwarded: r.result.committed!.xp,
    gemsAwarded: r.result.committed!.gems,
  };
}
it('[INV-CER-01][INV-CER-02] restores the actual frozen result without reevaluating predicates or rewards', () => {
  const r = receipt();
  const raw = serialiseCeremonyReceipt(r);
  const parsed = parseCeremonyReceipt(raw, key(r));
  expect(parsed).toEqual(r);
  expect(parsed.result.predicateEvaluations).toEqual(r.result.predicateEvaluations);
  expect(JSON.stringify(parsed)).toBe(raw);
});
it('[INV-CER-13] the actual skip-all result retains its one-time screens and separate toast slots', () => {
  const r = receipt(true);
  expect(r.result.skippedToToast.length).toBeGreaterThan(0);
  expect(parseCeremonyReceipt(serialiseCeremonyReceipt(r), key(r))).toEqual(r);
});
it('[INV-CER-01] an actual zero-award abandonment has an empty predicate record and empty chain', () => {
  const state = ceremonyState({}, {}, { outcome: 'abandoned', xp: 0 });
  const r = { ...receipt(), state, result: runCeremony(state) };
  expect(r.result.chain).toEqual([]);
  expect(parseCeremonyReceipt(serialiseCeremonyReceipt(r), key(r))).toEqual(r);
});
const invalid: readonly [string, unknown][] = [
  ['schemaVersion', 2],
  ['state.account.streak', -1],
  ['state.account.streakBeat', 'maybe'],
  ['state.account.streakGoal.goal', false],
  ['state.account.streakGoal.presentations', 0.5],
  ['state.account.streakGoal.lastPicked', -1],
  ['state.account.bundle.boost.durationMinutes', 0],
  ['state.account.achievementCrossings.0.gems', -1],
  ['state.course.scoreEntries.0.slot', 'S999'],
  ['state.course.takeover.consecutiveDeclines', '2'],
  ['state.course.nodeIsLegendary', null],
  ['state.session.outcome', 'complete'],
  ['state.session.gradedItems', 0.5],
  ['state.session.xp', Number.POSITIVE_INFINITY],
  ['state.milestoneDays.0', -7],
  ['result.committed', null],
  ['result.bundle.freezes', 0.5],
  ['result.achievements.screens.0.rows.0.extraTiers', -1],
  ['result.predicateEvaluations.S067_sessionComplete', 2],
  ['facts.accuracy', 1.1],
  ['facts.combo', -1],
  ['facts.unitIndex', 0.5],
  ['facts.score', null],
  ['unexpected', 'extra'],
];
it.each(invalid)('[INV-CER-01] rejects malformed nested presentation field %s', (path, value) => {
  const r = structuredClone(receipt());
  let object = r as unknown as Record<string, unknown>;
  const parts = path.split('.');
  for (const part of parts.slice(0, -1)) object = object[part] as Record<string, unknown>;
  object[parts.at(-1)!] = value;
  expect(() => parseCeremonyReceipt(JSON.stringify(r), key(receipt()))).toThrow();
});
it('[INV-CER-02] rejects duplicate/reordered chains, overlapping skipped slots and multiple achievement screens', () => {
  const base = receipt();
  for (const result of [
    { ...base.result, chain: [...base.result.chain, base.result.chain[0]!] },
    { ...base.result, chain: [...base.result.chain].reverse() },
    { ...base.result, skippedToToast: [base.result.chain[0]!] },
    {
      ...base.result,
      achievements: {
        ...base.result.achievements,
        screens: [...base.result.achievements.screens, ...base.result.achievements.screens],
      },
    },
  ])
    expect(() => parseCeremonyReceipt(JSON.stringify({ ...base, result }), key(base))).toThrow();
});
it('[INV-CER-01][INV-CER-03] rejects another course/session, unpaid amounts and an out-of-chain SQL cursor', () => {
  const r = receipt(),
    raw = serialiseCeremonyReceipt(r),
    binding = key(r);
  for (const changed of [
    { courseId: 'fr' },
    { sessionId: 'other' },
    { xpAwarded: 29 },
    { gemsAwarded: 99 },
    { cursor: r.result.chain.length + 1 },
    { cursor: -1 },
  ])
    expect(() => parseCeremonyReceipt(raw, { ...binding, ...changed })).toThrow();
  expect(parseCeremonyReceipt(raw, { ...binding, cursor: r.result.chain.length })).toEqual(r);
});
it('[INV-CER-01] refuses sparse arrays, getters and undefined fields before serializing', () => {
  const getter = vi.fn(() => receipt().facts);
  const r = { ...receipt() };
  Object.defineProperty(r, 'facts', { get: getter, enumerable: true });
  expect(() => serialiseCeremonyReceipt(r)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const sparse = { ...receipt(), state: { ...receipt().state, milestoneDays: Array(2) } };
  expect(() => serialiseCeremonyReceipt(sparse)).toThrow();
  const undefinedField = { ...receipt(), facts: { ...receipt().facts, xpExplanation: undefined } };
  expect(() => serialiseCeremonyReceipt(undefinedField as unknown as CeremonyReceipt)).toThrow();
});

it('[INV-CER-02][INV-CER-13] a frozen chain cannot drop return-to-path or hide one-time screens in a toast', () => {
  const r = receipt();
  const missingReturn = {
    ...r,
    result: { ...r.result, chain: r.result.chain.filter((s) => s !== 'S087_returnToPath') },
  };
  expect(() => parseCeremonyReceipt(JSON.stringify(missingReturn), key(r))).toThrow();
  const hiddenUnlock = {
    ...r,
    result: {
      ...r.result,
      chain: r.result.chain.filter((s) => s !== 'S068_scoreUnlock'),
      skippedToToast: ['S068_scoreUnlock'],
    },
  };
  expect(() => parseCeremonyReceipt(JSON.stringify(hiddenUnlock), key(r))).toThrow();
});
