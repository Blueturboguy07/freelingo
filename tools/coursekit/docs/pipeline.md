# The pipeline, for the lane that has to add to it

`coursekit` compiles open corpora plus an originally-authored curriculum into a signed
content pack. This page is the contract between the P2 lanes: what the dependency groups
are and which ones CI carries, what crosses each stage boundary, where a run writes, and
which stated constants in the research corpus are wrong.

Read `../README.md` for the commands and `~/duolingo-research/scope2/00-FRAMEWORK-ANSWER.md`
§2 for the framework this implements.

---

## 1. Dependency groups, and the two CI does not carry

| Group     | Carries                                                     | Synced by CI                     |
| --------- | ----------------------------------------------------------- | -------------------------------- |
| (default) | typer, httpx, pyyaml, jsonschema, pynacl, regex             | yes                              |
| `dev`     | pytest, ruff                                                | yes                              |
| `nlp`     | spaCy 3.8 + `es_core_news_md` 3.8.0 **pinned by wheel URL** | yes                              |
| `lm`      | kenlm, pinned to commit `4cb443e6`                          | yes                              |
| `align`   | simalign + torch (CPU) + transformers                       | **no**                           |
| `tts`     | kokoro-onnx + soundfile + numpy                             | `build-es` only (G8 bakes there) |

`pack-ci.yml`'s `coursekit` job runs `uv sync --locked`, which installs
`[tool.uv] default-groups` — `dev`, `nlp`, `lm`. That job has a 20-minute budget; `align`
and `tts` are gigabytes of wheels plus model downloads on first use and do not fit in it.

**`build-es` is the exception, added at P2 integration**, and the reason is arithmetic
rather than preference: a stage whose group is absent exits 3 rather than degrading, G8
needs `tts`, and G9 needs G8 — so without the group the build stops at G8 and the artefact
the job uploads is not a pack. `build-es` has a 60-minute budget and syncs
`--group nlp --group lm --group tts`, with the Kokoro weights cached exactly as
`build-es` caches them; `pack-bake.yml` was deleted at the P2 fix round (docs/ci.md).
`align` is still carried nowhere.

Install them locally:

```sh
uv sync --group align      # G7 word alignment
uv sync --group tts        # G8 bake
```

**The decision has a consequence, and it is a rule.** A stage that needs an absent group
must **fail loudly** — `inputs.require_group(...)`, exit **3**, with the install command
in the message — and must never degrade. There is no fallback aligner and no system-voice
fallback, because both failures are invisible downstream: a worse aligner produces
word-bank hints that are wrong in ways V4 cannot catch, and a system voice ships audio
that is neither content-addressed nor reproducible. `tests/test_cli.py` asserts the exit
code and the message; `CI_SYNCED_GROUPS` is asserted against `pyproject.toml`, so the two
cannot drift into CI believing it carries a group it does not.

### Two pins that are not fussiness

- **`es_core_news_md` by wheel URL, never `spacy download`.** `download` resolves against
  a live manifest. A lemmatiser change re-partitions the lemma ledger and can
  retro-introduce a lemma before its introduction unit — a **V1** failure invisible to
  every test downstream of G2, because all of them agree with the new lemmatiser.
- **kenlm by commit, never `archive/master.zip`.** Same class: a perplexity band computed
  against one build of KenLM and enforced against another is a V8 that drifts with no
  diff.

`torch` resolves from PyTorch's CPU index on Linux (`[tool.uv.sources]`); nothing here
touches a GPU and the CUDA wheels are ~2.5 GB.

---

## 2. The frozen artefact contract

P2 runs as **two waves over eight lanes**, and a lane in wave 2 cannot watch another
lane's stage run to discover what it emits. So the boundaries are written first, in
`coursekit/artifacts.py`: one JSON Schema per record, one file per record kind.

| Stage | Emits               | File                  |
| ----- | ------------------- | --------------------- |
| G0    | `ingested_sentence` | `g0/ingested.jsonl`   |
| G1    | `analysed_sentence` | `g1/analysed.jsonl`   |
| G2    | `banded_lemma`      | `g2/banded.jsonl`     |
| G3    | `unit_assignment`   | `g3/units.jsonl`      |
| G4    | `selected_item`     | `g4/selected.jsonl`   |
| G5    | `candidate`         | `g5/candidates.jsonl` |
| G6    | — (runlog only)     | —                     |
| G7    | `exercise`          | `g7/exercises.jsonl`  |
| G8    | `baked_clip`        | `g8/clips.jsonl`      |
| G9    | `pack_row`          | `g9/pack-rows.jsonl`  |

