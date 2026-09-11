# P0 — foundation: what is actually green

Repository: <https://github.com/Blueturboguy07/freelingo> (public, AGPL code / CC BY-NC-SA packs)

Written at the P0 founder checkpoint (plan §The build workflow, step 6). Every row below
says what was run, where the evidence is, and where it is missing. **A gate with no CI run
behind it is listed as not proven, not as done.**

## The P0 gate, row by row

The plan's P0 gate is three clauses: *"DAY-01/05 + CER-01 at 10k cases in four zones; DB-path
gate on sim + emu; coverage-map job exists."*

| Gate clause | Status | Evidence |
| --- | --- | --- |
| DAY-01/05 + CER-01 at 10,000 cases in four zones | **GREEN** | `ci.yml` — see the numRuns table below |
| DB-path gate (INV-PER-06) on **emulator** | **GREEN** | `native-e2e` Android job + local run; screenshot described below |
| DB-path gate (INV-PER-06) on **simulator** | **NOT PROVEN** | iOS cannot build: `expo-modules-jsi@57.1.0` — see *The iOS blocker* |
| coverage-map job exists | **GREEN** | `ci.yml` step *Coverage map — every owned invariant id has an owning test* |

### Invariant coverage

`pnpm test:coverage-map`: **424** ids in the registry, **6** owned at P0, **6** with an owning
test, 418 pending for later phases. Owned ids and their owning test counts:

| Invariant | Owning tests |
| --- | --- |
| INV-DAY-01 | 3 |
| INV-DAY-05 | 5 |
| INV-CER-01 | 7 |
| INV-PER-06 | 11 |
| INV-PLAT-01 | 3 |
| INV-PLAT-02 | 1 |

### numRuns per property (the "10,000 cases in four zones" clause)

The floor is `PROPERTY_RUNS = 10_000` in `packages/testkit/src/config.ts`. A zone-looped
property runs the full count **in each** zone, not a quarter in each.

| Invariant | Property | numRuns | Total cases |
| --- | --- | --- | --- |
| INV-DAY-01 | streak is a function of the SET: duplicates and order never change it | `PROPERTY_RUNS` | 10,000 |
| INV-DAY-01 | streak agrees with an independent reference, in every zone | `PROPERTY_RUNS_PER_ZONE` × 4 zones | 40,000 |
| INV-DAY-05 | civil arithmetic is exact and reversible for every generated instant and zone | `PROPERTY_RUNS` | 10,000 |
| INV-DAY-05 | local_day is monotonic in the instant, in every zone | `PROPERTY_RUNS_PER_ZONE` × 4 zones | 40,000 |
| INV-CER-01 | the decision is idempotent: replaying any planned commit yields null | 10,000 | 10,000 |
| INV-CER-01 | the plan never invents or drops value: it carries the outcome verbatim | 10,000 | 10,000 |
| INV-PER-06 | a copy name round-trips through the parser | 10,000 | 10,000 |
| INV-PER-06 | pruning is idempotent and leaves exactly min(n, keep) copies for any set | 10,000 | 10,000 |

**140,000 property cases.** Two meta-gates keep that honest, because a floor stated in a plan
is easy to undo quietly:

- `property-gates.test.ts` scans every test file in the tree and fails if any `numRuns` is
  below `PROPERTY_RUNS`; it also fails if the scan found nothing (a scan that finds nothing
  passes for free). It additionally holds the **per-project** vitest timeout — see *CI rounds*.
- `arbitraries.test.ts` holds the day-history generator's shape floors (anchored > 45 %, a run
  of 3+ in > 20 %, a run of 10+ in > 8 %), because the first version of that generator spent
  97 % of its budget asserting `0 === 0`.

## The other P0 deliverables

