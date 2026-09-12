GATE: RED

# P2 — Spanish pack v0: the integration report (round 3)

Repository: <https://github.com/Blueturboguy07/freelingo> (public, AGPL code / CC BY-NC-SA packs)
Integrated on `main` — the integrator works the main checkout and is the only task that
pushes, which is how rounds 1 and 2 ran too, so there is no `p2r3/integrate` branch.
Rounds 1 and 2 are kept verbatim as `docs/P2-REPORT-round1.md` and
`docs/P2-REPORT-round2.md`; this file replaces their verdict and repeats none of their
numbers except where a number is unchanged and says so.
Written at the P2 founder checkpoint (plan §The build workflow, step 5 → 6).

**The gate is RED, and for the third round the headline is a different thing.** Round 1
was red because ~18,200 authored sentences did not exist. Round 2 was red because the last
two stages had never seen the ones that did. **Those stages now work** — on the expand
lane's own tree G7 completed over the whole course, G8 baked units 1–3, G9 built the first
pack this project has ever made from real content, and `coursekit validate es` ran over it
(11/17 green, 210 blocking) — and none of that happened on `main`, because on `main` the
pipeline stops at **G5**: the content is keyed to a course that the phase's own founder
ruling changed underneath it.

B9(a) and B9(c) are right and they landed: the course now teaches what it declares
(`unreachable_lexemes []`, 945 of 952 lexemes assigned against 928 of 990 before). The
cost is that G4's gap list is a different SET — 494 slots, not the frozen 490, with 18
gone and 22 new — and **9,269 of 9,812 authored rows** named a window that no longer
exists. Founder ruling B9's own last clause authorised the remedy and it is done and
measured: `stale_ledger` 9,269 → 0. What is left is **29 slots of authoring** and one
question only the founder can answer, and that is B19.

And the reviewer lane, merged last, produced the number the phase has been missing since
round 1: the content measures **4.00% wrong (12/300)** against a 2% gate, with three
repeated patterns accounting for half the defects, so **2% is reachable from here and 0%
is not**. The published rate is still `None`, deliberately, because no sheet exists to
publish one from.

So the honest summary this time is: **the pipeline works, the content is keyed to the
wrong course, re-keying it got 465 of 494 slots back, and the content itself measures
twice the gate.**

**EVIDENCE RULE** (plan §Verification): only CI produces artefacts. Everything labelled
_corroboration_ below was produced on this Mac and is not evidence. The gate is GREEN
only if `pack-ci`'s four jobs all **ran** and all **passed**; a skipped pack job reads
green and proves nothing (`docs/ci.md` §"the job that was green because it never ran").

## What was merged

Seven branches were in the queue and **six were merged**, one at a time, `--no-ff`, with
`pnpm test` and `uv run pytest` re-run after each. The seventh,
`p2r3/reviewer-sample-300`, had no commit of its own when the queue started and landed one
while the integration was running; it was merged last, as the dependency order requires. `p2r3/deps-contract`
had already been merged and its handoff discharged by the previous integrate pass, whose
four commits are on `main` ahead of this round (`52f411a`, `d73d295`, `61bc272`,
`b9a68eb`).

| #   | Branch                      | Tip       | Merge commit      | Textual conflicts |
| --- | --------------------------- | --------- | ----------------- | ----------------- |
| 0   | `p2r3/deps-contract`        | `52f411a` | already on `main` | —                 |
| 1   | `p2r3/lemma-reachability`   | `b8e2900` | `796d412`         | none              |
| 2   | `p2r3/gapfill-lesson1`      | `31885ce` | `366565f`         | none              |
| 3   | `p2r3/expand-bake-package`  | `f80d556` | `3740196`         | none              |
| 4   | `p2r3/validators-ci-loader` | `5f8bd57` | `553be5f`         | none              |
| 5   | `p2r3/provenance-docs`      | `ca76cce` | `1b2ad66`         | none              |
| 6   | `p2r3/reviewer-sample-300`  | `f9a9b16` | `034f14d`         | none              |

