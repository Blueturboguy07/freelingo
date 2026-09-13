# Spanish H1 review — P2 round 4

`content/es/review/scores.jsonl` is the independent agent review of the real 300-exercise
sheet at `/Users/mannbellani/freelingo/build/es/sample-300.jsonl`, drawn with seed
`20260912`. The sheet contains 300 unique exercise ids across 30 units and seven exercise
types. All 300 ids join the scores file.

> PROVISIONAL (unreviewed by a paid native speaker)

Reviewer kind: `opus-agent-reviewer`. This pass may unblock P3 only when its measured
wrong-item rate is at most 2%. It does not replace the paid-native release prerequisite.

## Result

| Verdict | Rows | Rate |
| --- | ---: | ---: |
| `wrong` | 51 | **17.00%** |
| `awkward` | 22 | **7.33%** |
| `ok` | 227 | 75.67% |

The 2% gate is **RED**: 51/300 is above 6/300. The scores were not adjusted to obtain a
pass. Failing dimensions were: `answer_set` 37, `meaning` 8, `grammar` 6,
`naturalness` 21, and `register` 1. `awkward` remains separate from the wrong-item rate.

The largest hard-defect class is `answer_set`: obvious pro-drop, gender, or lexical
alternates are absent, and multiple context-free cloze distractors are valid answers.
The match shape also fails systematically: examples include `solicitar = that`,
`alcanzar = was`, `encargar = of`, `estar = is`, singular/plural mismatches, and several
tense mismatches. Other hard findings include `Yo soy mal señor`, a duplicated cloze stem
that produces `TienesTienes`, `en la izquierda`, `lápices = pens`, and `está pesada` for
an inherently heavy backpack. Every affected row carries its specific note in
`scores.jsonl`.

## Audio and accent evidence

The sheet has 80 audio-bearing rows. All 80 referenced files existed and `ffprobe`
decoded their containers successfully: Opus, mono, 48 kHz; duration range 0.924–2.972 s;
byte range 3,370–8,962. Every drawn audio row is narrator/Plumas. Thus the draw contains
no Rosa or Nico row and cannot answer the rubric's blend-distinctness question.

The reviewer interface could not deliver local audio bytes to the model for auditory
inspection (its audio handoff explicitly returned `audio content omitted because you do
not support audio input`). Container validation is not listening and cannot establish
accent, timbre, or cast consistency. Consequently `accent_consistency` is `null` on all
300 rows, including the 80 with playable bytes; it is never marked `pass`. Each audio row
records that limitation in its note. The pack's `accent_claim` therefore stays
`unverified`.

## Reproduction and audit

`score_round4.py` is a decision table, not an automated language judge. It checks three
sentinel ids and the 300-row unique draw before materialising the reviewed rows. The
review was performed against prompt, accepted answers, distractors, source text and
translation. The mechanical rate was then recomputed by `coursekit.sample.review_summary`
over the intersection of the sheet ids and scored ids.

Commands used for the audio evidence and review gate:

```text
ffprobe -v error -show_entries stream=codec_name,sample_rate,channels,duration \
  -show_entries format=duration -of json <each of 80 clip paths>
python3 content/es/review/score_round4.py \
  /Users/mannbellani/freelingo/build/es/sample-300.jsonl \
  content/es/review/scores.jsonl
uv run pytest tests/test_sample.py tests/test_sample_accent.py
```

This result is a content failure, not a tooling failure: the sheet is complete, every row
is scored, every score joins, and the measured rate is above the threshold.
