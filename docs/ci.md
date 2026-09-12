# CI

Four workflows. `ci.yml` is the fast one every change waits on; `native-e2e.yml` is the
slow one that proves the app exists on real devices; `mutation.yml` is nightly and
`pack-ci.yml` is content-only.

| Workflow         | Runner                 | What it proves                                                                |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `ci.yml`         | ubuntu-latest          | lint, typecheck, `pnpm test`, registry digest, coverage map, gitleaks         |
| `native-e2e.yml` | ubuntu + macos-15      | flows exist, they pass on a simulator and an emulator, INV-PLAT-02            |
| `mutation.yml`   | ubuntu-latest, nightly | Stryker, reporting only — no score has ever printed; see below                |
| `pack-ci.yml`    | ubuntu-latest          | coursekit lint+tests; the whole es pack is built, baked, validated and signed |

(`cla.yml` is the CLA bot on pull requests and proves nothing about the code.)

## `pack-bake.yml` was deleted, and why that is the honest option

**Decision, 2026-09-12: `pack-bake.yml` is deleted.** The brief offered two ways out —
give it an upstream download of `build-es`'s `es-build-<sha>` artefact, or delete it —
and deletion is the one that leaves nothing that can lie.

What it was: `workflow_dispatch` on a fresh checkout, running `coursekit bake es`. G8
reads **G7's exercises**, a fresh checkout has no `build/` tree, so every possible
dispatch exits 3/4 naming the missing upstream stage. It was never dispatched and **no
`es-audio-<sha>` artefact has ever existed**. A workflow that cannot succeed is worse
than no workflow: the row above used to read "rebuilds one language's audio bank and
hands back the artefact", which is bake coverage nobody had.

Why not the artefact download:

- `es-build-<sha>` is uploaded by `build-es` with **`retention-days: 1`**. A dispatch
  more than a day after the matching `pack-ci` run finds nothing, so the workflow's
  success would depend on a 24-hour window.
- Downloading an artefact produced by a **different workflow run** needs
  `actions/download-artifact@v4` with `run-id:` plus a `github-token:`, and the run id
  would have to be a dispatch input the operator looks up by hand. That is not "rebuild
  the bank", it is "rebuild the bank if you can find yesterday's run".
- The bake already happens where it has its inputs. `build-es` syncs the `tts` group,
  caches the same pinned Kokoro weights at the same `COURSEKIT_KOKORO_WEIGHTS` path, and
  runs G8 as part of `coursekit build es`, on every push to `main` that touches
  `tools/coursekit/**` or `content/**`. `es-build-<sha>` (`path: build/es`) already
  carries `g8/bank/`, `g8/clips.jsonl` and the run's `runlog.jsonl` — everything
  `es-audio-<sha>` promised, produced by a job that has G7's output.

So the bank travels in `es-build-<sha>`, and the manifest F2 validates travels in
`es-pack-<sha>`. If a language ever needs a bake without a build, the workflow to write
then is one that runs the upstream stages itself, not one that hopes an artefact is still
around.

One thing this deletion does **not** fix, said plainly: `es-build-<sha>` keeps
`retention-days: 1`, so a bank is downloadable for a day after the run that made it and
then only re-derivable by re-running `build-es`. That is a real limit and it is the same
limit as before — a workflow that never produced a bank did not give anyone a longer
window. Raise the retention, or add a bank to `es-pack-<sha>`, if a bank ever needs to
outlive its run.

## `pack-ci.yml` and the job that was green because it never ran

```
coursekit lint + tests
pipeline-ready ──> build-es (G0-G9) ──> validate-es (V1-V12 + F1-F5)
```

**`pipeline-ready` decides whether the two pack jobs run at all**, by asking whether every
id in `config.VALIDATOR_IDS` and `config.BUILD_STAGE_IDS` is registered. That gate is right
— a pack built over an empty registry is not a pack — and it has the failure mode every
conditional job has: while `ready=false`, `build-es` and `validate-es` **skip**, and a
skipped job is green.

Measured at P2 integration: F1, F3, F4 and F5 were declared in the ledger and registered
nowhere, so for the whole phase both jobs skipped, the run was green, and the pack the
phase exists to produce had never been built. The lesson is the same one `flows-present`
teaches one workflow over: when a job can be skipped, something must fail if it is skipped
for the wrong reason. Here that something is `pnpm test` — `test_validators_freelingo.py`
asserts `VALIDATORS.missing(VALIDATOR_IDS) == ()`, on every push, with no conditional in
front of it.

