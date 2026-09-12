# How the Spanish reviewer sample was scored — 2026-09-12

The run record for the P2 round-3 task `p2r3/reviewer-sample-300`, commissioned by founder
ruling **B3**: score the 300-item stratified sheet so the pack publishes a measured
wrong-item rate instead of `None`.

**Read the headline first, because it is two findings and not one.**

|                                                     |                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `coursekit sample es` on this tree                  | **exit 4** — no sheet exists, so `scores.jsonl` has no rows and the published rate is still `None` |
| the 300 items that _would_ be on that sheet, scored | **wrong-item rate 4.00% (12/300)**, awkward rate **22.67% (68/300)**                               |
| the 2% gate                                         | **not passed**, and above the gate is the finding this sample exists to produce                    |

Neither number cancels the other. The pack still publishes no rate, and the content the
pack would be built from measures twice the gate.

## Who scored this, and why that is not the measurement the plan asked for

`reviewer: opus-agent-reviewer`, `REVIEWER_KIND_AGENT`. The same model family — Claude
Opus — authored every `provenance: llm` row in this sample: `content/es/candidates/*.jsonl`
carries `"author": "claude-opus-5 (agent; Freelingo p2fix-author-… lane)"` on all 9,812
rows, and this reviewer is a Claude Opus agent in the same workflow. **This is not an
independent measurement.** It is the same model family marking its own homework, which is
precisely why `REVIEWER_KIND_AGENT` exists as a separate constant from
`REVIEWER_KIND_PAID_NATIVE`, and why every number on this page carries, verbatim:

> PROVISIONAL (unreviewed by a paid native speaker)

Founder ruling B3 lets an agent-scored rate unblock **P3**. It does not unblock a
**release**: the paid native Spanish review is item 1 of `docs/RELEASE.md` and stays a
release prerequisite. Nothing on this page changes that, and a 4% agent-measured rate is
an argument for commissioning the paid pass sooner rather than later, not later.

One asymmetry worth naming. A reviewer who is the author's own model family is _least_
reliable exactly where the content is most defensible-looking — a sentence that is
grammatical, matched to its gloss and semantically empty is the shape this reviewer is
most likely to wave through, and 64 of the 68 `awkward` verdicts below are that shape. So
read the 22.67% awkward rate as a floor, not a measurement.

## What was run, in order, with what it printed

Worktree `/Users/mannbellani/freelingo-wt/p2r3-reviewer-sample-300`, branch
`p2r3/reviewer-sample-300` at `a4e7f8b`: `origin/main` `b9a68eb` with the
`p2r3/lemma-reachability`, `p2r3/gapfill-lesson1`, `p2r3/expand-bake-package`,
`p2r3/validators-ci-loader` and `p2r3/provenance-docs` lanes merged locally
(`p2r3/deps-contract` was already in `main`).

**1. The LanguageTool sidecar (B8's four lines), live, not mocked.**

```
java -cp LanguageTool-6.6/languagetool-server.jar org.languagetool.server.HTTPServer --port 8081
POST /v2/check language=es text="Yo tengo un qwzxvb grande."
  -> {"software":{"name":"LanguageTool","version":"6.6","buildDate":"2025-03-27 …"}}, MORFOLOGIK_RULE_ES
```

**2. `uv run coursekit build es --set languagetool_url=http://localhost:8081`** —
10:55:43 to 11:06:36, **exit 4**.

| Stage | What it reported                                                                                         |
| ----- | -------------------------------------------------------------------------------------------------------- |
| G0    | 399,896 read, 123,693 rejected, **276,203 written** (tatoeba 180,862 + nllb 95,341), NFC, window [3, 12] |
| G1    | 276,203 read, 3,921 rejected, 272,282 written                                                            |
| G2    | 50,000 read, 33,681 written                                                                              |
| G3    | 30 units                                                                                                 |
| G4    | 276,203 read, **1,584 slots, 1,090 filled, 494 gaps**                                                    |
| G5    | 9,812 read, 9,449 written, **failed**                                                                    |

```
g5 failed: 18 authored slot(s) are not in G4's gap list: u1/l4/s3, u1/l4/s4, u1/l6/s2,
u1/l6/s3, u1/l6/s4, u1/l6/s5, u4/l19/s4, u4/l22/s3, u5/l28/s6, u6/l35/s6, u9/l51/s5,
u13/l73/s6, u13/l75/s5, u16/l95/s5, u17/l101/s4, u24/l137/s7, u25/l142/s3, u25/l144/s4.
```

**3. `uv run coursekit sample es`** — the bare spelling, because there is no `--n` flag
(B4). **exit 4**:

```
sample failed: no exercise artefact at build/es/g7/exercises.jsonl; `coursekit sample`
draws from G7 output, so run `coursekit build es` first. Drawing from nothing would
produce an empty sheet and a defect rate of 0%.
```

That refusal is the right behaviour and it is why `scores.jsonl` still has no rows.

## Why the build cannot reach G7 on this tree, measured rather than inferred

The 18 orphan slots are the message G5 prints; they are not the size of the problem.
Reading this build's own `g5/candidates.jsonl`:

| G5 verdict on the 9,449 authored rows it wrote     | Rows         |
| -------------------------------------------------- | ------------ |
| `accepted`                                         | **12**       |
| rejected `stale_ledger`                            | **9,269**    |
| rejected `out_of_vocabulary`                       | 144          |
| rejected `duplicate`                               | 24           |
| **gap slots with at least one accepted candidate** | **9 of 494** |

A slot's `ledger_digest` is 16 hex over its sorted `known | new` lemma set. Joining the
committed bank against this build's `coursekit gaps es` (494 slots, ledger digest
`e041abe57f6f0836`):

