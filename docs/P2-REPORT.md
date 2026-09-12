GATE: RED

# P2 — Spanish pack v0: the integration report (round 2)

Repository: <https://github.com/Blueturboguy07/freelingo> (public, AGPL code / CC BY-NC-SA packs)
Integrated at **`47b91bd`** on `main`. Round 1's report is kept verbatim as
`docs/P2-REPORT-round1.md`; this file replaces its verdict.
Written at the P2 founder checkpoint (plan §The build workflow, step 5 → 6).

**The gate is RED, and the headline has changed.** Round 1 was red because ~18,200
authored sentences did not exist. They exist now: **490 gap slots, 9,687 authored
candidates, 5,265 distinct sentences, 481 of 490 slots filled**, and the pipeline runs
**G0 → G6 clean on the real corpus with a real LanguageTool 6.6 sidecar**. It now stops in
two places, and neither is "the content is not written":

1. **B9, a founder decision.** `u1/l1/s0 … s8` — the first lesson of the course — cannot
   hold a sentence. The ledger permits five lemmas there, none of them a verb, and the
   pinned lemmatiser turns `buenos días` into `buen`, which the ledger does not contain.
   Eleven strings exist inside that window and all eleven are word lists. This round
   refused to ship them.
2. **B16, a code defect found by running G7 for the first time.** G7 looks a distractor up
   by _surface_, and an authored candidate has no analysis to look one up by, so the stage
   stops on the first authored item whose gap lands on a capitalised or inflected word.

So the honest summary this time is: **the content is written and the last two stages have
never seen it.**

**EVIDENCE RULE** (plan §Verification): only CI produces artefacts. Everything labelled
_corroboration_ below was produced on this Mac and is not evidence.

## What was merged

Six branches into `/Users/mannbellani/freelingo` on `main`, one at a time, `--no-ff`,
re-tested after each.

| #   | Branch                              | Tip       | Merge commit | Conflicts |
| --- | ----------------------------------- | --------- | ------------ | --------- |
| 1   | `p2fix/ledger-freeze-and-gap-brief` | `f1839ca` | `56f1609`    | none      |
| 2   | `p2fix/author-u01-u06`              | `caf5546` | `0338b18`    | none      |
| 3   | `p2fix/author-u07-u14`              | `e0773aa` | `a0dbce5`    | none      |
| 4   | `p2fix/author-u15-u23`              | `a376139` | `08869fb`    | none      |
| 5   | `p2fix/author-u24-u30`              | `2b354f2` | `11d8c93`    | none      |
| 6   | `p2fix/g6-g9-validate-and-ci`       | `154c4f7` | `fa0ab16`    | none      |

No textual conflict in any of the six. Every defect below is a **semantic** conflict or a
thing that only a real run could find: each branch was green alone.

## The nine defects this integration found

### 1. `coverage-map` crashed instead of naming a file

`docs/owned/p2fix-author-u24-u30.json` put its ids under `invariants`; the script casts to
`{owned: string[]}` and died with `TypeError: file.ids is not iterable`, naming nothing.
Its three sibling lanes all declare `owned: []` plus a prose key, and its ids were already
owned elsewhere, so the file now matches them — and `scripts/coverage-map.ts` checks the
shape and names the file it cannot read.

### 2. 218 candidates were `usted` in a course that declares `tu` — a blocking V6

`p2fix-author-u01-u06` wrote the rule down (`DEFAULT_REGISTER_BY_SLOT['binary_t_v']` is
`tu`, so `usted`/`ustedes` in an accepted answer is a **blocking** V6 finding) and two
other lanes authored against it anyway: 202 rows in `u15-u23`, 14 in `u24-u30`, 2 in
`u07-u14`. All 218 rewritten to tuteo keeping the English — `Usted sigue hasta la plaza` →
`Tú sigues hasta la plaza` — and where the second person singular does not lemmatise
(`continúas` is not a lemma the pinned model produces) the pronoun is dropped and the
imperative kept. Each rewritten row carries `register_rewritten_from: usted`. Checked with
V6's own marker table afterwards: **0 accepted rows carry `usted`**.

### 3. G6 read one candidates file and there are five

