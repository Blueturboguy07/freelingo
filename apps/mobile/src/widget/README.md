# Snapshot-only widget boundary — S138–S140

2026-09-13 bounded P5 implementation. The existing core widget engine owns the
states, threshold ladder, draw-time civil-boundary calculation and timeline. This
leaf adds source, transport, routing and durable publication boundaries. The native
follow-up below has a built WidgetKit simulator extension and compiled Android
module. Device rendering, reload measurements and the P5 phase gate remain open.

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

## Native target integration

The follow-up native implementation uses installed @bacons/apple-targets 5.0.0.
Root's sole deps commit 79a0749 supplies Glance 1.2.0, DataStore preferences 1.1.7,
the Compose plugin matching Expo's root Kotlin version, and the iOS pod declaration.
The widget-only config plugin now declares `group.<app bundle id>.widget`, and the
source-managed `targets/widget` directory declares the WidgetKit extension. Expo
prebuild generates the app targets; generated `ios`/`android` files are never edited.
The Glance receiver lives in the local module source manifest. Both platform targets
consume only the snapshot wire. The app-only SQL projector remains outside them.

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

## Native publication and target follow-up

`modules/widget-publication` is a real local Expo module, loaded by
`nativeWidgetPorts`. `createNativeWidgetPorts` implements the existing publisher
ports with the native methods `acquire`, `read`, `write`, `reload`, and `release`.
Each operation after acquire carries its opaque lease. The lease encloses the
entire app source read, durable write, reload request and receipt write. It is
released in finally; callbacks used outside the lease fail. A malformed saved
record raises an error and cannot become a fresh empty reload budget.

On iOS, `AtomicWidgetPublication` holds an advisory file lock in the App Group,
validates the whole record, writes and fsyncs a temporary file, atomically renames
it, and fsyncs its directory. Process death releases the OS lock; module destruction
invalidates pending/active leases. The target reads the single published file
without taking an app writer lease. The containing directory is excluded from
backup. WidgetKit's synchronous `reloadTimelines` is a request acknowledgement,
not proof of a rendered frame.

Android uses a process-wide lease shared by all module instances and one DataStore
instance. One atomic DataStore edit replaces the whole publication JSON string;
there are no separate snapshot/budget writes. The store lives in `noBackupFilesDir`.
The Glance provider and Expo module run in the app process and use the same
DataStore singleton; the external launcher hosts the resulting widget view. No
extra `android:process` is declared. Glance `updateAll` is awaited after the durable
reservation. Module destruction releases the lease without changing saved budget.

Swift and Kotlin implement the same closed snapshot parser, complete state table,
course URI encoding and current-zone civil-day boundary calculation. Forty-two
original fixtures compare both real native model implementations with the core
contract, including DST, half-hour zones, stale snapshots, cold/satisfied days and
malformed fields. `nativeWidgetFixtures.test.ts` also catches later drift of the
frozen fixtures from the current core implementation.

The platform content evaluation reads current time and device zone. WidgetKit
receives threshold timeline entries carrying raw snapshots, never baked rendered
models. Because WidgetKit and Glance may cache an already evaluated view, the
native UI uses non-time practice copy for NUDGE/DANGER instead of presenting a
cached numeric countdown as live. This is the conservative non-time alternative
allowed by INV-WID-03; the native model retains the exact full state/time result.
OS throttling and changes while a view is cached still require real device QA.
Apple documents the host-driven rendering model in
[Displaying dynamic dates](https://developer.apple.com/documentation/widgetkit/displaying-dynamic-dates),
and Android documents Glance's cached remote views in
[Manage and update GlanceAppWidget](https://developer.android.com/develop/ui/compose/glance/glance-app-widget).

The authoritative account-read/boot-chain factory binding is still an integration
step: construct WidgetPublisher with the real committed source, nativeWidgetPorts
and current device clock. This implementation does not fabricate initialized
account history, a rendered state, a screenshots baseline, or a completed phase.
The current native layouts are initial target wiring; mascot/token pixel parity,
maximum-font numeral fit, native cold/restore/timezone flows, measured reloads and
real course-route handling remain device/visual gates.

## Recorded native verification

The unsigned `FreelingoWidget` target built through the Expo-generated Xcode
project for the iOS simulator. The actual product is
`/private/tmp/p5-widget-ios/products/FreelingoWidget.appex`; `build.exit` is 0.
`target-proof.json` records bundle `org.freelingo.app.widget`, App Group
`group.org.freelingo.app.widget`, version `0.1.0`, build `1`, and no SQLite linkage.
This is an extension build; the app's Swift Expo bridge still needs a whole-app
build with its generated Pods integration.

The Expo-generated Android project compiled the complete `:widget-publication`
module, including its Expo bridge, DataStore storage and Glance provider, against
the installed dependencies. `/private/tmp/p5-widget-android/compile2.exit` is 0.
The initial Android compile caught incorrect Glance alignment API names and the
initial standalone Swift type check caught an iOS availability boundary; those
failed logs are preserved alongside the corrected actual outputs.

Actual Swift and Kotlin snapshot harnesses each passed 42 shared conformance
fixtures. Native lease/storage controls also passed. Six isolated native guard
removals failed their assertions: lock serialization, duplicate reload on each
platform, stale current-zone boundary on each platform, and the Android budget
cap. `/private/tmp/p5-widget-native-mutations/results.json` preserves the initial
run; `p5-widget-native-mutations-retake/results.json` records the corrected
test-only waiter lifecycle and the final two Kotlin failures. The original final
Kotlin compile timed out during measured host pressure and was not treated as a
mutation verdict. No mutation was made in the active worktree source.
