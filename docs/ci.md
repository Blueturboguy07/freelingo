# CI

Four workflows provide build evidence; `cla.yml` runs the CLA bot on pull requests.

| Workflow         | Runner                 | What it proves                                                                                               |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ci.yml`         | ubuntu-latest          | lint, typecheck, property tests, registry digest, coverage map, gitleaks                                     |
| `native-e2e.yml` | ubuntu + macos-15      | the persistence flow runs on both platforms; native trees are generated reproducibly                         |
| `mutation.yml`   | ubuntu-latest, nightly | Stryker reporting only; no gating score yet                                                                  |
| `pack-ci.yml`    | ubuntu-latest          | pipeline tests, a real Spanish build, validators, current reviewer sample, trusted signature and pack loader |

## Spanish pack workflow

```
coursekit lint + tests
pipeline-ready -> build-es -> immutable candidate artifact -> validate-es
                                                            validate -> H1 review
                                                            -> repackage -> sign/verify
                                                            -> loader -> collect audio
                                                            -> loader -> final artifact
```

| Job              | Required result                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coursekit`      | Ruff and pytest pass, including the real Opus measurement test. `COURSEKIT_REQUIRE_OPUS_TOOLS=1` makes a missing executable fail.                                                                                                                                   |
| `pipeline-ready` | Every G0–G9 stage and all V1–V12/F1–F5 validators are registered. Missing registrations prevent pack jobs from running; the ordinary tests also assert registry completeness.                                                                                       |
| `build-es`       | G0–G9 complete against the real corpus, LanguageTool 6.6 and pinned Kokoro weights; the audio budget passes; a 300-item sample is drawn; the build tree is uploaded.                                                                                                |
| `validate-es`    | All validators run and pass, V1–V4 are 100%, the complete current sample passes H1, G9 republishes the fresh report and measured review, signing verifies against the committed public key, and the shipping loader opens both the pack and the collected artifact. |

The last measured gate before the round-5 repair was
[`65e1f81`, run 34724358433](https://github.com/Blueturboguy07/freelingo/actions/runs/34724358433).
G0–G9 completed, the G8 directory measured **6,998,636 bytes** against **120,000,000**,
and sample drawing succeeded. Signing then rejected the CI secret's PEM format. The
build upload and validator job did not run; no validator result or final pack artifact
exists for that run. These measurements do not assert that the repaired workflow has run.

### Candidate artifacts and reviewer input

`es-build-<sha>` contains the entire `build/es` tree, including G7 exercises, the
300-item sheet, its summary, G8 clips and bank, the candidate database/manifest and
runlog. It is uploaded before validation, H1 and signing, so a rejected review or a
signing failure leaves the exact candidate available. `ci-source.json` records the
source SHA, workflow run ID/attempt, sheet digest and selected stage measurements.
The artifact belongs to that run; its contents are immutable. Retention is seven days.

The sheet uses paths such as `g8/bank/<id>.opus`, relative to the downloaded language
build directory. Reviewers score those exact rows and clips. Current-population and
per-row content fingerprints prevent committed scores from silently applying to altered
exercises, source text or audio. The final H1 check calls `derive_review("es")` and
`gate_passed`: the complete 300-item sample must join to its scores with a measured
wrong-item rate of at most 2%. Agent review remains labelled
`PROVISIONAL (unreviewed by a paid native speaker)`; paid native review is still a
release prerequisite in `docs/RELEASE.md`.

`es-gap-brief-<sha>` is diagnostic and may be incomplete when an early build stage
fails. G0 reads a live Tatoeba export, so the committed gap brief is not asserted equal
to each new run's brief. `es-validation-<sha>` preserves the report and runlog after a
validation, H1 or signing failure. Neither diagnostic artifact is a final pack.

### Validation, signing and publication order

Validation precedes the final `coursekit pack es`. That second G9 invocation embeds the
fresh full validator report and measured review, then recomputes the database digest.
Only then does `coursekit sign es` sign the manifest and verify against
`packages/schema/keys/pack-signing.pub`. No command after signing edits the manifest.

The CI secret accepts the standard unencrypted, version-zero Ed25519 PKCS8 PEM encoding
specified in [RFC 8410](https://www.rfc-editor.org/rfc/rfc8410.html#section-10.3), as well as
the existing base64 32-byte seed or 64-byte seed-plus-public-key encoding. The PEM importer
requires the exact DER lengths, Ed25519 OID and nested seed envelope; optional attributes,
version-one extensions, encrypted keys and other algorithms are refused. A 64-byte raw
key must contain the matching public half. Private material is read only from the CI
environment. Tests generate ephemeral keys in memory and never use the release secret.

`packages/core/src/packs/real-pack.test.ts` opens the actual SQLite file named by
`FREELINGO_REAL_PACK`. A missing named file fails; with no variable, ordinary developer
runs skip this expensive-build test. The checks cover first-lesson content, resolvable
item IDs, credits, the full hard-gate report, a real V8 engine, payload digest, trusted
signature, and every declared audio file's measured size. The test runs again after
collection against `es-pack/pack.sqlite`, proving that copying preserved a usable pack.

`es-pack-<sha>` contains the signed manifest, database, complete `audio/` directory,
validator report, reviewer sheet/summary/scores, runlog and CI source record. An empty or
missing bank fails collection. Final upload requires successful gates and an available
signing secret. Fork pull requests without that secret can retain an unsigned candidate
marked `unverified`; they publish no final `es-pack` artifact.

The separate bake-only workflow was removed because a fresh checkout has no G7 input.
G8 runs inside `build-es`, where its upstream exercises exist. That job installs all four
optional groups (`nlp`, `lm`, `align`, `tts`); the lighter test job keeps the default
groups. LanguageTool is supplied as a server base URL and probed for Spanish spelling
rules. KenLM remains unavailable without a trained model, so G6 records `grammar_only`
when appropriate; it never claims an engine ran when none did.

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

### The CI reporter path

`ci.yml` runs the suite with Vitest's `dot` reporter, disables file parallelism, and wraps
the command in Bash `time`. This keeps the final test counts, failures and Vitest
test-time while avoiding the default reporter's per-task terminal rendering and the
concurrent worker-update queue that produced B20's `Timeout calling "onTaskUpdate"` on
the slowest hosted runners. The shell timing prints wall/user/sys time on every attempt,
so the deliberately slower serial run proves the slow-run path instead of mistaking a
green fast run for evidence. `PROPERTY_RUNS` remains 10,000; scheduling and reporter
overhead are the levers, not invariant coverage.

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
