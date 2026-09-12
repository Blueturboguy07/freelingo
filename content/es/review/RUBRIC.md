# Spanish reviewer rubric (H1)

The pack's published **wrong-item rate** is produced by scoring a 300-item stratified
sample against this rubric. `scope2/00` §2.4 calls it H1, beneath the twelve mechanical
validators; the plan's non-negotiable 5 makes it a gate: a pack ships only at or below
**2%**, and the measured rate is shown to the learner on the S001 pack card and in
S137 About.

## Who is scoring, and what that means

**This run has no paid native reviewer.** The scores in `scores.jsonl` are produced by
the phase's Opus reviewer agent. That is a real second pass over content the pipeline
authored, and it is not the thing `scope2/00` H1 describes. So every number derived from
this file carries, verbatim — as do `docs/pack-provenance.md` and
`tools/coursekit/README.md` today, and the pack manifest's `review` block and the S001
card once G9 and P3 build them:

> PROVISIONAL (unreviewed by a paid native speaker)

The string lives in `tools/coursekit/src/coursekit/config/sample.py` as
`PROVISIONAL_DEFECT_RATE_NOTE` and `tests/test_sample.py` opens both committed carriers
and asserts it appears verbatim in each, because a sentence that has to read identically
in four places and is typed four times says something different in one of them.

Founder ruling **B3** (2026-09-12) settled what that buys and what it does not:

> P3 proceeds. The 300-item sample is scored by an Opus reviewer as
> `REVIEWER_KIND_AGENT`; the manifest and S001 card carry
> `PROVISIONAL (unreviewed by a paid native speaker)` verbatim; `gate_passed()`
> accepts an agent-scored rate ≤ 2 % for
> the automated run; the paid native review is a **release prerequisite** listed in
> `docs/RELEASE.md`.

So an agent-scored rate unblocks **P3** and does not unblock a **release**. The paid pass
is item 1 of `docs/RELEASE.md`, ahead of everything else on that page, because it is the
only prerequisite that can invalidate work already done (plan §Risks 7).

Replacing the agent pass with a paid native pass is a change of **one field**:
`reviewer_kind` becomes `paid-native-speaker` and the note becomes empty. Nothing else
in the pipeline moves. The draw is deterministic under its recorded seed, so the 300 rows
a paid reviewer scores later are the same 300 rows the agent scored.

## How to draw the sheet

```sh
cd tools/coursekit
uv run coursekit build es          # G0-G9
uv run coursekit sample es         # 300 items, seed 20260911
# or: uv run coursekit sample es --set n=300 --set seed=20260911
```

The draw is stratified over `(unit_index, exercise_type, provenance)` and deterministic
under the recorded seed, so the sheet can be redrawn and audited. It lands at
`build/es/sample-300.jsonl`, with `build/es/sample-summary.json` recording the seed and
the per-stratum allocation.

## How to score one row

Read the row's `prompt`, `accepted_answers`, `distractors` and `source_text`, and — for
the accent dimension below — listen to the row's clip. Judge it as a **learner would meet
it**, not as a corpus line: the question is whether an ordinary educated speaker of the
variety the course teaches would accept the exercise as correct and unremarkable.

The course declares `language: es` with `accent_claim: unverified`, not `locale: es-ES`
(founder ruling **B6**). The written variety this course teaches is still the peninsular
one — `tú`/`vosotros`, `distinción` orthography, the accepted-answer sets — so judge the
**text** as an educated peninsular speaker. Do not read the accent claim into the text
dimensions or the text into the accent dimension; they are scored separately and for
different reasons.

Score the six dimensions, then give one verdict.

