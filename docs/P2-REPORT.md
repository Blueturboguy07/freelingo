GATE: TBD-GATE

# P2 — Spanish pack v0: the integration report (round 3)

Repository: <https://github.com/Blueturboguy07/freelingo> (public, AGPL code / CC BY-NC-SA packs)
Integrated on `main` — the integrator works the main checkout and is the only task that
pushes, which is how rounds 1 and 2 ran too, so there is no `p2r3/integrate` branch.
Rounds 1 and 2 are kept verbatim as `docs/P2-REPORT-round1.md` and
`docs/P2-REPORT-round2.md`; this file replaces their verdict and repeats none of their
numbers except where a number is unchanged and says so.
Written at the P2 founder checkpoint (plan §The build workflow, step 5 → 6).

**EVIDENCE RULE** (plan §Verification): only CI produces artefacts. Everything labelled
_corroboration_ below was produced on this Mac and is not evidence. The gate is GREEN
only if `pack-ci`'s four jobs all **ran** and all **passed**; a skipped pack job reads
green and proves nothing (`docs/ci.md` §"the job that was green because it never ran").

## What was merged

Six branches were in the queue. **Five existed and were merged**, one at a time,
`--no-ff`, with `pnpm test` and `uv run pytest` re-run after each. `p2r3/deps-contract`
had already been merged and its handoff discharged by the previous integrate pass, whose
four commits are on `main` ahead of this round (`52f411a`, `d73d295`, `61bc272`,
`b9a68eb`).

| #   | Branch                      | Tip       | Merge commit                      | Textual conflicts |
| --- | --------------------------- | --------- | --------------------------------- | ----------------- |
| 0   | `p2r3/deps-contract`        | `52f411a` | already on `main`                 | —                 |
| 1   | `p2r3/lemma-reachability`   | `b8e2900` | `796d412`                         | none              |
| 2   | `p2r3/gapfill-lesson1`      | `31885ce` | `366565f`                         | none              |
| 3   | `p2r3/expand-bake-package`  | `f80d556` | `3740196`                         | none              |
| 4   | `p2r3/validators-ci-loader` | `5f8bd57` | `553be5f`                         | none              |
| 5   | `p2r3/provenance-docs`      | `ca76cce` | `1b2ad66`                         | none              |
| 6   | `p2r3/reviewer-sample-300`  | `a4e7f8b` | **not merged — nothing to merge** | —                 |

**No textual conflict in any of the five.** `git merge-tree` over each branch against
`main` reported none before the queue ran and none appeared inside it. Every defect below
is a **semantic** conflict or a thing only a real run could find: each branch was green
alone, and three of the four defects were found by a test one lane wrote against a state
another lane changed.

### `p2r3/reviewer-sample-300`

The seventh branch exists and carries **no commit of its own**:

```
$ git log --oneline --no-merges p2r3/reviewer-sample-300 \
      --not p2r3/lemma-reachability p2r3/gapfill-lesson1 p2r3/expand-bake-package \
           p2r3/validators-ci-loader p2r3/provenance-docs
(nothing)
```

Four merge commits of its sibling lanes, and `content/es/review/scores.jsonl` at **0
bytes**. Its own worktree was still running `coursekit build es` when this integration
finished, on a scratch branch (`p2r3/sheet-draw-scratch`) that had just merged
`p2r3/lemma-reachability` — so it is walking into B19 as well.