Nine records over ten stages: **G6 emits none**. It validates G5 candidates in place and
writes a runlog entry, which is what a downstream validator reads to learn that G6 ran
and what it concluded.

Three properties make it a contract rather than a suggestion:

1. Every schema is `additionalProperties: false`. A lane cannot smuggle a field past a
   boundary and have the next lane quietly depend on it.
2. Records are validated on **write and on read**. Validating only on write trusts that
   every writer went through the module — the assumption that fails the first time
   somebody hand-edits a `.jsonl` to debug something.
3. `contract_digest()` hashes the whole set and `tests/test_artifacts.py` pins it.

**Changing a schema is allowed.** Update `FROZEN_CONTRACT_DIGEST` in the same commit, and
say so here, because every other lane reads these shapes.

### Answer and source boundary — P2 repair contract, 2026-09-12

This contract extends `selected_item` and `candidate` with `accepted_alternates`.
It is an array of unique, nonblank course-language strings. These are the only optional
fields in the closed record schemas: **absence on existing records means no authored
alternates**. New G4/G5 writers emit `[]` when there are none. Consumers read with
`record.get("accepted_alternates", [])`, and must not drop a present set. `null`, a
string in place of an array, duplicate strings, and authored rubric objects are invalid
at this boundary. G0–G3 and the pack database schema do not change.

The canonical sentence remains the source's `text`; English meaning remains its
`translation`. An alternate is an authored whole-sentence answer in `lang`, with the
same meaning and unit register. It is neither an English answer nor a preferred
replacement. The JSON schema checks shape, not semantic equivalence or language;
producers must establish those properties before publishing an accepted surface.

| Producer / consumer | Obligation                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G4                  | Emit `accepted_alternates: []` for corpus slots and gaps; an unfilled gap must not assert an alternate for a nonexistent source.                                                                                                                                                                                                                            |
| G5                  | Read authored `{text, backtranslation}` alternate entries; independently analyse each alternate against the same slot ledger, language, register and budget as the canonical text. Carry only the explicit surface strings after those checks. The raw authoring format is not the inter-stage format.                                                      |
| G6                  | Independently apply every configured language engine and the recorded meaning rubric to each alternate. A canonical pass cannot stand in for an alternate pass. Apply the same reject/discard/resample policy; downstream selection reads the final post-G6 accepted flags.                                                                                 |
| G7                  | Use the canonical surface first, then validated authored alternates only for whole-sentence English-to-course-language translation (`reverse_translate`). Do not copy this set into `translate` (course-language-to-English), cloze, word-bank, transcription, or speaking contracts. Those shapes need their own explicit answer evidence.                 |
| G9 / grader         | `exercise.accepted_answers[0]` is the canonical preferred surface, carried into `preferred_surface`; all remaining entries are non-preferred accepted forms. Preserve order and deduplicate without replacing index 0. Grading treats acceptance as a set. Never sort the array to determine preference or generate new alternates at runtime (INV-GRD-03). |

Adding, removing, or reordering non-preferred alternates is a presentation change:
keep the preferred surface and semantic item fields fixed so item ids and FSRS rows
remain stable (INV-PACK-41). No new ledger unit or token-counting rule is introduced;
existing ledger declarations and analyser output still govern each language
(INV-PACK-40). V6 remains responsible for every accepted answer's declared register
and the enumerated Japanese script variants (INV-PACK-08).

`exercise.source_sentence_id` already holds either a corpus G0 `sentence_id` or an
authored G5 `candidate_id`; it needs no companion source field. Candidate ids include
slot context, so consumers must not replace one with `sentence_id(lang, text)`, infer
identity from a preferred answer, or look up a different reserve candidate in its slot.

The shared `first_accepted_candidates(records, lang=...)` contract helper validates
rows, refuses mixed-language streams, and chooses the first row with `accepted: true`
for each `(unit_index, lesson_index, slot_index)` in input order. Later surviving rows
are reserves. G7, G9, validator population building, and sampling must call it over the
**same ordered post-G6 candidate stream**. Only chosen gap fills join the shipped
sentence population; shipping every accepted reserve biases provenance and review.

