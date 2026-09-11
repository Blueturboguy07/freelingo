# CI

Four workflows. `ci.yml` is the fast one every change waits on; `native-e2e.yml` is the
slow one that proves the app exists on real devices; `mutation.yml` and `pack-ci.yml` are
nightly and content-only.

| Workflow         | Runner                 | What it proves                                                        |
| ---------------- | ---------------------- | --------------------------------------------------------------------- |
| `ci.yml`         | ubuntu-latest          | lint, typecheck, `pnpm test`, registry digest, coverage map, gitleaks |
| `native-e2e.yml` | ubuntu + macos-15      | flows exist, they pass on a simulator and an emulator, INV-PLAT-02    |
| `mutation.yml`   | ubuntu-latest, nightly | Stryker score against the threshold                                   |
| `pack-ci.yml`    | ubuntu-latest          | `coursekit validate` on content changes                               |

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

> **This job is red until `e2e/flows/p0-db-path.yaml` lands from the persistence branch.**
> Red means "there are no flows", which is true. Do not make it conditional.

**Both platforms build Release.** Release embeds the JS bundle in the binary, which is
what makes `--no-bundler` honest; a Debug build with no Metro launches to a red screen and
every flow then fails on the first assertion for the wrong reason. Expo's Android template
signs `release` with the debug keystore, so this needs no secret.

**Screenshots.** A flow writes them with

```yaml
- takeScreenshot: ${ARTIFACT_DIR}/<test-id>
```

`ARTIFACT_DIR` is passed in with `maestro test -e ARTIFACT_DIR=…` and is
`e2e/artifacts/<sha>/<platform>`, so no flow hard-codes a sha or a platform. `PLATFORM` is
passed alongside it for flows that need to branch. After the run, a step fails the job if
the JUnit report is missing or if not a single `.png` reached the directory.

**Artefacts** upload as `e2e-<sha>-ios` and `e2e-<sha>-android`. (`upload-artifact@v4`
refuses two uploads with the same name, so the platform suffix is not decoration.) Each
carries `report.xml`, the screenshots, Maestro's `--debug-output` and a `runner.txt`
naming the simulator or AVD that was actually used — runner images rotate, and a snapshot
diff caused by a different device must never read as a code change.

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
