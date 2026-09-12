# Pack provenance — what a pack claims, and who checked it

Three surfaces render what is on this page, and they are the reason it exists rather than
living in a code comment:

| Screen   | Renders                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S001** | the course-picker card: `A1 · CEFR-checked` / `Beginner · frequency-ordered`, `{{n}}% machine-authored`, `measured wrong-item rate {{n}}%`, size |
| **S002** | pack detail: sample sentence, item count, size, **validator-report summary**                                                                     |
| **S137** | About: licences, content provenance, measured defect rate, version                                                                               |

The product map marks all three `[DEPART D-HONEST]`. The departure is the point: a
learner can see how the course was made and how well it was checked, which is a thing the
reference product does not show. A number rendered there without its provenance is worse
than no number, because it makes the same claim as a number somebody paid to verify.

## The claims, and what backs each one

| Claim on the card         | Produced by                                               | Backed by                                                          |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| CEFR level                | G3 section assignment, checked against CEFRLex (es/fr)    | `config.CEFR_LANGUAGES`; de/ja read `Beginner · frequency-ordered` |
| `{{n}}% machine-authored` | the `selected_item` / `candidate` split at G4-G5          | counted over the shipped-item join                                 |
| validator-report summary  | `coursekit validate`                                      | `build/<lang>/validator-report.json`                               |
| measured wrong-item rate  | `coursekit sample` + `content/<lang>/review/scores.jsonl` | the rubric in `content/<lang>/review/RUBRIC.md`                    |
| licences and attribution  | V10, over every shipped sentence                          | the credits surface S152 (INV-PACK-17)                             |
| signature                 | `coursekit sign`                                          | `packages/schema/keys/pack-signing.pub`                            |

## The honesty string

The Spanish pack's wrong-item rate for this run is **not** measured by a paid native
speaker. `scope2/00` §2.4 H1 describes a native-speaker pass; the plan budgets $300-800
per language for one; this run has none. What it has instead is a second pass by the
phase's Opus reviewer agent against a written rubric.

So every rate this pipeline publishes carries, verbatim:

```
PROVISIONAL (unreviewed by a paid native speaker)
```

It is a constant — `PROVISIONAL_DEFECT_RATE_NOTE` in
`tools/coursekit/src/coursekit/config/sample.py` — so that it cannot be paraphrased in
one carrier and not another. There are **two places that exist today** and two that are
future work:

| Carrier                                       | State                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| this document                                 | carries it now                                                          |
| `tools/coursekit/README.md`                   | carries it now                                                          |
| the S001 pack card, beside the rate           | **does not exist yet** — S001 is P3, and no app screen renders anything |
| the pack manifest's `review` block (and S137) | **does not exist yet** — G9 writes the manifest, in the p2-g9 lane      |

`tools/coursekit/tests/test_sample.py::test_the_honesty_string_is_exactly_what_the_docs_promise`
opens the two committed carriers and asserts the constant appears verbatim in both — a
test that only compared the literal to itself would stay green through a doc edit that
softened the wording, which is the whole failure this constant exists to prevent. A
second test, `test_the_docs_do_not_claim_the_note_already_appears_where_it_cannot`,
fails if this section starts describing the two unbuilt carriers in the present tense.
Meanwhile
`test_validate_runner.py::test_the_summary_never_reports_a_rate_without_its_provenance`
pins the rule that `summarise()` cannot emit a rate without it. Only
`reviewer_kind == "paid-native-speaker"` clears the note, and clearing it is a one-field
change — nothing else in the pipeline moves when a real reviewer is hired.

## What "unscored" renders as

An unscored or partly scored sample has **no rate**. `wrong_item_rate` is `null`, not 0,
and `gate_passed()` is false. `None` is not 0%: a sample with no numerator is not a clean
pack, and a screen that rendered `0%` there would be the single most misleading number in
the app.

Both `sample_size` (rows drawn) and `scored` (rows a reviewer actually judged) are
published, so a partly-scored sheet cannot be mistaken for a complete one.

`awkward` verdicts — "a speaker would phrase it differently" — are counted and published
**separately**. Folding them into the wrong-item rate would make the 2% gate meaningless
in both directions.

## The validator report

`build/<lang>/validator-report.json`, written by every `coursekit validate` run and
copied into the pack manifest at G9. Schema: `tools/coursekit/src/coursekit/validators/report.py`.

The property that makes it worth rendering: **a validator that did not run is in the
report, with an outcome that says so.** `unregistered` and `skipped` are blocking
outcomes. A report that listed only the validators that executed would say "16 of 16
green" for a suite with a hole in it, and that sentence would be printed on a card
somebody reads before downloading 120 MB.

`summarise()` is the only thing a screen reads:

```json
{
  "status": "green",
  "line": "17/17 validators green",
  "declared": 17,
  "green": 17,
  "not_run": 0,
  "blocking_findings": 0,
  "warning_findings": 1,
  "hard_gate_passed": true,
  "wrong_item_rate": null,
  "wrong_item_rate_note": "PROVISIONAL (unreviewed by a paid native speaker)",
  "reviewer_kind": null,
  "reviewer_sample_size": 0
}
```

`hard_gate_passed` is V1-V4 specifically, which is the plan's P2 gate row ("V1-V4 100%").
The other thirteen must be green for the pack to ship at all; those four are called out
because they are the i+1 promise itself.

## Reproducing any of it

```sh
cd tools/coursekit
uv sync --locked
uv run coursekit build es                 # G0-G9
uv run coursekit validate es              # writes build/es/validator-report.json
uv run coursekit sample es                # writes build/es/sample-300.jsonl, seed 20260911
PACK_SIGNING_KEY=… uv run coursekit sign es
```

The sample is deterministic under its recorded seed, so a reviewer's 300 rows and a
maintainer's 300 rows six weeks later are the same 300. That is what makes an audit of
the published rate possible at all.