`engines/backtranslation.py` was built from `content/es/candidates.jsonl` alone. Sharding
moved every authored row into `content/es/candidates/*.jsonl` and that file stopped
existing, so the engine probed a path that was not there, reported
`backtranslation_engine: none`, and G6 failed the build with _"an engine was requested and
could not run"_ — with every rubric score on disk one directory across. It now takes the
same path list G5 takes.
`test_INV_PACK_14_the_rubric_scores_are_read_from_the_shards_as_well` builds a course whose
rows live only in shards and asserts the probe comes back available.

### 4. `build-es` named no language engine (B8)

Found by `p2fix-downstream` and unfixable in its lane, because `pack-ci.yml` was outside
it. G6 recorded `grammar_engine: none` and V8 blocks a run that checked nothing
(INV-PACK-14), so `validate-es` could not exit 0 for **any** content whatsoever.
`build-es` now downloads LanguageTool 6.6, starts the server, waits for `/v2/languages`,
and proves the sidecar with a planted misspelling (`MORFOLOGIK_RULE_ES`) before the build
runs. The test that pinned the broken state now reads the YAML and fails if the step ever
stops naming an engine.

### 5. `build-es` never had the aligner (B13)

G7 needs the `align` group; the job synced `nlp + lm + tts`. It exits 3 with no fallback,
deliberately — a degraded aligner produces word-bank hints that are wrong in a way no
row-level validator can see. Invisible for exactly the reason B8 was: the build had never
reached G7. `align` added, `torch` already routed to the CPU index on Linux by the deps
lane, and the job's timeout raised 60 → 90 minutes, because when 60 was chosen the job had
never run a sidecar, a torch download or a Kokoro bake.

### 6. Two slots came out of G6 with no survivor

`u1/l2/s0` and `u1/l6/s5`: every candidate that passed G5 was scored below the rubric
minimum **by its own author**, and a slot with no survivor is a blocking V8 finding. Five
replacements authored against those two windows and verified with the pinned lemmatiser —
`Mucho gusto, señora.`, `Hasta luego, señor.`, `Encantado, hasta luego.`, `Hola, sí.
Adiós.`, `No, adiós, por favor.` G6 now reports `slots_without_survivor: []`.

### 7. The 122 slots `p2fix/author-u07-u14` left behind

That lane shipped 180 rows for one lesson and argued the rest needed the frozen build. The
frozen build is exactly what `content/es/authoring/gap-brief.jsonl` is, so the slots were
authorable. **378 distinct Spanish sentences** written at integration against the brief's
own windows, each checked with the pinned `es_core_news_md` before entering the pool;
drafts that failed the window were discarded and rewritten, never patched into the shard
(INV-PACK-10). The twenty per slot are its fresh candidates plus texts **already accepted
earlier in the same unit**, which G5 rejects as `duplicate` — the shape
`p2fix-author-u01-u06` documented, and the only shape a closed vocabulary allows. A first
attempt padded with texts that had _not_ been accepted yet and starved 77 slots by filling
them with another slot's sentence; the generator now simulates G5's own evaluation order.

The measured lemmatiser traps are worth keeping: `respondo`/`respondes` do not lemmatise
to `responder` (third person does), `come` lemmatises to `comar`, `compra` to `compro`,
`sé` to `sar`, `entiendo` to `enteir`, `arregla` to `arreglir`, feminine `cuadrada` to
`cuadrar`, and `casa`, `cocina`, `nada`, `este`, `a`, `que` and `muy` are in **no** unit's
target lexemes anywhere in the course.

### 8. G7 made word-bank tiles out of punctuation (B15)

The first thing G7 ever did with a real authored candidate:

```
g7 failed: NotEnoughDistractors: concept:subject_pronouns: needed 2 distractors for
'Hola,' (POS , band unbanded) and the rule core found 0.
```

An authored candidate has no `analysed_sentence`, so G7 falls back to a whitespace split,
and the split was bare — `Hola,` and `noche.` became word-bank tiles, and the distractor
core was asked for two same-POS same-band lexemes for a string in no lexicon. The
asymmetry inside the same file was the tell: `_lemmas_for`'s fallback already stripped the
same characters, so one sentence produced clean lemmas and dirty tiles. Fixed, pinned by
`test_INV_PACK_40_an_authored_candidates_tiles_carry_no_punctuation`. **This would have
stopped the build on ordinary sentences, not only on the diagnostic ones** — most authored
candidates carry a comma or a full stop.

### 9. …and G7 then stops one line later (B16, OPEN)