`build-es` carries the `tts` dependency group and the cached Kokoro weights, unlike the
`coursekit` job. A stage whose group is absent exits 3 rather than degrading, G8 needs
`tts`, and G9 needs G8 — so without it the build stops before the pack exists. The
`coursekit` job keeps the light default groups and its 20-minute budget; `build-es` has 60
minutes and its product is a pack.

## The property floor

`pnpm test` is Vitest + fast-check. Plan §Verification: **≥ 10,000 cases per property**,
and the P0 gate is "DAY-01/05 + CER-01 at 10,000 cases in four zones" — meaning 10,000 in
_each_ zone, not 2,500 in each.

Two things hold that floor, because both of its failure modes are invisible in a green
suite:

- `packages/testkit/src/property-gates.test.ts` fails if any `numRuns` anywhere in the
  tree is below `PROPERTY_RUNS`. Runs are never lowered to buy wall-clock; a property
  that is too slow has a loose generator.
- `packages/testkit/src/arbitraries.test.ts` fails if the day-history generator stops
  producing the shape the invariant is about. The first four-zone streak property drew 40
  dates from a four-year span and produced a streak anchored at today-or-yesterday in 2.8%
  of cases: 10,000 cases of a generator that cannot reach the interesting shape is 10,000
  cases of nothing.

Whole suite: **7.6 s** at 10,000 runs per property per zone (2026-09-11), against a
~3-minute budget.

## `native-e2e.yml`

```
flows-present ──┬─> ios-simulator      (macos-15, Maestro on a booted simulator)
                └─> android-emulator   (ubuntu-latest, Maestro on an API 34 x86_64 AVD)
prebuild-determinism                   (ubuntu-latest, INV-PLAT-02)
```

**`flows-present` exists because `maestro test` over an empty directory exits 0.** That is
the most expensive way this workflow could lie: two device jobs, twenty minutes of build
each, a green tick, nothing tested. So the flows are counted first on a ten-second Linux
runner — a flow is a `.yaml`/`.yml` file with an `appId:` header, so `README.md` is not
miscounted as one — and both device jobs `needs:` it.

**Both platforms build Release.** Release embeds the JS bundle in the binary, which is
what makes `--no-bundler` honest; a Debug build with no Metro launches to a red screen and
every flow then fails on the first assertion for the wrong reason. Expo's Android template
signs `release` with the debug keystore, so this needs no secret.

**The iOS toolchain is pinned, deliberately low.** `XCODE_APP` selects Xcode 16.4, the
macos-15 image default, and the job fails loudly if it is missing rather than drifting onto
whatever is newest. Measured 2026-09-11: under Xcode 26.2 (17C52, Apple Swift 6.2.3) the
build dies at the ExpoModulesJSI xcframework phase with

```
RuntimeScheduler.h:53:26: 'RuntimeScheduler' cannot be annotated with either
SWIFT_RETURNS_RETAINED or SWIFT_RETURNS_UNRETAINED because it is not returning a
SWIFT_SHARED_REFERENCE type
```

and again at `:61` — two errors, `xcodebuild` exit 65. That is expo-modules-jsi@57.1.0's
own header meeting a tightened C++ interop check in Swift 6.2, and the package compiles
that framework from source at pod time, so there is no prebuilt slice to fall back to. The
fix belongs upstream in expo/expo; raise the pin when it lands, not before. Xcode 16.4
carries no iOS 26 runtime, so `SIMULATOR_OS` names an 18.x one.

**Screenshots.** A flow names its frame and nothing else:

```yaml
- takeScreenshot: <test-id>
```

This is not the obvious contract, and the obvious one does not work. Two things measured on
Maestro 2.10.0, 2026-09-11:

- `takeScreenshot` is always resolved **inside Maestro's own run directory**, as
  `<run-dir>/<flow>/takeScreenshot/<the given path>.png`. It is never relative to the
  working directory, so no spelling of the path lets a flow write into `e2e/artifacts/`.
- a flow-level `env:` default **wins over** `maestro test -e NAME=…`. A flow that defaults
  `ARTIFACT_DIR` therefore ignores whatever CI passes and every run on every sha writes the
  same literal path. (`-e` does apply to a name the flow does not default — `PLATFORM` is
  passed that way for flows that need to branch.)

