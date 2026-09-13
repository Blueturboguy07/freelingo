import type { Db, DbRow } from '@freelingo/schema';
import {
  FREEZE_CHANNELS,
  newDayEngineState,
  toLocalDay,
  type DayEngineState,
  type DayKeyGuardState,
  type DayDisposition,
  type LocalDay,
  type FreezeGrant,
  type FreezeConsumption,
  type ZoneStamp,
} from '@freelingo/core/day';
import { canonicalJson } from '@freelingo/core/session';
import { LearningDataError } from './SqliteSchedulerStore';
export interface PersistedDayState {
  readonly engine: DayEngineState;
  readonly satisfiedDays: ReadonlySet<LocalDay>;
  readonly guard: DayKeyGuardState;
}
function fail(field: string): never {
  throw new LearningDataError('Invalid day ledger: ' + field);
}
function text(v: unknown, f: string): string {
  if (typeof v !== 'string' || !v.trim()) return fail(f);
  return v;
}
function int(v: unknown, f: string, min = 0): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) return fail(f);
  return v;
}
function day(v: unknown): LocalDay {
  return toLocalDay(text(v, 'civil day'));
}
function optionalDay(v: unknown): LocalDay | null {
  return v === null ? null : day(v);
}
function month(v: unknown): string {
  const s = text(v, 'month');
  day(s + '-01');
  return s;
}
function optionalMonth(v: unknown): string | null {
  return v === null ? null : month(v);
}
function oneOf<T extends string | number>(v: unknown, values: readonly T[], f: string): T {
  const value = values.find((x) => x === v);
  if (value === undefined) return fail(f);
  return value;
}
function flag(v: unknown, f: string): boolean {
  return oneOf(v, [0, 1] as const, f) === 1;
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function requireHistory<T>(old: readonly T[], next: readonly T[], key: (r: T) => string): void {
  const map = new Map(next.map((r) => [key(r), r]));
  if (map.size !== next.length) return fail('duplicate history key');
  for (const r of old) if (!same(r, map.get(key(r)))) return fail('changed history');
}
function readZone(account: DbRow): ZoneStamp | null {
  const values = [
    account.last_completed_at_utc_ms,
    account.last_tz_id,
    account.last_utc_offset_minutes,
    account.last_tz_source,
  ];
  if (values.every((v) => v === null)) return null;
  const utc = int(account.last_completed_at_utc_ms, 'guard timestamp', -Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(new Date(utc).getTime())) return fail('guard timestamp');
  return {
    tzId: text(account.last_tz_id, 'guard zone'),
    utcOffsetMinutes: int(
      account.last_utc_offset_minutes,
      'guard offset',
      -Number.MAX_SAFE_INTEGER,
    ),
    tzSource: oneOf(
      account.last_tz_source,
      ['iana', 'fixed_offset', 'unknown'] as const,
      'guard zone source',
    ),
  };
}
function readGrant(r: DbRow): FreezeGrant {
  const requested = int(r.requested, 'grant requested'),
    applied = int(r.applied, 'grant applied');
  if (applied > requested) return fail('grant amount');
  return {
    grantKey: text(r.grant_key, 'grant key'),
    channel: oneOf(r.channel, FREEZE_CHANNELS, 'freeze channel'),
    subtype: r.subtype === null ? null : oneOf(r.subtype, ['one_time'] as const, 'freeze subtype'),
    ownedFromDay: day(r.owned_from_day),
    requested,
    applied,
  };
}
const dispositions: readonly DayDisposition[] = [
  'completed',
  'frozen',
  'missed',
  'unlived',
  'recovered',
];
/** Normalized ledger persistence. Mutations join a containing completion transaction
 * through its scoped Db; this adapter never awards XP or reconstructs unknown history. */
export class SqliteDayStore {
  constructor(private readonly db: Db) {}
  load(): PersistedDayState {
    const a = this.db.get('SELECT * FROM account WHERE id=1');
    if (!a) return fail('missing account');
    const engine = newDayEngineState({ cap: int(a.freeze_cap, 'freeze cap') });
    const ds = new Map<LocalDay, DayDisposition>(),
      grace = new Set<LocalDay>(),
      satisfied = new Set<LocalDay>();
    for (const r of this.db.all('SELECT * FROM account_day ORDER BY local_day')) {
      const d = day(r.local_day);
      if (r.disposition !== null) ds.set(d, oneOf(r.disposition, dispositions, 'disposition'));
      if (flag(r.grace_credited, 'grace flag')) grace.add(d);
      if (flag(r.streak_satisfied, 'satisfied flag')) satisfied.add(d);
    }
    if (
      int(a.streak, 'streak') > 0 &&
      satisfied.size === 0 &&
      (a.last_processed_day === null || ds.size === 0)
    )
      return fail('legacy streak history requires recovery');
    const grants = this.db.all('SELECT * FROM account_freeze_grant ORDER BY rowid').map(readGrant);
    const byGrant = new Map(grants.map((g) => [g.grantKey, g])),
      unitCounts = new Map<string, number>(),
      consumptions: FreezeConsumption[] = [];
    for (const r of this.db.all(
      'SELECT * FROM account_freeze ORDER BY consumed_for_day,freeze_id',
    )) {
      if (r.grant_key === null) return fail('legacy freeze provenance requires recovery');
      const key = text(r.grant_key, 'unit grant'),
        g = byGrant.get(key);
      if (!g) return fail('orphan freeze unit');
      if (
        day(r.acquired_on_day) !== g.ownedFromDay ||
        r.acquired_via !== g.channel ||
        r.subtype !== (g.subtype ?? 'standard')
      )
        return fail('freeze unit provenance');
      unitCounts.set(key, (unitCounts.get(key) ?? 0) + 1);
      if (r.consumed_for_day === null) {
        if (r.consumed_on_day !== null) return fail('partial freeze consumption');
      } else {
        if (r.consumed_on_day === null)
          return fail('legacy consumption provenance requires recovery');
        const forDay = day(r.consumed_for_day),
          onDay = day(r.consumed_on_day);
        if (g.ownedFromDay >= forDay || onDay < forDay)
          return fail('freeze was not owned before missed day');
        consumptions.push({ consumedForDay: forDay, consumedOnDay: onDay });
      }
    }
    for (const g of grants)
      if ((unitCounts.get(g.grantKey) ?? 0) !== g.applied) return fail('freeze grant unit count');
    if (new Set(consumptions.map((c) => c.consumedForDay)).size !== consumptions.length)
      return fail('duplicate freeze consumption');
    const consumedDays = new Set(consumptions.map((c) => c.consumedForDay));
    if (
      consumptions.some((c) => ds.get(c.consumedForDay) !== 'frozen') ||
      [...ds].some(([d, disposition]) => disposition === 'frozen' && !consumedDays.has(d))
    )
      return fail('freeze/disposition mismatch');
    const br = this.db.get('SELECT * FROM account_streak_break WHERE id=1');
    const brk = br
      ? {
          brokenOn: day(br.broken_on),
          previousStreak: int(br.previous_streak, 'previous streak'),
          uncoveredDays: this.db
            .all('SELECT local_day FROM account_streak_break_day ORDER BY local_day')
            .map((r) => day(r.local_day)),
        }
      : null;
    if (!brk && this.db.get('SELECT 1 FROM account_streak_break_day'))
      return fail('orphan break days');
    const ch = this.db.get('SELECT * FROM account_recovery_challenge WHERE id=1');
    const challenge = ch
      ? {
          brokenOn: day(ch.broken_on),
          previousStreak: int(ch.previous_streak, 'challenge streak'),
          expiresAfterDay: day(ch.expires_after_day),
          lessonsRequired: int(ch.lessons_required, 'required lessons', 1),
          lessonsDone: int(ch.lessons_done, 'completed lessons'),
          earnedOnDay: optionalDay(ch.earned_on_day),
        }
      : null;
    if (
      challenge &&
      (challenge.lessonsDone > challenge.lessonsRequired ||
        (challenge.lessonsDone === challenge.lessonsRequired) !== (challenge.earnedOnDay !== null))
    )
      return fail('challenge progress');
    const repairs = this.db
      .all('SELECT * FROM account_streak_repair ORDER BY month_key')
      .map((r) => ({
        monthKey: month(r.month_key),
        onDay: day(r.repaired_on_day),
        restoredStreak: int(r.restored_streak, 'restored streak'),
        repaintedDays: this.db
          .all(
            'SELECT local_day FROM account_streak_repair_day WHERE month_key=? ORDER BY local_day',
            [r.month_key],
          )
          .map((x) => day(x.local_day)),
      }));
    const settlements = this.db
      .all('SELECT * FROM account_month_settlement ORDER BY rowid')
      .map((r) => ({
        month: month(r.month),
        settledMonth: optionalMonth(r.settled_month),
        atDay: day(r.at_day),
      }));
    const longAbsences = this.db
      .all('SELECT * FROM account_long_absence ORDER BY rowid')
      .map((r) => ({
        from: day(r.from_day),
        to: day(r.to_day),
        days: int(r.days, 'absence days', 1),
        freezesConsumed: int(r.freezes_consumed, 'absence freezes'),
      }));
    const lastZone = readZone(a),
      max = optionalDay(a.max_local_day_seen);
    return {
      engine: {
        ...engine,
        lastProcessedDay: optionalDay(a.last_processed_day),
        maxLocalDaySeen: max,
        dispositions: ds,
        graceCreditedDays: grace,
        longestStreak: int(a.longest_streak, 'longest streak'),
        ledger: { cap: engine.ledger.cap, grants, consumptions },
        brk,
        challenge,
        repairs,
        settlements,
        lastProcessedMonth: optionalMonth(a.last_processed_month),
        longAbsences,
        clockUnreliable: flag(a.clock_unreliable, 'clock flag'),
      },
      satisfiedDays: satisfied,
      guard: {
        maxLocalDaySeen: max,
        lastCompletedAtUtcMs:
          lastZone === null
            ? null
            : int(a.last_completed_at_utc_ms, 'guard timestamp', -Number.MAX_SAFE_INTEGER),
        lastZone,
      },
    };
  }
  save(next: PersistedDayState): void {
    this.db.withExclusiveTransaction(() => {
      const before = this.load(),
        old = before.engine,
        n = next.engine;
      if (n.maxLocalDaySeen !== next.guard.maxLocalDaySeen) return fail('guard high-water binding');
      if (
        (old.maxLocalDaySeen !== null &&
          (n.maxLocalDaySeen === null || n.maxLocalDaySeen < old.maxLocalDaySeen)) ||
        (old.lastProcessedDay !== null &&
          (n.lastProcessedDay === null || n.lastProcessedDay < old.lastProcessedDay)) ||
        n.longestStreak < old.longestStreak
      )
        return fail('backward history marker');
      for (const [d, disposition] of old.dispositions) {
        const replacement = n.dispositions.get(d);
        if (
          replacement !== disposition &&
          !(disposition === 'missed' && replacement === 'recovered')
        )
          return fail('changed disposition history');
      }
      for (const d of before.satisfiedDays)
        if (!next.satisfiedDays.has(d)) return fail('erased satisfied history');
      for (const d of old.graceCreditedDays)
        if (!n.graceCreditedDays.has(d)) return fail('erased grace history');
      requireHistory(old.ledger.grants, n.ledger.grants, (g) => g.grantKey);
      requireHistory(old.ledger.consumptions, n.ledger.consumptions, (c) => c.consumedForDay);
      requireHistory(old.repairs, n.repairs, (r) => r.monthKey);
      requireHistory(old.settlements, n.settlements, (s) => s.month);
      requireHistory(old.longAbsences, n.longAbsences, (a) => a.from + '|' + a.to);
      const cap = int(n.ledger.cap, 'freeze cap');
      if (
        n.ledger.grants.some((g) => g.applied > cap) ||
        n.ledger.grants.reduce((sum, g) => sum + g.applied, 0) - n.ledger.consumptions.length > cap
      )
        return fail('freeze cap');
      const existingGrants = new Set(old.ledger.grants.map((g) => g.grantKey));
      for (const g of n.ledger.grants)
        if (!existingGrants.has(g.grantKey)) {
          const checked = readGrant({
            grant_key: g.grantKey,
            channel: g.channel,
            subtype: g.subtype,
            owned_from_day: g.ownedFromDay,
            requested: g.requested,
            applied: g.applied,
          });
          this.db.run('INSERT INTO account_freeze_grant VALUES(?,?,?,?,?,?)', [
            checked.grantKey,
            checked.channel,
            checked.subtype,
            checked.ownedFromDay,
            checked.requested,
            checked.applied,
          ]);
          for (let i = 0; i < checked.applied; i++)
            this.db.run(
              'INSERT INTO account_freeze(freeze_id,acquired_on_day,acquired_via,subtype,grant_key) VALUES(?,?,?,?,?)',
              [
                JSON.stringify([checked.grantKey, i]),
                checked.ownedFromDay,
                checked.channel,
                checked.subtype ?? 'standard',
                checked.grantKey,
              ],
            );
        }
      const existingConsumptions = new Set(old.ledger.consumptions.map((c) => c.consumedForDay));
      for (const c of n.ledger.consumptions)
        if (!existingConsumptions.has(c.consumedForDay)) {
          const forDay = day(c.consumedForDay),
            onDay = day(c.consumedOnDay);
          if (onDay < forDay) return fail('consumption order');
          const unit = this.db.get(
            'SELECT freeze_id FROM account_freeze WHERE consumed_for_day IS NULL AND acquired_on_day<? ORDER BY acquired_on_day,freeze_id LIMIT 1',
            [forDay],
          );
          if (!unit) return fail('no freeze owned before missed day');
          this.db.run(
            'UPDATE account_freeze SET consumed_for_day=?,consumed_on_day=? WHERE freeze_id=?',
            [forDay, onDay, unit.freeze_id],
          );
        }
      const account = this.db.get('SELECT daily_goal_xp FROM account WHERE id=1')!;
      const allDays = new Set([
        ...n.dispositions.keys(),
        ...n.graceCreditedDays,
        ...next.satisfiedDays,
      ]);
      for (const rawDay of allDays) {
        const d = day(rawDay),
          disposition = n.dispositions.get(d) ?? null;
        if (disposition !== null) oneOf(disposition, dispositions, 'disposition');
        this.db.run(
          'INSERT INTO account_day(local_day,goal_xp,day_source) VALUES(?,?,?) ON CONFLICT(local_day) DO NOTHING',
          [d, int(account.daily_goal_xp, 'goal'), disposition === 'unlived' ? 'unlived' : 'lived'],
        );
        this.db.run(
          'UPDATE account_day SET disposition=?,grace_credited=?,streak_satisfied=?,freeze_consumed=? WHERE local_day=?',
          [
            disposition,
            Number(n.graceCreditedDays.has(d)),
            Number(next.satisfiedDays.has(d)),
            Number(n.ledger.consumptions.some((c) => c.consumedForDay === d)),
            d,
          ],
        );
      }
      // These rows describe the current offer, not immutable reward history.
      this.db.run('DELETE FROM account_streak_break');
      if (n.brk) {
        this.db.run('INSERT INTO account_streak_break VALUES(1,?,?)', [
          day(n.brk.brokenOn),
          int(n.brk.previousStreak, 'previous streak'),
        ]);
        for (const d of n.brk.uncoveredDays)
          this.db.run('INSERT INTO account_streak_break_day VALUES(?,1)', [day(d)]);
      }
      this.db.run('DELETE FROM account_recovery_challenge');
      if (n.challenge) {
        const c = n.challenge;
        this.db.run('INSERT INTO account_recovery_challenge VALUES(1,?,?,?,?,?,?)', [
          day(c.brokenOn),
          int(c.previousStreak, 'challenge streak'),
          day(c.expiresAfterDay),
          int(c.lessonsRequired, 'required lessons', 1),
          int(c.lessonsDone, 'completed lessons'),
          optionalDay(c.earnedOnDay),
        ]);
      }
      for (const r of n.repairs)
        if (!old.repairs.some((x) => x.monthKey === r.monthKey)) {
          this.db.run('INSERT INTO account_streak_repair VALUES(?,?,?)', [
            month(r.monthKey),
            day(r.onDay),
            int(r.restoredStreak, 'restored streak'),
          ]);
          for (const d of r.repaintedDays)
            this.db.run('INSERT INTO account_streak_repair_day VALUES(?,?)', [r.monthKey, day(d)]);
        }
      for (const s of n.settlements)
        if (!old.settlements.some((x) => x.month === s.month))
          this.db.run('INSERT INTO account_month_settlement VALUES(?,?,?)', [
            month(s.month),
            optionalMonth(s.settledMonth),
            day(s.atDay),
          ]);
      for (const a of n.longAbsences)
        if (!old.longAbsences.some((x) => x.from === a.from && x.to === a.to))
          this.db.run('INSERT INTO account_long_absence VALUES(?,?,?,?)', [
            day(a.from),
            day(a.to),
            int(a.days, 'absence days', 1),
            int(a.freezesConsumed, 'absence freezes'),
          ]);
      const g = next.guard,
        z = g.lastZone;
      if ((z === null) !== (g.lastCompletedAtUtcMs === null)) return fail('partial guard zone');
      this.db.run(
        'UPDATE account SET last_processed_day=?,max_local_day_seen=?,longest_streak=?,freeze_cap=?,last_processed_month=?,clock_unreliable=?,last_completed_at_utc_ms=?,last_tz_id=?,last_utc_offset_minutes=?,last_tz_source=? WHERE id=1',
        [
          optionalDay(n.lastProcessedDay),
          optionalDay(n.maxLocalDaySeen),
          int(n.longestStreak, 'longest streak'),
          int(n.ledger.cap, 'freeze cap'),
          optionalMonth(n.lastProcessedMonth),
          Number(n.clockUnreliable),
          g.lastCompletedAtUtcMs,
          z?.tzId ?? null,
          z?.utcOffsetMinutes ?? null,
          z?.tzSource ?? null,
        ],
      );
      this.load(); // Validate the complete SQL representation before its transaction can commit.
    });
  }
}
