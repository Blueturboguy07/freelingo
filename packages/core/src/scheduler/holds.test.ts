/**
 * INV-SCH-07 (report suppression) and INV-SCH-08 (a disabled modality), which are the
 * same mechanism pointed at two different scopes.
 *
 * Both invariants are about time that must NOT pass. The failure mode they share is the
 * cheapest possible bug: do nothing. Leave the clock running while the item is out of
 * circulation, and seven local days later it comes back as a week overdue — reading as a
 * lapse the learner never had (EC-SCH-08) — or three days of listening-off produce
 * EC-SCH-09's "several-hundred-item false backlog" that buries new material.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS, VirtualClock, ZONES, arbInstant } from '@freelingo/testkit';
import { addCivilDays, localDayOf } from '../day/civil.js';
import { MS_PER_DAY, REPORT_SUPPRESSION_LOCAL_DAYS } from './config.js';
import { eligibleDueRows } from './endgame.js';
import { dueAt, introduceRow, newRow, overdueMsAt, reviewRow, type FsrsRow } from './fsrs.js';
import {
  disableModality,
  dismissHold,
  enableModality,
  heldMsBetween,
  isHeldAt,
  reportHoldWindow,
  startOfLocalDay,
  type HoldWindow,
} from './holds.js';
import { asItemId, type Grade } from './types.js';

/** A row already carrying a real multi-day interval, so "overdue" means something. */
function matureRow(start: Date, id: string, modalities: readonly string[] = []): FsrsRow {
  let row = introduceRow(
    newRow({ itemId: asItemId(id), surface: 'x', kind: 'lexeme', modalities }),
    start,
  );
  let at = start;
  for (let i = 0; i < 4; i += 1) {
    row = reviewRow(row, { grade: 3, now: at }).row;
    at = dueAt(row);
  }
  return row;
}