Every one of the seven lane branches is fully merged — `git rev-list --count main..<branch>`
is **0** for all of `p2r3/deps-contract`, `lemma-reachability`, `gapfill-lesson1`,
`expand-bake-package`, `validators-ci-loader`, `provenance-docs` and
`reviewer-sample-300`. One eighth branch exists, `p2r3/sheet-draw-scratch`, four commits
ahead of `main` and **all four of them merges** (`git log --no-merges main..` is empty):
it is the throwaway worktree the reviewer lane used for its diagnostic builds and says it
deliberately did not commit. Nothing is left unmerged.

**No textual conflict in any of the six.** `git merge-tree` over each branch against
`main` reported none before the queue ran and none appeared inside it. Every defect below
is a **semantic** conflict or a thing only a real run could find: each branch was green
alone, and two of the five defects were found by a test one lane wrote against a state
another lane changed.

### `p2r3/reviewer-sample-300`

The seventh branch landed its commit while this integration was running, and it is the
one branch whose product no other lane could make: **the measured wrong-item rate.**

`f9a9b16` adds three files and no code — `content/es/review/scores.jsonl`,
`content/es/review/scores-method.md`, `docs/owned/p2r3-reviewer-sample.json` (7,149
lines, the 300 scored rows among them) — and it reaches two conclusions.

**It found B19 independently, before this integration had.** Its own `coursekit build es`
exited 4 at G5 twice, it diagnosed the cause as `p2r3/lemma-reachability` removing target
lexemes rather than only adding `forms:` blocks, it named ruling B9's re-key clause as the
remedy, and it bounded the cost with two diagnostic builds in a throwaway worktree. Two
lanes, two machines, one defect, same diagnosis — which is the strongest evidence in this
report that the diagnosis is right.

**And it measured the content**, over the two populations G7 would expand — the 1,090
corpus sentences G4 selected and the 5,100 authored candidates G5 accepts after a re-key —
drawn with coursekit's own `allocate()` at `SAMPLE_SEED = 20260911` over 58
`(unit_index, provenance)` strata, 54 corpus rows and 246 authored:

```
wrong-item rate   12/300 = 4.00%      gate 2.00%   NOT passed
awkward rate      68/300 = 22.67%
ok               220/300
wrong by dimension     answer_set 5 · grammar 4 · meaning 3
awkward by dimension   naturalness 64 · register 4
by provenance     corpus  n=54  wrong 3.7%  awkward 3.7%
                  llm     n=246 wrong 4.07% awkward 26.83%
accent_consistency scored on 0 of 300 rows — G8 never ran, so there is no clip to hear
```

**Recomputed from the file rather than quoted from the lane's summary**: 300 rows are
present, the verdicts are `ok 220 / awkward 68 / wrong 12`, 12/300 = 0.04 and 68/300 =
0.2267 exactly, the provenance split is 246 llm / 54 corpus, the wrong rows' failing
dimensions are `answer_set 5 · grammar 4 · meaning 3`, and **0 of 300 rows carry an
`accent_consistency` key** — consistent with the lane's note that G8 never ran, so there
was nothing to listen to. Every row carries a `note`; the first wrong one reads
_"`¿Son cuarenta, señor?` is glossed 'Are there forty, sir?'; `son` is not existential"_,
which is a reviewer's finding and not a template.

Two things in that table matter more than the headline. **Six of the twelve wrong items
are three reusable patterns**, not six independent mistakes — the `Continúa …` / "You
carry on" gloss, the `hay {weather}` / "There is clouds" gloss, and _ser_ + _limpio_ for a
room — so fixing three patterns puts the rate at 6/300 = **2.00%**, at the gate. 2% is
reachable from here and 0% is not. And **the near-equal wrong rates hide opposite failure
modes**: both corpus defects are English-side mis-glosses of natural Spanish, while the
authored bank is correctly glossed Spanish nobody would say (26.83% awkward against
3.70%). A course built from this bank would read as grammatical and empty.

**Its diagnostic re-key and this integration's differ by 58 slots, and the difference is
not a mystery — it reconciles exactly.** The lane's throwaway re-key reported 5,100 rows
accepted and **407 of 494** slots filled, leaving "~87 to re-author"; the script committed
here reports **465 of 494**. `_axis` has **two** `stale_ledger` returns, one on the digest
and one on `set(new_lemmas) != set(gap["new_lemmas"])`, so a digest-only re-key leaves
every slot whose _reserved lemma set_ also moved to be rejected by the second check.
Measured on the committed shards' own `rekeyed.from_new_lemmas` records:

