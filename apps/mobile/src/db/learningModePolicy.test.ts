import { expect, it } from 'vitest';
import { DEFAULT_FLAVOUR_MATRIX, SESSION_FLAVOURS } from '@freelingo/core/session';
import { HUB_SESSION_FLAVOURS } from '@freelingo/core/types';
import { toLocalDay } from '@freelingo/core/day';
import type { LearningLaunch } from './SqliteLearningContextStore';
import {
  LEARNING_ECONOMY_FLAVOURS,
  learningSessionPolicy,
  validateLearningSessionPolicy,
} from './learningModePolicy';
function context(
  economyFlavour: LearningLaunch['economyFlavour'],
  origin: LearningLaunch['origin'] = { kind: 'path' },
  targetNodeId: string | null = 'node-1',
): Pick<LearningLaunch, 'economyFlavour' | 'origin' | 'targetNodeId'> {
  return { economyFlavour, origin, targetNodeId };
}
const hub = { kind: 'hub', offerId: 'offer-1', localDay: toLocalDay('2026-09-13') } as const;
it.each(SESSION_FLAVOURS)(
  '[INV-SESS-06][INV-ECO-09] existing %s path configuration is unchanged',
  (flavour) => {
    const c = context(flavour);
    const policy = learningSessionPolicy(c);
    expect(policy.engineFlavour).toBe(flavour);
    expect(policy.config).toBe(DEFAULT_FLAVOUR_MATRIX[flavour]);
    expect(validateLearningSessionPolicy({ flavour }, c)).toBe(policy.config);
  },
);
it.each(HUB_SESSION_FLAVOURS)(
  '[INV-HUB-03][INV-HUB-09] %s uses the validated short practice engine carrier',
  (flavour) => {
    const c = context(flavour, hub, null);
    const policy = learningSessionPolicy(c);
    expect(policy.engineFlavour).toBe('nodePractice');
    expect(policy.config).toMatchObject({
      flavour: 'nodePractice',
      targetLength: 10,
      minLength: 1,
      mistakeAllowance: null,
      mayIntroduceNewItems: false,
      padsFromDuePool: false,
      advancesNodeRing: false,
    });
    expect(validateLearningSessionPolicy({ flavour: 'nodePractice' }, c)).toBe(policy.config);
  },
);
it('[INV-HUB-06] only the exact Hub lesson promotion keeps its real path configuration', () => {
  const c = context('lesson', hub, 'node-1');
  expect(learningSessionPolicy(c).config).toBe(DEFAULT_FLAVOUR_MATRIX.lesson);
  expect(validateLearningSessionPolicy({ flavour: 'lesson' }, c)).toBe(
    DEFAULT_FLAVOUR_MATRIX.lesson,
  );
  expect(() => learningSessionPolicy(context('lesson', hub, null))).toThrow(/path promotion/i);
  expect(() => learningSessionPolicy(context('lesson', hub, ' '))).toThrow(/path promotion/i);
});
it('[INV-ECO-09][INV-SESS-21] every mismatched engine/economy pair fails explicitly', () => {
  for (const economyFlavour of LEARNING_ECONOMY_FLAVOURS) {
    const isHub = (HUB_SESSION_FLAVOURS as readonly string[]).includes(economyFlavour);
    const c = context(economyFlavour, isHub ? hub : { kind: 'path' }, isHub ? null : 'node-1');
    const expected = learningSessionPolicy(c).engineFlavour;
    for (const flavour of SESSION_FLAVOURS) {
      if (flavour === expected) continue;
      expect(() => validateLearningSessionPolicy({ flavour }, c)).toThrow(/engine.*economy/i);
    }
  }
});
it('[INV-ECO-09][INV-HUB-06] unsupported narrative, timed and wrong-origin mappings are refused', () => {
  for (const flavour of ['story', 'radio', 'roleplay', 'timedChallenge'] as const)
    expect(() => learningSessionPolicy(context(flavour))).toThrow(/unsupported/i);
  for (const flavour of HUB_SESSION_FLAVOURS) {
    expect(() => learningSessionPolicy(context(flavour))).toThrow(/Hub origin/i);
    expect(() => learningSessionPolicy(context(flavour, hub, 'node-1'))).toThrow(/path target/i);
  }
  for (const flavour of SESSION_FLAVOURS.filter((f) => f !== 'lesson'))
    expect(() => learningSessionPolicy(context(flavour, hub))).toThrow(/path promotion/i);
  expect(() => learningSessionPolicy(context('lesson', { kind: 'placement' }))).toThrow(
    /placement/i,
  );
  expect(learningSessionPolicy(context('placement', { kind: 'placement' })).engineFlavour).toBe(
    'placement',
  );
});
it('[INV-SESS-21] stale and prototype keys cannot resolve a policy', () => {
  for (const economyFlavour of ['__proto__', 'constructor', 'unknown', false, null]) {
    const c = { economyFlavour, origin: { kind: 'path' }, targetNodeId: 'node-1' };
    expect(() =>
      learningSessionPolicy(c as unknown as Parameters<typeof learningSessionPolicy>[0]),
    ).toThrow(/unsupported/i);
  }
});