G7 writes the chosen `candidate_id` verbatim. G9 stores that row under the same id in
the pack sentence table, and sampling joins it to that exact candidate. Corpus sources
retain their G0 ids. Source-less synthetic lexeme or grammar exercises may use `null`;
a sentence-backed exercise must resolve to its exact source in the same language.
Missing or conflicting source joins must fail with the exercise/source id rather than
quietly becoming `unknown` provenance. Nullable schema shape alone cannot prove this
relational obligation; each consuming lane owns its executable join checks.

Migration: old G4/G5 artefacts remain readable with no alternates; new producers write
the field explicitly. Shared synthetic fixtures now do so. Rebuild G4 onward once the
producer changes land to obtain the new source population and audited alternate sets;
rebuild G7–G9 and redraw/review after any selection or semantic correction. An earlier
sample's scores do not describe the rebuilt population. This boundary change requires
no dependency installation, signature-key change, or database migration. The contract
digest is re-pinned in `tests/test_artifacts.py` in the same commit.

### Run directories

```
build/<lang>/
  runlog.jsonl        one provenance log, entries keyed by stage
  g0/ingested.jsonl
  g1/analysed.jsonl
  ...
```

Rooted at `<repo>/build` or `$COURSEKIT_BUILD_ROOT`. `build/` is in `.gitignore`: a run
directory is reproducible output and is never committed.

### The runlog

`coursekit/runlog.py`. What crossed a boundary is in the artefacts; what _happened_ at it
is here — tool and version, sources read, rows in/out/rejected, licences touched, and
free-form `notes` a validator reads.

It is load-bearing because the validators that decide whether a pack may ship run last
and need facts about the run that no row carries: whether a grammar engine existed for
this language (V8), which corpora were read and under what licence (V10, INV-PACK-13),
what codec and bitrate the bake used (INV-PACK-15). **A validator that cannot tell
"clean" from "did not run" reports the same green either way.**

Two rules: `require_successful()` raises rather than returning a default, so a lane that
runs G7 before G4 finds out at the first line instead of producing exercises over an
empty ledger; and a **failed** stage still writes its entry, because a missing entry and
a failed entry send a reader to different places.

---

## 3. Registries — how a lane lands a stage

Nothing in `cli.py` or `commands/` knows what a stage does. A lane adds a module:

```python
# coursekit/stages/select.py
from ..stages import StageContext, StageResult, register_stage


@register_stage("g4", reads=("analysed_sentence", "unit_assignment"), writes=("selected_item",))
def select(ctx: StageContext) -> StageResult: ...
```

Discovery imports every module in the package at first lookup. Same shape for
`validators/`, `sources/`, `adapters/`, `engines/`, `tts/`, `exercises/`, `packbuild/`.

### Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | ok                                                                      |
| 1    | usage — unknown language, unknown stage or validator id                 |
| 2    | the verb exists, the stage or validator behind it is **not registered** |
| 3    | a required input or dependency group is absent                          |
| 4    | a registered stage or validator ran and failed                          |

**2 is the one that matters.** `coursekit build es` with nothing registered exits 2 and
names every missing stage. A 0 there would produce no pack, say nothing, and read as a
fast build — and the artefact downstream is a file a learner installs.
`test_exit_two_is_not_vacuous` proves it both ways: 2 empty, 0 full, 2 again with one
stage pulled back out, so the rule cannot rot into something that is true only because
nothing is registered yet.

### The no-literal rule

Every constant lives in `coursekit/config/`: `base.py` for what more than one stage
shares, `config/<stage>.py` for what exactly one stage tunes. Those per-stage files are
**empty on purpose** — one per lane, so two lanes never edit the same file to add a
threshold. `tests/test_cli.py::test_no_constant_lives_outside_config` walks the package
with `ast` and fails on a violation, with a falsifier beside it so the walker cannot pass
by walking nothing.

---

## 4. The es-mini fixture

