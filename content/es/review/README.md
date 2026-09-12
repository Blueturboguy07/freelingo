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
