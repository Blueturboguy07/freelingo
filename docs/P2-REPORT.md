GATE: RED

# P2 — Spanish pack v0: the integration report

Repository: <https://github.com/Blueturboguy07/freelingo> (public, AGPL code / CC BY-NC-SA packs)
Integrated at **`281b623`** on `main`. Written at the P2 founder checkpoint (plan §The
build workflow, step 5 → 6).

Every CI figure below names a run URL. Where something is not proven, the row says NOT
PROVEN and does not round up. A locally produced artefact is labelled as corroboration and
never as evidence (plan §Verification, EVIDENCE RULE).

**The gate is RED for one reason, and it is not a bug.** Eight branches merged, twelve
cross-lane defects were found and fixed, `ci.yml` and `native-e2e.yml` are green, and
`coursekit build es` runs for the first time — G0 through G4 on the real corpus. It stops
at **G5**, the only authoring stage, because G4 emits **918 gap slots** and
`content/es/candidates.jsonl` covers **8** of them. The phase needs 18,360 authored
candidates and has 160. Everything else in the gate is behind that one file.

The honest summary is: **the pipeline is built and the content is not written.**

## What was merged

Eight branches, into `/Users/mannbellani/freelingo` on `main`, one at a time with
`git merge --no-ff`, in G-stage order.

| #   | Branch                      | Tip merged | Merge commit | Conflicts                 |
| --- | --------------------------- | ---------- | ------------ | ------------------------- |
| 1   | `p2/g0-ingest`              | `c7a6c2c`  | `e2ed920`    | none                      |
| 2   | `p2/g1-g2-analyze-band`     | `11f9210`  | `3e9dd47`    | none                      |
| 3   | `p2/g3-g4-curriculum`       | `c9f993c`  | `80df077`    | none                      |
| 4   | `p2/g5-g6-gapfill-language` | `929585e`  | `cdac1f3`    | none                      |
| 5   | `p2/g7-expand`              | `b3efb21`  | `4434529`    | none                      |
| 6   | `p2/g8-bake`                | `f892e3b`  | `0a2fdfb`    | `scripts/coverage-map.ts` |
| 7   | `p2/g9-package-loader`      | `19fd1a2`  | `cf01ce4`    | none                      |
| 8   | `p2/validate-sample-ci`     | `94f7034`  | `6578df9`    | none                      |

`p2/deps-scaffold` was already on `origin/main` as `e9da02e` (merge `7e90cbd`) before this
task started; it is the phase's only dependency change.

Two integration commits follow the eight merges: `558029c` (the defects the merged tree
exposed) and `281b623` (what the first real `coursekit build es` found).

## The defects, and none of them existed on a branch

Every branch was green on its own. All eleven below appeared only when the eight met, or
only when the pipeline was actually run — which is the entire content of the plan's
§Safeguards line, _"PRs that break main merge cleanly"_.

### 1. Six lanes each brought their own tokeniser (INV-PACK-40)

`coursekit.ledger` is the single definition of "what a token is". The merged tree had
seven more: `config/g0.py`'s word-class regex, G0's `.split()`, G4's candidate length
filter, G7's word-bank and gapped-body splitting, the distractor builder, the mock
LanguageTool engine, and V1/V2's difficulty proxy — the last of which carried a comment
saying it was "restated rather than imported so a change on one side shows up as a
disagreement". Every one of them agrees with the ledger on Spanish function words and
disagrees on every clitic, which is the failure mode the invariant text describes.

`tests/test_ledger_unit.py`'s grep gate caught all of them at once, and the fix is not to
widen the gate. The ledger now names the two notions that are **not** the ledger unit and
are still "a token":

| Function                             | What it is                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `units()` / `count_units()`          | the ledger unit. Needs an `analysed_sentence`; V1/V2, the budget and the window use it |
| `surface_tokens()`                   | the words of a RENDERED string. A word-bank tile is a display token, never a lemma     |
| `letter_runs()` / `pre_analysis_*()` | G0's filter, which runs before a morphology model exists                               |

`TOKEN_PATTERN` left `config/g0.py` as part of this: a word-class regex in a config file
is the same second definition wherever it is written. The six **test** files that re-derive
a fixture in plain Python are on the gate's exception list with a per-file reason, which is
what that list is for — and `test_the_exception_list_cannot_grow_into_src` still forbids
adding a `src/` entry.