| Dimension            | Ask                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `meaning`            | Does the Spanish mean what the English says? Is any accepted answer a mistranslation?          |
| `grammar`            | Agreement, mood, clitics, prepositions, ser/estar, por/para.                                   |
| `naturalness`        | Would a speaker say this, or is it grammatical and dead?                                       |
| `register`           | Is it inside the unit's declared register? No `vosotros`/`ustedes` mixing inside one exercise. |
| `answer_set`         | Is every listed accepted answer actually acceptable, and is an obvious correct answer missing? |
| `accent_consistency` | Does the clip sound like one accent, the same cast, and the variety the course teaches?        |

Each dimension is `pass` or `fail`.

**All six keys are declared in code**, as of the P2 round-3 integration.
`REVIEW_DIMENSIONS` in `tools/coursekit/src/coursekit/config/sample.py` is
`("meaning", "grammar", "naturalness", "register", "answer_set", "accent_consistency")`,
and the spelling is not free: a `dimensions` key that is not in that tuple makes
`read_scores` raise `ScoreError` and the **whole scored sheet produces no rate at all** —
not a lower rate, no rate, including the dimensions that were scored correctly.

`accent_consistency` was the one cross-lane contract in this rubric that could break
something, filed in `docs/owned/p2r3-provenance-docs.json` with its exact spelling
because the lane that wrote this file could not edit `config/sample.py`. The integrator
landed it. Round 4 then closed B18: each drawn row now carries the joined G8 `clip_path`,
`clip_id`, `voice_role`, `voice_name`, `clip_engine`, and `clip_text`. The dimension is
scoreable only when `has_audio` is true. If `clip_path` is null, the honest value remains
`null`, never `pass`.

## `accent_consistency` — the dimension that is the only check there is

This dimension exists because of founder ruling **B6**, and it is load-bearing rather
than thorough. Read this section before scoring it; it is the one dimension where a
`pass` means something the rest of the toolchain cannot say.

### Why it is here

The approved plan named **Azure Neural** as the voice vendor, and Azure publishes a
locale sub-tag per voice — so `es-ES` used to be a vendor-backed, machine-checkable fact.
No cloud credential exists in this build environment, so Spanish is baked on **Kokoro**,
whose three Spanish style vectors (`ef_dora`, `em_alex`, `em_santa`) are tagged `e`
(Spanish) and **nothing finer**, and whose Spanish G2P path is generic espeak-ng. No
peninsular phonology is asserted anywhere in the toolchain.

Ruling B6 followed the fact rather than the plan:

> Kokoro is the voice engine for es/fr/ja (Piper build-time only for de). Manifests
> replace `locale: es-ES` with `language: es` + `accent_claim: unverified`; the reviewer
> rubric checks accent consistency; the two blended cast roles stay, declared in
> `cast.yaml`.

`accent_claim: unverified` is honest about the vendor, and it is not a check. **Nothing
in `coursekit` can falsify a Latin-American-sounding course.** V1–V12 and F1–F5 read
text, licences, bands, difficulty and bytes; none of them listens. This 300-item sample
is the last place it can be caught before a learner hears it, which is why the dimension
is a scored column and not a paragraph of advice.

### What to listen for

Three questions, in this order. A `fail` on any of them is a `fail` on the dimension, and
the `note` says which.

1. **Is it one accent?** Play the row's clip against two or three others from a different
   unit. The failure this catches is a bank that drifts — some rows seseo, others
   distinción; some rows with a Latin-American intonation contour, others peninsular.
   One consistent accent that is not the peninsular one is a **different finding** from a
   bank that mixes, and both are failures, so say which in the note.
2. **Is it the variety the course teaches?** The written course is peninsular. A clip
   that is consistently and recognisably Latin American under a course whose text teaches
   `vosotros` is the exact defect `accent_claim: unverified` admits the project cannot
   see. If you cannot tell — Kokoro's Spanish is generic by construction, so "neutral,
   unplaceable" is a real answer — score `pass` and write `unplaceable` in the note. A
   dimension that punished honesty here would just get gamed.