**And it cannot finish this round, for a reason that is not lateness.** `coursekit sample
es` draws 300 items from G7's exercises; G5 exits 4, so there are none, and the command
refuses rather than drawing from nothing ("_Drawing from nothing would produce an empty
sheet and a defect rate of 0%_"). The 300-item sheet, the agent reviewer's scores, the
measured wrong-item rate and therefore the whole of founder ruling B3's automated half are
downstream of B19. Nothing was merged and nothing was lost.

## The defects this integration found

Five. The first three are the classes the brief predicted — a lane green alone against a
state a sibling lane changed — and the first two were each found by a test the _other_
lane had written on purpose. None of the five would have been visible in any branch's own
CI.

### 1. G7 expanded the LAST accepted candidate; G5 fills the slot with the FIRST

`p2r3/gapfill-lesson1` authored `content/es/candidates/u01-l01.jsonl` (180 rows, 9 slots,
28 distinct texts) against a tree where founder ruling **B9(a)** had not landed, and left
a canary test saying so by name:
`test_the_pinned_lemmatiser_still_has_not_absorbed_the_prenominal_table`, whose failure
message reads "delete `PRENOMINAL_BUENO` and this test", not "the adapter regressed".
`p2r3/lemma-reachability` landed B9(a). The canary fired, as designed — and so did a
second test, which is the one that mattered.

With the adapter's lemma-normalisation table in place, three greetings that were
out-of-vocabulary rejects come **into** `u1/l1`'s five-lemma window. Measured on `main`
after the two merges, with the pinned `es_core_news_md` through the registered adapter:

```
s0 reserved=['hola']   in-window=4  G5 fills with 'Hola.'
   all in window: ['Hola.', 'Buenas noches.', '¡Buenas tardes!', 'Buenos días, buenas tardes.']
s1 reserved=['bueno']  in-window=4  G5 fills with 'Buenos días.'
s2 reserved=['día']    in-window=4  G5 fills with 'Hola, buenos días.'
s3 reserved=['tarde']  in-window=4  G5 fills with 'Buenas tardes.'
s4 reserved=['noche']  in-window=4  G5 fills with 'Hola, buenas noches.'
s5..s8 reserved=[]     in-window=4  Buenas. / Hola, buenas tardes. / Hola, buenas. / Buen día.
```

G5 does not accept one row per slot. It measures every authored row against its five
reject axes, marks each `accepted` independently, and the **fill** is the first accepted
row in shard order (`slot_filled`). `g7_expand._load` built its map with
`candidates[key] = row`, which is **last**-wins. So at `s0` G5 accepted four rows,
reported `Hola.`, and G7 would have shipped `Buenos días, buenas tardes.` — a word list,
in the lesson that teaches `hola`. The learner met a different sentence from the one the
runlog named, and nothing in either stage said so.

`s1 … s8` agreed only because the `duplicate` axis had eaten those same three texts by
the time the second slot was measured. That is ordering luck, not a property — and it is
why the defect survived a lane that was green alone.

**Fix**: `candidates.setdefault(key, row)` in `g7_expand._load`. One line, no new field on
the frozen `CANDIDATE` contract (the deps lane owns that), and it holds for whatever G5
accepts because `write_records`/`read_records` preserve order. Pinned by
`test_the_slot_is_expanded_from_the_candidate_G5_filled_it_with_not_the_last_one`, and the
falsifier was measured rather than asserted: reverted to last-wins, the cloze's accepted
answer becomes `caliente` instead of `libros`.

Three of the gapfill lane's tests were rewritten rather than deleted, because each was
pinning something true at its own sha: the canary now asserts the post-B9(a) measurement
(`Buenos días.` → `['bueno','día']`, `Buenas.` → `['bueno']`, `Hola, buenas tardes.` →
`['hola','bueno','tarde']`, `Buenas noches.` → `['bueno','noche']` — **both** traps
closed, including the `PROPN`-plural one B9 as written does not mention); the
exactly-one-in-window test now walks G5's own order and asserts the row G5 _fills_ with is
in-window and carries the reserved lemma, which is the property the count was a proxy for;
and the bare-blank cloze test was calling `_gapped(tokens, index)` before the expand lane
gave it a `slot`, so it now cuts the gap out of the original text and the hazard renders
`____.` rather than `____`. `PRENOMINAL_BUENO` is deleted: a second copy of a
normalisation table inside a test is the second source of truth INV-PACK-40 exists about.

### 2. The rubric scored a sixth dimension `read_scores` would have thrown the whole sheet away for

`content/es/review/RUBRIC.md` (from `p2r3/provenance-docs`) scores **six** dimensions.
`config/sample.py::REVIEW_DIMENSIONS` (in `p2r3/validators-ci-loader`'s file lane)
declared **five**. `sample.py::read_scores` raises `ScoreError` on any `dimensions` key
outside that tuple and the caller turns it into exit 4 — so the mismatch does not produce
a slightly wrong wrong-item rate, it produces **no rate for the whole sheet**, including
the five text dimensions that were scored correctly.

Neither lane could fix it: the rubric's lane does not own `config/sample.py` and the
constant's lane was not asked for the dimension. The provenance lane did the next best
thing and filed it as a cross-lane contract in
`docs/owned/p2r3-provenance-docs.json` — the exact spelling, the failure mode, and a
`note:`-prefixed fallback for a scorer working in the gap. It is the one contract in that
file marked "THIS IS THE ONE CONTRACT IN THIS LANE THAT CAN BREAK SOMETHING", and the
reviewer lane was already drawing against the rubric when the queue ran.

**Fix**: `accent_consistency` is the sixth member of `REVIEW_DIMENSIONS`, with the
rubric's spelling for the rubric's reason — `accent` alone reads as the orthographic
diacritic in a Spanish file, and the two-word snake form is precedented by `answer_set`.
Founder ruling **B6** is what makes it load-bearing: Kokoro declares no regional accent,
the manifest therefore states `accent_claim: unverified`, and the reviewer pass is the
only check on the accent that exists. Declaring it cannot move a published rate on its own
— RUBRIC.md gives an accent-only failure the `awkward` verdict and `DEFECT_VERDICTS`
counts only `wrong` — and it still cannot be **scored** from a drawn sheet, because
`SampleItem` carries no clip reference and no voice role (**B18**, open).

### 3. B9(a) and B9(c) moved the ledger, and 9,269 of 9,812 authored rows went stale

The third predicted class — _a slot set that changed under an authored shard_ — and the
largest thing this round found. Neither lane did anything wrong: B9(a) put a
lemma-normalisation table in the G1 adapter, B9(c) made G3 fail the build on a target
lexeme the pinned lemmatiser cannot reach, and satisfying (c) meant the curriculum had to
declare the lemmas the model actually produces. Both are right. Together they change
which corpus sentences fit which lesson, so G4's gap list is a different SET:

```
G3   990 authored / 928 assigned / 63 deferred   ->   952 / 945 / 7, unreachable_lexemes []
G4   1,584 slots / 1,094 filled / 490 gaps / 0.3093   ->   1,584 / 1,090 / 494 / 0.3119
```

(Both G3 lines are from this repository's own runlog. The lemma-reachability lane's
`curriculum.yaml` header reports the reachability count behind it — 92 of 990 unreachable
before its change, 0 of 952 after — which is its measurement, not one repeated here.)

```
18 authored slots no longer exist            363 rows
22 gap slots appeared with no author           0 rows
463 of 472 surviving slots moved digest    9,269 rows of 9,812
```

`coursekit build es` stopped at G5 on the first of those, and **its message misdiagnoses
this case**: it blames the B1b per-unit-vs-global lesson keying, a real bug once, when in
fact the slots were correctly keyed and then ceased to exist. Worth fixing when somebody
is next in that file — a check with two causes should not name one.

The brief was regenerated too — `coursekit gaps es`, 494 slots, 9,880 candidates
required, 26 verbless slots, digest `e041abe57f6f0836`, **0 rows differing from CI's
artefact**. It is a derived snapshot that G5 never reads, but it is the authoring input,
and a 490-slot brief beside a 494-slot gap list is a trap for whoever takes B19.

**Fix**: founder ruling B9's own last clause, _"Re-key only rows whose `ledger_digest`
changes"_, as `tools/coursekit/scripts/rekey_authored_candidates.py` — dry-run by
default, `rekeyed: {from_digest, from_new_lemmas, g4_run_id, at, why}` written once per
row and never overwritten, and the 363 rows whose slot is gone moved to
`content/es/candidates-orphaned/` outside the glob G5 reads rather than nudged onto a
neighbouring slot (INV-PACK-10). It is idempotent: a second dry run over the re-keyed
tree reports 9,449 rows already correct and nothing to orphan.

Re-keying does not launder a stale row, and this is the part worth being precise about.
`stale_ledger` is a fingerprint — "were you written against THIS window?" — and everything
substantive in `_axis` runs after it: `out_of_vocabulary` re-lemmatises the text against
the new `known | new`, `new_lemma_budget` counts introductions against the new reserved
set, then `length` and `duplicate`. The measurement proves it:

```
stale_ledger      9,269  ->  0
out_of_vocabulary  (not reached)  ->  283   rows the NEW window rejects, by name, in the census
465 of 494 slots filled
```

What is left is authoring, not a re-key: **22 slots with no candidate at all** — 440
candidates to write, at the over-generation floor of 20 each — and **7 slots with twenty
or more and no survivor**, which need fresh texts against the new window rather than a
re-key. And one contradiction the new gap list
contains: `u1/l3/s3` is reserved to teach the lemma `usted`
(`content/es/curriculum.yaml:420`) in a course whose register is `tu`, where V6 treats an
`usted` marker in an accepted answer as **blocking** — the rule 218 rows were rewritten
for at the fix round. No candidate can both teach that slot and pass V6. `docs/P2-BLOCKERS.md`
§B19 carries every list, every window, and the three costed ways out. None is taken here:
authoring 440 candidates inside an integration pass is what produced the starved-slot
defect at the last one.

### 4. Four documents reported a build state that the merge queue made false

Not a code defect, and it is here because the lane that wrote the prose is the one that
caught it: `docs/owned/p2r3-provenance-docs.json` carries an `integratorMustRemeasure`
list — every sentence of its prose that reports build state, why it goes stale, the
command to re-measure it with, and the edit expected. That is the right shape for prose
measured at a sha, and it is the reason this section is three paragraphs and not a defect
hunt.

Re-measured on `main` after the queue: **founder ruling B6 is 5/5 built, not 3/5.**
`content/es/cast.yaml` has no `locale:` key at all (`:12` `language: es`, `:23`
`accent_claim: unverified`), `config/g8.py:61` is `ACCENT_CLAIMS = ("unverified",)` with
no `verified` member, `packbuild/manifest.py:244` writes `"accentClaim"` into the
manifest's `audio` block and `:325` refuses a value outside that tuple, and
`content/es/audio-manifest.json:4` carries it. The B6 summary row, heading, five-parts
sentence and two rows of its part table are updated; the lane's own notes are kept as
history beside what superseded them, because the general lesson is worth more than the
tidy table. In `docs/pack-provenance.md` the accent half of the manifest gap is closed and
the `PROVISIONAL`-beside-`defectRate` half is still future — they came apart here, which
is what that paragraph said to do.

`tools/coursekit/tests/test_sample.py::test_the_docs_do_not_claim_the_note_already_appears_where_it_cannot`
is green after the edits. It is the test that fails when this kind of re-measurement
overstates what shipped, so it is the one worth naming.

### 5. A guard that noticed the re-key, which is what a guard is for

`test_the_lesson_one_shard_ships_none_of_the_eleven_word_lists` pins the number of
word-list rows outside `u1/l1` and its own message reads "if the number went DOWN a lane
cleaned up; if it went UP, a lane is padding with them again". After the re-key it read
**201, not 217** — because 16 of those rows were keyed to slots that stopped existing and
went to `content/es/candidates-orphaned/` with the rest of the 363.

The number is updated to 201 and a second assertion was added:
`len(in the shards) + len(orphaned) == 217`, measured, so a word-list row **deleted**
rather than orphaned now fails the test where before it would have looked like a cleanup.
That is the whole difference between a pinned number and a pinned number with an
invariant behind it.

## The pipeline, measured

Two runs of the same pipeline over the same content:

- **CI, `pack-ci` / `build-es`** — the only run that makes evidence. See §CI.
- **This Mac, 2026-09-12, 16:07–16:21 UTC** — _corroboration_. A LanguageTool 6.6
  sidecar (Java 22.0.1) on `http://localhost:8081`, the `align` and `tts` groups
  installed (torch 2.14.0, `kokoro-onnx`), the pinned Kokoro weights at
  `~/.kokoro` (353,753,249 B). Unlike every previous round's local run there is **no
  diagnostic shard and no runtime override**: the committed content is what ran, because
  B9(b) landed in `config/g5.py` and lesson 1 has 180 committed candidates.

### G0 — ingest

```
399,896 read · 123,693 rejected · 276,203 written   (39 s)
per corpus: tatoeba 180,862 + nllb 95,341 · max_pairs 200,000 · NFC · window [3, 12]
rejected: too_long 103,510 · duplicate 11,688 · too_short 7,871 · register 321
          profanity 301 · untranslated 2
licences: tatoeba CC-BY-2.0-FR shippable · nllb ODC-By-1.0 oracle_only
```

**276,203 for the third round running**, from an independently streamed download on a
third day. The corpus is stable at this cap and that number is now load-bearing: it is
what lets a gap list from one day be compared with a gap list from another.

### G1 — analyse

```
276,203 read · 3,921 rejected · 272,282 written   (7 m 6 s)
es_core_news_md-3.8.0, spaCy 3.8.16, adapter self-test ok
mean content words per sentence 3.9310 · outside_length_window 3,921 (1.42%, cap 5%)
```

### G2 — band

```
50,000 surface forms read · 126 rejected · 33,681 ledger lemmas   (1 m 10 s)
ELELex (CEFRLex) 14,290 entries · 7,508 lemmas covered
frequency: hermitdave es_50k.txt · band_by_decile agreement 0.38
```

`33,681` against the frozen build's `33,685`: four fewer, which is B9(a) collapsing four
prenominal spellings onto `bueno`.

### G3 — solve curriculum, and this is where the round's big number is

```
33,681 read · 7 rejected · 30 units · 176 lessons   (1 s)
lexemes authored 952 · assigned 945 · deferred 7 · backfilled 0
unreachable_lexemes []          <- B9(c)'s gate, green on the real curriculum
new_lemmas_per_lesson 5.369 · cefr_checked false
```

The frozen build was **990 authored / 928 assigned / 63 deferred**, with 92 of 990
unreachable by the pinned lemmatiser and counted as "deferred" — the same bucket as a
good lemma the corpus happened not to contain. So the course used to teach 62 fewer
things than it said, silently. It now teaches what it declares, and `deferred` is 7 real
frequency misses (`frutería`, `tutear`, `transbordo`, `recreo`, `cucharilla`, `bautizo`,
`romería`).

That is the win of this round, and it is also the cause of its blocker: see §the defects,
3, and B19.

### G4 — select

```
276,203 read · 95,341 not shippable · 1,584 slots · 1,090 filled · 494 gaps   (1 m 21 s)
gap_fraction 0.3119 · cross_unit_repeats 0 · ledger_yield 0.1452 (predicted 0.05-0.15)
```

Against the frozen brief's 1,094 filled / 490 gaps / 0.3093. **The slot SET differs by
more than the counts**: 18 slots gone, 22 appeared.

### G5 — gap-fill, after the re-key

```
9,449 read · 9,449 written · 3,646 rejected · reject_rate 0.3859   (15 s)
stale_ledger 0 · out_of_vocabulary 283 · duplicate 2,965 · length 398 · new_lemma_budget 0
494 gap slots · 465 filled · orphan_authored_slots []
22 thin slots (0 candidates each) · 7 unfilled (20+ candidates, no survivor)
g5 failed: 22 slot(s) authored below the over-generation floor of 20
```

Before the re-key the same tree stopped one check earlier, on the 18 orphans. The
`duplicate` majority is unchanged in character from round 2 — a lesson window admits a few
hundred sentences in total, so a slot's twenty are its fresh candidates plus texts already
accepted earlier in the unit.

### G6 – G9, `validate`, `sample`, `sign` — not reached on this Mac

G5 exits 4, so nothing downstream ran here this round. What is known about them comes from
the lanes' own live runs, is recorded in `docs/owned/p2r3-expand-bake-package.json`, and
is **corroboration at one remove** — a different tree, with a diagnostic shard and a
runtime override neither of which exists any more:

- **G7** over the whole committed course exited 0 for the first time: 6,100 exercise
  records, all 16 P2 shapes, INV-PACK-07 / INV-PACK-50 / V5 all 0 blocking.
- **G8** over units 1–3: 125 clips, 580,184 B measured on the shipped Opus files, engine
  `kokoro` / `model-files-v1.0`, −16.0 LUFS ±0.5 on the decoded file.
- **G9** over units 1–3: `pack.sqlite` 5,509,120 B, 617 item ids, `ledgerUnit` declared
  once, provenance 16.93% corpus / 83.07% machine-authored, `audio.accentClaim
"unverified"`.
- **`coursekit validate es`** over that pack: **11/17 green, 0 unregistered, 0 skipped,
  210 blocking, 48 warnings** — V9 171 in-unit sentence reuses, V6 13 register, V11 13
  difficulty falls, V2 8 new-lemma budget, V4 4, V12 1 glyph. None of the 210 is G7/G8/G9's.
  B17's ruling has landed since that run, so the 13 V11 findings split by section
  boundary now; the other 197 are unchanged and none of them is measured on this tree.
- **the full-course bake is outside `build-es`'s budget**: 2,898 clips at ~15/minute is
  about 3 hours against a 90-minute job. INV-AUD-08 is why it is slow (loudness measured
  on the decoded file, re-encoded until it lands inside half the tolerance), so the fix is
  a budget, a cache keyed on the re-bake key, or a bake job of its own — not a faster loop.

## The gate, item by item

The P2 gate row of the plan, plus every command the brief named. `ci.yml` numbers are
CI's; anything marked _corroboration_ is this Mac's.

| Gate item                                                                                | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Where                 |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `pnpm install --frozen-lockfile`                                                         | **GREEN** — no lockfile diff; the deps lane needed no new package this round                                                                                                                                                                                                                                                                                                                                                                                     | ci.yml                |
| `pnpm lint`                                                                              | **GREEN**                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ci.yml                |
| `pnpm typecheck`                                                                         | **GREEN**                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ci.yml                |
| `pnpm format:check`                                                                      | **GREEN**                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ci.yml                |
| `pnpm invariants:check`                                                                  | **GREEN** — 424 ids, digest matches the corpus                                                                                                                                                                                                                                                                                                                                                                                                                   | ci.yml                |
| `pnpm test`                                                                              | **GREEN on the final sha** — 1,316 passed / 6 skipped on `859f3fb`, first attempt. It FAILED on both attempts of `86f2430` with the same 1,316 passing and `Timeout calling "onTaskUpdate"`: an intermittent reporter RPC timeout, recorded as B20 with all three attempts                                                                                                                                                                                                                                                                                                                                             | ci.yml                |
| `pnpm test:falsify`                                                                      | **GREEN** — 280 committed falsifier cases                                                                                                                                                                                                                                                                                                                                                                                                                        | ci.yml                |
| `pnpm test:coverage-map`                                                                 | **GREEN** — no unowned id, no id claimed twice                                                                                                                                                                                                                                                                                                                                                                                                                   | ci.yml                |
| `uv run ruff check .` + `uv run pytest`                                                  | **GREEN** — ruff clean; pytest all passed                                                                                                                                                                                                                                                                                                                                                                                                                        | pack-ci `coursekit`   |
| `pipeline-ready` — every stage and validator registered                                  | **GREEN** — 10/10 stages, 17/17 validators; both pack jobs live                                                                                                                                                                                                                                                                                                                                                                                                  | pack-ci               |
| `uv run coursekit build es` (G0–G9)                                                      | **RED — G0–G4 pass, G5 exits 4** on the 18 orphaned slots (`86f2430`, pre-re-key) and on the 22 unauthored ones (post-re-key, this Mac). B19                                                                                                                                                                                                                                                                                                                     | pack-ci `build-es`    |
| `uv run coursekit validate es` → exit 0                                                  | **DID NOT RUN** — `validate-es` skipped on `needs: build-es`. `pipeline-ready` was green, so the skip is a real dependency and not the green-because-skipped failure mode                                                                                                                                                                                                                                                                                        | pack-ci `validate-es` |
| V1–V4 = 100%, zero violations \[INV-PACK-06]                                             | **NOT PROVEN** — V1–V4 need G7's artefact and G5 exits 4                                                                                                                                                                                                                                                                                                                                                                                                         | —                     |
| V5–V12, F1–F5: the report names every validator that ran                                 | **NOT PROVEN this round** — the suite's last real run was the expand lane's, on a tree that no longer exists: 11/17 green, 0 unregistered, 0 skipped, 210 blocking, 48 warnings                                                                                                                                                                                                                                                                                  | —                     |
| V8 records the engines actually used \[INV-PACK-14]                                      | **PROVEN at one remove** — `languagetool/6.6/es` for grammar and spellcheck, `agent_rubric/v1` for backtranslation, `perplexity none`, `degraded_to grammar_only`; the sidecar step is green in CI on this sha, the G6 run is not on this tree                                                                                                                                                                                                                   | —                     |
| zero UNRESOLVED licences; attribution owner on every required row \[V10, INV-PACK-13/17] | **NOT PROVEN** — V10 needs the pack                                                                                                                                                                                                                                                                                                                                                                                                                              | —                     |
| audio manifest codec=opus, 20 kbps, ≤ 120 MB on real bytes \[INV-PACK-15]                | **NOT PROVEN on real bytes for the whole course.** Units 1–3 measured 580,184 B over 125 clips (expand lane, another tree); `content/es/audio-manifest.json` declares `codec opus`, `bitrate_kbps 20`, and charges 98,000,000 B of the 120,000,000 B budget across lesson + stories + radio. A declaration, and a third of the bank                                                                                                                              | —                     |
| manifest declares `ledger_unit=lemma` exactly once \[INV-PACK-40]                        | **GREEN as a source property** — the grep gate over `tools/coursekit` has no offenders; the manifest half needs a pack                                                                                                                                                                                                                                                                                                                                           | —                     |
| every missable item carries ≥ 2 authored forms \[INV-PACK-07]                            | **NOT PROVEN this round** — 0 blocking over 6,100 records on the expand lane's tree; G7 has not run on this one                                                                                                                                                                                                                                                                                                                                                  | —                     |
| the built pack loads in `packages/core`'s loader                                         | **DID NOT RUN, and the mechanism was verified instead.** The step lives in `validate-es`, which skipped. Locally the file **skips** with `FREELINGO_REAL_PACK` unset (1 file / 6 tests skipped) and, with it set to a path that does not exist, **all 6 tests fail** — `ENOENT: … /nonexistent/manifest.json` — rather than skipping. So the step cannot be green on a missing pack, which is the property it exists for; it has simply never had a pack to open | pack-ci `validate-es` |
| `uv run coursekit sample es` — 300 items                                                 | **BLOCKED by B19** — `sample` draws from G7's exercises and refuses to draw from nothing                                                                                                                                                                                                                                                                                                                                                                         | —                     |
| wrong-item rate, its reviewer kind, and the provisional note                             | **UNMEASURED as a number.** `content/es/review/scores.jsonl` is 0 bytes, `wrong_item_rate` is `None`, `gate_passed()` false. B3's ruling stands: an agent-scored rate ≤ 2 % would pass, `reviewer_kind` would read `opus-agent-reviewer`, and the manifest and S001 card carry `PROVISIONAL (unreviewed by a paid native speaker)` verbatim. The reviewer lane is downstream of B19                                                                              | —                     |
| `uv run coursekit sign es`                                                               | **NOT PROVEN** — `sign` needs a manifest and G9 has not run                                                                                                                                                                                                                                                                                                                                                                                                      | pack-ci `build-es`    |
| `mutation.yml` nightly, non-gating                                                       | **NO SCORE EXISTS** — unchanged; Stryker times out in its dry run on an INV-DAT-04 property. Non-gating by ruling                                                                                                                                                                                                                                                                                                                                                | B7                    |

## CI

All three workflows ran on the integration sha **`86f2430`** — the merge queue plus the
first two integration fixes and the format sweep. The re-key (`2d16f5f`) and the blockers
(`a81b729`) landed after it, so **a second CI pass** ran on `859f3fb` and is quoted below.

"Round 2" in this file always means the second CI pass of this integration. The previous
phase round's report is `docs/P2-REPORT-round2.md` and is called that by name.

| Workflow         | Run                                                                    | Result                                                                                                 |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ci.yml`         | <https://github.com/Blueturboguy07/freelingo/actions/runs/34704497896> | **FAILURE on both attempts** — 1,316/1,316 tests pass, then `Timeout calling "onTaskUpdate"`. B20      |
| `pack-ci.yml`    | <https://github.com/Blueturboguy07/freelingo/actions/runs/34704497734> | **FAILURE at G5**, `validate-es` skipped on `needs:`                                                   |
| `native-e2e.yml` | <https://github.com/Blueturboguy07/freelingo/actions/runs/34704497731> | **CANCELLED** — three of four jobs green; the iOS job was killed by the second CI pass's push, not by a failure |
| `mutation.yml`   | nightly, non-gating                                                    | no score exists; B7                                                                                    |

### The second CI pass, on `859f3fb`

TBD-ROUND2



### `ci.yml` — red twice on one sha, green on the next, with every test passing throughout

```
Test Files  114 passed | 1 skipped (115)
     Tests  1316 passed | 6 skipped (1322)
    Errors  2 errors          <- attempt 1;  1 error on attempt 2
  Duration  227.31s (tests 604.56s)

Error: [vitest-worker]: Timeout calling "onTaskUpdate"
```

The reporter's RPC to the worker times out on a 227-second run. No test failed, on any
attempt. `docs/P2-REPORT-round2.md` met this once, re-ran the job, got green, and recorded
it as a flake. The brief's rule is to re-run once on the identical sha before calling a
failure a regression — that was done (`gh run rerun 34704497896 --failed`) and **attempt 2
failed the same way**, which looked like a deterministic failure. Then the second CI pass
on `859f3fb` **passed first time**, over an identical TypeScript tree.

| sha | attempt | result |
| --- | --- | --- |
| `86f2430` | 1 | FAILURE — 1,316/1,316 pass, 2 errors |
| `86f2430` | 2 (`--failed` re-run) | FAILURE — 1,316/1,316 pass, 1 error |
| `859f3fb` | 1 | **SUCCESS** — 1,316/1,316 pass |

So it is a flake, and what is worth recording is the hit rate rather than the existence:
**two consecutive failures on one sha do not mean a regression, and a re-run on the same
sha is not a reliable way to clear it** — which is precisely what the "re-run once" rule
assumes. Recorded as **B20** with all three attempts and the levers, and not fixed here:
the same suite is 26 s on this Mac against 227 s on the runner, so no fix could have been
measured before pushing it.

### `pack-ci.yml`

```
✓ pipeline-ready (which stages and validators exist)   10s
✓ coursekit lint + tests                               2m
X build-es (G0-G9, capped ingest)                      22m13s
- validate-es (V1-V12 + F1-F5)                         skipped (needs: build-es)
```

`pipeline-ready` green means both pack jobs were live, not skipped — the failure mode
`docs/ci.md` warns about is not in play. Every step of `build-es` before the build passed,
including `Sync nlp + lm + align + tts (locked)` and `Start the LanguageTool sidecar`
whose last line is the `MORFOLOGIK_RULE_ES` probe on a planted misspelling. Then:

```
16:12:53  g0  Ingest
16:13:50  g1  Analyze
16:29:02  g2  Band
16:31:47  g3  Solve curriculum
16:31:49  g4  Select
16:34:59  g5  Gap-fill
16:35:05  g5 failed: 18 authored slot(s) are not in G4's gap list: u1/l4/s3, u1/l4/s4,
          u1/l6/s2, u1/l6/s3, u1/l6/s4, u1/l6/s5, u4/l19/s4, u4/l22/s3, u5/l28/s6,
          u6/l35/s6, u9/l51/s5, u13/l73/s6, u13/l75/s5, u16/l95/s5, u17/l101/s4,
          u24/l137/s7, u25/l142/s3, u25/l144/s4.
##[error]Process completed with exit code 4.
```

**The same eighteen slots this Mac named, in the same order, on a runner that streamed the
corpus itself.** Defect 3 is CI-confirmed, not corroborated.

#### The artefact that settles it — CI-produced

`build-es` uploads `es-gap-brief-<sha>` on `always()`, so it survived the failure.
Downloaded and diffed against the committed brief and against this Mac's G4:

```
CI brief:  494 gap slots · digest e041abe57f6f08366f7a26939b1a9bc4d58b3ac40ca5fecd93fa71f00c6d971a
           ingested 276,203 · verbless_slots 26 · g4_status ok
vs this Mac's G4:      slots only in CI 0 · only local 0        <- the same 494 slots
vs the committed brief: only in CI 22 · only frozen 18
                        463 of the 472 shared slots carry a different ledger_digest
frozen digest e1dcba859bdfe9aa157b14d130d692bec1bf72041624b0921c0ea99733adfbbe
```

Two machines, two ingests, one gap list — and it is **not** the frozen one. That is the
whole of B19 measured by CI: the ledger moved, the gap set moved with it, and 9,269 rows
were keyed to windows that no longer exist.

Artefact: `es-gap-brief-86f243011bec2c4a067201acb6f9712a03e8674f` (35,723 B) on
<https://github.com/Blueturboguy07/freelingo/actions/runs/34704497734>.

**There is no `es-pack-<sha>` and no `es-build-<sha>`, and there cannot be**: both are
uploaded after the build, and the build exits 4 at G5. The gate asks for those two
artefact URLs and this round has neither.

### `native-e2e.yml`

```
✓ flows exist                                                8s
✓ INV-PLAT-02 — native trees are generated and reproducible  21s
✓ Android emulator                                           17m
X iOS simulator                                              CANCELLED
```

**The iOS job was cancelled, not failed**, and this is the hazard `docs/P2-REPORT-round2.md`
already named: `pack-ci` and `native-e2e` share a concurrency group with the branch, so
the push that carried the re-key (`2d16f5f` … `859f3fb`) killed a job that had been
running for 27 minutes. Recorded as a cancellation. The second CI pass below re-runs it on the
final code sha, which is the only honest way to get the iOS half back.

`flows exist` and `prebuild-determinism` are the two jobs that can lie cheaply and both
are green: `maestro test` over an empty directory exits 0, and two `expo prebuild` runs
agree up to a consistent renaming of Xcode object ids.

### Screenshots

One artefact from this round, CI-produced, downloaded with `gh run download 34704497731`:

**`e2e-86f2430…-android/screenshots/p0-db-path-p0-db-path.png`** (25,224 B) — the app's
**Diagnostics** sheet on an API 34 x86_64 `google_apis` emulator, Maestro 2.10.0. The
title is in Freelingo green over an off-white ground, and the rows read
`db-path file:///data/user/0/org.freelingo.app/files/freelingo-progress.db`,
`journal-mode wal`, `user-version 2`,
`packs-dir file:///data/user/0/org.freelingo.app/cache/packs/`, `packs-excluded true`,
`platform android`, `db-path-persistent true`, `pre-migration-backup none`, with a green
CLOSE at the foot. `report.xml` reads `tests="1" failures="0" time="15.921"`; `runner.txt`
carries `api_level=34 arch=x86_64 target=google_apis flows=1 maestro=2.10.0`.

There is **no iOS screenshot for this sha** because the job was cancelled mid-run. The
round-2 artefacts below carry both platforms.

**And there are no pack screenshots, as in round 2, because P2's product is a content pack
and not a screen.** The first surfaces that render any of it — S001's course card with
`{{n}}% machine-authored` and the measured wrong-item rate, S002's validator-report
summary, S137's About, S152's credits — are P3's and P4's. `docs/pack-provenance.md`
specifies their copy.

## Blockers

The live list is `docs/P2-BLOCKERS.md`, and this round **re-measured five of its rows**
rather than copying them: each had been written on a lane that could not see its
siblings' files, and each had gone stale in the same direction — done, and reported
undone. Where it stands on `main`:

| Id         | What                                                               | Kind                 | Status after this round                                                                                                                                             |
| ---------- | ------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1/B1a/B1b | the candidates, the empty ledger, the lesson numbering             | authoring + code     | **RESOLVED**                                                                                                                                                        |
| B2         | `pack-bake.yml` could not succeed on any dispatch                  | code                 | **RESOLVED** (deleted)                                                                                                                                              |
| B3         | the wrong-item rate is `None`, not 2%                              | **founder decision** | **DECIDED** — agent-scored gate; the rate is still unmeasured because the sheet is downstream of B19                                                                |
| B4         | `coursekit sample es --n 300` is not a spelling the CLI has        | docs                 | **RESOLVED**                                                                                                                                                        |
| B5         | S152 has validator F3 and no product-map row                       | **founder decision** | **DECIDED** — Surface 16; P4 builds it                                                                                                                              |
| B6         | Azure is dead; Spanish bakes on Kokoro                             | **founder decision** | **DECIDED, BUILT 5/5** — re-measured here                                                                                                                           |
| B7         | `mutation.yml` has never produced a score                          | pre-existing         | **NON-GATING by ruling**, still no score                                                                                                                            |
| B8         | `build-es` named no language engine                                | code (CI)            | **RESOLVED** — sidecar                                                                                                                                              |
| B9         | unit 1 lesson 1 cannot hold a sentence                             | **founder decision** | **DECIDED, BUILT** — (a)+(b)+(c) all on `main`; re-measured here                                                                                                    |
| B10        | 218 candidate texts were `usted` in a `tu` course                  | content              | **RESOLVED**                                                                                                                                                        |
| B11        | G6 read one candidates file and there are nine                     | code                 | **RESOLVED**                                                                                                                                                        |
| B12        | the gate's `validate --pack … --report …` spelling                 | docs                 | **RESOLVED**                                                                                                                                                        |
| B13        | `build-es` synced no `align` group                                 | code (CI)            | **RESOLVED**                                                                                                                                                        |
| B14        | a starved slot crashed G7 instead of failing by name               | code                 | **DECIDED, BUILT** — `StarvedSlot(LookupError)`; re-measured here                                                                                                   |
| B15        | G7 made word-bank tiles out of punctuation                         | code                 | **RESOLVED**                                                                                                                                                        |
| B16        | G7 looked a distractor up by surface                               | code                 | **DECIDED, BUILT** — writer + reader; re-measured here                                                                                                              |
| B17        | V11 sees mean difficulty fall across unit boundaries               | content + code       | **DECIDED, BUILT** — severity splits on the section boundary; re-measured here                                                                                      |
| B18        | the accent dimension B6 made load-bearing has nothing to listen to | code                 | **OPEN, measured** — `SampleItem` carries no clip ref and no voice role                                                                                             |
| B19        | B9(a)+(c) moved the ledger: 18 slots died, 22 appeared             | content              | **OPEN — the phase blocker.** Re-key done (`stale_ledger` 9,269 → 0); 22 slots need 440 candidates, 7 need fresh ones, `u1/l3/s3` reserves `usted` in a `tu` course |
| B20        | `ci.yml` fails with 1,316 of 1,316 passing                         | infrastructure       | **OPEN, measured** — `Timeout calling "onTaskUpdate"` twice on `86f2430`                                                                                            |

**B19 is the phase blocker and it is one question**: who authors the 29 slots, and does
`usted` stay a target lexeme? Everything else on this list is resolved, decided-and-built,
or non-gating. The three blocked gate items — `validate`, `sample`, `sign` — are all
downstream of it, and so is the whole automated half of B3.

Two rows are new and both were found by running the thing rather than reading it: B19 by
the pipeline, B20 by re-running a failed CI job as the brief requires.

## Disk

`df -h ~` before the build: **65 GiB free of 460 GiB (85% used)**. After it: **64 GiB**,
`df -g` agreeing at 64. Well above the 15 GB floor the brief names, so no cache was
cleared and `apps/mobile/ios/build`, `apps/mobile/android/build` and
`~/Library/Developer/Xcode/DerivedData/Freelingo-*` were left alone.

P0's target of ≥ 80 GB free is still unmet and nothing in P2 needed it. What this round
added locally and does not need again: `build/` 520 MB (the G0–G5 tree, gitignored),
`tools/coursekit/.venv` 1.1 GB (the `align` group's torch/transformers wheels), the
pinned Kokoro weights 353,753,249 B at `~/.kokoro`, and a LanguageTool 6.6 unpack in the
session scratchpad. CI carries its own copies and caches the Kokoro weights.