```
slots whose reserved lemma set moved          63
slots G5 filled after the two-field re-key   465
of those 63, filled                           58
465 - 58                                    = 407     <- the lane's number, exactly
```

So the two runs agree, and what separated them was one field. The committed script writes
both, which is why 465 is the number in §The pipeline.

**`scores.jsonl` still has no scored rows, on purpose, and the published rate is still
`None`.** A row there needs an `exercise_id`; these verdicts are keyed by `candidate_id`
and `sentence_id` because no exercise exists, and putting them in an `exercise_id` field
would publish a rate over rows belonging to no population — which is what
`review_summary`'s `joined` denominator exists to prevent. The file carries `//` comments
(`read_scores` skips them) saying so. `gate_passed()` is false and
**`PROVISIONAL (unreviewed by a paid native speaker)`** is unchanged.

The reviewer kind is `opus-agent-reviewer`. The lane says the thing that has to be said
about it: the same model family authored every `provenance: llm` row, so this is not an
independent measurement, which is exactly why `REVIEWER_KIND_AGENT` is a separate constant
and why the paid native pass stays a release prerequisite in `docs/RELEASE.md`.

One gap in the method is worth carrying forward: the real sheet stratifies over
`(unit_index, exercise_type, provenance)` and `exercise_type` cannot exist without G7, so
nothing in this sample measures word banks, distractors, cloze gaps, match grids or
accepted-answer sets **as the tool builds them**. `answer_set` was scored against the
sentence pair alone. A real sheet would also catch a valid answer sitting in the distractor
list; this one cannot.

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
§B19 carries every list, every window, the reject census for each starved slot, and the
two ways out of the `usted` contradiction. Neither is taken here, and the authoring is
not done here either: 440 candidates written unreviewed inside an integration pass is
what produced the starved-slot defect at the last one.

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

### G6 – G9 not reached; `validate` and `sample` were run anyway

G5 exits 4, so G6–G9 did not run here. `coursekit validate es` and `coursekit sample es`
were run over the G0–G5 tree regardless, because a validator suite that has never executed
is its own risk — and this run produced two things worth having.

```
es: 5/17 validators green, 0 unregistered, 0 skipped, 33 blocking finding(s). Nothing ships.
validator report: build/es/validator-report.json
```

**Founder ruling B17 works, and this is the first time anyone has seen it on real data.**
V11 finds **13 unit boundaries where mean difficulty falls** and splits them by severity
exactly as the ruling says:

```
BLOCKING, 1 of 13:
  u10->u11  10.398 -> 9.359  (-1.039)  ACROSS the section boundary s1->s2
WARNING, 12 of 13 (inside a section, carried in the report with the measured delta):
  u6->u7 -0.344 · u8->u9 -0.700 · u13->u14 -0.419 · u14->u15 -0.428 · u15->u16 -1.542
  u18->u19 -3.181 · u19->u20 -0.041 · u21->u22 -0.555 · u22->u23 -2.237 · u25->u26 -0.527
  u26->u27 -1.592 · u28->u29 -1.356
```

Round 2 reported "V11: mean difficulty falls across 13 unit boundaries" as 13 blocking
findings. It is **one** blocking finding and twelve warnings, and the largest fall
(u18→u19, −3.181) is one of the warnings. That is the whole of B17 discharged, measured.

The other 32 blocking findings are B19's shadow rather than new defects: **V10 raises 12
unresolved-licence findings** and every one of them names a slot on the thin-or-unfilled
list (`u23/l134/s6`, `u25/l143/s8`, `u25/l144/s8`, `u25/l145/s4`, `u27/l154/s4 s5 s6`,
`u27/l156/s3`, `u27/l157/s5 s6`, `u27/l158/s7`, `u29/l168/s6`) — a gap slot with no
accepted candidate has no sentence, so it has no licence. **V12** says the pack declares no
meta rows because G9 has not run. **F4** says a signature check with no manifest is not a
pass. **F5** records that the ja character syllabus is not applicable to es rather than
skipping silently.

`coursekit sample es` refuses, in the words it should:

```
sample failed: no exercise artefact at build/es/g7/exercises.jsonl; `coursekit sample`
draws from G7 output, so run `coursekit build es` first. Drawing from nothing would
produce an empty sheet and a defect rate of 0%.
```

#### What the lanes measured downstream, at one remove

