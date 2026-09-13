# Narrative runtime contracts

`StoryDocument` is the JSON payload for `story.lines_json`. `RadioEpisode` (the sibling
`radio` module) is the payload for `radio_episode.transcript_json`; `anchors_json`
mirrors its authored questions. Both have an explicit wire version, content revision,
unit placement and stable ids. Content compilers own structure and language checks.
Core modules are pure and import no React Native or Expo code.

A saved `StoryState` or `RadioState` binds the exact content id/revision and a run id.
The App persistence adapter owns storing it in `course_session_state` and rejects an
unresolvable revision. The engine checks id/revision whenever document and state meet.
Audio ticks and scrubs use the same Radio anchor transition. Consumed anchors include
background skips: they cannot refire on rewind, but the foreground review can answer
previously skipped questions. Each question creates at most one attempt per run.

Completion emits `{canCommit, rewardTier, answers}`. It never writes XP or SQLite.
The App adapter must commit only on an explicit foreground completion, atomically
and idempotently by run id. `plainReplay` and `completed` select the existing economy
policy; they are not numeric XP promises. Each attempt contains scheduler item ids;
multiple morphemes on one heard tile are targets of that one attempt, not extra
question attempts. Background playback alone creates no attempts or reward writes.

Story hints are character spans. Hidden spans suppress intersecting hints and ruby;
legendary suppresses hints but does not affect ruby. Karaoke requires the exact own
asset, matching text and cast version, and real keypoints. The 50 ms media tick test
proves the discrete mapping algorithm; device scheduling latency still needs a
measured device run. Missing Radio assets require repair; there is no TTS escape.

Source: product map S101–S117, invariant sections 14/15 and appended STO rows,
founder-ratified EC-STO-01..29 (2026-09-11). Deep06's adversarial appendix supersedes
its original copy and empirical constants: five MATCH pairs is a warning, rewards
are parameters, and story/Radio chrome without reference screenshots is reconstructed.