### 2. The ledger unit was declared twice, and the two already disagreed

`config/g9.py` carried its own `LEDGER_UNIT_BY_LANGUAGE` saying Japanese counts a
`morpheme`. `config/g1.py` says `morpheme_mode_a`, and `LEDGER_UNITS` does not carry the
first — so a `ja` pack built through G9 would have shipped a manifest naming a unit the
ledger refuses. That is INV-PACK-40's falsifier case 2 ("two declarations is worse than
none") happening for real, and it is why the gate greps for the NAME rather than comparing
values. Deleted; `packbuild/sqlite.py` reads the ledger.

### 3. Two Python claim conventions, one reader each

`p2/g1-g2` made a pytest test claim an invariant in the bracketed ids **leading its
docstring**; `p2/g8` made it claim in the **`def test_inv_aud_08_…` name**. Both are in the
tree — `test_cast.py` uses only the name form, `test_licences.py` only the docstring,
`test_ledger_unit.py` both on the same test — and each lane's scanner could see only its
own convention. `scripts/coverage-map.ts` and `packages/core/src/journey/ownership.ts` now
read both, case-insensitively (the tree carries `test_inv_aud_08_…` and
`test_INV_PACK_40_…`). Neither reader can turn prose into coverage: the name reader never
looks at a docstring, the docstring reader reads only the leading brackets of a test's own
docstring, and both `--self-test`s pin it.

### 4. Seven owned ids nobody claimed

INV-PACK-07, -08, -12, -13, -40, -50 and -51 all had real owning tests and sat in no
ownership file, because on a branch the coverage map could not see a pytest claim at all.
Claimed now, each in the lane that wrote the tests.

### 5. Eight falsifier corpora rejected over a key name

The coursekit lanes spelled "what this input falsifies" as `$comment`, `statement` and
`why_this_corpus_exists`; the gate knew five other spellings and reported all eight files
as reasonless, which then reported INV-PACK-06 as having no committed falsifier. Widened,
in the order that lets a file whose `falsifier` is an object of cases fall through to its
prose key.

### 6. A monkeypatch that patched a module nobody calls

`tests/test_g2_band.py` patched `coursekit.stages.g2_band.ELELEX_POS_MUST_MATCH` by dotted
path. `Registry.restore_for_tests()` restores registration by **evicting** its modules from
`sys.modules`, so after `tests/test_cli.py` had run, that path resolved to a freshly
imported module while the test's own `build_rows` still read the old one's globals. The
relaxed-POS branch never ran and the failure read as a banding bug. It passed when the file
ran alone. Patched on the function's own `__globals__`, with the trap written into
`Registry.restore_for_tests`'s docstring and pinned by
`test_a_restore_replaces_the_module_object_a_test_already_imported`.

The same trap then caught the new F4 test, which is the best evidence that writing it down
was worth doing.

### 7. A config-module list that went stale silently

`test_g5_gapfill.py`'s A1-window drift scan named `coursekit.config.analyze` and `.band`,
which `p2/g1-g2` renamed to `g1`/`g2`. The loud half was a `ModuleNotFoundError`; the quiet
half is that a renamed module simply stops being scanned and the drift this gate exists to
catch walks through. Enumerated from the package now.

### 8. Four validators nobody owned, and the two jobs that skipped because of them

`config.VALIDATOR_IDS` declares V1–V12 **and F1–F5**. F2 was registered; F1, F3, F4 and F5
were registered nowhere, so `pack-ci.yml`'s `pipeline-ready` job reported `ready=false` and
`build-es` and `validate-es` were **skipped** — and a skipped job is green. The phase's
central artefact had never been built and both jobs reported success.

Written in `tools/coursekit/src/coursekit/validators/freelingo.py`:

| Id  | Subject                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------- |
| F1  | INV-PACK-13, read from the **runlog** — the only record of what G0 did before it opened a socket           |
| F3  | INV-PACK-17, re-asked of the **artefact** rather than of the stage that wrote it                           |
| F4  | INV-PACK-18, verified against the **committed** key; unsigned is `unverified`, never `corrupt`             |
| F5  | INV-PACK-16: `info` + the reason for a language with no character syllabus, **blocking** for `ja` until P7 |

