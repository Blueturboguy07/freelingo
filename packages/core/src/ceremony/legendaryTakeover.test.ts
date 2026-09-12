/**
 * The legendary takeover: INV-CER-10.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  DECLINES_BEFORE_SUPPRESSION,
  FRESH_TAKEOVER_STATE,
  onSectionBoundary,
  popupLegendaryEnabled,
  recordAccepted,
  recordDecline,
  takeoverEligible,
  type TakeoverState,
} from './legendaryTakeover.js';
import { runCeremony } from './queue.js';
import { ceremonyState } from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

describe('the legendary takeover', () => {
  it('[INV-CER-10] falsifier: a ten-node decline run renders two takeovers, not ten', () => {
    const input = falsifier('INV-CER-10');
    const expected = input.expect as Record<string, number | boolean>;
    let takeover: TakeoverState = FRESH_TAKEOVER_STATE;
    let rendered = 0;
    for (let i = 0; i < (input.nodes as number); i += 1) {
      const chain = runCeremony(
        ceremonyState({}, { nodeIsComplete: true, nodeIsLegendary: false, takeover }),
      ).chain;
      if (chain.includes('S081_nodeCompleteLegendaryOffer')) {
        rendered += 1;
        takeover = recordDecline(takeover);
      }
      // The popup button is never disabled by any of this.
      expect(popupLegendaryEnabled()).toBe(expected.popupButtonAlwaysEnabled);
    }
    expect(rendered).toBe(expected.takeoversRendered);
  });

  it('[INV-CER-10] eligibility is false after two consecutive declines and true again after a re-arm', () => {
    let state = recordDecline(recordDecline(FRESH_TAKEOVER_STATE));
    expect(takeoverEligible(state)).toBe(false);
    expect(takeoverEligible(onSectionBoundary())).toBe(true);
    state = recordAccepted();
    expect(takeoverEligible(state)).toBe(true);
  });

  it('[INV-CER-10] over any decline/accept/boundary trace, no run exceeds two consecutive takeovers', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('decline' as const, 'accept' as const, 'boundary' as const), {
          minLength: 1,
          maxLength: 40,
        }),
        (events) => {
          let state = FRESH_TAKEOVER_STATE;
          let consecutive = 0;
          for (const event of events) {
            if (!takeoverEligible(state)) {
              // Suppressed: only a boundary or an accepted run re-arms it.
              expect(state.consecutiveDeclines).toBeGreaterThanOrEqual(DECLINES_BEFORE_SUPPRESSION);
              if (event === 'boundary') state = onSectionBoundary();
              else if (event === 'accept') state = recordAccepted();
              consecutive = 0;
              continue;
            }
            if (event === 'decline') {
              consecutive += 1;
              expect(consecutive).toBeLessThanOrEqual(DECLINES_BEFORE_SUPPRESSION);
              state = recordDecline(state);
            } else if (event === 'accept') {
              state = recordAccepted();
              consecutive = 0;
            } else {
              state = onSectionBoundary();
              consecutive = 0;
            }
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-CER-10] an already-legendary node never offers the takeover', () => {
    const chain = runCeremony(
      ceremonyState({}, { nodeIsComplete: true, nodeIsLegendary: true }),
    ).chain;
    expect(chain).not.toContain('S081_nodeCompleteLegendaryOffer');
  });

  it('[INV-CER-10] the offer is an eligibility test, not a completed-this-session trigger', () => {
    // ADV 02/A10: deep/105 shows the offer again after a PRACTICE session on a node that
    // was already complete before that session started.
    const chain = runCeremony(
      ceremonyState(
        {},
        { nodeCompletedThisSession: false, nodeIsComplete: true, nodeIsLegendary: false },
        { flavour: 'practice' },
      ),
    ).chain;
    expect(chain).toContain('S081_nodeCompleteLegendaryOffer');
  });
});