3. **Is it the same cast, row to row?** Each role is a fixed voice for the whole course
   (`content/es/cast.yaml`). A character whose timbre changes between units is a bake
   defect, not an accent one, and this is the only pass over the bank that would see it.

### The two blended roles, and the specific question `cast.yaml` promises you

Kokoro ships **three** Spanish voices and the cast wants **four**, with two female roles
against one female vector. So two of the four roles are **deterministic weighted blends**
of stock vectors, declared in `content/es/cast.yaml` as `D-CAST-ES-02`:

| Role           | Voice            | Weights                          | Rate |
| -------------- | ---------------- | -------------------------------- | ---- |
| `narrator`     | Plumas — stock   | `ef_dora` 1.0                    | 1.00 |
| `adult_male`   | Mateo — stock    | `em_alex` 1.0                    | 1.00 |
| `adult_female` | Rosa — **blend** | `ef_dora` 0.70 + `em_santa` 0.30 | 0.98 |
| `young`        | Nico — **blend** | `em_alex` 0.55 + `ef_dora` 0.45  | 1.08 |

`cast.yaml`'s own caveat on Rosa names the question this sheet has to answer, so it is
asked here explicitly:

> The reviewer sample asks about this row specifically — whether Rosa reads as a
> different speaker from Plumas. If she does not, the fix is a different blend or a
> second vendor, never a silent swap.

So on any row whose clip is **Rosa** or **Nico**, answer one extra question in the note:
**does this read as a different person from the stock voice it is blended out of?** Rosa
against Plumas (`ef_dora` is 70% of her), Nico against Mateo (`em_alex` is 55% of him).
"Sounds like the same person, slightly slower" is a `fail` with `blend-indistinct` in the
note. Blends are deterministic and reproducible to the bit, so a `fail` here is
actionable: it is a weight change and a re-bake, not a mystery.

### How the dimension is reported, and why it is not in the 2% gate

An accent finding is **not** a wrong item. A learner meeting a clip in the wrong accent
is not taught something false, so folding it into the wrong-item rate would make the 2%
gate mean two things at once — the same reason `awkward` is published separately.

- A row whose **only** failing dimension is `accent_consistency` takes the verdict
  `awkward`, and the note must begin `accent:` so the two can be told apart in the
  awkward count.
- The dimension's own **pass rate over rows that have audio** is what the accent question
  is answered from, and it is reported beside the wrong-item rate rather than inside it.
- There is deliberately **no numeric accent threshold invented in this file.** A
  threshold belongs in `config/sample.py` beside `MAX_DEFECT_RATE`, where the code can
  enforce it; a number that lives only in prose is a number nothing checks. What this
  rubric asserts instead is the qualitative rule that does not need a constant: **a
  systematic finding falsifies the claim.** One odd row is a clip to re-bake. A whole
  role, or a whole bank, reading off-claim means `accent_claim` cannot be raised above
  `unverified` and the remedy is a different blend or a second vendor.

### The sheet carries the baked clip and cast role

Round 4 joins each exercise's `audio_ref` through G8's baked-clip records and
`cast.yaml`. A reviewer uses `clip_path` to play the exact packed bytes and
`voice_role`/`voice_name` to group Plumas, Diego, Rosa, and Nico. A row with
`has_audio: false` remains unscoreable and takes `accent_consistency: null`.

### If the constant does not carry it yet

`read_scores` raises on a `dimensions` key outside `REVIEW_DIMENSIONS`, and the tuple in
`config/sample.py` is owned by the validator/sample lane, not by this file. It carries
`accent_consistency` since the P2 round-3 integration, so this section is a fallback for
a tree where it does not — check, rather than assume either way. If you are scoring a
sheet whose `REVIEW_DIMENSIONS` has no `accent_consistency`:

**do not put the key in `dimensions`** — it would throw away the whole sheet's rate.
Record the finding in `note`, prefixed `accent:`, and take the `awkward` verdict as
above. The rate you publish is then a text-only rate, and the accent question is answered
in prose until the constant catches up.

