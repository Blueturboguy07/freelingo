import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  generateSession,
  placeWithoutAdjacentRepeats,
  revalidateQueue,
  seedFor,
} from './generate.js';
import { DEFAULT_FLAVOUR_MATRIX, MIN_SESSION_LENGTH } from './flavours.js';
import { FixedAudio, FixedModality, FixedPack, RecordingScheduler } from './test-doubles.js';
import type { GenerationRequest } from './ports.js';
import type { ItemFamily, QueuedItem } from './types.js';
import { SESSION_FLAVOURS } from './types.js';
import { item, items } from './session-fixture.js';

function request(over: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    sessionId: 'session-1',
    courseId: 'en-es',
    nodeRef: 'node-1',
    flavour: 'lesson',
    candidates: items(14),
    audio: new FixedAudio(),
    pack: new FixedPack(),
    modality: new FixedModality(),
    scheduler: new RecordingScheduler(),
    seed: 7,
    ...over,
  };
}

/** Candidates with a controllable mix of audio-needing items. */
function mixedCandidates(count: number, audioEvery: number): QueuedItem[] {
  return Array.from({ length: count }, (_, i) =>
    item(i + 1, {
      type: (i + 1) % audioEvery === 0 ? 'listenTapWhatYouHear' : 'meaningSelect',
      conceptId: `concept-${(i % 4) + 1}`,
    }),
  );
}