These are **corroboration at one remove** — the expand lane's own tree, with a diagnostic
shard and a runtime override, neither of which exists any more — and are in
`docs/owned/p2r3-expand-bake-package.json`:

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
  B17's ruling has landed since that run and the split is now measured — 1 blocking, 12
  warnings — so **that 210 is 198 blocking today**; the other 197 findings are unchanged
  and none of them has been measured on this tree.
- **the full-course bake is outside `build-es`'s budget**, and this is the next wall after
  B19: 2,898 clips at ~15/minute is
  about 3 hours against a 90-minute job. INV-AUD-08 is why it is slow (loudness measured
  on the decoded file, re-encoded until it lands inside half the tolerance), so the fix is
  a budget, a cache keyed on the re-bake key, or a bake job of its own — not a faster loop.

## The gate, item by item

The P2 gate row of the plan, plus every command the brief named. A row that says GREEN or
RED without qualification is CI's; a row that names this Mac is corroboration and is
labelled so. Nothing in this table is inferred from a lane's own report without saying
whose measurement it is.

| Gate item                                                                                | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Where                                |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `pnpm install --frozen-lockfile`                                                         | **GREEN** — no lockfile diff; the deps lane needed no new package this round                                                                                                                                                                                                                                                                                                                                                                                                                                | ci.yml                               |
| `pnpm lint`                                                                              | **GREEN**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ci.yml                               |
| `pnpm typecheck`                                                                         | **GREEN**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ci.yml                               |
| `pnpm format:check`                                                                      | **GREEN**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ci.yml                               |
| `pnpm invariants:check`                                                                  | **GREEN** — 424 ids, digest matches the corpus                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ci.yml                               |
| `pnpm test`                                                                              | **GREEN on the final code sha** — 1,316 passed / 6 skipped on `859f3fb`, first attempt. It FAILED on both attempts of `86f2430` with the same 1,316 passing and `Timeout calling "onTaskUpdate"`: an intermittent reporter RPC timeout, recorded as B20 with all three attempts                                                                                                                                                                                                                             | ci.yml                               |
| `pnpm test:falsify`                                                                      | **GREEN** — 280 committed falsifier cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ci.yml                               |
| `pnpm test:coverage-map`                                                                 | **GREEN** — no unowned id, no id claimed twice                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ci.yml                               |
| `uv run ruff check .` + `uv run pytest`                                                  | **GREEN** — ruff clean; pytest all passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pack-ci `coursekit`                  |
| `pipeline-ready` — every stage and validator registered                                  | **GREEN** — 10/10 stages, 17/17 validators; both pack jobs live                                                                                                                                                                                                                                                                                                                                                                                                                                             | pack-ci                              |
| `uv run coursekit build es` (G0–G9)                                                      | **RED — G0–G4 pass, G5 exits 4** on the 18 orphaned slots (`86f2430`, pre-re-key) and on the 22 unauthored ones (post-re-key, this Mac). B19                                                                                                                                                                                                                                                                                                                                                                | pack-ci `build-es`                   |
| `uv run coursekit validate es` → exit 0                                                  | **DID NOT RUN IN CI** — `validate-es` skipped on `needs: build-es`; `pipeline-ready` was green, so the skip is a real dependency and not the green-because-skipped failure mode. Run on this Mac over the G0–G5 tree: **5/17 green, 0 unregistered, 0 skipped, 33 blocking**                                                                                                                                                                                                                                | pack-ci `validate-es`                |
| V1–V4 = 100%, zero violations \[INV-PACK-06]                                             | **NOT PROVEN** — V1–V4 need G7's artefact and G5 exits 4                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                    |
| V5–V12, F1–F5: the report names every validator that ran                                 | **PARTIAL, and it names all 17** — 5 green, 0 unregistered, 0 skipped, and each of the rest says which of _clean_, _nothing to check_ and _never ran_ it is. Measured on this Mac; the last run over a real pack was the expand lane's, on a tree that no longer exists: 11/17 green, 0 unregistered, 0 skipped, 210 blocking, 48 warnings                                                                                                                                                                  | —                                    |
| V8 records the engines actually used \[INV-PACK-14]                                      | **PROVEN at one remove** — `languagetool/6.6/es` for grammar and spellcheck, `agent_rubric/v1` for backtranslation, `perplexity none`, `degraded_to grammar_only`; the sidecar step is green in CI on this sha, the G6 run is not on this tree                                                                                                                                                                                                                                                              | —                                    |
| zero UNRESOLVED licences; attribution owner on every required row \[V10, INV-PACK-13/17] | **NOT PROVEN** — V10 needs the pack                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —                                    |
| audio manifest codec=opus, 20 kbps, ≤ 120 MB on real bytes \[INV-PACK-15]                | **NOT PROVEN on real bytes for the whole course.** Units 1–3 measured 580,184 B over 125 clips (expand lane, another tree); `content/es/audio-manifest.json` declares `codec opus`, `bitrate_kbps 20`, and charges 98,000,000 B of the 120,000,000 B budget across lesson + stories + radio. A declaration, and a third of the bank                                                                                                                                                                         | —                                    |
| manifest declares `ledger_unit=lemma` exactly once \[INV-PACK-40]                        | **GREEN as a source property** — the grep gate over `tools/coursekit` has no offenders; the manifest half needs a pack                                                                                                                                                                                                                                                                                                                                                                                      | —                                    |
| every missable item carries ≥ 2 authored forms \[INV-PACK-07]                            | **NOT PROVEN this round** — 0 blocking over 6,100 records on the expand lane's tree; G7 has not run on this one                                                                                                                                                                                                                                                                                                                                                                                             | —                                    |
| the built pack loads in `packages/core`'s loader                                         | **DID NOT RUN, and the mechanism was verified instead.** The step lives in `validate-es`, which skipped. Locally the file **skips** with `FREELINGO_REAL_PACK` unset (1 file / 6 tests skipped) and, with it set to a path that does not exist, **all 6 tests fail** — `ENOENT: … /nonexistent/manifest.json` — rather than skipping. So the step cannot be green on a missing pack, which is the property it exists for; it has simply never had a pack to open                                            | pack-ci `validate-es`                |
| `uv run coursekit sample es` — 300 items                                                 | **BLOCKED by B19, and it refuses rather than drawing** — run on this Mac: _"no exercise artefact at build/es/g7/exercises.jsonl … drawing from nothing would produce an empty sheet and a defect rate of 0%"_                                                                                                                                                                                                                                                                                               | —                                    |
| wrong-item rate, its reviewer kind, and the provisional note                             | **MEASURED at 4.00% and NOT PASSED, and the published rate is still `None`.** 12/300 wrong, 68/300 awkward, over the two populations G7 would expand, `reviewer_kind: opus-agent-reviewer`, seed 20260911, 58 strata. `scores.jsonl` deliberately holds no scored rows (no `exercise_id` exists), so `wrong_item_rate` is `None` and `gate_passed()` is false. `PROVISIONAL (unreviewed by a paid native speaker)` verbatim. Three repeated patterns account for six of the twelve: fixing them lands 2.00% | `content/es/review/scores-method.md` |
| `uv run coursekit sign es`                                                               | **NOT PROVEN** — `sign` needs a manifest and G9 has not run                                                                                                                                                                                                                                                                                                                                                                                                                                                 | pack-ci `build-es`                   |
| `mutation.yml` nightly, non-gating                                                       | **NO SCORE EXISTS** — unchanged; Stryker times out in its dry run on an INV-DAT-04 property. Non-gating by ruling                                                                                                                                                                                                                                                                                                                                                                                           | B7                                   |

