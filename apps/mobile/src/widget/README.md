# Snapshot-only widget boundary — S138–S140

2026-09-13 bounded P5 implementation. The existing core widget engine owns the
states, threshold ladder, draw-time civil-boundary calculation and timeline. This
leaf adds source, transport, routing and durable publication boundaries. It does
not claim a built WidgetKit/Glance view, a device reload measurement, or a passing
P5 phase gate.

The five file lanes are:

1. `packages/core/src/widget/snapshot.ts`: closed shared JSON parser and projection
   from explicitly known committed account facts. Missing/unknown history returns
   UNKNOWN; zero values never establish known-empty history. Genuine initialized
   zero history may render COLD. Completed-session streak safety and XP goal status
   remain separate, including STREAK_SAFE_GOAL_UNMET.
2. `packages/core/src/widget/route.ts`: validate the exact snapshot-generated course
   link and return an open/resume/path/practice landing surface. Duplicate/unknown
   parameters, malformed UTF-8, missing IDs, fragments and foreign schemes fail.
   There is no session-store capability. The App must resolve the explicit course
   or show unavailable; it must never substitute its current course or auto-resume.
3. `SqliteWidgetSource.ts`: app-only read of actual account/day/course-selection/
   freeze columns. It takes explicit history and validated course/node/resume inputs
   from the current account, SqliteDayStore, SqliteAppState and SqliteSessionStore
   boundary. It does not infer history from empty counters or arbitrary saved rows.
4. `packages/core/src/widget/publication.ts` and `WidgetPublisher.ts`: await committed
   facts, obtain a fresh clock, atomically replace the shared snapshot and reserve
   reload budget, then call the platform. The app storage port serializes publishers
   across instances. A failed native request still spends budget; its pending state
   can retry after the interval. A success receipt records a completed API request,
   not evidence that the OS drew the widget.
5. Invariant tests and this native handoff. No package, schema, App entry-point,
   device-clock or speech-module changes belong to this leaf.

## Stable interfaces

`WidgetAccountRead` is a discriminated `known`/`unavailable` value. Known fields are
an actual source projection, never an optimistic transaction result. `readCommitted`
must run after the reward/rollover transaction commits and after the foreground
FSRS recompute; wire it to the existing awaited boot chain. The publisher waits for
that read before writing, and re-reads the clock afterward so a midnight crossing
becomes UNKNOWN instead of publishing yesterday as current. It also replaces the
snapshot with null if the authoritative read throws. A storage read/write failure
is reported and does not claim a successful refresh.

The app-only SQL reader takes `WidgetHistoryRead` with an explicit known-history
result, count and last completed civil day. Current schema has no complete generic
session-history header, so this authority is a required caller input. A validated
caller can compute it from complete permanent committed-session evidence; it must
return unavailable for legacy/missing facts. The reader requires DayEngine's exact
settled marker **yesterday**, not today: rollover decides all days strictly before
today. The passed history read is stamped for today. It verifies actual active
course equality, requires today's goal/streak row, and refuses unreliable clocks.

`freezes_owned` in this widget projection is the coverage-ready unused count:
`acquired_on_day < current local day`. A newly acquired freeze is retained in the
source inventory but cannot promise protection for that day. Full freeze inventory
and validated grant/consumption history remain in the account store. The existing
widget engine only needs this currently eligible count; a stale-stamped snapshot
is UNKNOWN under the later EC-WID-15 ruling. Previous recovered/unlived dispositions
carry no previous-day completed/frozen/missed widget cue and project null.

`WidgetPublicationStore` reads/writes one closed revision-1 publication record:

```text
{schemaVersion:1, snapshotJson:string|null, attemptsMs:number[],
 lastRenderedKey:string|null, pendingKey:string|null}
```

Only `snapshotJson` is exposed through `WidgetSnapshotReadPort.readSnapshot()` to a
target. It contains the existing closed WidgetSnapshot fields. Reload records are
app-private accounting, not displayed data. `write` must atomically replace the
whole record and resolve only after durable completion. `exclusive` must cover all
publishers for that storage. A provider must not implement these promises using two
uncoordinated writes. Corrupt persisted budget fails visibly instead of resetting
free requests. At most 40 attempts occur in any rolling 24-hour window and calls
are at least 15 minutes apart, including across midnight or zone/clock changes.
Timeline entries spend no reload requests. Remaining minutes and computation time
are excluded from the rendered-state key; copy/state/course/cosmetic changes remain.

`drawStoredWidget` is the executable TypeScript reference consumer. It accepts only
a tiny snapshot reader and a **fresh draw clock**; it has no SQLite, account or
session port. Swift/Glance targets cannot execute this TypeScript directly: their
native codec/state adapters must consume the same wire, use current device zone
at draw and pass cross-language fixtures before a rendering claim. Precomputed
`WidgetTimelineEntry.render` values must never be reused as current countdowns
after a throttled delay or zone change.

## Native integration still required

The P5 worktree has installed @bacons/apple-targets 5.0.0 and expo-file-system
57.0.7, but no widget target or App Group entitlement is declared in app.json.
No dependency or entitlement is added here. Root's deps/integration task must bind
an actual atomic App Group store on iOS and DataStore on Android, implement the
serialized app publisher and native reload adapters, and build the WidgetKit and
Glance targets. Widget target dependency graphs must contain no SQLite symbol;
only this app-side SQL projector can read the database.

INV-WID-07 remains a native layout gate: at maximum font scale the streak numeral
must retain layout priority and its declared font floor while words truncate first.
No screenshot or property about a TypeScript object proves that. Required remaining
evidence includes small/medium/accessory layouts, all states, live zone/DST changes,
sleep/Low Power throttling, restore-before-first-launch UNKNOWN, a real course-link
flow that leaves parked sessions untouched, and measured OS reload behavior.

## Verification scope

Repository tests cover INV-WID-01/02/03/04/05/06/08/09/10 and the publisher ordering
part of INV-SESS-27, with PROPERTY_RUNS unchanged. They use original synthetic
facts; they do not approve a production account or language pack. The separate
`/private/tmp/p5-widget-sql-real` harness imports the actual root v13 migration graph
and the real rollover engine, then tests original SQL fixtures against this reader.
It checks source joins, exact-day/previous-day freeze eligibility and no mutations.
The first private fixture used an incorrect today marker; the corrected actual
rollover witness first failed and is preserved as `marker-red.xml` before the fix.