| Deliverable | Status | Evidence |
| --- | --- | --- |
| Monorepo + CI on the public repo | done | `ci.yml`, `pack-ci.yml`, `native-e2e.yml`, `mutation.yml`, `cla.yml` |
| Code/pack licence split | done | `LICENSE` (AGPL), `content/LICENSE` (CC BY-NC-SA), `packs/README.md` |
| CLA bot | done | `.github/workflows/cla.yml` + `CLA.md`; accepted by comment on a PR |
| Signing key custody | done | `packages/schema/keys/pack-signing.pub`; private half in the `PACK_SIGNING_KEY` Actions secret, `rm -P`'d, never printed. `packages/schema/src/signing.ts` is a hand-rolled ed25519-SPKI parser (the app has no `node:crypto`), held against `node:crypto` in `signing.test.ts` and shown to reject a P-256 key, prose, an empty block and a truncation. **It does not claim INV-PACK-18** — verify-before-install lands at P2 with the installer. |
| Expo skeleton, persistence layout | done | `apps/mobile/src/db/ExpoDb.ts` opens `freelingo-progress.db` in `Paths.document` with `PRAGMA journal_mode = WAL` set outside any transaction; migrations run against `PRAGMA user_version` inside one `withExclusiveTransactionAsync` |
| Backup-exclusion plugin | done on Android, unverified on iOS | local Expo module `apps/mobile/modules/backup-exclusion`; the config plugin writes `backup_rules.xml` and `data_extraction_rules.xml` (both excluding `domain="root" path="cache/packs"`). The iOS half (`URLResourceValues.isExcludedFromBackup`, read back off the filesystem) has never run on a device. |
| `testkit` | done | virtual clock, four-zone matrix, arbitraries, named config, repo helpers |
| PLAT-01 / PLAT-02 gates | **GREEN** | `ci.yml` frozen-lockfile install; `native-e2e` job *INV-PLAT-02 — native trees are generated and reproducible* |
| **Merge pass** (388 hunted cases, ~120–160 new invariants, 4 in-place corrections) | **NOT DONE** | The registry still carries 424 ids. See *Deferred*. |
| Disk: free ≥ 80 GB | **NOT DONE** | `df -h ~` below. See *Deferred*. |

### INV-PLAT-02 is not a byte comparison, on purpose

`expo prebuild` is **not** byte-reproducible: two consecutive `--clean --no-install` runs on
the same commit agree on 70 files and differ in exactly one thing — a 24-hex Xcode object id
that `expo-dev-client`'s config plugin mints afresh for its *Strip Local Network Keys* build
phase. A byte-for-byte gate would have been red on every run. The job compares trees **up to a
consistent renaming of Xcode object ids** (`scripts/canonicalise-pbxproj.py`, whose
`--self-test` proves a changed build setting and a reordered build phase are still drift), and
the tree hash covers the sorted entry list with types and symlink targets, so a rename, a
vanished symlink and a new empty directory count as drift too.

## Local device proof

The plan says only CI writes `e2e/artifacts/` and a screenshot without a CI URL is not
evidence. These local runs are therefore **corroboration, not the gate**; the gate is the CI
row above. `e2e/artifacts/` is git-ignored, so nothing below is committed.

### Android — passed

`npx expo run:android --no-bundler --variant release` on the already-booted
`Pixel_3a_API_34` (Android 14, `emulator-5554`), then the flow, run with the same command CI
runs. 1/1 passed in 16 s, 11 assertions.

Screenshot: `e2e/artifacts/local-ab0f323/android/screenshots/p0-db-path-p0-db-path.png`
(1080 × 2220 PNG). **Described honestly:** a light screen with a green **Diagnostics** heading
and eight label/value rows — `db-path` `file:///data/user/0/org.freelingo.app/files/freelingo-progress.db`,
`journal-mode` `wal`, `user-version` `1`, `packs-dir`
`file:///data/user/0/org.freelingo.app/cache/packs/`, `packs-excluded` `true`, `platform`
`android`, `db-path-persistent` `true`, `pre-migration-backup` `none` — and a green **CLOSE**
button. `pre-migration-backup none` is meaningful because the flow launches with
`clearState: true`: a copy there would mean the pre-migration path fired on a database that
never had a previous schema.