describe('queue generation', () => {
  it('[INV-SESS-13] a generated session never contains the same item twice in adjacent positions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 1000 }),
        (count, distinct, seed) => {
          // Deliberately few distinct item ids so adjacency is REACHABLE: a generator
          // where every id is unique cannot falsify this invariant at all.
          const candidates = Array.from({ length: count }, (_, i) =>
            item((i % distinct) + 1, { conceptId: `c${i % distinct}` }),
          ).map((q, i) => ({ ...q, id: `slot-${i}` }));
          const result = generateSession(request({ candidates, seed }));
          for (let i = 1; i < result.queue.length; i += 1) {
            expect(result.queue[i]!.itemId).not.toBe(result.queue[i - 1]!.itemId);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SESS-13] length is min(target, available) and padding draws only from the due pool', () => {
    const due = items(6).map((q, i) => ({ ...q, id: `due-${i}`, itemId: `due-item-${i}` }));
    const result = generateSession(
      request({
        candidates: items(8),
        scheduler: new RecordingScheduler({ due }),
      }),
    );
    const target = DEFAULT_FLAVOUR_MATRIX.lesson.targetLength;
    expect(result.queue).toHaveLength(target);
    // The four padded slots are all from the due pool — nothing else may be a source.
    const padded = result.queue.filter((q) => q.itemId.startsWith('due-item-'));
    expect(padded).toHaveLength(target - 8);

    // With no due pool the session SHORTENS rather than repeating an item.
    const short = generateSession(request({ candidates: items(8) }));
    expect(short.queue).toHaveLength(8);
  });

  it('[INV-SESS-26] no session below the configured floor is offered', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 14 }),
        fc.constantFrom(...SESSION_FLAVOURS),
        (count, flavour) => {
          const result = generateSession(request({ candidates: items(count), flavour }));
          if (count < MIN_SESSION_LENGTH) {
            expect(result.offered).toBe(false);
            expect(result.reason).toBe('nothingDue');
            expect(result.queue).toEqual([]);
          } else {
            expect(result.offered).toBe(true);
            expect(result.queue.length).toBeGreaterThanOrEqual(MIN_SESSION_LENGTH);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SESS-26] falsifier: the generator can legally assemble only four exercises, so the node reads `nothing due right now`', () => {
    const result = generateSession(request({ candidates: items(4) }));
    expect(result.offered).toBe(false);
    expect(result.queue).toEqual([]);
  });

  it('[INV-AUD-01] for any availability combination the queue contains zero unplayable items and its length is unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.array(fc.integer({ min: 1, max: 18 }), { maxLength: 6 }),
        (audioEvery, unavailableIndices) => {
          // 18 candidates for a 12-item lesson: enough eligible substitutes exist, so the
          // LENGTH must not move when clips go missing.
          const candidates = mixedCandidates(18, audioEvery);
          const unavailable = unavailableIndices.map((i) => `item-${i}`);
          const full = generateSession(request({ candidates }));
          const degradedRun = generateSession(
            request({ candidates, audio: new FixedAudio(unavailable) }),
          );
          expect(degradedRun.queue).toHaveLength(full.queue.length);
          for (const queued of degradedRun.queue) {
            if (queued.requiresAudio) expect(unavailable).not.toContain(queued.itemId);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-AUD-01] falsifier: availability resolved at render instead of generation would leave an unplayable item in the queue', () => {
    const candidates = mixedCandidates(18, 2);
    const everyClipGone = candidates.filter((c) => c.requiresAudio).map((c) => c.itemId);
    const result = generateSession(request({ candidates, audio: new FixedAudio(everyClipGone) }));
    expect(result.queue.filter((q) => q.requiresAudio)).toEqual([]);
    expect(result.droppedForAudio.length).toBeGreaterThan(0);
    // Still a full session: the nine silent candidates fill it.
    expect(result.offered).toBe(true);
  });

  it('[INV-PACK-05] a missing asset degrades exactly one item and never aborts the session', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 14 }), { maxLength: 6 }),
        (missingIndices) => {
          const missing = missingIndices.map((i) => `item-${i}`);
          const result = generateSession(
            request({ pack: new FixedPack({ missingAssets: missing }) }),
          );
          // The session still completes: it is offered, full length, and every missing
          // asset degraded ONE item rather than removing or aborting anything.
          expect(result.offered).toBe(true);
          expect(result.queue).toHaveLength(DEFAULT_FLAVOUR_MATRIX.lesson.targetLength);
          for (const queued of result.queue) {
            if (missing.includes(queued.itemId)) expect(queued.degraded).toBe('noImage');
            else expect(queued.degraded).toBeUndefined();
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SESS-16] a generated session contains zero items from a currently gated family', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.constantFrom<ItemFamily>('listening', 'speaking', 'production', 'character'),
          { maxLength: 3 },
        ),
        (gated) => {
          const candidates = [
            ...items(8, { type: 'meaningSelect' }),
            ...items(4, { type: 'listenTapWhatYouHear' }).map((q, i) => ({
              ...q,
              id: `listen-${i}`,
              itemId: `listen-item-${i}`,
            })),
            ...items(4, { type: 'speakSentence' }).map((q, i) => ({
              ...q,
              id: `speak-${i}`,
              itemId: `speak-item-${i}`,
            })),
          ];
          const result = generateSession(
            request({ candidates, modality: new FixedModality(gated) }),
          );
          for (const queued of result.queue) expect(gated).not.toContain(queued.family);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SESS-16] falsifier: a lesson parked with listening items queued, listening disabled, resumed — no gate screen inside the queue', () => {
    const queue: QueuedItem[] = [
      item(1, { type: 'meaningSelect', conceptId: 'c1' }),
      item(2, { type: 'listenTapWhatYouHear', conceptId: 'c2' }),
      item(3, { type: 'listenTypeWhatYouHear', conceptId: 'c3' }),
      item(4, { type: 'meaningSelect', conceptId: 'c4' }),
    ];
    const substitutes: QueuedItem[] = [
      { ...item(11, { type: 'meaningSelect', conceptId: 'c2' }) },
      { ...item(12, { type: 'wordBankTranslate', conceptId: 'c3' }) },
    ];
    const result = revalidateQueue(queue, 1, {
      gatedFamilies: ['listening'],
      pack: new FixedPack(),
      audio: new FixedAudio(),
      substitutes,
    });
    expect(result.queue).toHaveLength(4); // the index and nominal length hold
    expect(result.queue.map((q) => q.family)).not.toContain('listening');
    expect(result.substituted).toEqual(['slot-2', 'slot-3']);
    // The slot ids are preserved, so the index and the option seeds still line up.
    expect(result.queue.map((q) => q.id)).toEqual(['slot-1', 'slot-2', 'slot-3', 'slot-4']);
    expect(result.resumable).toBe(true);
  });

  it('[INV-SESS-21] RESUME is offered iff every queued item id resolves in the installed pack and maps to the node', () => {
    const queue = items(4);
    // A pack update dissolved the node that `item-3` belonged to.
    const dissolved = revalidateQueue(queue, 1, {
      gatedFamilies: [],
      pack: new FixedPack({ unresolved: ['item-3'] }),
      audio: new FixedAudio(),
      substitutes: [],
    });
    expect(dissolved.resumable).toBe(false);
    expect(dissolved.removed).toEqual(['slot-3']);
    // …and the player never renders a blank exercise: the item is simply not in the queue.
    expect(dissolved.queue.map((q) => q.itemId)).not.toContain('item-3');

    // A re-cut pack that MOVED an item to another node is equally not resumable.
    const moved = revalidateQueue(queue, 1, {
      gatedFamilies: [],
      pack: new FixedPack({ movedTo: { 'item-4': 'node-9' } }),
      audio: new FixedAudio(),
      substitutes: [],
    });
    expect(moved.resumable).toBe(false);

    // Everything resolving ⇒ resumable.
    const clean = revalidateQueue(queue, 1, {
      gatedFamilies: [],
      pack: new FixedPack(),
      audio: new FixedAudio(),
      substitutes: [],
    });
    expect(clean.resumable).toBe(true);
    expect(clean.queue).toEqual(queue);
  });

  it('[INV-SESS-21] generation drops an item whose pack id no longer maps to the node', () => {
    const result = generateSession(
      request({ pack: new FixedPack({ movedTo: { 'item-1': 'node-9' } }) }),
    );
    expect(result.queue.map((q) => q.itemId)).not.toContain('item-1');
  });

  it('[INV-SESS-05] option seeds are a pure function of (session seed, slot id)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100000 }),
        fc.string({ maxLength: 12 }),
        (seed, key) => {
          expect(seedFor(seed, key)).toBe(seedFor(seed, key));
          expect(Number.isInteger(seedFor(seed, key))).toBe(true);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
    const a = generateSession(request({ seed: 42 }));
    const b = generateSession(request({ seed: 42 }));
    expect(a.optionSeeds).toEqual(b.optionSeeds);
    const c = generateSession(request({ seed: 43 }));
    expect(c.optionSeeds).not.toEqual(a.optionSeeds);
  });

  it('[INV-SESS-13] the placement helper never emits an adjacent repeat and never exceeds the target', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 4 }), { maxLength: 20 }),
        fc.integer({ min: 0, max: 20 }),
        (ids, target) => {
          const candidates = ids.map((n, i) => ({ ...item(n), id: `slot-${i}` }));
          const placed = placeWithoutAdjacentRepeats(candidates, target);
          expect(placed.length).toBeLessThanOrEqual(target);
          for (let i = 1; i < placed.length; i += 1) {
            expect(placed[i]!.itemId).not.toBe(placed[i - 1]!.itemId);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('the endgame flavour never introduces an unseen item (INV-SCH-06 is the scheduler lane; this is the generation half)', () => {
    const scheduler = new RecordingScheduler({ seen: ['item-1', 'item-2', 'item-3'] });
    const result = generateSession(
      request({ flavour: 'endgameReview', candidates: items(14), scheduler }),
    );
    for (const queued of result.queue) {
      expect(['item-1', 'item-2', 'item-3']).toContain(queued.itemId);
    }
  });
});