With the tiles clean, the same run fails on `'Hola'` itself: `_decoys(...,
lemmas=[target_tokens[gap_index]], ...)` passes the **surface** where a lemma is expected,
so POS is empty, the band is `unbanded`, and the rule core has nothing to choose from. For
a corpus sentence this mostly works by accident; for an authored candidate there is no
analysis at all. The two possible fixes — analyse authored candidates in G7 with the
registered adapter, or carry the analysis across the frozen G5 → G7 contract — are a design
decision for the G7 lane, written up in `docs/P2-BLOCKERS.md` §B16 rather than guessed at
here.

## The pipeline, measured

Two runs of the same pipeline over the same corpus:

- **CI, `build-es`** — the only run that makes evidence. See §CI.
- **This Mac, 2026-09-12** — _corroboration only_, and with one difference stated up
  front: the nine `u1/l1` slots were padded with a **diagnostic shard that is not
  committed and never will be** (author string `DIAGNOSTIC ONLY - not committed content`)
  so that the stages after G5 could be exercised at all. Everything else is the committed
  content.

### G0 — ingest

```
276,203 ingested (tatoeba 180,862 + nllb 95,341) of 399,896 read
rejected: too_long 103,510 · duplicate 11,688 · too_short 7,871 · register 321 · profanity 301 · untranslated 2
licences: tatoeba CC-BY-2.0-FR shippable (attribution: Tatoeba contributors)
          nllb ODC-By-1.0 oracle_only (attribution: NLLB / OPUS)
```

`276,203` is the **same number the frozen brief carries**, from an independently streamed
download on another day. The corpus is stable at this cap.

### G4 — select, and the question that decided whether any of the authoring counted

```
1,584 slots · 1,094 filled from the corpus · 490 gaps · gap_fraction 0.3093 · cross_unit_repeats 0
```

`coursekit gaps es` over this run reproduces the committed
`content/es/authoring/gap-brief.jsonl` **exactly** — same 490 slots, same digest
`e1dcba859bdfe9aa157b14d130d692bec1bf72041624b0921c0ea99733adfbbe`, **0 slots added, 0
removed, 0 `ledger_digest` mismatches, 0 `new_lemmas` mismatches**. That is the answer to
the one question this round could not have settled by reading: the 9,687 authored rows are
keyed to slots that still exist, and G5's `stale_ledger` axis rejects **0** of them.

### G5 — gap-fill

```
490/490 slots filled · 9,867 candidates read and written · reject rate 0.3869
rejected: duplicate 3,187 · length 615 · out_of_vocabulary 16 · stale_ledger 0 · new_lemma_budget 0
thin slots: none · unfilled: none · orphan authored slots: none
```

The `duplicate` majority is the shape of the problem rather than a defect: a lesson window
admits a few hundred sentences in total, so twenty _distinct_ candidates per slot do not
exist, and a slot's twenty are its fresh candidates plus texts already accepted earlier in
the same unit.

### G6 — validate language, with a real sidecar

```
6,049 checked
grammar_engine         languagetool/6.6/es
spellcheck_engine      languagetool/6.6/es
perplexity_engine      none
backtranslation_engine agent_rubric/v1 (agent-authored rubric score, not a model round-trip)
degraded_to            grammar_only
narrowed: backtranslation 88 · grammar 15 · perplexity_out_of_band 0
slots_without_survivor: none
```

This is the state V8 accepts: an engine that _can_ find an error ran, the run records which
one, and the missing one is named in `degraded_to` rather than silently absent. Before this
round both `grammar_engine` and `spellcheck_engine` read `none` and V8 blocked every
possible pack.

### G7 — stops (B16). G8, G9, `sample`, `sign` — never reached

`coursekit validate es` was nonetheless run against that tree, because a validator suite
that has never executed is its own risk. It exits non-zero, as it must, and what it says is
worth reading:

```
es: 7/17 validators green, 0 unregistered, 0 skipped, 15 blocking finding(s). Nothing ships.
```

- **V1–V6, V9, V12, F4** raise `UpstreamStageMissing` / `FileNotFoundError` for G7 and G9 —
  and they raise rather than pass, which is the property INV-PACK-14 is about.
