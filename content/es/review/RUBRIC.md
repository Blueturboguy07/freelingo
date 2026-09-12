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

Replacing the agent pass with a paid native pass is a change of **one field**:
`reviewer_kind` becomes `paid-native-speaker` and the note becomes empty. Nothing else
in the pipeline moves.

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

Read the row's `prompt`, `accepted_answers`, `distractors` and `source_text`. Judge it as
a **learner would meet it**, not as a corpus line: the question is whether an ordinary
educated speaker of peninsular Spanish (the course locale is `es-ES`) would accept the
exercise as correct and unremarkable.

Score the five dimensions, then give one verdict.

| Dimension     | Ask                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `meaning`     | Does the Spanish mean what the English says? Is any accepted answer a mistranslation?          |
| `grammar`     | Agreement, mood, clitics, prepositions, ser/estar, por/para.                                   |
| `naturalness` | Would a speaker say this, or is it grammatical and dead?                                       |
| `register`    | Is it inside the unit's declared register? No `vosotros`/`ustedes` mixing inside one exercise. |
| `answer_set`  | Is every listed accepted answer actually acceptable, and is an obvious correct answer missing? |

Each dimension is `pass` or `fail`.

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

Score `awkward` when only `naturalness` or `register` fails.

## The row format

One JSON object per line in `scores.jsonl`:

```json
{
  "exercise_id": "3f0c1a2b4d5e6f70",
  "verdict": "ok",
  "dimensions": {
    "meaning": "pass",
    "grammar": "pass",
    "naturalness": "pass",
    "register": "pass",
    "answer_set": "pass"
  },
  "reviewer": "opus-agent-reviewer",
  "reviewed_at": "2026-09-12",
  "note": ""
}
```

`exercise_id`, `verdict` and `reviewer` are required. `dimensions` keys must be the five
above. `note` is free text and is what a maintainer reads when a rate moves.

Score **every** row on the sheet. `coursekit`'s `unscored_items()` reports the ones you
did not, and an unscored sample has a rate of `None` — which does not pass the gate.
`None` is not 0%.

## What the rate is

```
wrong_item_rate = |{rows with verdict == "wrong"}| / |{rows scored}|
```

The denominator is rows **scored**, not rows drawn, and both numbers are published, so a
partially scored sheet cannot look like a clean one.
