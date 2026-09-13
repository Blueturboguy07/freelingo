# Narrative authoring checkpoint — 2026-09-13

This module is an incomplete P6 preparation checkpoint, not a shipping pipeline.
`compile_story` parses the Story DSL with exact analyzer spans and caller-provided
real pack item IDs. It preserves explicit bilingual translations and source hashes;
parsing does not certify language quality. Unknown blocks stay visible as ERROR
rows. Review selection rejects missing, stale and same-author review evidence.

Wire spans are UTF-16. CONTINUATION carries `spokenText` with the hidden answer
omitted; the next player/bake integration must consume and hash this exact speech
variant. That integration is not implemented yet, so these source candidates must
not be inserted into a playable pack. The existing player still speaks `content.text`.

The six original Story files and three Radio JSON files are preserved under
`content/es/{stories,radio}`. They are unreviewed candidates, have no rendered covers,
no baked audio, no measured episode durations, and no scored sample. Current compiler
outputs set `bakedAudioComplete` false. No content from this checkpoint is signed.

Remaining work: Radio compiler; complete lesson+story+radio validator bridge;
independent exact-source bilingual/answer review; legitimate vocabulary/placement
resampling; phrase hints and covers; cast-backed Opus bake with measured loudness,
durations and total three-pipeline bytes; truthful alignment/freshness evidence;
G9 packaging; native background/lock-screen/scrub and audio-match evidence.

Local diagnostic `/private/tmp/p6-language-probe.json` checked real spaCy exact spans,
registers and LanguageTool 6.6 Spanish grammar/spelling on 120 Story lines/header
and 49 Radio segments. All returned no LanguageTool matches and passed the register
predicate. It did not check translation meaning, English grammar, perplexity,
V1–V12 or the scored sample. Its raw vocabulary census found future or unallocated
lemmas; it is not a passing content gate. Candidate revisions after rejection must
preserve the rejected source and be reviewed as new candidates.