- **V7** records that the every-string-has-audio half checked nothing, in words.
- **V8** passes with the engines above and asks for a KenLM model by name.
- **V11** measured something real and new: **mean difficulty falls across 13 unit
  boundaries**, the largest `u18 → u19` at −3.222. Gap-heavy units read easier than the
  unit before them because an authored sentence is plainer than a corpus sentence that
  fits the same window. Recorded as **B17**, undecided.
- **F5** records that the ja character syllabus is not applicable to es, rather than
  skipping silently.

## The gate, item by item

| Gate item                                                                                | Status                                                                                                                                                                                                                                                                                       | Where                            |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `pnpm install --frozen-lockfile`                                                         | **GREEN**                                                                                                                                                                                                                                                                                    | ci.yml                           |
| `pnpm lint`                                                                              | **GREEN**                                                                                                                                                                                                                                                                                    | ci.yml                           |
| `pnpm typecheck`                                                                         | **GREEN**                                                                                                                                                                                                                                                                                    | ci.yml                           |
| `pnpm format:check` (P1 left 35 files red)                                               | **GREEN** — the three files the fix round left red were swept                                                                                                                                                                                                                                | ci.yml                           |
| `pnpm invariants:check`                                                                  | **GREEN** — 424 ids, digest matches the corpus                                                                                                                                                                                                                                               | ci.yml                           |
| `pnpm test`                                                                              | **GREEN** — 114 files, 1,316 tests                                                                                                                                                                                                                                                           | ci.yml                           |
| `pnpm test:falsify`                                                                      | **GREEN** — 280 committed falsifier cases                                                                                                                                                                                                                                                    | ci.yml                           |
| `pnpm test:coverage-map`                                                                 | **GREEN** — the 14 P2 ids owned via `docs/owned/p2-*.json`, no duplicate claim                                                                                                                                                                                                               | ci.yml                           |
| `uv sync --locked --group nlp --group lm`                                                | **GREEN**                                                                                                                                                                                                                                                                                    | pack-ci                          |
| `uv run ruff check .`                                                                    | **GREEN**                                                                                                                                                                                                                                                                                    | pack-ci                          |
| `uv run pytest`                                                                          | **GREEN**                                                                                                                                                                                                                                                                                    | pack-ci                          |
| `uv run coursekit build es`                                                              | **RED — G0–G6 pass, G5 stops on the nine `u1/l1` slots in CI (B9); locally, with those padded, G7 stops on B16**                                                                                                                                                                             | pack-ci `build-es`               |
| `uv run coursekit validate es` → exit 0                                                  | **NOT PROVEN** — it runs and exits non-zero (7/17 green), correctly, because G7 and G9 have no artefacts                                                                                                                                                                                     | corroboration                    |
| `uv run coursekit sample es`                                                             | **NOT PROVEN** — refuses to draw from nothing: _"Drawing from nothing would produce an empty sheet and a defect rate of 0%"_                                                                                                                                                                 | corroboration                    |
| `uv run coursekit sign es` (CI only)                                                     | **NOT PROVEN** — needs a manifest, and G9 has not run                                                                                                                                                                                                                                        | —                                |
| V1–V4 = 100%, zero violations \[INV-PACK-06]                                             | **NOT PROVEN** — all four raise on the missing G7 artefact                                                                                                                                                                                                                                   | corroboration                    |
| V5–V12 zero failures; the report names every validator that ran                          | **PARTIAL** — the report names all 17 and says which of _clean_, _nothing to check_ and _never ran_ each is; 7 green                                                                                                                                                                         | corroboration                    |
| V8 records the engines actually used \[INV-PACK-14]                                      | **PROVEN, locally** — `grammar_engine` and `spellcheck_engine` = `languagetool/6.6/es`, `backtranslation_engine` = `agent_rubric/v1`, `perplexity_engine` = `none`, `degraded_to` = `grammar_only`, over 6,049 candidates; the sidecar step itself is green in CI                            | corroboration + pack-ci          |
| zero UNRESOLVED licences; attribution owner on every required row \[INV-PACK-13/17, V10] | **NOT PROVEN** — V10 needs the pack                                                                                                                                                                                                                                                          | —                                |
| no NC/ND corpus reached the ledger, zero-network-call test on the forbidden list         | **GREEN** — `resolve()` raises on a forbidden source before any request                                                                                                                                                                                                                      | pack-ci `coursekit lint + tests` |
| audio manifest codec=opus, 20 kbps, ≤ 120 MB \[INV-PACK-15]                              | **NOT PROVEN on real bytes** — the committed `content/es/audio-manifest.json` declares `codec: opus`, `bitrate_kbps: 20`, 23 clips / 144,694 B baked and 98,000,000 B of the 120 MB budget charged across lesson + stories + radio. That is a declaration, not a bake                        | corroboration                    |
| manifest declares `ledger_unit=lemma` exactly once \[INV-PACK-40]                        | **GREEN as a source property** — the grep gate over `tools/coursekit` has no offenders; the manifest half needs a pack                                                                                                                                                                       | pack-ci                          |
| every missable item carries ≥ 2 authored forms \[INV-PACK-07]                            | **NOT PROVEN** — G7 writes the forms                                                                                                                                                                                                                                                         | —                                |
| wrong-item rate recorded as PROVISIONAL                                                  | **GREEN as a string, UNMEASURED as a number** — `content/es/review/scores.jsonl` is deliberately empty, `wrong_item_rate` is `None`, `gate_passed()` is false. B3                                                                                                                            | `docs/pack-provenance.md`        |
| `pack-bake.yml` green run uploading `es-audio-<sha>`                                     | **DELETED, deliberately (B2)** — a dispatch on a fresh checkout has no G7 output to bake, so it could never succeed. G8 runs inside `build-es`, which has G7's output, and the bank travels in `es-build-<sha>` — retention raised 1 → 7 days at this integration. Reasoning in `docs/ci.md` | —                                |
| `mutation.yml` nightly, non-gating                                                       | **NO SCORE EXISTS** — unchanged from P1: Stryker instruments 10,765 mutants and times out in the dry run on an INV-DAT-04 property. Identical on the P1 sha `75d6242`, so it is pre-existing and P2 touched nothing in `packages/core/src/day/`                                              | B7                               |