## CI

All three workflows ran on the integration sha **`86f2430`** — the merge queue plus the
first two integration fixes and the format sweep. The re-key (`2d16f5f`) and the blockers
(`a81b729`) landed after it, so **a second CI pass** ran on `859f3fb` and is quoted below.

"Round 2" in this file always means the second CI pass of this integration. The previous
phase round's report is `docs/P2-REPORT-round2.md` and is called that by name.

| Workflow         | Run                                                                    | Result                                                                                                          |
| ---------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ci.yml`         | <https://github.com/Blueturboguy07/freelingo/actions/runs/34704497896> | **FAILURE on both attempts** — 1,316/1,316 tests pass, then `Timeout calling "onTaskUpdate"`. B20               |
| `pack-ci.yml`    | <https://github.com/Blueturboguy07/freelingo/actions/runs/34704497734> | **FAILURE at G5**, `validate-es` skipped on `needs:`                                                            |
| `native-e2e.yml` | <https://github.com/Blueturboguy07/freelingo/actions/runs/34704497731> | **CANCELLED** — three of four jobs green; the iOS job was killed by the second CI pass's push, not by a failure |
| `mutation.yml`   | nightly, non-gating                                                    | no score exists; B7                                                                                             |

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

| sha       | attempt               | result                               |
| --------- | --------------------- | ------------------------------------ |
| `86f2430` | 1                     | FAILURE — 1,316/1,316 pass, 2 errors |
| `86f2430` | 2 (`--failed` re-run) | FAILURE — 1,316/1,316 pass, 1 error  |
| `859f3fb` | 1                     | **SUCCESS** — 1,316/1,316 pass       |

So it is a flake, and what is worth recording is the hit rate rather than the existence:
**two consecutive failures on one sha do not mean a regression, and a re-run on the same
sha is not a reliable way to clear it** — which is precisely what the "re-run once" rule
assumes. Recorded as **B20** with all three attempts and the levers, and not fixed here:
the same suite is 26 s on this Mac against 227 s on the runner, so no fix could have been
measured before pushing it.

### `pack-ci.yml` on `86f2430`

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

**The per-stage counters from CI are therefore not available either**, and this is worth
stating rather than substituting: `read`/`rejected`/`written` per stage live in
`build/es/runlog.jsonl`, which travels inside `es-build-<sha>`, which is uploaded after
the build. What CI produced is the stage _timeline_ above, the failure message, and the
gap brief. Every G0–G9 counter in §The pipeline is this Mac's, and the two places where
CI and this Mac can be compared — `ingested 276,203` and the 494-slot gap list with its
digest — agree exactly.

### `native-e2e.yml` on `86f2430`

```
✓ flows exist                                                8s
✓ INV-PLAT-02 — native trees are generated and reproducible  21s
✓ Android emulator                                           17m
X iOS simulator                                              CANCELLED
```

**The iOS job was cancelled, not failed**, and this is the hazard `docs/P2-REPORT-round2.md`
already named: `pack-ci` and `native-e2e` share a concurrency group with the branch, so
the push that carried the re-key (`2d16f5f` … `859f3fb`) killed a job that had been
running for 27 minutes. Recorded as a cancellation. The second CI pass, below, re-runs it on the
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

### The second CI pass, on `859f3fb`

`859f3fb` is the sha that carries the re-key, the regenerated brief and the blockers — the
tree this integration actually hands over. The reviewer-sample merge (`034f14d`) and this
report land after it, and neither changes a stage.

| Workflow         | Run                                                                    | Result                                                                                    |
| ---------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ci.yml`         | <https://github.com/Blueturboguy07/freelingo/actions/runs/34705920961> | **SUCCESS**, first attempt — 114 files / 1,316 passed, 6 skipped, no `onTaskUpdate` error |
| `pack-ci.yml`    | <https://github.com/Blueturboguy07/freelingo/actions/runs/34705920930> | TBD-R2-PACK                                                                               |
| `native-e2e.yml` | <https://github.com/Blueturboguy07/freelingo/actions/runs/34705920937> | TBD-R2-NATIVE                                                                             |