`tests/fixtures/es-mini/` — 200 **original** es/en pairs written for this repository (not
from Tatoeba, OPUS, Cervantes or Duolingo), a surface-form frequency list, a spaCy lemma
map and 348 banded lemmas. It exists so a wave-2 lane can build and test without its
upstream. Every derived file is recomputed by the tests in plain Python; the lemma map
has its own spaCy-gated test, so a model bump fails there rather than silently
re-partitioning the ledger.

160 rows are CC0-1.0 and 40 are CC-BY-4.0 with an attribution owner. Both grants are real
(the text is original) and the split is deliberate: a uniformly CC0 fixture would let an
**INV-PACK-17** attribution bug pass every test in the suite. See its `README.md`.

---

## 5. Ten stated constants that are wrong

`deep/10`'s adversarial pass returned **REFUTED**. These are encoded in
`config/base.py` with the review id at the row, and asserted in `tests/test_artifacts.py`,
so a lane that reads the spec instead of the code gets a failing test rather than a
plausible bug.

| Id  | The spec said                                 | Actually                                                                                                                                                                 |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | LanguageTool ja: spell-check only, no grammar | **735 XML grammar rules, no spell checker** — the exact inverse. The "spell checking only" sentence is about Norwegian. V8 records `spellcheck_engine: none`.            |
| R2  | NLLB/CCMatrix: no licence, oracle only        | NLLB v1's legacy page states **ODC-By 1.0**. Kept oracle-only anyway (ODC-By covers the database, not each crawled sentence — plan risk 2), but for a stated reason now. |
| R3  | `sentences_cc0.tar.bz2`                       | **`sentences_CC0.tar.bz2`** — uppercase. Lowercase 404s.                                                                                                                 |
| R4  | The CC0 subset "shrinks the pool"             | It **eliminates** es/de/ja: 2,266 B / 1,852 B / 228 B compressed. French only.                                                                                           |
| R7  | Piper covers `ja`                             | Its one ja voice is **CC BY-NC-SA** — the same NC conflict that cut TED2020. Kokoro is the ja path; Piper is de only.                                                    |
| R8  | JParaCrawl: 25.7M ja pairs, no verdict        | **Non-commercial by default** ("contact NTT for commercial use"). `forbidden`.                                                                                           |
| R9  | hermitdave: 69 language directories           | **62**.                                                                                                                                                                  |
| R10 | `output_config.effort` for the re-rank        | `effort` **errors on `claude-haiku-4-5`**, which is still on the `thinking`/`budget_tokens` shape. Per-model request shapes, never one constant.                         |
| R13 | 35-40 MB audio bank per language              | Arithmetically impossible at ~8,000 utterances. **Re-declared at 120 MB**, Opus 20 kbps, stated codec and transcode.                                                     |
| R14 | Bake cost covers the course                   | It counted **lessons only**; Stories and Radio ride the same budget. INV-PACK-15 asserts all three pipelines.                                                            |

Two more that change where a decision lives: **R23** — the shipped CEFR label is attached
to **sections**, which is a G3 curriculum output, not the per-lemma G2 lookup CEFRLex
provides; and **R24** — the reference product marks a one-character typo fully wrong with
no grace, so an exercise's enumerated `accepted_answers` set **is** the entire tolerance
budget, and an omission is an unrecoverable wrong answer rather than a degraded one.

---

## 6. Licence posture

| Verdict       | Means                                                             | Sources                                    |
| ------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| `shippable`   | text may appear verbatim in a pack                                | Tatoeba, hermitdave (derived ordering, SA) |
| `oracle_only` | may inform frequency, perplexity and alignment; **never** shipped | NLLB, OpenSubtitles, CCMatrix, CEFRLex     |
| `forbidden`   | must never enter the ledger at all                                | TED2020, JParaCrawl                        |

`forbidden` is refused **at ingest**, not filtered at package time: filtering later leaves
the text in every intermediate artefact. That is what INV-PACK-13 means by "before G0
reads a byte", and the invariant registry calls it the only invariant whose failure
cannot be fixed after release.

---

## 7. What this lane did not build

`p2-deps-scaffold` is dependencies, contracts and wiring. Every stage and every validator
is unregistered, which is why `coursekit build es` exits **2** today. The wave-2 lanes
register them; nothing in `cli.py`, `commands/`, `artifacts.py`, `runlog.py` or
`inputs.py` needs to change for that to work.