This was a **Release** build with `EXPO_PUBLIC_FREELINGO_E2E=1`, which is what proves the
diagnostics fix below: in Release `__DEV__` is false, so the screen is reachable only through
the flag.

### iOS — did not run

There is **no iOS screenshot**, and none is being passed off as one. The build fails; see
below. `e2e/artifacts/local-ab0f323/ios-BUILD-FAILED.log` holds the full local failure.

## The iOS blocker

`expo-modules-jsi@57.1.0` cannot build its `ExpoModulesJSI` xcframework at **either end** of
the Xcode range available to this project. The package declares `customBuild` in
`apple/spm.config.json` and its shipped xcframework slices are 20 KB stubs, so the framework is
compiled from source at pod-build time and there is no prebuilt fallback.

- **Xcode 26.2 (17C52, Apple Swift 6.2.3)** — fails loudly, 2 errors, `xcodebuild` exit 65:

  ```
  RuntimeScheduler.h:53:26: 'RuntimeScheduler' cannot be annotated with either
  SWIFT_RETURNS_RETAINED or SWIFT_RETURNS_UNRETAINED because it is not returning a
  SWIFT_SHARED_REFERENCE type
  ```

  and again at `:61`. Reproduced locally, and reduced to a 15-line standalone repro with no
  Expo and no React Native: a C++ class carrying a trailing `SWIFT_SHARED_REFERENCE(...)`
  whose constructor is annotated `SWIFT_RETURNS_RETAINED` fails with the byte-identical
  diagnostic under `xcrun swiftc -cxx-interoperability-mode=default`, and compiles the moment
  the annotation is removed. This is the only Xcode installed on the build Mac, which is why
  iOS cannot be proven locally at all.

- **Xcode 16.4 (Swift 6.1)** — fails quietly at the same phase. `[CP-User] Build
  ExpoModulesJSI xcframework` starts, the next log line is 16 s later, and the build reports
  `0 error(s), and 1 warning(s)` and exits 65. A script phase's stdout does not reach Expo's
  pretty printer, so a build that failed reports no errors.

The fix belongs upstream in `expo/expo`. **The dependency's header was not patched**: the task
forbids dependency changes, and a monkey-patched green gate is exactly the failure mode these
gates exist to prevent. `native-e2e.yml` now pins `XCODE_APP` explicitly and carries a
`Why the build failed` step that re-runs `xcodebuild` raw on failure, so the next attempt reads
an error instead of guessing.

**Specifically unverified on iOS:** that `Paths.document` resolves under `/Documents/`, and
that `BackupExclusionModule.swift`'s `URLResourceValues.isExcludedFromBackup` round-trip
returns `true`.

## CI rounds — what the first real run of these jobs found

`native-e2e`'s device jobs had **never executed** before this integration; the previously green
runs were of a placeholder that booted a simulator and took a screenshot. Four defects surfaced
on contact, none of them visible locally, each failing in a way that points somewhere else:

1. **The screenshot contract did not work.** Measured on Maestro 2.10.0: `takeScreenshot` is
   always resolved inside Maestro's *own* run directory, never relative to the working
   directory — so no flow can write into `e2e/artifacts/` however the path is spelled; and a
   flow-level `env:` default **wins over** `maestro test -e NAME=…`, so CI's `ARTIFACT_DIR` was
   discarded and every run on every sha wrote the same literal path. (Probed with
   `-e ARTIFACT_DIR=ZZZ_OVERRIDE_MARKER`: the marker never appeared.) The jobs only avoided
   going red because `--debug-output` happened to nest the run directory under `ARTIFACT_DIR`.
   Fixed: `--test-output-dir`, a bare screenshot name, and a collection step.
   **Never `--flatten-debug-output`** — on 2.10.0 it writes into `$HOME` and never creates the
   output directory at all.
