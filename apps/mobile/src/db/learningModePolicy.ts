import {
  DEFAULT_FLAVOUR_MATRIX,
  SESSION_FLAVOURS,
  type SessionFlavour,
  type SessionFlavourConfig,
  type SessionState,
} from '@freelingo/core/session';
import { HUB_SESSION_FLAVOURS, type HubSessionFlavour } from '@freelingo/core/types';
import { HUB_CONFIG } from '@freelingo/core/hub';
import { FLAVOUR_XP, flavourRow } from '@freelingo/core/economy';
import type { LearningLaunch } from './SqliteLearningContextStore';
import { LearningDataError } from './SqliteSchedulerStore';

/** Freelingo application mapping, 2026-09-13, not a measured UI variant. The existing
 * serialized nodePractice carrier runs Hub review; its economy identity remains exact.
 * INV-HUB-03 permits true-count short sets and forbids unrelated padding. */
export const HUB_MIN_SESSION_LENGTH = 1;
export const LEARNING_ECONOMY_FLAVOURS = [...SESSION_FLAVOURS, ...HUB_SESSION_FLAVOURS] as const;
export type LearningEconomyFlavour = (typeof LEARNING_ECONOMY_FLAVOURS)[number];
type PolicyLaunch = Pick<LearningLaunch, 'economyFlavour' | 'origin' | 'targetNodeId'>;
export interface LearningSessionPolicy {
  readonly engineFlavour: SessionFlavour;
  readonly config: SessionFlavourConfig;
}
function hubConfig(
  flavour: HubSessionFlavour,
  screen: string,
  stepUp: SessionFlavourConfig['stepUp'],
): SessionFlavourConfig {
  return Object.freeze({
    ...DEFAULT_FLAVOUR_MATRIX.nodePractice,
    screen,
    targetLength: HUB_CONFIG.target,
    minLength: HUB_MIN_SESSION_LENGTH,
    recyclesMistakes: flavourRow(flavour, 'completed').writesMistakeRows,
    mistakeAllowance: null,
    stepUp,
    padsFromDuePool: false,
    mayIntroduceNewItems: false,
    baseXp: FLAVOUR_XP[flavour].base,
    advancesNodeRing: false,
  });
}
/** Deep07 S2-S8: Words stays matching, Speak stays spoken, and Listen-Up has the
 * documented audio ramp. General review retains the existing authored production ramp. */
const HUB_CONFIGS: Readonly<Record<HubSessionFlavour, SessionFlavourConfig>> = Object.freeze({
  hubMistakes: hubConfig('hubMistakes', 'S092', 'production'),
  hubWords: hubConfig('hubWords', 'S094', null),
  hubListenUp: hubConfig('hubListenUp', 'S095', 'audio'),
  hubPronunciation: hubConfig('hubPronunciation', 'S096', null),
  hubTargetPractice: hubConfig('hubTargetPractice', 'S099', 'production'),
  hubUnitRewind: hubConfig('hubUnitRewind', 'S099', 'production'),
});
export function isHubLearningFlavour(value: string): value is HubSessionFlavour {
  return (HUB_SESSION_FLAVOURS as readonly string[]).includes(value);
}
function isPath(value: string): value is SessionFlavour {
  return (SESSION_FLAVOURS as readonly string[]).includes(value);
}
function fail(message: string): never {
  throw new LearningDataError('Learning session policy: ' + message);
}
/** No writes or scheduling. The caller must independently join origin, target and saved
 * source receipts; this function admits only the supported engine/economy combinations. */
export function learningSessionPolicy(launch: PolicyLaunch): LearningSessionPolicy {
  const flavour = launch.economyFlavour;
  if (isHubLearningFlavour(flavour)) {
    if (launch.origin.kind !== 'hub') return fail('Hub origin is required.');
    if (launch.targetNodeId !== null) return fail('Hub practice cannot carry a path target.');
    return { engineFlavour: 'nodePractice', config: HUB_CONFIGS[flavour] };
  }
  if (!isPath(flavour)) return fail('unsupported economy flavour.');
  if (
    launch.origin.kind === 'hub' &&
    (flavour !== 'lesson' || launch.targetNodeId === null || !launch.targetNodeId.trim())
  )
    return fail('only an exact lesson path promotion may advance from Hub.');
  if (launch.origin.kind === 'placement' && flavour !== 'placement')
    return fail('placement origin requires the placement economy flavour.');
  return { engineFlavour: flavour, config: DEFAULT_FLAVOUR_MATRIX[flavour] };
}
/** Every restored/graded/committed state uses this same identity check. */
export function validateLearningSessionPolicy(
  state: Pick<SessionState, 'flavour'>,
  launch: PolicyLaunch,
): SessionFlavourConfig {
  const policy = learningSessionPolicy(launch);
  if (state.flavour !== policy.engineFlavour) return fail('engine and economy flavours disagree.');
  return policy.config;
}