## The three verdicts

The verdict vocabulary is closed (`config/sample.py::REVIEW_VERDICTS`) and a row with
anything else is a hard error in `read_scores`, never a silently dropped row — a verdict
the tool cannot read would vanish from the denominator and flatter the rate.

| Verdict   | Means                                                                                         | Counts as a defect |
| --------- | --------------------------------------------------------------------------------------------- | ------------------ |
| `ok`      | A learner meeting this loses nothing.                                                         | no                 |
| `awkward` | Understandable and defensible, but a speaker would phrase it differently. Stilted, not wrong. | no                 |
| `wrong`   | The learner is taught something false, or a correct answer is marked wrong.                   | **yes**            |

**`awkward` is reported separately and never folded into the wrong-item rate.** "A native
speaker would not say it this way" and "this is not Spanish" are different claims, and
the published number is about the second one. Folding them together makes 2% mean
nothing. The awkward rate is published beside it.

Score `wrong` when **any** of these is true:

- `meaning` fails — the pair does not mean the same thing;
- `grammar` fails in a way a teacher would correct;
- `answer_set` fails because a listed accepted answer is **not** acceptable (the learner
  is taught an error) **or** because the single most obvious correct answer is missing
  (the learner is marked wrong for being right — the reference product gives no typo
  grace, so the enumerated set _is_ the whole tolerance budget);
- a distractor is in fact a valid answer.

Score `awkward` when only `naturalness`, `register` or `accent_consistency` fails. An
`accent_consistency`-only failure takes a `note` beginning `accent:`, because it is a
different problem with a different fix from a stilted sentence and the two would
otherwise be one number.

## The row format

One JSON object per line in `scores.jsonl`. **Copy this row, exactly as it is**, and change
the values:

```json
{
  "exercise_id": "3f0c1a2b4d5e6f70",
  "verdict": "ok",
  "dimensions": {
    "meaning": "pass",
    "grammar": "pass",
    "naturalness": "pass",
    "register": "pass",
    "answer_set": "pass",
    "accent_consistency": null
  },
  "reviewer": "opus-agent-reviewer",
  "reviewed_at": "2026-09-12",
  "note": ""
}
```

`exercise_id`, `verdict` and `reviewer` are required. `dimensions` keys must all be in
`REVIEW_DIMENSIONS`; a key outside it is a hard error on the whole file, never a dropped
row. `note` is free text and is what a maintainer reads when a rate moves.

`accent_consistency` is present and null in the canonical form because the example does
not point at a real drawn row. On a row with `has_audio: true`, listen to `clip_path` and
replace null with `pass` or `fail`. `read_scores` accepts only those values (or null) and
refuses arbitrary truthy strings such as `"yes"`.

For example, a row whose clip was played and failed the accent check is:

```json
{
  "exercise_id": "3f0c1a2b4d5e6f70",
  "verdict": "awkward",
  "dimensions": {
    "meaning": "pass",
    "grammar": "pass",
    "naturalness": "pass",
    "register": "pass",
    "answer_set": "pass",
    "accent_consistency": "fail"
  },
  "reviewer": "paid-native-speaker",
  "reviewed_at": "2026-10-01",
  "note": "accent: consistently Latin American under a vosotros course"
}
```

Keep the value null on any row whose `has_audio` is false. `coursekit validate` rejects
`pass` or `fail` against a row with no playable clip; `"pass"` on a clip nobody played
would be the one lie this sheet exists to prevent.

Score **every** row on the sheet. `coursekit`'s `unscored_items()` reports the ones you
did not, and an unscored sample has a rate of `None` — which does not pass the gate.
`None` is not 0%.

## What the rate is

```
wrong_item_rate = |{rows with verdict == "wrong"}| / |{rows scored}|
```

The denominator is rows **scored**, not rows drawn, and both numbers are published, so a
partially scored sheet cannot look like a clean one.