## CI

All three workflows ran on the integration sha `47b91bd`.

| Workflow         | Run                                                                    | Result                                                                                 |
| ---------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ci.yml`         | <https://github.com/Blueturboguy07/freelingo/actions/runs/34691399776> | **SUCCESS** — lint, typecheck, 114 files / 1,316 tests, golden-DB migrations, gitleaks |
| `pack-ci.yml`    | <https://github.com/Blueturboguy07/freelingo/actions/runs/34691399785> | **FAILURE at G5, and nowhere else**                                                    |
| `native-e2e.yml` | <https://github.com/Blueturboguy07/freelingo/actions/runs/34691399754> | **SUCCESS** — all four jobs                                                            |
| `mutation.yml`   | nightly, non-gating                                                    | no score exists; B7                                                                    |

### `ci.yml` — green on a re-run, and the first attempt is worth naming

The first attempt failed with **1,316 of 1,316 tests passing**:

```
Vitest caught 1 unhandled error during the test run.
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
Test Files  114 passed (114)
Tests  1316 passed (1316)
Errors  1 error
```

That is the reporter's RPC to the worker timing out on a 224-second run, not a test. Rerun
of the failed job: green in 3m6s, same tree. Recorded rather than quietly re-run, because
a flake that nobody writes down is a flake somebody re-runs forever.

### `pack-ci.yml` — three jobs, and the one that matters got further than it ever has

```
✓ pipeline-ready (which stages and validators exist)   8s
✓ coursekit lint + tests                               2m1s
X build-es (G0-G9, capped ingest)                     24m20s
- validate-es (V1-V12 + F1-F5)                        skipped (needs: build-es)
```

Every step of `build-es` before the build passed, including the two this round added:
**`Sync nlp + lm + align + tts (locked)`** and **`Start the LanguageTool sidecar`**, whose
last line is the probe asserting `MORFOLOGIK_RULE_ES` on a planted misspelling. Then:

```
11:35:34  g0  Ingest — corpus fetch, dedup, length and register filter, licence row
11:36:33  g1  Analyze — segment, lemmatise, morph features (Mode A for ja)
11:52:24  g2  Band — frequency rank and CEFR/decile band per lemma
11:55:23  g3  Solve curriculum — assign lemmas and grammar concepts to units
11:55:25  g4  Select — pick corpus sentences inside the ledger; emit the gap list
11:58:50  g5  Gap-fill — the only authoring stage; candidates re-enter at G6
11:59:16  g5 failed: 9 slot(s) authored below the over-generation floor of 20:
          u1/l1/s0 (1), u1/l1/s1 (2), u1/l1/s2 (3), u1/l1/s3 (4), u1/l1/s4 (7),
          u1/l1/s5 (8), u1/l1/s6 (9), u1/l1/s7 (10), u1/l1/s8 (11).
          Generate-and-reject has nothing to resample from, and the alternative is patching.
