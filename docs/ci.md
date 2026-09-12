# CI

Five workflows. `ci.yml` is the fast one every change waits on; `native-e2e.yml` is the
slow one that proves the app exists on real devices; `mutation.yml` is nightly and
`pack-ci.yml` / `pack-bake.yml` are content-only.

| Workflow         | Runner                 | What it proves                                                        |
| ---------------- | ---------------------- | --------------------------------------------------------------------- |
| `ci.yml`         | ubuntu-latest          | lint, typecheck, `pnpm test`, registry digest, coverage map, gitleaks |
| `native-e2e.yml` | ubuntu + macos-15      | flows exist, they pass on a simulator and an emulator, INV-PLAT-02    |
| `mutation.yml`   | ubuntu-latest, nightly | Stryker score against the threshold                                   |
| `pack-ci.yml`    | ubuntu-latest          | coursekit lint+tests; the whole es pack is built and validated        |
| `pack-bake.yml`  | ubuntu-latest, manual  | rebuilds one language's audio bank and hands back the artefact        |

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

## Editing a workflow

Lint locally before pushing — there is no way to validate a workflow from a branch that has
not been pushed:

```sh
brew install actionlint     # bundles shellcheck for the `run:` blocks
actionlint .github/workflows/*.yml
```
