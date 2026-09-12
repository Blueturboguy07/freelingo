# `content/es/review/`

The H1 human-review pass for the Spanish pack.

| File           | What it is                                                                    |
| -------------- | ----------------------------------------------------------------------------- |
| `RUBRIC.md`    | how a row is scored, what counts as a defect, and who is scoring in this run  |
| `scores.jsonl` | the 300 scored rows from the seed-20260912 round-4 sheet               |
| `score_round4.py` | the auditable decision table that materialises those rows          |

The current review is complete: 300/300 unique rows join the real sheet. It measures
**51 wrong (17.00%)**, **22 awkward (7.33%)**, and 227 ok. The 2% gate is therefore red;
the scores were not softened to produce a pass. See `scores-method.md` for findings and
reproducible counts.

The sheet to score is `build/es/sample-300.jsonl`, drawn by `coursekit sample es`. It is
not committed: it is reproducible output of a recorded seed, and `build/` is gitignored.

Read `RUBRIC.md` before scoring, and read the paragraph headed "Who is scoring, and what
that means" before quoting any number that comes out of this directory.

## Two things founder rulings changed on 2026-09-12

**An agent-scored rate unblocks P3 and does not unblock a release** (ruling B3). The gate
`coursekit` enforces accepts `reviewer_kind: opus-agent-reviewer` at ≤ 2%; the paid
native pass is item 1 of [`docs/RELEASE.md`](../../../docs/RELEASE.md), ahead of every
other release prerequisite, because it is the only one that can invalidate work already
done.

**The rubric now has a sixth dimension, `accent_consistency`** (ruling B6). Spanish is
baked on Kokoro, whose Spanish voices declare no regional accent, so the manifest says
`language: es` + `accent_claim: unverified` and nothing in `coursekit` can falsify the
accent of a shipped bank. This sample is the only check there is. Two caveats a scorer
needs before starting:

- the fresh sheet carries playable clip references for 80 rows, all narrator/Plumas;
- all 80 files passed Opus container/48 kHz/mono checks, but this reviewer interface could
  not present their sound to the model. `accent_consistency` is therefore honestly
  `null`, never `pass`; no Rosa/Nico row was drawn, so blend distinctness is unanswered.
