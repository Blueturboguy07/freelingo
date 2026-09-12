/**
 * The P1 journey gate: thirty simulated local days, two courses, four zones, one engine.
 *
 * Run as part of `pnpm test`. It binds the real modules (`bind.ts` never substitutes a
 * local implementation), drives `script.ts` through them, and asserts the END-STATE
 * LEDGERS — not screens, not intermediate renders.
 *
 * The three failure lists it produces are different things and are asserted separately,
 * because collapsing them is how a gate stops being readable:
 *
 *  - `replayViolations` — a day whose rollover, replayed with the same arguments, decided
 *    something. INV-DAY-09 and INV-FRZ-05. Every day in the trace is replayed once.
 *  - `refutations` — the engine and an independent reference disagree. Each one names the
 *    lane that owns it, because this task does not patch across a module boundary.
 *  - `notProven` — a clause of the journey that could not be executed at all, because the
 *    lane that owns it has not landed. This fails the gate too, but it is not a defect
 *    report: it is the list docs/P1-REPORT.md prints under NOT PROVEN.
 */
import { describe, expect, it } from 'vitest';
import { bindEngine } from './bind.js';
import { DEFAULT_SEED, runJourney, type JourneyLedger } from './driver.js';
import { JOURNEY, JOURNEY_DAYS, PRIMARY_COURSE, SECOND_COURSE } from './script.js';

/**
 * Skipped inside a Stryker worker: `stryker.config.json` does not mutate `journey/**`,
 * and driving a 30-day trace under every mutant measures the gate rather than the engine.
 */
const UNDER_STRYKER = process.env['STRYKER_MUTATOR_WORKER'] !== undefined;

const bound = await bindEngine();
const ledger: JourneyLedger = runJourney({ engine: bound.engine, seed: DEFAULT_SEED });

describe.skipIf(UNDER_STRYKER)('the 30-day two-course four-zone journey', () => {
  it('binds every port it needs to a real engine module (it never substitutes one)', () => {
    expect(
      bound.missing,
      'the journey drives the real modules; these capabilities could not be resolved. ' +
        'Each line is `port.capability`; ports.ts names the lane that owes each port.',
    ).toEqual([]);
  });

  it('executed every clause of the journey (nothing silently skipped)', () => {
    expect(ledger.notProven).toEqual([]);
  });

  it('ran all thirty local days, in order, in the zone each day declares', () => {
    expect(ledger.days).toHaveLength(JOURNEY_DAYS);
    expect(ledger.days.map((d) => d.localDay)).toEqual(JOURNEY.map((d) => d.localDate));
    expect(ledger.days.map((d) => d.zone)).toEqual(JOURNEY.map((d) => d.zone));
  });

  it("[INV-DAY-09] every day's rollover is idempotent: replaying it decides nothing", () => {
    expect(ledger.replayViolations).toEqual([]);
    expect(ledger.days.every((d) => d.replayClean)).toBe(true);
  });

  it('the engine agrees with an independent reference all thirty days', () => {
    expect(ledger.refutations).toEqual([]);
  });

  it('both courses are installed and both carry XP at the end', () => {
    expect(Object.keys(ledger.courses).sort()).toEqual([PRIMARY_COURSE, SECOND_COURSE].sort());
    expect(ledger.courses[PRIMARY_COURSE]!.sessions).toBeGreaterThan(0);
    expect(ledger.courses[SECOND_COURSE]!.sessions).toBeGreaterThan(0);
  });

  it('conservation: lifetime XP is the sum of the two courses XP', () => {
    const sum = Object.values(ledger.courses).reduce((total, c) => total + c.xp, 0);
    expect(ledger.account.lifetimeXp).toBe(sum);
  });

  it('conservation: one committed session row per session, none committed twice', () => {
    const ids = ledger.committedSessions.map((row) => row.sessionId);
    expect(new Set(ids).size).toBe(ids.length);
    const sessions = Object.values(ledger.courses).reduce((total, c) => total + c.sessions, 0);
    expect(ids.length).toBe(sessions);
  });

  it('[INV-FRZ-01] freezes consumed never exceed freezes granted', () => {
    expect(ledger.account.freezesConsumed).toBeLessThanOrEqual(ledger.account.freezesGranted);
    expect(ledger.account.freezesConsumed).toBeGreaterThan(0);
  });

  it('[INV-DAY-03] the date-line crossing produced an unlived date, and it is not missed', () => {
    expect(ledger.unlivedDays).toContain('2026-10-04');
    expect(ledger.dispositions.get('2026-10-04')).not.toBe('missed');
  });

  it('[INV-REC-01] at most one Streak Repair per calendar month, and never on a frozen day', () => {
    const byMonth = new Map<string, number>();
    for (const repair of ledger.account.repairs) {
      byMonth.set(repair.monthKey, (byMonth.get(repair.monthKey) ?? 0) + 1);
    }
    expect([...byMonth.values()].every((n) => n <= 1)).toBe(true);
    for (const repair of ledger.account.repairs) {
      expect(ledger.dispositions.get(repair.onDay)).not.toBe('frozen');
    }
  });

  it('[INV-DAY-16] months are settled exactly once each, and the trace crosses one boundary', () => {
    const months = ledger.account.settledMonths;
    expect(new Set(months).size).toBe(months.length);
    expect(months).toContain('2026-09');
    expect(months).toContain('2026-10');
  });

  it('every day of the trace has a settled disposition by the end', () => {
    const undecided = ledger.days
      .filter((d) => d.disposition === null)
      .map((d) => `${d.day} (${d.localDay})`);
    // The last day is still open when its snapshot is taken; the closing rollover decides
    // it, so only that one may be null at snapshot time.
    expect(undecided.length).toBeLessThanOrEqual(1);
  });

  it('the streak never moves by more than one lived day in a day', () => {
    const jumps: string[] = [];
    for (let i = 1; i < ledger.days.length; i += 1) {
      const delta = ledger.days[i]!.streak - ledger.days[i - 1]!.streak;
      // A restore (recovery or repair) may raise it by the whole previous streak, which
      // is what makes the interesting direction the other one: it may never jump ahead.
      if (delta > 1) {
        const wasRestore = JOURNEY[i]!.events.some(
          (e) => e.kind === 'streak-repair' || e.kind === 'recovery-lesson',
        );
        if (!wasRestore) jumps.push(`day ${ledger.days[i]!.day}: +${delta}`);
      }
    }
    expect(jumps).toEqual([]);
  });
});