2. **`Error: Test timed out in 5000ms`** on the two 40,000-case zone properties. Vitest's
   5,000 ms default is a default, not a decision about this suite; the case count is the gate.
   Now named at 60 s in `vitest.config.ts` — **per project**, because a top-level `testTimeout`
   is silently ignored by inline `projects` (probed with a 6-second test that still failed at
   5000 ms). A fix in the ignored place is indistinguishable from a fix; a test now holds it.
3. **`sh: 1: set: Illegal option -o pipefail`, exit 2.**
   `reactivecircus/android-emulator-runner` runs `script:` under `/usr/bin/sh` (dash), so the
   block died on its first line, before `adb`. The job then failed on a missing JUnit report,
   which reads as an emulator problem and is not one. `set -eu` there.
4. **The invariant coverage scan walked the generated native trees.** Its pattern matches any
   `.yaml` (Maestro flows are yaml and carry invariant ids) and `expo prebuild` fills
   `apps/mobile/ios` with vendored ones — a prebuilt checkout reported 27 test files instead of
   12, fifteen of them CocoaPods dSYM relocation maps. Nothing in a generated, gitignored tree
   may decide whether an invariant has an owning test. Skipped by **path**, not by the names
   `ios`/`android`, so a future `packages/core/src/platform/ios` test does not vanish silently.

A fifth, found before CI: **`DevDiagnostics` was gated on `__DEV__`**, and both device jobs
build Release (Release embeds the JS bundle, which is what makes `--no-bundler` honest), so the
one surface the INV-PER-06 gate reads was invisible to the job that gates it. It is now
`__DEV__ || EXPO_PUBLIC_FREELINGO_E2E === '1'`; Metro inlines `EXPO_PUBLIC_*` at bundle time,
so a store build that does not set it does not merely hide the screen — it does not contain the
branch that opens it.

Each of 1–4 and the fifth is held by a test that was shown to fail when the defect is
reintroduced (`packages/testkit/src/native-e2e-gates.test.ts`,
`packages/testkit/src/diagnostics-gate.test.ts`, `property-gates.test.ts`).

## Dependencies added

**None.** No package was added to any `package.json` and `pnpm-lock.yaml` is unchanged by this
integration.

## Deferred to P1, and why

| Deferred | Why |
| --- | --- |
| **The merge pass** — 388 hunted cases, ~120–160 new invariants, the four in-place corrections (DAY-03, MOD-01, SEC-01, GRD-16), and the founder checkpoint on the re-baselined count | It is a content change to `docs/invariants.md`, which is generated from the research corpus, and the plan reserves a single task per phase for `packages/schema` and the registry. It is P1's first task, and P1's gate cannot be stated until the count is re-baselined. |
| **The iOS DB-path gate** | Blocked upstream on `expo-modules-jsi@57.1.0`; see above. Not fakeable and not worth faking. |
| **iOS backup exclusion on device** (INV-PACK-11's iOS half) | Same blocker. The Android half is proven. |
| **INV-PACK-18** (verify a pack signature before install) | There is no installer and no pack yet. The key custody exists so P2 has one; the invariant lands with the thing it guards. |
| **Two INV-CER-01 properties draw ids from `fc.string()`** | The ledger-collision branch ("already committed, refuse") is therefore covered only by example tests, never by the property — the same failure mode already fixed in the streak generator. `packages/core/src/ceremony` was outside every P0 task's file lane. Fix at P1 by drawing ids from a small pool so collisions are common. |
| **An AVD cache for the Android job** | The AVD is created fresh every run. Worth doing once the job is reliably green, not while it is still being shaped. |
| **Disk: free ≥ 80 GB** | A deletion list the founder approves item by item (plan §Risks 1). Nothing was deleted without approval. |

## Disk

```
df -h ~
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   460Gi   379Gi    27Gi    94%    4.0M  288M    1%   /System/Volumes/Data
```

**27 GB free at 94 %, against a P0 target of ≥ 80 GB.** Below the plan's own threshold and
lower than when P0 started, because an Xcode build tree and two prebuilt native trees were
created and removed during this integration. The candidate list in plan §Risks 1 is still
waiting on founder approval; nothing was deleted.