The temptation this creates is worth naming: four functions returning `[]` would have turned
`pipeline-ready` green in ten minutes and made `scope2/00` §2.4's "hard CI gate" a list of
function names. `tests/test_validators_freelingo.py` plants a specific defect for each — a
corpus read under a `forbidden` verdict, a source that shipped rows with no recorded permit,
oracle-only text in the selected set, a voice bank nothing credits, a manifest signed by a
key that is not the shipped one, a manifest edited after it was signed — and pairs each with
a clean case, because a gate that fails on everything is as useless as one that fails on
nothing.

### 9. `es.pack` was a filename somebody wrote down

`pack-ci.yml`'s collect step named `build/es/g9/es.pack`, recorded in
`docs/owned/p2-validate-ci.json` as a cross-lane contract because `config/package.py` was
empty when the validate lane was written. G9 calls it `pack.sqlite`. The guess was wrong,
which is what writing it down was for; the failure would have read as a build that produced
nothing.

### 10. G1 died on a 0.53% tail, and it was right to notice and wrong to die

The first real `coursekit build es` on this Mac reached G1 and failed:

```
g1 failed: 15 of 2823 sentence(s) fall outside the pack's length window 3-12 lemma(s)
 — shortest 3, longest 15.
```

G0's filter counts letter runs, because it runs before any morphology model exists; G1
counts lemmas. The two disagree at the margins **by construction** — spaCy splits `del`
into `de` + `el` and `dámelo` into `dar` + `me` + `lo`, and it drops punctuation G0 never
counted — so a corpus filtered to 3–12 letter runs always has a small tail outside 3–12
lemmas.

The window is now **applied** at G1, where real tokenisation exists; the drop is counted
in the runlog; and `LENGTH_DRIFT_MAX_RATE = 0.05` is what fails the stage. What INV-PACK-40
is about is a G0 that measured with a _materially_ different notion of a token. A stage
that died on the first straggler made the ledger's own window unusable on real data, and
one that dropped silently is how a corpus loses a percent of itself between two stages and
nobody can say which one.

### 11. F1 fired on the designed path

The first version of F1 read `ingested_sentence` and reported **1,000 NLLB rows** as
oracle-only text in the ledger. Every one was legitimate: `sources/licences.py` is explicit
that `oracle_only` is not refused at ingest — the plan ingests NLLB, capped, to inform
frequency, KenLM and the alignment priors — and `inputs.forbid_unshippable` stops it at G4.
The check now asks the question of what G4 **selected**, and warns (neither passes nor
fails) when there is no selection to check. A gate that cries wolf on the designed path
gets muted, which is worse than one that never ran.

### 12. `build-es` could not have produced a pack

Turning `pipeline-ready` green turned the job on, and the job walked into two walls that
had been invisible while it was skipped:

- G2 wants hermitdave's `es_50k.txt` and nothing fetched it.
- G8 wants the `tts` dependency group, which the job did not sync, so `build es` exits 3
  before G9 and the uploaded "pack" is not one.

Both fixed in `pack-ci.yml`. The frequency list is curled from the allow-listed source
(CC BY-SA-4.0, `shippable`, attribution required — `resolve()` refuses it if it ever leaves
the allow-list, so fetching it cannot smuggle anything past INV-PACK-13); verified locally
at 50,000 lines / 658,626 bytes, the size `config/g2.py` pins. `tts` plus the cached Kokoro
weights are set up exactly as `pack-bake.yml` does: the deps lane kept `tts` out of the
default groups so the 20-minute `coursekit` job stays 20 minutes, and `build-es` has 60
minutes and its product is a pack.

## The gate is RED, and here is the one thing that is missing

**`coursekit build es` now runs, and it stops at G5.** That is the phase's headline, and
it is not a bug in anything the eight lanes wrote.