##[error]Process completed with exit code 4.
```

**Nine slots. Not 918, not 481 — nine, all in one lesson, all of them B9.** Round 1's build
died at the same stage with every slot short; this one names the nine that a founder
decision has to unblock.

### The artefact that settles the ledger question — CI-produced, not corroboration

`build-es` uploads `es-gap-brief-47b91bd…` on `always()`, which is why it survived the
failure. Downloaded and diffed against the committed `content/es/authoring/gap-brief.jsonl`:

```
frozen 490 slots · CI 490 slots
frozen digest e1dcba859bdfe9aa157b14d130d692bec1bf72041624b0921c0ea99733adfbbe
CI     digest e1dcba859bdfe9aa157b14d130d692bec1bf72041624b0921c0ea99733adfbbe
slots only in the frozen brief: 0 · only in CI's: 0
ledger_digest mismatches: 0 · new_lemmas mismatches: 0 · ingested: 276,203 both
```

So the 9,687 authored rows are keyed to slots that exist **on a runner that streamed the
corpus itself**, and `stale_ledger` cannot reject them. That was the open question of the
round and it is answered by CI rather than by this Mac.

### `native-e2e.yml`

```
✓ flows exist                                                8s
✓ INV-PLAT-02 — native trees are generated and reproducible  20s
✓ Android emulator                                           17m54s
✓ iOS simulator                                              29m34s
```

Non-regression, as the gate asks. The iOS job failed on the previous sha `78cfae3` — a
docs-only commit — with `xcrun simctl openurl … exited with non-zero code: 60` while
opening the dev-client URL, and passed here on a tree that differs from it by content and
workflow files only. Flaky simulator launch, not a regression.

An earlier pair of runs on `aa49862` was **cancelled**, not failed: `pack-ci` and
`native-e2e` share a concurrency group with the branch, so the push carrying the G7 fix
killed them. `ci.yml` on that sha finished green first
(<https://github.com/Blueturboguy07/freelingo/actions/runs/34690354264>).

## Screenshots

`gh run download 34691399754` → `e2e/artifacts/ci-47b91bd/`. Two screenshots, one per
platform, both from the single P0 flow `p0-db-path`, both CI-produced:

| File                                                         | What it shows                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e-47b91bd…-ios/screenshots/p0-db-path-p0-db-path.png`     | the app's **Diagnostics** sheet on iPhone 17 / iOS 26.1: title in Freelingo green, `db-path` = `…/Application/395863DE…/Documents/freelingo-progress.db`, `journal-mode wal`, `user-version 2`, `packs-dir` = `…/Library/Caches/packs/`, `packs-excluded true`, `platform ios`, `db-path-persistent true`, `pre-migration-backup none`, and a green CLOSE |
| `e2e-47b91bd…-android/screenshots/p0-db-path-p0-db-path.png` | the same sheet on API 34 x86_64: `file:///data/user/0/org.freelingo.app/files/freelingo-progress.db`, `wal`, `user-version 2`, `packs-dir file:///data/user/0/org.freelingo.app/cache/packs/`, `packs-excluded true`, `platform android`, `db-path-persistent true`                                                                                       |

Both `report.xml` files read `tests="1" failures="0"`. Runner metadata is beside them:
`maestro=2.10.0`, Android `api_level=34 arch=x86_64 target=google_apis`, iOS
`simulator_used=iPhone 17 @ iOS-26-1`, `xcode=Xcode 26.2 Build version 17C52`.

**There are no pack screenshots, and there cannot be yet.** P2's product is a content pack,
not a screen. The first surfaces that render any of it — S001's course card with
`{{n}}% machine-authored` and the measured wrong-item rate, S002's validator-report summary,
S137's About — are P3's, and P3 has not started. `docs/pack-provenance.md` specifies their
copy.

## Blockers

The live list is `docs/P2-BLOCKERS.md`. Where it stands after this round:

