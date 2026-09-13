# Spanish pack review

`RUBRIC.md` defines the six dimensions and the `ok`, `awkward`, `wrong` verdicts.
`scores.jsonl` holds one score per current sampled exercise and stays empty until that
review is performed. An empty, incomplete, duplicate or stale review does not pass H1.
Historical material is preserved under `history/`; it is not current score input.

Draw exactly 300 rows with `coursekit sample es`; round 5 uses seed 20260913, selected
before scoring. The local output is `build/es/sample-300.jsonl`. For CI review, download
the immutable `es-build-<sha>` artifact and verify `ci-source.json` and its sample hash.
Copy each row's `exercise_id` and exact `content_fingerprint` into the score. The complete
population fingerprint also binds unsampled exercises and actual audio bytes.

A valid clip is linked through `clip_id`, `clip_path`, `clip_sha256`, `voice_role`,
`voice_name`, `clip_engine` and `clip_text`. Portable paths resolve under the candidate
artifact's `g8/bank/`; final runtime artifacts place audio under `audio/`. Score accent
only after actually hearing the clip. Otherwise retain null and report that limitation.

Round 5 uses `reviewer_kind: codex-agent-reviewer`; historical Opus records retain
`opus-agent-reviewer`. The gate accepts a complete current agent review at <=2% wrong
under founder ruling B3. Every such rate is labelled verbatim:

> PROVISIONAL (unreviewed by a paid native speaker)

The paid native review remains a prerequisite in `docs/RELEASE.md`. An agent pass may
unblock P3; it does not authorize a release. Written Spanish is judged against the
rubric's peninsular variety. Audio retains `accent_claim: unverified`.
