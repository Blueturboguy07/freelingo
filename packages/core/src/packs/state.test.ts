import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  NOT_DOWNLOADED_FACTS,
  PACK_EVENTS,
  PACK_STATES,
  allPackSurfaces,
  applyPackEvent,
  packSurface,
  resolvePackState,
  type PackFacts,
} from './state.js';

/**
 * INV-PACK-01, INV-PACK-04 and INV-PACK-18's enum half.
 *
 * The generator draws facts, not a state: a pack's state is a reading of the disk and the
 * catalogue, and the combinations that matter are the contradictory ones (a withdrawn
 * pack that is also corrupt, a valid signature over no file, audio present beyond what is
 * expected). A generator over `PackState` would only ever produce the six answers.
 */
const arbFacts: fc.Arbitrary<PackFacts> = fc
  .record({
    catalogue: fc.constantFrom<PackFacts['catalogue']>('available', 'withdrawn'),
    dbPresent: fc.boolean(),
    signature: fc.constantFrom<PackFacts['signature']>('valid', 'invalid', 'unchecked'),
    integrity: fc.constantFrom<PackFacts['integrity']>('ok', 'failed'),
    audioBytesExpected: fc.integer({ min: 0, max: 120_000_000 }),
    audioFraction: fc.integer({ min: 0, max: 100 }),
  })
  .map(({ audioBytesExpected, audioFraction, ...rest }) => ({
    ...rest,
    audioBytesExpected,
    audioBytesPresent: Math.round((audioBytesExpected * audioFraction) / 100),
  }));

describe('INV-PACK-01 six-value pack enum', () => {
  it('[INV-PACK-01] the enum has exactly the six named values', () => {
    expect([...PACK_STATES]).toEqual([
      'not-downloaded',
      'partial',
      'installed',
      'corrupt',
      'unverified',
      'withdrawn',
    ]);
    expect(new Set(PACK_STATES).size).toBe(6);
  });

  it('[INV-PACK-01] resolving is total: every combination of facts lands on one of the six', () => {
    fc.assert(
      fc.property(arbFacts, (facts) => {
        expect(PACK_STATES).toContain(resolvePackState(facts));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-01] the machine is total: every event applied to any facts still resolves', () => {
    fc.assert(
      fc.property(
        arbFacts,
        fc.constantFrom(...PACK_EVENTS),
        fc.integer({ min: 0, max: 120_000_000 }),
        (facts, event, bytes) => {
          const next = applyPackEvent(facts, event, bytes);
          expect(PACK_STATES).toContain(resolvePackState(next));
          expect(next.audioBytesPresent).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-01] every surface renders every value, with its own copy and one action', () => {
    const surfaces = allPackSurfaces();
    expect(surfaces).toHaveLength(6);
    const copy = surfaces.map((s) => s.copyKey);
    expect(new Set(copy).size, 'two states sharing a copy string is EC-PACK-01').toBe(6);
    for (const surface of surfaces) {
      expect(surface.copyKey.length).toBeGreaterThan(0);
      expect(['download', 'resume', 'redownload', 'repair', 'none']).toContain(surface.action);
    }
  });

  it('[INV-PACK-01] a withdrawn pack keeps its course read-only with account totals intact', () => {
    const withdrawn = packSurface('withdrawn');
    expect(withdrawn.pathRendered).toBe(true);
    expect(withdrawn.readOnly).toBe(true);
    expect(withdrawn.lessonsPlayable).toBe(false);
    expect(withdrawn.accountTotalsCounted).toBe(true);
    expect(withdrawn.progressRowsRetained).toBe(true);
  });

  it('[INV-PACK-01] no state ever drops progress rows or stops counting account totals', () => {
    fc.assert(
      fc.property(arbFacts, (facts) => {
        const surface = packSurface(resolvePackState(facts));
        // EC-PER-09: dropping the course makes Total XP disagree with the visible courses.
        expect(surface.accountTotalsCounted).toBe(true);
        expect(surface.progressRowsRetained).toBe(true);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-01] a withdrawal is honoured whatever the local disk says', () => {
    fc.assert(
      fc.property(arbFacts, (facts) => {
        expect(resolvePackState(applyPackEvent(facts, 'catalogue-withdrawn'))).toBe('withdrawn');
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('INV-PACK-04 partial is not corrupt', () => {
  it('[INV-PACK-04] a partial pack keeps the path and lessons usable, with per-item fallback and RESUME', () => {
    const partial = packSurface('partial');
    expect(partial.pathRendered).toBe(true);
    expect(partial.lessonsPlayable).toBe(true);
    expect(partial.perItemAudioFallback).toBe(true);
    expect(partial.action).toBe('resume');
    expect(partial.showsUnavailable).toBe(false);
  });

  it('[INV-PACK-04] only corrupt shows the unavailable state', () => {
    const showing = PACK_STATES.filter((state) => packSurface(state).showsUnavailable);
    expect(showing).toEqual(['corrupt']);
  });

  it('[INV-PACK-04] an interrupted audio fetch over an installed pack resolves to partial, never corrupt', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 120_000_000 }), (expected) => {
        const installed: PackFacts = {
          ...NOT_DOWNLOADED_FACTS,
          dbPresent: true,
          signature: 'valid',
          audioBytesExpected: expected,
          audioBytesPresent: expected,
        };
        expect(resolvePackState(installed)).toBe('installed');
        const interrupted = applyPackEvent(
          installed,
          'audio-fetch-interrupted',
          Math.floor(expected * 0.6),
        );
        expect(resolvePackState(interrupted)).toBe('partial');
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('INV-PACK-18 an invalid signature is never corrupt', () => {
  it('[INV-PACK-18] no arrangement of facts maps an invalid signature to corrupt', () => {
    fc.assert(
      fc.property(arbFacts, (facts) => {
        const state = resolvePackState({ ...facts, signature: 'invalid' });
        expect(state).not.toBe('corrupt');
        // Only a catalogue withdrawal outranks it; otherwise it is the distinct state.
        expect(state).toBe(facts.catalogue === 'withdrawn' ? 'withdrawn' : 'unverified');
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-18] unverified carries its own copy and a re-download action, unlike corrupt', () => {
    const unverified = packSurface('unverified');
    const corrupt = packSurface('corrupt');
    expect(unverified.copyKey).not.toBe(corrupt.copyKey);
    expect(unverified.action).toBe('redownload');
    expect(corrupt.action).toBe('repair');
    expect(unverified.showsUnavailable).toBe(false);
  });

  it('[INV-PACK-18] bytes that were never verified are never treated as installed', () => {
    const staged: PackFacts = {
      ...NOT_DOWNLOADED_FACTS,
      dbPresent: true,
      signature: 'unchecked',
      audioBytesExpected: 100,
      audioBytesPresent: 100,
    };
    expect(resolvePackState(staged)).toBe('unverified');
  });
});