| Id                 | What                                                                                                         | Kind                     | Status                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------ | ----------------------------------------------- |
| **B1 / B1a / B1b** | the candidates did not exist; the gap ledger was empty; the fixture was keyed in a numbering G4 does not use | authoring + code         | **RESOLVED** — 9,687 rows, 481/490 slots filled |
| **B2**             | `pack-bake.yml` could not succeed on any dispatch                                                            | code                     | **RESOLVED**                                    |
| **B3**             | the wrong-item rate is `None`, not 2%                                                                        | **founder decision**     | **OPEN**                                        |
| **B4**             | `coursekit sample es --n 300` is not a spelling the CLI has                                                  | docs                     | **RESOLVED**                                    |
| **B5**             | S152 has validator F3 and no row in the product map                                                          | **founder decision**     | **OPEN**                                        |
| **B6**             | Azure is dead as the voice vendor; Spanish bakes on Kokoro                                                   | **founder decision**     | **OPEN**                                        |
| **B7**             | `mutation.yml` has never produced a score                                                                    | pre-existing, non-gating | **OPEN, measured**                              |
| **B8**             | `build-es` named no language engine, so V8 blocked any pack                                                  | code (CI)                | **RESOLVED**                                    |
| **B9**             | unit 1 lesson 1 cannot hold a sentence                                                                       | **founder decision**     | **OPEN — a phase blocker**                      |
| **B10**            | 218 candidate texts were `usted` in a `tu` course                                                            | content                  | **RESOLVED**                                    |
| **B11**            | G6 read one candidates file and there are five                                                               | code                     | **RESOLVED**                                    |
| **B12**            | the gate's `coursekit validate es --pack … --report …` spelling does not exist                               | docs                     | **RESOLVED**                                    |
| **B13**            | `build-es` synced no `align` group                                                                           | code (CI)                | **RESOLVED**                                    |
| **B14**            | a starved slot crashes G7 with a `KeyError` instead of failing by name                                       | code                     | **OPEN, cosmetic**                              |
| **B15**            | G7 made word-bank tiles out of punctuation                                                                   | code                     | **RESOLVED**                                    |
| **B16**            | G7 looks a distractor up by surface, and an authored candidate has no analysis                               | code                     | **OPEN — a phase blocker**                      |
| **B17**            | V11 sees mean difficulty fall across 13 unit boundaries                                                      | content                  | **OPEN, measured**                              |

### B9, restated, because it is half the gate

`u1/l1/s0 … s8`. The ledger permits `{bueno, día, hola, noche, tarde}` and nothing else: no
verb until lesson 3, no article until lesson 19, no preposition, no proper noun anywhere in
the course. On top of that the pinned `es_core_news_md` lemmatises every prenominal form of
`bueno` to `buen`/`buena`, so **`Buenos días.` is out of vocabulary in the lesson that
teaches both `bueno` and `día`**, and the only surface that reaches the lemma `bueno` is the
bare discourse marker — two tokens, under the floor.

Eleven strings exist inside that window and all eleven are word lists (`Hola, hola.`,
`Día, tarde, noche.`). This round did not ship them, and the diagnostic run showed that
shipping them would not have worked either: G7 asked the distractor core for two same-POS
same-band lexemes for the tile `Hola,` and got none. **Padding was never a path to green.**

`docs/P2-BLOCKERS.md` §B9 costs the three ways out — re-chunk unit 1 so lesson 1 also deals
a verb (blast radius ≈ 40 unit-1 slots); declare the lemmas the model actually produces
(blast radius: every `ledger_digest` in the course, so all 9,687 rows); or let lesson 1 be
phrases rather than sentences (a config constant, and half a fix). None is taken here.

The general defect behind all three — **a curriculum may declare a target lemma the pinned
lemmatiser never produces for the forms the course intends to teach** — has no validator
today and should get one at G3 whichever option is chosen.

## Disk

`df -h ~` at the end of the round: **69 GiB free of 460 GiB (84% used)**.

P0's target of ≥80 GB free is still unmet, and nothing in P2 needed it. This round added
about 1.5 GB locally that is not in the repository and is not needed again: the `align`
group's torch/transformers wheels in `tools/coursekit/.venv` (1.1 GB), the pinned Kokoro
weights (353,764,321 B across two files) and a LanguageTool 6.6 unpack, all under the
session scratchpad or the venv. CI carries its own copies and caches the Kokoro weights.
