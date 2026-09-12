/**
 * The two-course session fixture.
 *
 * Rules of engagement §4: "Two courses installed is the default fixture, not the
 * exceptional one. Every scoping bug in the hunt came from a single-course assumption."
 * So `COURSE_A` and `COURSE_B` both exist here and the store properties use both.
 *
 * Kept in `src/` (not a test folder) so falsifier inputs under `__falsifiers__/` can be
 * replayed by anything, including a debug build of the app.
 */
import type { RuntimeState } from './machine.js';
import type { SessionFlavour, ItemFamily, QueuedItem, SessionKind } from './types.js';
import { EMPTY_IN_FLIGHT } from './types.js';
import { initialProgress } from './progress.js';
import { DEFAULT_FLAVOUR_MATRIX } from './flavours.js';
import { exerciseSpec } from './registry.js';
import { seedFor } from './generate.js';

export const COURSE_A = 'en-es';
export const COURSE_B = 'en-fr';

export interface ItemOptions {
  readonly type?: QueuedItem['type'];
  readonly family?: ItemFamily;
  readonly conceptId?: string;
  readonly nodeRef?: string;
  readonly requiresAudio?: boolean;
}

export function item(n: number, options: ItemOptions = {}): QueuedItem {
  const type = options.type ?? 'meaningSelect';
  const spec = exerciseSpec(type);
  return {
    id: `slot-${n}`,
    itemId: `item-${n}`,
    type,
    family: options.family ?? spec.family,
    conceptId: options.conceptId ?? `concept-${n}`,
    nodeRef: options.nodeRef ?? 'node-1',
    requiresAudio: options.requiresAudio ?? spec.requiresAudio,
  };
}

export function items(count: number, options: ItemOptions = {}): QueuedItem[] {
  return Array.from({ length: count }, (_, i) => item(i + 1, options));
}

export interface FixtureOptions {
  readonly sessionId?: string;
  readonly courseId?: string;
  readonly sessionKind?: SessionKind;
  readonly nodeRef?: string;
  readonly flavour?: SessionFlavour;
  readonly queue?: readonly QueuedItem[];
  readonly motivationalMessages?: boolean;
  readonly packNonLatinScript?: boolean;
  readonly monotonicMs?: number;
}

/** A fresh session at its very first exercise: index 0, combo 0, hardMode false. */
export function freshSession(options: FixtureOptions = {}): RuntimeState {
  const flavour = options.flavour ?? 'lesson';
  const config = DEFAULT_FLAVOUR_MATRIX[flavour];
  const queue = options.queue ?? items(config.targetLength);
  const seeds: Record<string, number> = {};
  for (const q of queue) seeds[q.id] = seedFor(1, q.id);
  const startedMonotonicMs = options.monotonicMs ?? 0;
  return {
    sessionId: options.sessionId ?? 'session-1',
    courseId: options.courseId ?? COURSE_A,
    sessionKind: options.sessionKind ?? 'graded',
    nodeRef: options.nodeRef ?? 'node-1',
    flavour,
    core: {
      queue,
      index: 0,
      answers: [],
      // Super default: hearts render `∞`. A test flavour swaps in a pip row (S056).
      hearts:
        config.mistakeAllowance === null
          ? { kind: 'infinite' }
          : { kind: 'pips', total: config.mistakeAllowance, remaining: config.mistakeAllowance },
      combo: 0,
      usedInterstitialKeys: [],
      inputMode: 'bank',
      hardMode: false,
      optionSeeds: seeds,
    },
    shellState: 'loading',
    inFlight: EMPTY_IN_FLIGHT,
    mistakes: [],
    progress: initialProgress(queue.length),
    checkpointMonotonicMs: startedMonotonicMs,
    startedMonotonicMs,
    pendingInterstitialKeys: [],
    stepUpFired: false,
    motivationalMessages: options.motivationalMessages ?? true,
    currentReplay: null,
    inputModeExplicit: false,
    mistakeRows: [],
    weakItemRows: [],
    packNonLatinScript: options.packNonLatinScript ?? false,
    exited: null,
  };
}