Measured on `281b623`, `build-es`
([run](https://github.com/Blueturboguy07/freelingo/actions/runs/34684986287)), step
_Build es (G0-G9)_:

```
g0  Ingest — corpus fetch, dedup, length and register filter, licence row      09:07:28  ok
g1  Analyze — segment, lemmatise, morph features (Mode A for ja)               09:08:38  ok
g2  Band — frequency rank and CEFR/decile band per lemma                       09:17:14  ok
g3  Solve curriculum — assign lemmas and grammar concepts to units             09:18:47  ok
g4  Select — pick corpus sentences inside the ledger; emit the gap list        09:18:48  ok
g5  Gap-fill — the only authoring stage; candidates re-enter at G6             09:20:35  FAILED

g5 failed: 918 slot(s) authored below the over-generation floor of 20:
  u1/l1/s1 (0), u1/l1/s2 (0), … u30/l176/s8 (0).
  Generate-and-reject has nothing to resample from, and the alternative is patching.
exit code 4
```

**Five stages of the pipeline ran on the real corpus and produced real artefacts for the
first time.** G0 ingested under the licence gate, G1 lemmatised through the pinned
`es_core_news_md`, G2 ranked 50,000 hermitdave surface forms and banded them, G3 solved
the curriculum into 176 lessons, and G4 selected every corpus sentence it could place.
What G4 then emitted is a gap list of **918 slots**, and G5 — _the only authoring stage_ —
has candidates for **8** of them.

`content/es/candidates.jsonl` holds **160 rows: 8 slots × exactly 20 candidates**, which
is the over-generation floor met perfectly for eight slots and not attempted for the other 910. The whole course needs **918 × 20 = 18,360** authored candidates; the lane shipped
0.9% of them.

That is not a defect to fix in an integration round. There is no hosted model in this
environment — the brief's ruling is that the Opus agent building the lane is the author —
so those 18,200 missing sentences are 18,200 sentences an agent has to write, with their
English, their allowed-lemma list and their rubric score. It is days of authoring, and it
is the largest single piece of P2's ≈700–900 hour estimate.

`MIN_CANDIDATES_PER_SLOT = 20` is deliberately a constant and not a flag
(`config/g5.py` §"Why over-generation is a constant and not a flag"), and lowering it to
make CI green would be the exact move that file exists to prevent: a slot with three
candidates cannot survive five filter axes, and the stage would then be choosing between
shipping the least bad sentence and failing. **This report does not lower it.**

## The phase gate, item by item

| Gate item                                                        | Status                                                   | Evidence                                                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                 | GREEN                                                    | `ci.yml` [34684986281](https://github.com/Blueturboguy07/freelingo/actions/runs/34684986281)                                       |
| `pnpm lint`                                                      | GREEN                                                    | same run                                                                                                                           |
| `pnpm typecheck`                                                 | GREEN                                                    | same run                                                                                                                           |
| `pnpm format:check` (P1 left 35 files red)                       | GREEN                                                    | same run — the sweep landed with `p2/validate-sample-ci`; 0 files red                                                              |
| `pnpm invariants:check`                                          | GREEN                                                    | `digest matches (424 ids)`                                                                                                         |
| `pnpm test`                                                      | GREEN — **1,316 / 1,316**, 114 files                     | same run                                                                                                                           |
| `pnpm test:falsify`                                              | GREEN — 280 passed                                       | local on `281b623`; `ci.yml` runs the same corpus gate inside `pnpm test`                                                          |
| `pnpm test:coverage-map` — the 14 P2 ids owned                   | GREEN — 231/231 owned                                    | same run; every P2 id listed below                                                                                                 |
| `uv sync --locked --group nlp --group lm`                        | GREEN                                                    | `pack-ci` job _coursekit lint + tests_                                                                                             |
| `uv run ruff check .`                                            | GREEN                                                    | same job                                                                                                                           |
| `uv run pytest` — **787 tests**                                  | GREEN                                                    | same job                                                                                                                           |
| `coursekit build es`                                             | **RED — fails at G5**                                    | `build-es`, exit 4, 918 slots unauthored                                                                                           |
| `coursekit validate es … → exit 0`                               | **NOT RUN**                                              | `validate-es` skipped: `needs: build-es`                                                                                           |
| V1–V4 = 100%, zero violations (INV-PACK-06)                      | **NOT PROVEN**                                           | needs a pack                                                                                                                       |
| V5–V12 zero failures, report names every validator that ran      | **NOT PROVEN**                                           | needs a pack                                                                                                                       |
| V8 records grammar/spellcheck/perplexity engines (INV-PACK-14)   | **NOT PROVEN** on a pack                                 | the behaviour is unit-tested (16 tests) and has never run over a real course                                                       |
| zero UNRESOLVED licences; every attributed row has an owner      | **NOT PROVEN** on a pack                                 | F1 and V10 exist and are tested; neither has run over a real pack                                                                  |
| no NC/ND corpus reached the ledger, by a zero-network-call test  | GREEN                                                    | `test_licences.py` — a recording transport that MUST have recorded no request                                                      |
| audio manifest: codec, bitrate, lessons+stories+radio ≤ 120 MB   | GREEN on the **committed** manifest                      | `codec=opus`, `bitrate_kbps=20`, three pipelines charged 98,000,000 B of 120 MB                                                    |
| manifest declares `ledger_unit` exactly once (INV-PACK-40)       | GREEN in unit tests                                      | `manifest.ledger_unit_declarations`; **not** on a produced manifest                                                                |
| every missable item carries ≥ 2 authored forms (INV-PACK-07)     | GREEN in unit tests                                      | 17 tests; not on a produced pack                                                                                                   |
| wrong-item rate recorded as PROVISIONAL                          | GREEN as a **string**; the rate itself is **unmeasured** | `content/es/review/scores.jsonl` is empty by design; `wrong_item_rate` is `None`, and `None` is not 0%                             |
| `ci.yml` green                                                   | GREEN                                                    | [34684986281](https://github.com/Blueturboguy07/freelingo/actions/runs/34684986281)                                                |
| `pack-ci.yml` — coursekit, pipeline-ready, build-es, validate-es | **RED**                                                  | [34684986287](https://github.com/Blueturboguy07/freelingo/actions/runs/34684986287): 2 green, build-es failed, validate-es skipped |
| `pack-bake.yml` green run uploading `es-audio-<sha>`             | **NOT RUN — blocker**                                    | see Blockers                                                                                                                       |
| `native-e2e.yml` all jobs                                        | see CI runs                                              | [34684986282](https://github.com/Blueturboguy07/freelingo/actions/runs/34684986282)                                                |
| `mutation.yml` nightly, non-gating                               | see CI runs                                              | [34685272894](https://github.com/Blueturboguy07/freelingo/actions/runs/34685272894)                                                |

## CI runs

All on `281b623`.

| Workflow         | Run                                                                    | Result                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`         | <https://github.com/Blueturboguy07/freelingo/actions/runs/34684986281> | **success** — all three jobs                                                                                                                |
| `pack-ci.yml`    | <https://github.com/Blueturboguy07/freelingo/actions/runs/34684986287> | **failure** — `coursekit lint + tests` ✅, `pipeline-ready` ✅ (17/17 validators, 10/10 stages), `build-es` ❌ at G5, `validate-es` skipped |
| `native-e2e.yml` | <https://github.com/Blueturboguy07/freelingo/actions/runs/34684986282> | see below                                                                                                                                   |
| `mutation.yml`   | <https://github.com/Blueturboguy07/freelingo/actions/runs/34685272894> | see below                                                                                                                                   |

### `native-e2e.yml` — all four jobs green, as non-regression

[Run 34684986282](https://github.com/Blueturboguy07/freelingo/actions/runs/34684986282),
conclusion **success**:

| Job                                                         | Result  |
| ----------------------------------------------------------- | ------- |
| `flows exist`                                               | success |
| `INV-PLAT-02 — native trees are generated and reproducible` | success |
| `iOS simulator`                                             | success |
| `Android emulator`                                          | success |

P2 changed nothing under `apps/`, so this is exactly the non-regression the gate asks for.
Artefacts downloaded to `e2e/artifacts/ci-281b623/`.

**Screenshots — two, and here is what is actually in them.** Both are the P0 `p0-db-path`
flow's `Diagnostics` screen, the only flow in `e2e/flows/` at P2 (`flows=1` in both
`runner.txt` files). Nothing in this phase renders a learner-facing screen — the lesson
player is P3 — so there is no pack, path or lesson frame to show, and this report does not
pretend otherwise.

_`…-ios/screenshots/p0-db-path-p0-db-path.png`_ — a portrait iPhone frame, status bar
reading 9:28. A green `Diagnostics` heading over eight labelled rows:
`db-path` = `file:///Users/runner/Library/Developer/CoreSimulator/Devices/3D025AD9-…/Documents/freelingo-progress.db`;
`journal-mode` = `wal`; `user-version` = `2`; `packs-dir` = the same container's
`Library/Caches/packs/`; `packs-excluded` = `true`; `platform` = `ios`;
`db-path-persistent` = `true`; `pre-migration-backup` = `none`. A green `CLOSE` button
below. That is INV-PER-06 (progress in `Documents`, packs in `Caches`) and INV-PACK-11
(backup exclusion) rendered from the device rather than asserted in a unit test.

_`…-android/screenshots/p0-db-path-p0-db-path.png`_ — the same screen on the emulator:
`db-path` = `file:///data/user/0/org.freelingo.app/files/freelingo-progress.db`,
`journal-mode` = `wal`, `user-version` = `2`,
`packs-dir` = `file:///data/user/0/org.freelingo.app/cache/packs/`, `packs-excluded` =
`true`, `platform` = `android`, `db-path-persistent` = `true`, `pre-migration-backup` =
`none`.

Runners, from the artefacts' own `runner.txt` (these rotate, and a snapshot diff caused by
a different toolchain must never read as a code change):

```
ios     simulator_requested=iPhone 17 (iOS-26-1)  simulator_used=iPhone 17 @ iOS-26-1
        udid=3D025AD9-C9BB-46A3-BCB4-B84F592C53A0  xcode=Xcode 26.2 Build 17C52  maestro=2.10.0
android api_level=34  arch=x86_64  target=google_apis  maestro=2.10.0
```

### `mutation.yml` — non-gating, and it did not produce a score

[Run 34685272894](https://github.com/Blueturboguy07/freelingo/actions/runs/34685272894)
reports **success**, and that word means only that `continue-on-error` held. Stryker
instrumented 118 of 843 files with 10,765 mutants and then **never got past the dry run**:

```
ERROR DryRunExecutor One or more tests failed in the initial test run:
  INV-DAT-04 historical rows are never re-stamped; gap days are missed
  [INV-DAT-04] imported gap days count as missed, never unlived, …
    Test timed out in 300000ms.
ERROR Stryker There were failed tests in the initial test run.
```

**No mutation score exists for this sha, and none is quoted.** The same failure is in the
previous nightly on the P1 sha `75d6242`
([34673140566](https://github.com/Blueturboguy07/freelingo/actions/runs/34673140566)) with
the same test and the same 300,000 ms timeout, so it is a pre-existing P1 property that
does not finish under `perTest` instrumentation — P2 touched nothing in `packages/core/src/day/`.
It is recorded here rather than fixed because the job is explicitly non-gating at this
phase, and because "the mutation job is green" was never a measurement.

## Invariant coverage

`pnpm test:coverage-map` on `281b623`, inside `ci.yml`'s `lint + typecheck + unit/property
tests` job: **424 ids in the registry, 231 owned across 21 ownership files, 231 with a test,
0 missing**. The registry digest matched (`invariants:check: digest matches (424 ids)`).

The fourteen ids P2 owns, with the number of tests whose NAME (or leading docstring)
carries the id:

| Id          | Owning file                    | Tests | What the owning test does                                        |
| ----------- | ------------------------------ | ----- | ---------------------------------------------------------------- |
| INV-PACK-06 | `docs/owned/p2-g3-g4.json`     | 6     | the two gates that decide a pack, at the size the claim is true  |
| INV-PACK-07 | `docs/owned/p2-g7.json`        | 17    | every missable item carries ≥ 2 authored forms                   |
| INV-PACK-08 | `docs/owned/p2-g7.json`        | 14    | every accepted answer is in the unit's declared register         |
| INV-PACK-10 | `docs/owned/p2-g5-g6.json`     | 19    | generate-and-reject: a candidate re-enters through G0's filter   |
| INV-PACK-12 | `docs/owned/p2-g0-ingest.json` | 14    | a missing per-language input stops the stage **by name**         |
| INV-PACK-13 | `docs/owned/p2-g0-ingest.json` | 57    | forbidden corpora refused at `resolve()`, before any request     |
| INV-PACK-14 | `docs/owned/p2-g5-g6.json`     | 16    | V8 records the engines it used; "0 errors with no engine" fails  |
| INV-PACK-15 | `docs/owned/p2-g8.json`        | 16    | codec, bitrate and bytes for all three pipelines vs 120 MB       |
| INV-PACK-17 | `docs/owned/p2-g9.json`        | 27    | every attribution-requiring asset reachable from S152            |
| INV-PACK-40 | `docs/owned/p2-g1-g2.json`     | 29    | one ledger unit, declared once, and the tree-wide grep gate      |
| INV-PACK-41 | `docs/owned/p2-g9.json`        | 15    | item ids are content hashes, agreed across Python and TS         |
| INV-PACK-50 | `docs/owned/p2-g7.json`        | 18    | no non-lexeme focus reaches a quoting exercise shape             |
| INV-PACK-51 | `docs/owned/p2-g1-g2.json`     | 14    | `(normalized_form, reading_form, POS)` never collapses two items |
| INV-AUD-08  | `docs/owned/p2-g8.json`        | 22    | the re-bake key includes the engine, so a re-bake is a new clip  |

Every one has a committed falsifying input beside it in
`tools/coursekit/tests/falsifiers/` — fourteen files, one per id — and
`packages/core/src/journey/falsifier-corpus.test.ts` reads, parses and (where the file
offers the executable contract) **runs** every one of them.

**Property runs.** `PROPERTY_RUNS = 10_000` in `packages/testkit/src/config.ts`, and
`packages/testkit/src/property-gates.test.ts` fails if any `numRuns` anywhere in the tree
is below it. None of the fourteen P2 ids is owned by a fast-check property: the content
pipeline's properties are asserted over the committed `es-mini` fixture and over planted
defects in pytest, not over generated inputs, so **there is no numRuns figure to quote for
P2** and this report does not invent one. The 10,000-case floor still holds for every
engine property `ci.yml` runs (1,316 vitest tests green on this sha).

## Blockers

### B1 — 18,200 candidates do not exist (the phase blocker)

G4 emits 918 gap slots; `content/es/candidates.jsonl` covers 8 of them. Every downstream
gate in the phase — `validate es`, V1–V12, F1–F5 on a real pack, the 120 MB bank, the
signature, the 300-item reviewer sheet — is behind this one file.

The remedy is authoring, not code: 910 slots × 20 candidates, each with its Spanish, its
English, its `allowed_lemmas` and its rubric score, written by an Opus agent because no
hosted model exists here. It is a dedicated task, and the plan already prices it: the
content framework plus Spanish is 700–900 hours, and this is the bulk of it.

**Do not lower `MIN_CANDIDATES_PER_SLOT`.** `config/g5.py` argues the constant at length
and the argument is right: the reject loop has five filter axes, and a slot with three
candidates makes the stage choose between shipping the least bad sentence and failing.

### B2 — `pack-bake.yml` cannot produce a bank on a clean runner

`pack-bake.yml` is `workflow_dispatch` on a fresh checkout and runs `coursekit bake es`,
which reads **G7's exercises**. A clean runner has no build tree, so a dispatch exits 4
naming the missing stage — the workflow's own header says so. It was therefore never
dispatched for this report, and **no `es-audio-<sha>` artefact exists**. Claiming one
would be inventing evidence.

The bank is now produced inside `build-es` instead, where G8 runs with the `tts` group in
the same job that has G7's output. `pack-bake.yml`'s remaining honest purpose is
re-baking on top of an existing tree, and it has no way to get one; it needs either an
upstream artefact download or deletion. Not this task's call.

**Local corroboration, labelled as such:** no Kokoro bank was produced on this Mac either.
The `tts` group is not installed locally and the weights were never fetched here, so there
are no local sha256 sums to offer. The only bank-shaped evidence in the repository is the
**committed** `content/es/audio-manifest.json` — 23 clips, 144,694 bytes, 45.695 s,
`codec=opus`, `bitrate_kbps=20`, three pipelines charging 98,000,000 bytes of the 120 MB
budget — which the `p2/g8-bake` lane produced and committed, and which F2 validates. That
manifest is a committed artefact, not a CI artefact, and is corroboration only.

### B3 — the wrong-item rate is unmeasured, not 2%

`content/es/review/scores.jsonl` is committed **empty on purpose**: `coursekit` treats an
absent and an empty file the same way, `wrong_item_rate` is `None`, and `gate_passed()` is
`false`. An unscored sample does not pass the ≤ 2% gate by having no numerator. The
PROVISIONAL string is carried verbatim in `docs/pack-provenance.md` and
`tools/coursekit/README.md` and asserted by
`test_the_honesty_string_is_exactly_what_the_docs_promise`; the number it qualifies does
not exist yet, and it cannot until B1 unblocks the sheet.

### B4 — the sample sheet has never been drawn

`coursekit sample es` is behind `build-es` in the same job chain. The gate's spelling
`coursekit sample es --n 300` is also wrong: per-stage options ride on `--set`
(`--set n=300 --set seed=20260911`), and a bare `coursekit sample es` already draws 300 at
seed 20260911. The `p2-validate-sample-ci` lane recorded that discrepancy in
`docs/owned/p2-validate-ci.json` → `knownHazards` before it could bite.

### B5 — S152 is not in the product map

Raised by `p2/g9-package-loader` and unresolved: INV-PACK-17 names a per-sentence credits
surface S152, and `deep/00-PRODUCT-MAP.md` stops at S151. The invariant has a validator
(F3) and no screen. A founder decision at P3, not a code fix.

### B6 — Azure is dead as the voice vendor, by necessity

`docs/owned/p2-g8.json` → `founderCheckpointItems` → `OVERRIDE-VOICE-VENDOR`: the plan's
§Approval line accepts "Azure as the voice vendor", and no cloud credentials exist in this
environment, so Spanish is baked on **Kokoro** (Apache-2.0). The consequence the lane
recorded is the one that matters: Kokoro's Spanish voices declare no regional accent, so
`locale: es-ES` drops from a vendor-backed fact to a **course claim** that nothing in the
toolchain can falsify — and the only remaining falsifier is the native-reviewer sample,
which must therefore be briefed to check accent consistency and not only correctness.
Kokoro also ships three Spanish voices where the cast wants four, so two of the four roles
are deterministic weighted blends. **Both need a founder decision.**

## Disk

`df -h ~` on this Mac at the end of the task: **75 GiB free** of 460 GiB (82% used). The
P0 target was ≥ 80 GB free and it is not met; nothing in P2 needed it, since the corpora
are streamed and capped and the only large local artefact was a 658,626-byte frequency
list. The eight merged worktrees under `/Users/mannbellani/freelingo-wt/` were removed and
`git worktree prune` run; `git worktree list` now shows only the main checkout.

## What P2 needs before it can be green

In order, with the reason each one is next:

1. **Author the candidates (B1).** 910 slots × 20, into `content/es/candidates.jsonl`,
   following the shape the 160 committed rows already demonstrate — Spanish, English,
   `allowed_lemmas`, `new_lemmas`, `function`, `authoring_intent`, `backtranslation`
   score. This is a dedicated task, not an integration round, and every other item waits
   on it.
2. **Re-run `pack-ci`.** G5 → G9 have never executed on real data. Expect them to find
   things: G1 found a 0.53% length-window tail within minutes of first running, and there
   is no reason G6's engines, G7's alignment or G9's schema will be different. Budget a
   round for what the first complete build says.
3. **Then** `validate es` can produce a report, V1–V4 can be measured at 100%, F1–F5 can
   run over a real pack, the bank can be measured against 120 MB with real bytes, and
   `coursekit sign` can put a signature on a manifest that exists.
4. **Draw and score the sample.** `coursekit sample es` writes the 300-item sheet; scoring
   it fills `content/es/review/scores.jsonl` and turns `wrong_item_rate` from `None` into
   a number. Brief the reviewer to check **accent consistency** as well as correctness —
   B6 explains why that clause is now load-bearing.
5. **Decide B2** (delete `pack-bake.yml` or give it an upstream artefact), **B5** (S152's
   row in the product map) and **B6** (Kokoro as the voice vendor, and the two blended
   voices). All three are founder calls, not code.

## What this phase proved, even red

- The **pipeline exists and runs**: ten stages and seventeen validators registered,
  `pipeline-ready` green, G0–G4 executing against Tatoeba, NLLB, hermitdave and the pinned
  `es_core_news_md` on a clean runner.
- The **gates work**, and they were not decorative: the INV-PACK-40 grep gate found seven
  tokenisers and a second ledger declaration that already disagreed with the first, the
  falsifier corpus gate found eight unreadable files, the coverage map found seven
  unclaimed ids, and the first live build found a filter drift no unit test could have.
- **787 pytest tests and 1,316 vitest tests are green**, `format:check` is clean for the
  first time since P1 deferred 35 files, and all fourteen P2 invariant ids have owning
  tests with committed falsifying inputs.
- The **licence posture holds where it can be checked**: no forbidden corpus can be
  fetched (`test_licences.py` asserts a recording transport recorded nothing), the
  frequency list's share-alike duty reaches the manifest, and F1 now reads the runlog
  rather than the output — because "at ingest, not at package time" is not a property of
  the output.