TBD-R2-PROSE

## Blockers

The live list is `docs/P2-BLOCKERS.md`, and this round **re-measured five of its rows**
rather than copying them: each had been written on a lane that could not see its
siblings' files, and each had gone stale in the same direction — done, and reported
undone. Where it stands on `main`:

| Id         | What                                                               | Kind                 | Status after this round                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1/B1a/B1b | the candidates, the empty ledger, the lesson numbering             | authoring + code     | **RESOLVED**                                                                                                                                                                       |
| B2         | `pack-bake.yml` could not succeed on any dispatch                  | code                 | **RESOLVED** (deleted)                                                                                                                                                             |
| B3         | the wrong-item rate is `None`, not 2%                              | **founder decision** | **DECIDED, and now MEASURED at 4.00%** by the reviewer lane — over the populations G7 would expand, not over a sheet; the _published_ rate is still `None` because no sheet exists |
| B4         | `coursekit sample es --n 300` is not a spelling the CLI has        | docs                 | **RESOLVED**                                                                                                                                                                       |
| B5         | S152 has validator F3 and no product-map row                       | **founder decision** | **DECIDED** — Surface 16; P4 builds it                                                                                                                                             |
| B6         | Azure is dead; Spanish bakes on Kokoro                             | **founder decision** | **DECIDED, BUILT 5/5** — re-measured here                                                                                                                                          |
| B7         | `mutation.yml` has never produced a score                          | pre-existing         | **NON-GATING by ruling**, still no score                                                                                                                                           |
| B8         | `build-es` named no language engine                                | code (CI)            | **RESOLVED** — sidecar                                                                                                                                                             |
| B9         | unit 1 lesson 1 cannot hold a sentence                             | **founder decision** | **DECIDED, BUILT** — (a)+(b)+(c) all on `main`; re-measured here                                                                                                                   |
| B10        | 218 candidate texts were `usted` in a `tu` course                  | content              | **RESOLVED**                                                                                                                                                                       |
| B11        | G6 read one candidates file and there are nine                     | code                 | **RESOLVED**                                                                                                                                                                       |
| B12        | the gate's `validate --pack … --report …` spelling                 | docs                 | **RESOLVED**                                                                                                                                                                       |
| B13        | `build-es` synced no `align` group                                 | code (CI)            | **RESOLVED**                                                                                                                                                                       |
| B14        | a starved slot crashed G7 instead of failing by name               | code                 | **DECIDED, BUILT** — `StarvedSlot(LookupError)`; re-measured here                                                                                                                  |
| B15        | G7 made word-bank tiles out of punctuation                         | code                 | **RESOLVED**                                                                                                                                                                       |
| B16        | G7 looked a distractor up by surface                               | code                 | **DECIDED, BUILT** — writer + reader; re-measured here                                                                                                                             |
| B17        | V11 sees mean difficulty fall across unit boundaries               | content + code       | **DECIDED, BUILT** — severity splits on the section boundary; re-measured here                                                                                                     |
| B18        | the accent dimension B6 made load-bearing has nothing to listen to | code                 | **OPEN, measured** — `SampleItem` carries no clip ref and no voice role                                                                                                            |
| B19        | B9(a)+(c) moved the ledger: 18 slots died, 22 appeared             | content              | **OPEN — the phase blocker.** Re-key done (`stale_ledger` 9,269 → 0); 22 slots need 440 candidates, 7 need fresh ones, `u1/l3/s3` reserves `usted` in a `tu` course                |
| B20        | `ci.yml` intermittently fails with 1,316 of 1,316 passing          | infrastructure       | **OPEN, measured** — twice on `86f2430`, then green on `859f3fb`; a same-sha re-run does not reliably clear it                                                                     |

