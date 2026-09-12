/**
 * Queue generation.
 *
 * Everything the device can refuse to render is resolved HERE, once, before the learner
 * sees a thing: gated families (INV-SESS-16), audio that cannot be produced (INV-AUD-01),
 * ids that no longer resolve in the installed pack (INV-SESS-21), missing non-audio
 * assets (INV-PACK-05). A session that reaches the player has no gate screen inside it.
 *
 * Owns: INV-SESS-13, INV-SESS-16, INV-SESS-21 (the resolve half), INV-SESS-26,
 * INV-AUD-01, INV-PACK-05.
 */
import type { FlavourMatrixPort, SessionFlavourConfig } from './flavours.js';
import { defaultFlavourMatrixPort } from './flavours.js';
import type { GeneratedSession, GenerationRequest } from './ports.js';
import type { ItemFamily, QueuedItem } from './types.js';

/* ===================================================================== 1. the PRNG */

/**
 * mulberry32. Deterministic, tiny, and — the reason it is here rather than
 * `Math.random()` — seedable, so the realised option order of an item is a pure function
 * of `(sessionSeed, slotId)` and can be replayed verbatim on resume (INV-SESS-05).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit hash of a string, mixed with the session seed. */
export function seedFor(sessionSeed: number, key: string): number {
  let h = (sessionSeed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < key.length; i += 1) {
    h = (Math.imul(h ^ key.charCodeAt(i), 0x01000193) + 1) >>> 0;
  }
  return h >>> 0;
}

/* ============================================================ 2. ordering policy */

/**
 * `deep/01` §S20: **recognition before production**. A new lexeme appears first in a
 * recognition type, then matching/recall, then production.
 */
const FAMILY_RANK: Readonly<Record<ItemFamily, number>> = {
  recognition: 0,
  character: 1,
  listening: 2,
  discourse: 3,
  production: 4,
  speaking: 5,
};

/* ============================================================ 3. the generator */

export interface GenerateOptions {
  readonly flavours?: FlavourMatrixPort;
}

export function generateSession(
  request: GenerationRequest,
  options: GenerateOptions = {},
): GeneratedSession {
  const flavours = options.flavours ?? defaultFlavourMatrixPort;
  const config = flavours.row(request.flavour);

  const droppedForGate: string[] = [];
  const droppedForAudio: string[] = [];
  const degraded: string[] = [];
  const gated = new Set<ItemFamily>(request.modality.gatedFamilies());

  const eligible = filterEligible(
    request,
    config,
    gated,
    droppedForGate,
    droppedForAudio,
    degraded,
  );

  // INV-SESS-13: padding draws ONLY from the due pool, never from arbitrary content.
  const padded = padFromDuePool(request, config, eligible, gated, droppedForGate, droppedForAudio);

  const ordered = [...padded].sort((a, b) => FAMILY_RANK[a.family] - FAMILY_RANK[b.family]);
  const placeable = placeWithoutAdjacentRepeats(ordered, config.targetLength);

  const optionSeeds: Record<string, number> = {};
  for (const item of placeable) optionSeeds[item.id] = seedFor(request.seed, item.id);

  // INV-SESS-26: below the floor the session is NOT offered; the node reads
  // `nothing due right now` instead of serving a four-item session.
  const offered = placeable.length >= config.minLength;

  return {
    offered,
    reason: offered ? 'ok' : 'nothingDue',
    queue: offered ? placeable : [],
    optionSeeds: offered ? optionSeeds : {},
    droppedForGate,
    droppedForAudio,
    degraded,
  };
}

/* ============================================================ 4. the filter steps */

function filterEligible(
  request: GenerationRequest,
  config: SessionFlavourConfig,
  gated: ReadonlySet<ItemFamily>,
  droppedForGate: string[],
  droppedForAudio: string[],
  degraded: string[],
): QueuedItem[] {
  const out: QueuedItem[] = [];
  for (const item of request.candidates) {
    if (gated.has(item.family)) {
      droppedForGate.push(item.id);
      continue;
    }
    // INV-SESS-21: an id that no longer resolves, or that a re-cut pack moved to another
    // node, is not eligible — and on resume it is what turns RESUME into START OVER.
    if (!request.pack.resolves(item.itemId)) continue;
    if (request.pack.nodeRefOf(item.itemId) !== item.nodeRef) continue;
    if (!config.mayIntroduceNewItems && !request.scheduler.isSeen(request.courseId, item.itemId)) {
      continue;
    }
    // INV-AUD-01: availability resolved HERE. An item whose clip cannot be produced never
    // enters the queue, so the player never meets an unplayable exercise.
    if (item.requiresAudio && !request.audio.canProduce(item.itemId)) {
      droppedForAudio.push(item.id);
      continue;
    }
    // INV-PACK-05: a missing NON-audio asset degrades exactly this item and nothing else.
    if (!request.pack.assetPresent(item.itemId)) {
      degraded.push(item.id);
      out.push({ ...item, degraded: 'noImage' });
      continue;
    }
    out.push(item);
  }
  return out;
}