describe('scheduler/holds', () => {
  /* ================================================================== INV-SCH-07 */

  it('[INV-SCH-07] the report window runs to the start of the 7th local day after the report', () => {
    const zone = 'America/Los_Angeles';
    const reportedAt = new Date('2026-03-05T17:00:00Z'); // 09:00 local
    const window = reportHoldWindow(asItemId('lex:es:gato'), reportedAt, zone);
    const releaseDay = addCivilDays(localDayOf(reportedAt, zone), REPORT_SUPPRESSION_LOCAL_DAYS);
    expect(window.until!.getTime()).toBe(startOfLocalDay(releaseDay, zone).getTime());
    // Seven whole civil dates, whatever the DST transition on 2026-03-08 does to the hours.
    expect(localDayOf(window.until!, zone)).toBe(releaseDay);
    expect(window.until!.getTime() - reportedAt.getTime()).not.toBe(
      REPORT_SUPPRESSION_LOCAL_DAYS * MS_PER_DAY,
    );
  });

  for (const zone of ZONES) {
    it(`[INV-SCH-07] a reported item is generated zero times and accrues zero elapsed for 7 local days (${zone.id})`, () => {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.integer({ min: 0, max: 9 }),
          fc.integer({ min: 0, max: 23 * 60 }),
          (reportedAt, probeDayOffset, probeMinutes) => {
            const itemId = asItemId('lex:es:gato');
            // Matured a year before the report, so `last_review` is genuinely in the past
            // and "overdue" is a number with a sign rather than an artefact of the setup.
            const row = matureRow(new Date(reportedAt.getTime() - 400 * MS_PER_DAY), itemId, []);
            const holds = [reportHoldWindow(itemId, reportedAt, zone.id)];
            const reportedDay = localDayOf(reportedAt, zone.id);
            const releaseAt = holds[0]!.until!;

            const probe = new Date(
              startOfLocalDay(addCivilDays(reportedDay, probeDayOffset), zone.id).getTime() +
                probeMinutes * 60_000,
            );
            const inWindow =
              probe.getTime() >= reportedAt.getTime() && probe.getTime() < releaseAt.getTime();

            const served = eligibleDueRows({
              rows: [row],
              at: probe,
              sessionLength: 15,
              holds,
            });
            if (inWindow) {
              // "generated zero times within 7 local days"
              expect(served, `${zone.id} (${zone.why})`).toHaveLength(0);
              expect(isHeldAt(row, holds, probe)).toBe(true);
            }

            // "accrues zero elapsed over the window": at the moment the window closes the
            // item is exactly as overdue as it was when it was reported, so dismissal does
            // not read as a lapse.
            expect(overdueMsAt(row, releaseAt, holds)).toBe(overdueMsAt(row, reportedAt, holds));
            // And the elapsed that reaches FSRS on the next answer excludes the window.
            const after = new Date(releaseAt.getTime() + 3 * MS_PER_DAY);
            const result = reviewRow(row, {
              grade: 3,
              now: after,
              heldMs: heldMsBetween(row, holds, row.card.last_review!, after),
            });
            expect(result.effectiveElapsedMs).toBe(
              after.getTime() -
                row.card.last_review!.getTime() -
                (releaseAt.getTime() - reportedAt.getTime()),
            );
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  it('[INV-SCH-07] falsifier: the item reported at 09:00 that came back the same afternoon', () => {
    const zone = 'America/Los_Angeles';
    const itemId = asItemId('lex:es:gato');
    const reportedAt = new Date('2026-03-05T17:00:00Z'); // 09:00 local
    const row = matureRow(new Date('2026-01-01T00:00:00Z'), itemId);
    const holds = [reportHoldWindow(itemId, reportedAt, zone)];

    // The window closes at 00:00 local on 2026-03-12, which is 158 hours after a 09:00
    // report — NOT 168. Seven LOCAL DAYS is civil-date arithmetic, and 2026-03-08 is the
    // 23-hour spring-forward day in this zone, so the window is an hour SHORT of seven
    // times 24 and starts nine hours into its first day. Every probe is asserted to be
    // inside the window first, so this test cannot quietly drift into probing after it.
    expect((holds[0]!.until!.getTime() - reportedAt.getTime()) / 3_600_000).toBe(158);
    for (const hoursLater of [5, 11, 24, 72, 157]) {
      const at = new Date(reportedAt.getTime() + hoursLater * 3_600_000);
      expect(at.getTime()).toBeLessThan(holds[0]!.until!.getTime());
      expect(eligibleDueRows({ rows: [row], at, sessionLength: 15, holds })).toHaveLength(0);
    }
    // Dismissal in Settings closes the window early and still costs no overdue-ness.
    const dismissedAt = new Date(reportedAt.getTime() + 30 * 3_600_000);
    const dismissed = dismissHold(holds, itemId, dismissedAt);
    expect(isHeldAt(row, dismissed, new Date(dismissedAt.getTime() + 1))).toBe(false);
    expect(overdueMsAt(row, dismissedAt, dismissed)).toBe(overdueMsAt(row, reportedAt, dismissed));
  });

  /* ================================================================== INV-SCH-08 */

  for (const zone of ZONES) {
    it(`[INV-SCH-08] disable-then-enable advances zero elapsed for held items (${zone.id})`, () => {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.integer({ min: 1, max: 30 * 24 }),
          fc.array(
            fc.record({
              id: fc.integer({ min: 0, max: 200 }),
              modalities: fc.constantFrom<readonly string[]>(
                ['listening'],
                ['listening', 'reading'],
                ['reading'],
                [],
              ),
            }),
            { minLength: 1, maxLength: 12 },
          ),
          (disableAt, offHours, specs) => {
            const clock = new VirtualClock(disableAt);
            const rows = specs.map((spec, i) =>
              matureRow(
                new Date(disableAt.getTime() - 400 * MS_PER_DAY),
                `lex:${spec.id}:${i}`,
                spec.modalities,
              ),
            );

            const opened = [disableModality('listening', clock.now())];
            const dueAtDisable = rows
              .filter((r) => overdueMsAt(r, disableAt, opened) >= 0)
              .map((r) => r.key)
              .sort();

            clock.advanceHours(offHours);
            const enableAt = clock.now();
            const closed: HoldWindow[] = enableModality(opened, 'listening', enableAt);

            const dueAtEnable = rows
              .filter((r) => overdueMsAt(r, enableAt, closed) >= 0)
              .map((r) => r.key)
              .sort();

            const held = rows.filter((r) => isHeldAt(r, opened, disableAt));
            for (const row of held) {
              // Zero elapsed for held items, stated exactly.
              expect(overdueMsAt(row, enableAt, closed), `${zone.id} (${zone.why})`).toBe(
                overdueMsAt(row, disableAt, opened),
              );
              expect(heldMsBetween(row, closed, disableAt, enableAt)).toBe(
                enableAt.getTime() - disableAt.getTime(),
              );
            }
            // An item with another form left keeps running: `listening` off does not hold
            // a word that can still be read.
            for (const row of rows) {
              if (held.includes(row)) continue;
              expect(heldMsBetween(row, closed, disableAt, enableAt)).toBe(0);
            }
            // The due set on re-enable is the due set at disable time, plus whatever the
            // unheld rows legitimately reached in the meantime — and never less.
            expect(dueAtEnable).toEqual(expect.arrayContaining(dueAtDisable));
            const heldKeys = new Set(held.map((r) => r.key));
            expect(dueAtEnable.filter((k) => heldKeys.has(k))).toEqual(
              dueAtDisable.filter((k) => heldKeys.has(k)),
            );
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  it('[INV-SCH-08] falsifier: three days with listening off at 20 sessions a day', () => {
    const start = new Date('2026-03-01T09:00:00Z');
    const listeningOnly = Array.from({ length: 300 }, (_, i) =>
      matureRow(start, `lex:listen:${i}`, ['listening']),
    );
    const disableAt = new Date(start.getTime() + 30 * MS_PER_DAY);
    const opened = [disableModality('listening', disableAt)];
    const backlogAtDisable = listeningOnly.filter((r) => overdueMsAt(r, disableAt, opened) >= 0);

    const enableAt = new Date(disableAt.getTime() + 3 * MS_PER_DAY);
    const closed = enableModality(opened, 'listening', enableAt);
    const backlogAtEnable = listeningOnly.filter((r) => overdueMsAt(r, enableAt, closed) >= 0);

    // Without the pause, three days x 300 items is the several-hundred-item false backlog.
    expect(backlogAtEnable).toHaveLength(backlogAtDisable.length);
    // And nothing is generable while the modality is off.
    const midWindow = new Date(disableAt.getTime() + 36 * 3_600_000);
    expect(
      eligibleDueRows({ rows: listeningOnly, at: midWindow, sessionLength: 15, holds: opened }),
    ).toHaveLength(0);
  });

  it('[INV-SCH-08] a suspension inside a longer gap is measured exactly, not sampled', () => {
    const start = new Date('2026-03-01T00:00:00Z');
    const row = matureRow(start, 'lex:es:gato', ['listening']);
    const from = new Date('2026-04-01T00:00:00Z');
    const to = new Date('2026-04-04T00:00:00Z');
    const oneHour: HoldWindow = {
      scope: { kind: 'modality', modality: 'listening' },
      reason: 'modalitySuspended',
      from: new Date('2026-04-02T13:00:00Z'),
      until: new Date('2026-04-02T14:00:00Z'),
    };
    expect(heldMsBetween(row, [oneHour], from, to)).toBe(3_600_000);
  });

  it('[INV-SCH-08] overlapping windows are a union, never a sum', () => {
    const start = new Date('2026-03-01T00:00:00Z');
    const row = matureRow(start, 'lex:es:gato', ['listening']);
    const a: HoldWindow = {
      scope: { kind: 'item', itemId: row.itemId },
      reason: 'report',
      from: new Date('2026-04-01T00:00:00Z'),
      until: new Date('2026-04-05T00:00:00Z'),
    };
    const b: HoldWindow = {
      scope: { kind: 'modality', modality: 'listening' },
      reason: 'modalityDisabled',
      from: new Date('2026-04-03T00:00:00Z'),
      until: new Date('2026-04-07T00:00:00Z'),
    };
    expect(heldMsBetween(row, [a, b], a.from, b.until!)).toBe(6 * MS_PER_DAY);
  });

  it('[INV-SCH-07] a held row that is answered anyway credits nothing', () => {
    const start = new Date('2026-03-01T09:00:00Z');
    const row = matureRow(start, 'lex:es:gato');
    const holds = [reportHoldWindow(row.itemId, start, 'Asia/Tokyo')];
    const grade: Grade = 3;
    const result = reviewRow(row, {
      grade,
      now: new Date(start.getTime() + MS_PER_DAY),
      held: isHeldAt(row, holds, new Date(start.getTime() + MS_PER_DAY)),
    });
    expect(result.kind).toBe('uncredited');
    expect(result.row.card).toBe(row.card);
    expect(result.anomalies.map((a) => a.kind)).toContain('heldItemEncounter');
  });
});