**B19 is the phase blocker, and it is one decision plus one lane's work**: who authors the
29 slots, and does `usted` stay a target lexeme? Everything else on this list is resolved,
decided-and-built, or non-gating. The three blocked gate items — `validate`, `sample`,
`sign` — are all downstream of it.

**B3 is no longer unmeasured, and that changes what the founder is looking at.** The
reviewer lane measured 4.00% over the content the pack would be built from. It is above
the 2% gate, three repeated patterns account for half the defects, and fixing them lands
exactly 2.00% — so the content question now has a number and a route, where two rounds ago
it had neither. The _published_ rate stays `None` until a sheet exists, which is B19 again.

Two rows are new and both came from running the thing rather than reading it: B19 from the
pipeline (twice, independently — this integration and the reviewer lane), B20 from
re-running a failed CI job as the brief requires and then watching the next sha pass.

## Disk

`df -h ~` at the start of the integration: **66 GiB free of 460 GiB (84% used)**. Before
the build: 65 GiB. At the end: **65 GiB**, `df -g` agreeing. Well above the 15 GB floor
the brief names, so no cache was cleared and `apps/mobile/ios/build`,
`apps/mobile/android/build` and `~/Library/Developer/Xcode/DerivedData/Freelingo-*` were
left alone.

P0's target of ≥ 80 GB free is still unmet and nothing in P2 needed it. What this round
added locally and does not need again: `build/` 520 MB (the G0–G5 tree, gitignored),
`tools/coursekit/.venv` 1.1 GB (the `align` group's torch/transformers wheels), the
pinned Kokoro weights 353,753,249 B at `~/.kokoro`, and a LanguageTool 6.6 unpack in the
session scratchpad. CI carries its own copies and caches the Kokoro weights.