So the jobs point the run directory at the artefact directory with
`--test-output-dir "$ARTIFACT_DIR/maestro"`, and a following step copies every `.png` up
into `$ARTIFACT_DIR/screenshots/<flow>-<name>.png` — flat, no timestamp — and fails the job
if it collected none. **Never add `--flatten-debug-output`**: on 2.10.0 it makes the run
write into `$HOME` and never creates `--test-output-dir` at all.

**Artefacts** upload as `e2e-<sha>-ios` and `e2e-<sha>-android`. (`upload-artifact@v4`
refuses two uploads with the same name, so the platform suffix is not decoration.) Each
carries `report.xml`, `screenshots/`, Maestro's full run directory under `maestro/`, and a
`runner.txt` naming the Xcode and the simulator or AVD that was actually used — runner
images rotate, and a snapshot diff caused by a different device or toolchain must never
read as a code change.

**Only CI writes `e2e/artifacts/`.** A screenshot without a CI URL is not evidence.

## `prebuild-determinism` (INV-PLAT-02)

Two halves:

1. **Nothing under `apps/mobile/ios` or `apps/mobile/android` is tracked.** The moment one
   file is, somebody edits it by hand and the next `prebuild` deletes their work without
   saying so.
2. **`expo prebuild` run twice on the same commit produces the same tree.** Otherwise
   "generated" is not a property anyone can rely on, and a config-plugin change cannot be
   told apart from drift.

"The same tree" is **not** byte-for-byte, and claiming it would have made this job red on
every single run. Measured 2026-09-11 on this commit: two consecutive
`expo prebuild --clean --no-install` runs agree on 70 files and disagree on exactly one
thing — a 24-hex Xcode object id that expo-dev-client's config plugin mints afresh for its
`[Expo Dev Launcher] Strip Local Network Keys for Release` build phase every time.

An Xcode object id is an arbitrary internal name, so the trees are compared _up to a
consistent renaming of ids_: `scripts/canonicalise-pbxproj.py` rewrites each distinct id to
`OBJ000000`, `OBJ000001`, … in order of first appearance. A build phase that moved,
changed, appeared or vanished still changes the canonical form. Its `--self-test` asserts
exactly that and runs in the job before any hash is trusted.

The tree hash covers file contents **and** the sorted list of entries with their types and
symlink targets, so a rename, a vanished symlink and a new empty directory are drift too —
none of which changes any file's bytes.

The job runs on Linux: prebuild needs no Xcode, and skipping CocoaPods is what makes the
iOS half comparable at all, since `Podfile.lock` resolution is not hermetic.

## `mutation.yml`, and the score it has never produced

The nightly is `continue-on-error: true` and it is green every night. **No mutation score
exists for any sha in this repository**, and the job says so rather than implying one: the
"Record the score" step finds no `reports/mutation/mutation.json` and writes "Stryker did
not get far enough to score" into the run summary.

What happens is always the same. Stryker instruments 118 of 844 files with 10,765 mutants,
starts the initial run with `perTest` coverage analysis, and one fast-check property in
`packages/core/src/data/import.test.ts` hits `Test timed out in 300000ms`. Stryker refuses
to score a tree whose initial run is red, so there is nothing to record. Reproduced
locally 2026-09-12 with `stryker run stryker.config.json --dryRunOnly`: 13 m 29 s of dry
run, then the timeout.

Three facts that rule out the obvious fixes, so nobody spends a night on one:

- **300,000 ms is Vitest's clock, not Stryker's.** `vitest.config.ts` multiplies
  `TEST_TIMEOUT_MS` (60,000) by `STRYKER_TIMEOUT_FACTOR` (5) when `STRYKER_MUTATOR_WORKER`
  is set. `stryker.config.json`'s `dryRunTimeoutMinutes: 30` is a different clock and did
  not fire — 13 m 29 s is well inside it — so **raising it changes nothing**.
- **It is not a property that got slower.** The same test is 4,350 ms un-instrumented and
  over 300 s under `perTest`: a >69× execution-mode cost.
- **`PROPERTY_RUNS` is not the lever.** The floor above is a gate on purpose; buying a
  mutation score by weakening every property buys the wrong number.

The fix is a cheaper generator for that one property. Until a score prints, no report
quotes one — `docs/P2-BLOCKERS.md` B7 carries the measurement.

## Editing a workflow

Lint locally before pushing — there is no way to validate a workflow from a branch that has
not been pushed:

```sh
brew install actionlint     # bundles shellcheck for the `run:` blocks
actionlint .github/workflows/*.yml
```