- 490 authored slots, 9,812 rows;
- **18 slots are not gaps here at all** (363 rows) — G4 filled them from the corpus;
- **22 gap slots have zero authored candidates**, so they are under G5's floor of 20 at
  `(0)`: `u1/l3/s1`, `u1/l3/s3`…`u1/l3/s7`, `u4/l24/s6`, `u16/l96/s6`, `u17/l102/s6`,
  `u21/l121/s8`, `u23/l131/s6`, `u23/l132/s7`, `u23/l134/s6`, `u25/l145/s4`,
  `u27/l154/s4`…`s6`, `u27/l156/s3`, `u27/l157/s5`, `u27/l157/s6`, `u27/l158/s7`,
  `u29/l168/s6`;
- **463 of the 472 joinable slots carry a digest this build contradicts.**

**The cause is a cross-lane collision, and it is worth stating plainly because neither
lane is wrong on its own.** `p2r3/lemma-reachability` rewrote `content/es/curriculum.yaml`
— it does not only add `forms:` blocks, it also _removes_ target lexemes (`gracias` →
`gracia`, `media` → `medio`, `fuera` → `afuera`, and `ella`, `nosotros`, `ellos`,
`llamarse`, `encontrarse`, `equivocarse`, `levantarse`, `ducharse`, `vestirse`,
`peinarse`, `lavarse`, `afeitarse`, `acostarse`, `dormirse`, `despertarse`, `sentarse`
dropped outright). `p2r3/gapfill-lesson1` measured its green G5 and G6 on a tree **without**
that lane (`git merge-base --is-ancestor p2r3/lemma-reachability p2r3/gapfill-lesson1` is
false, and the two trees' `curriculum.yaml` differ). Founder ruling B9 anticipated exactly
this — _"Re-key only rows whose `ledger_digest` changes"_ — and the re-key was never done,
so the clause that was meant to bound the cost is the clause that is outstanding.

Two further builds pin that down rather than leaving it as a theory. Both were run in a
throwaway worktree, `/Users/mannbellani/freelingo-wt/p2r3-sheet-draw`, and **nothing in
either is committed**:

- **Without `lemma-reachability`** (the other four lanes, same corpus): G5 gets all the way
  to `g5 failed: 8 slot(s) exhausted every candidate: u1/l1/s1 … u1/l1/s8`. That is **B9
  recurring one lesson later** — with the old curriculum, unit 1 lesson 1's window cannot
  hold the greeting the lane authored for it.
- **With `lemma-reachability`, after a mechanical digest re-key** (re-stamp each row's
  `ledger_digest` from this build's gap brief; 9,269 rows re-stamped, the 363 orphan rows
  dropped): G5 accepts **5,100 of 9,449** and fills **407 of 494** slots, then stops on the
  22 empty slots. Re-stamping is not a bypass of anything substantive — G5's
  `out_of_vocabulary` axis independently checks every lexical lemma against `known | new`,
  and it rejected 188 rows in that run.

A fourth symptom, and the cheapest one to act on: **`uv run pytest` on the merged tree is
red.** Three tests in `tools/coursekit/tests/test_g5_gapfill.py` fail —
`test_the_pinned_lemmatiser_still_has_not_absorbed_the_prenominal_table` and two neighbours
— because they assert the pinned lemmatiser's _raw_ output (`Buenos días.` →
`['buenos', 'día']`) and the merged adapter now returns `['bueno', 'día']`, which is exactly
what B9(a)'s normalisation table is for. The same file passes 56/56 on
`p2r3/gapfill-lesson1` alone. `pack-ci.yml`'s `coursekit lint + tests` job runs `uv run
pytest` on every push and `pipeline-ready` gates the two pack jobs behind it, so this
collision turns the fast job red at the integration — which is the right behaviour, and the
signal to fix before any authoring is commissioned. This task changed no Python and no
content: `git status --porcelain` is three files.

So the cost of a green build is bounded and known: **re-key the bank, drop 18 slots' worth
of surplus rows, author 20 candidates for each of 22 slots (440 sentences), and expect
about 87 slots to still need a second authoring pass.** Six of the 22 are `u1/l3`, whose
window is 15 lemmas with no verb — that one is a curriculum decision, not authoring.
**`docs/P2-BLOCKERS.md` is not in this task's file lane**, so this is written up in
`docs/owned/p2r3-reviewer-sample.json` -> `blockersForTheIntegrator` as the proposed **B19**
rather than filed there by this lane.

## What was scored instead, and what population it describes

`coursekit sample es` draws from G7's exercises. G7 has never run on a real course, so
there are no exercises. The review was therefore done over the two populations G7 would
expand, drawn by the same method so the draw can be audited:

- **`corpus`** — the 1,090 slots G4 filled from the corpus, with text and translation read
  back out of `build/es/g0/ingested.jsonl`;
- **`llm`** — the 5,100 authored candidates G5 accepted in the re-keyed run.

Population **6,190**, strata `(unit_index, provenance)` — **58** strata — allocated with
coursekit's own `allocate()` and drawn with `random.Random(SAMPLE_SEED)`,
`SAMPLE_SEED = 20260911`. Drawn: **300** rows, **54 corpus** and **246 authored**. The
draw script is `scratchpad/draw-content-sample.py`, reproducible against the same build.

The sheet's third stratum, `exercise_type`, **cannot exist here**, and that is the first
thing this sample does not measure: no exercise exists, so nothing was scored about word
banks, distractors, cloze gaps, match grids or accepted-answer sets _as the tool builds
them_. `answer_set` was scored against the sentence pair only. A real H1 sheet would also
catch a valid answer sitting in the distractor list, and this one cannot.

### Authored versus corpus-derived, and the join this does not have

Counted, because the brief asks for it: **246 of 300 scored rows are authored**
(`provenance: llm`, corpus-independent text) and **54 are corpus-derived**.

**The join CI will get is not the join this sample has, and probably has no rows at all.**
`pack-ci`'s `build-es` streams a **live Tatoeba export that rebuilds every Saturday 06:30
UTC**, so:

- a **corpus-derived** row's `sentence_id` is a property of one week's export. This build's
  corpus digest is `sha256(build/es/g0/ingested.jsonl) =`
  `5ac184e4c583dc2166cd4501ab3cc680cdc3bfcc8f06f53c9dcc5297e1bdc17b`, run id
  `69ebe22815ae4776986e22458a2c82d6`, ingested 2026-09-12 from 399,896 raw pairs. No later
  build joins it except by coincidence.
- an **authored** row's text is corpus-independent, but its _exercise id_ is not: G7 hashes
  `(unit, lesson, shape_id, body, accepted…)`, and which slots are gaps at all is decided
  by which corpus sentences fitted the ledger. This build has 494 gaps; the run that raised
  B1 had 920; CI's run at `281b623` had 918. A slot that is a gap here may be corpus-filled
  there, and then the authored row is not in the course at all.

So the expected join between these 300 verdicts and a future CI sheet is: **zero rows for
the 54 corpus-derived items**, and for the 246 authored items, only those whose slot is
still a gap and whose text is still the chosen candidate — which cannot be computed until
one green build exists. That is why the verdicts are **not** written into `scores.jsonl`
with a `candidate_id` in an `exercise_id` field: `review_summary`'s denominator is `joined`
precisely so a rate cannot be quoted over rows belonging to no population, and a file that
defeated that check by mislabelling its ids would be worse than an empty one.

## The rates

```
wrong_item_rate = 12 / 300 = 4.00%        gate 2%  -> NOT PASSED
awkward_rate    = 68 / 300 = 22.67%
ok              = 220 / 300 = 73.33%
```

| Slice            | n   | wrong     | awkward |
| ---------------- | --- | --------- | ------- |
| all              | 300 | **4.00%** | 22.67%  |
| authored (`llm`) | 246 | **4.07%** | 26.83%  |
| corpus-derived   | 54  | **3.70%** | 3.70%   |

Failing dimensions: `wrong` — `answer_set` 5, `grammar` 4, `meaning` 3. `awkward` —
`naturalness` 64, `register` 4.

**The two provenances fail differently and that matters more than the near-equal wrong
rates.** Corpus rows are natural Spanish that is mis-glossed (both corpus defects are
English-side); authored rows are correctly glossed Spanish nobody would say (26.83%
awkward against 3.70%). A course built from this bank would read as grammatical and empty,
which is the failure mode `awkward` is reported separately in order to make visible.

## The twelve wrong items

| Row | Slot        | Prov.  | Item                                                           | Why                                                                    |
| --- | ----------- | ------ | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 6   | u2/l9/s6    | llm    | `¿Son cuarenta, señor?` / "Are there forty, sir?"              | `son` is not existential; the English asks for `¿Hay cuarenta?`        |
| 49  | u6/l36/s7   | llm    | `En agosto yo tengo veinte años.` / "In August I turn twenty." | turning an age is `cumplir`; the item teaches `tener` = "to turn"      |
| 50  | u6/l36/s7   | llm    | `Es una costa de un sur europeo.`                              | `un sur` — a cardinal-direction noun takes no indefinite article here  |
| 79  | u11/l64/s6  | corpus | `No encuentro mi cartera.` / "I lost my wallet."               | `no encuentro` is "cannot find"; "I lost" is `perdí`                   |
| 98  | u15/l87/s6  | llm    | `Continúa hasta la rotonda.` / "You carry on…"                 | imperative/3sg glossed as 2sg declarative; `continúas` is not accepted |
| 100 | u15/l87/s7  | llm    | `Continúa hasta el puente.` / "You carry on…"                  | same template                                                          |
| 121 | u16/l95/s3  | corpus | `Hoy tendremos pescado de cena.` / "We have fish…today."       | future glossed as present; `tenemos` is not accepted                   |
| 123 | u17/l98/s5  | llm    | `El sábado hay nubes en la plaza.` / "There is clouds…"        | the English prompt is not English                                      |
| 124 | u17/l98/s5  | llm    | `Mañana hay nubes en el oeste.` / "There is clouds…"           | same template                                                          |
| 150 | u18/l108/s7 | llm    | `Los dormitorios son limpios.`                                 | a room's cleanliness is `estar limpio`                                 |
| 151 | u18/l108/s7 | llm    | `Los salones son limpios.`                                     | same ser/estar error                                                   |
| 171 | u19/l112/s4 | llm    | `Mi hermana avisa la propuesta.`                               | `avisar` does not take the announced thing as a direct object          |

**Six of the twelve are three patterns, not six independent mistakes**: the `Continúa …` /
"You carry on" gloss (98, 100), the `hay {weather}` / "There is clouds" gloss (123, 124),
and `ser` + `limpio` for a room (150, 151). Fixing those three and re-drawing would put the
rate at **6/300 = 2.00%** — at the gate, not under it. The remaining six are one-offs
across four units, so **2% is reachable from here and 0% is not.** That is the most useful
thing on this page for whoever picks up the content work.

One systematic finding that is _not_ in the wrong count: rows 264, 266 and 270 use
**`cancha`**, which is Latin-American where a peninsular course says `pista` or `campo`.
Three rows in one sample of 300 is a variety slip in the authored bank, scored `awkward`
on `register`. It is the text-side echo of the `accent_claim: unverified` problem below,
and it is falsifiable by a validator (a variety word-list at G6) in a way the accent is
not.

## `accent_consistency` is `null` on all 300 rows, and could not be otherwise

Founder ruling **B6** makes this dimension the only check there is: Spanish bakes on
Kokoro, whose three Spanish vectors declare no regional accent, so the manifest says
`language: es` + `accent_claim: unverified` and nothing in `coursekit` listens. `RUBRIC.md`
§"The sheet carries no audio today" states the consequence and `docs/P2-BLOCKERS.md` B18
carries it: `SampleItem` has no clip reference and no voice role.

Here it is worse than that: **G8 never ran**, so no bank exists to listen to. The dimension
is recorded as `null` — not `pass` — on every row in
`docs/owned/p2r3-reviewer-sample.json`, and it is absent from the `dimensions` object
entirely, because `REVIEW_DIMENSIONS` in `config/sample.py` is the five text dimensions and
a sixth key makes `read_scores` raise on the **whole file**. `"pass"` on a clip nobody
played would be the one lie this sheet exists to prevent, and Rosa-against-Plumas — the
blend question `cast.yaml`'s `D-CAST-ES-02` asks the reviewer specifically — is unanswered.

## What would change these numbers

1. **One green `coursekit build es`.** Everything above is over candidates and corpus rows,
   not exercises. Re-key the bank (proposed B19, in this task's owned file), author the 22
   empty slots, then redraw.
2. **The paid native pass.** This one is an Opus agent scoring an Opus agent's Spanish.
   `docs/RELEASE.md` item 1.
3. **A bake.** Until G8 runs, one sixth of the rubric is unscoreable and `accent_claim`
   cannot move off `unverified`.