function padFromDuePool(
  request: GenerationRequest,
  config: SessionFlavourConfig,
  eligible: readonly QueuedItem[],
  gated: ReadonlySet<ItemFamily>,
  droppedForGate: string[],
  droppedForAudio: string[],
): QueuedItem[] {
  const out = [...eligible];
  if (out.length >= config.targetLength || !config.padsFromDuePool) return out;

  const present = new Set(out.map((i) => i.id));
  for (const item of request.scheduler.duePool(request.courseId)) {
    if (out.length >= config.targetLength) break;
    if (present.has(item.id)) continue;
    if (gated.has(item.family)) {
      droppedForGate.push(item.id);
      continue;
    }
    if (!request.pack.resolves(item.itemId)) continue;
    if (item.requiresAudio && !request.audio.canProduce(item.itemId)) {
      droppedForAudio.push(item.id);
      continue;
    }
    out.push(item);
    present.add(item.id);
  }
  return out;
}

/**
 * INV-SESS-13, first half: "never contains the same item twice in adjacent positions".
 *
 * Greedy, deterministic, and it never reorders more than it must: place the first
 * remaining item whose `itemId` differs from the one just placed; if every remaining item
 * repeats it, stop. Stopping is correct — the alternative is emitting the repeat — and it
 * is why `length = min(target, available)` is stated over PLACEABLE items.
 */
export function placeWithoutAdjacentRepeats(
  items: readonly QueuedItem[],
  target: number,
): QueuedItem[] {
  const remaining = [...items];
  const out: QueuedItem[] = [];
  while (out.length < target && remaining.length > 0) {
    const last = out[out.length - 1];
    const index = remaining.findIndex((i) => last === undefined || i.itemId !== last.itemId);
    if (index === -1) break;
    out.push(remaining[index]!);
    remaining.splice(index, 1);
  }
  return out;
}

/**
 * INV-SESS-16 / INV-SESS-21, the resume half: re-validate a PARKED queue against the
 * device and pack as they are NOW, keeping the index intact.
 *
 * A gated item is swapped 1:1 for a same-concept substitute so the index and the nominal
 * length hold (EC-SES-21); only when no substitute exists does the queue shorten. Items
 * already answered are never touched — re-validating the past would rewrite history.
 */
export interface RevalidationResult {
  readonly queue: readonly QueuedItem[];
  readonly substituted: readonly string[];
  readonly removed: readonly string[];
  /** False ⇒ offer START OVER alone, never RESUME (INV-SESS-21). */
  readonly resumable: boolean;
}

export function revalidateQueue(
  queue: readonly QueuedItem[],
  index: number,
  deps: {
    readonly gatedFamilies: readonly ItemFamily[];
    readonly pack: { resolves(id: string): boolean; nodeRefOf(id: string): string | null };
    readonly audio: { canProduce(id: string): boolean };
    readonly substitutes: readonly QueuedItem[];
  },
): RevalidationResult {
  const gated = new Set<ItemFamily>(deps.gatedFamilies);
  const substituted: string[] = [];
  const removed: string[] = [];
  const pool = [...deps.substitutes];
  const out: QueuedItem[] = [];

  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i]!;
    if (i < index) {
      // Already answered: it stands exactly as served.
      out.push(item);
      continue;
    }
    const unplayable = item.requiresAudio && !deps.audio.canProduce(item.itemId);
    const gone = !deps.pack.resolves(item.itemId);
    const moved = !gone && deps.pack.nodeRefOf(item.itemId) !== item.nodeRef;
    if (!gated.has(item.family) && !unplayable && !gone && !moved) {
      out.push(item);
      continue;
    }
    const swapIndex = pool.findIndex(
      (s) =>
        s.conceptId === item.conceptId &&
        !gated.has(s.family) &&
        (!s.requiresAudio || deps.audio.canProduce(s.itemId)) &&
        deps.pack.resolves(s.itemId),
    );
    if (swapIndex === -1) {
      removed.push(item.id);
      continue;
    }
    const swap = pool[swapIndex]!;
    pool.splice(swapIndex, 1);
    substituted.push(item.id);
    // The SLOT id is preserved so the index, the option seed and the progress denominator
    // all survive the swap; only the content behind it changed.
    out.push({ ...swap, id: item.id });
  }

  // INV-SESS-21: RESUME is offered iff every queued item still resolves AND maps to the
  // node. A removal means it did not, so the only honest offer left is START OVER.
  const resumable = removed.length === 0;
  return { queue: out, substituted, removed, resumable };
}
