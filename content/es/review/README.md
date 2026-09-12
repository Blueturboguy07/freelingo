# `content/es/review/`

The H1 human-review pass for the Spanish pack.

| File           | What it is                                                                    |
| -------------- | ----------------------------------------------------------------------------- |
| `RUBRIC.md`    | how a row is scored, what counts as a defect, and who is scoring in this run  |
| `scores.jsonl` | one JSON object per scored sheet row; **empty until the reviewer agent runs** |

`scores.jsonl` is committed empty on purpose rather than omitted. `coursekit` treats an
absent file and an empty one the same way — no rows, so `wrong_item_rate` is `None` and
`gate_passed()` is `false` — and `None` is not 0%: an unscored sample does not pass the
2% gate by having no numerator. The file exists so the path a reviewer writes to is the
path CI reads from, and so a reviewer never has to guess where it goes.

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

- the drawn sheet carries **no clip reference and no voice role** today, so the dimension
  is unscoreable — `docs/P2-BLOCKERS.md` **B18**;
- the key must be in `REVIEW_DIMENSIONS` (`config/sample.py`) before it appears in a
  `dimensions` object. `read_scores` raises on an unknown key and the whole file then
  produces **no rate**, so `RUBRIC.md` §"If the constant does not carry it yet" gives the
  note-only fallback.
