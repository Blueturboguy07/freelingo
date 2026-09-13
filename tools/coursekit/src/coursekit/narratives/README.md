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

Remaining work: measured Radio finalization and independent source/target plans;
complete lesson+story+radio validator bridge;
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


## Radio source and draft compiler checkpoint

`radio.prepare_radio(source, analyse=..., cast=...)` accepts the exact authored JSON
string and analyzes every Spanish source/title/question surface. The callback takes
`(language, text)` and returns the complete current G1 record using
`sentence_id(language, text)`. The parser verifies exact token coverage, lexical and
display sequences, bilingual source fields, cast roles, unique questions/anchors and
supported input shapes. Source bytes, source JSON, all exact analyses/texts and cast
snapshot stay bound by `radio_preparation_hash`. A consistently rehashed analysis of
a different sentence still fails the source join. English translations are retained
for review; this parser does not claim English grammar or bilingual meaning approval.
This source revision supports Spanish with `l1_ratio=0`. Mixed-language episodes need
an explicit per-segment language/analysis carrier and currently fail by name.

`preflight.inspect_radio_source(prepared, units, grammar=..., perplexity=...)` takes the
actual complete G3 unit records and the existing configured language engines. It
checks declared curriculum allowance/register on every source surface, applies the
unchanged G6 grammar issue types/perplexity band and names actual engine availability
or degradation. A failed call is a rejection, not zero errors. It also rejects a
listen-select distractor heard in the final anchored segment, which must be present
in every legal whole-segment window ending at that anchor. This is a bounded source
preflight, **not** the combined `coursekit validate` V1–V12 gate. Its report explicitly
retains exact-pack-targets, independent-review, combined-pack-validation and measured-
audio requirements.

`targets.load_radio_targets(pack_path, expected_sha256=..., references=[...],
maximum_unit_index=...)` reads a concrete immutable SQLite snapshot. Each reference
is exactly `{exerciseId, schedulerItemId, surfaceId}`. It verifies actual pack bytes,
selected runtime payload hashes, exercise placement, actual SQL lexeme definitions
and tags, and the matching declared lexical/scheduler surface. It retains full
reviewed lexical semantics, countability/classification, source/review hashes and
runtime payload hash. The caller must supply the expected verified or build-approved
pack digest: this helper is not a signature verifier or a decoder for every grading
family. Missing runtime targets in an older pack fail explicitly. It never selects
the first lexeme/tag by text or constructs a scheduler ID from a label.

`radio_draft.compile_radio_draft(prepared, plan, targets)` compiles a nonplayable
`RadioDraft`. Its source plan is closed:

```text
{schemaVersion:1, sourceSha256, preparationSha256, packSha256, author,
 introEndSegment, questions:[...]}
comprehension question = {id, targets:[binding, ...]}
matching question = {id, pairs:[binding, ...]}
listenSelect question = {id, listenFromSegment, tiles:[binding, ...]}
binding = {lemma, target:{exerciseId,schedulerItemId,surfaceId},
           occurrence:null | {segmentId,tokenIndex}}
```

Bindings retain source claim order and explicit pack target surfaces. A heard target
must match an exact source token's surface, lemma and POS within the declared window;
unheard distractors explicitly have no occurrence. The compiler rejects duplicate
visible surfaces, missing/future targets, wrong intro boundaries, omitted questions,
and any offered lemma heard in the listening window but labelled a distractor.
Comprehension targets must occur in the authored accepted answer and source; matching
pairs must occur before their anchor. All three shapes keep the actual declared
scheduler item IDs and separately preserve reviewed word-counter identities.

Draft question anchors are `afterSegment`, not `atMs`; matching pairs have no audio
URI. Drafts have no episode audio object or baked flag and cannot be used as a typed
`RadioEpisode`. The measured finalizer still needs actual cast-backed segment, pair,
intro and outro assets, exact durations, one stitched episode asset and its offsets,
freshness/alignment/loudness evidence, and the combined three-pipeline byte budget.
An authored `target_duration_ms` is never a measured duration.

`preflight.select_radio_draft(candidates, reviews)` selects the first eligible exact
reviewed draft and records preceding discards. Review rows contain
`{candidateSha256, reviewer, verdict:'accept'|'reject', date, note}`; the hash comes
from `radio_review_hash(draft, source_check)` and includes source, plan, analyses,
pack targets and all bounded check evidence. The reviewer must differ from both the
source author and plan author. Selection does not repair or overwrite a rejected
candidate and does not approve missing audio or the combined pack gate.

Local evidence for this checkpoint is under `/private/tmp/p6-radio-preflight-20260913/`.
The actual configured Spanish adapter and LanguageTool 6.6 prepared three preserved
sources and checked 81 Spanish surfaces. No grammar/spelling or register findings
were returned, with `grammar_only` explicitly recorded because no perplexity model
was supplied. There are 47 surface-level vocabulary rejections against the exact
isolated G3 snapshot and one heard-distractor defect: `03-la-lluvia:q2` offers
`ventana` as wrong although its anchored `s6` says `junto a la ventana`. No candidate
is eligible for a draft. `01-el-mercado:q2` additionally needs the explicit heard
`manzanas` occurrence rather than an inferred singular `manzana` surface. These are
preparation findings, not independent review or a phase/release gate result.

The 90 Radio tests include original source, SQL and engine fixtures; they certify no
production content. Twelve isolated guard-removal mutants were killed with a green
control (`/private/tmp/p6-radio-mutations/results.json`). The rehashed-text mismatch
was separately observed RED before correction. The broader check logs use
`/private/tmp/p6-radio-final-*`; no native playback or rendered/audio-success claim
is made by these checks.


The full-tree scanner additionally exposed a held Story parser issue. Hint spans now
come from the supplied lexical token analysis; only explicit `~` joins phrase spans.
Glosses use a DSL field lexer, and the two independent test fixture analyzers have
explicit test-only scanner entries. A two-token compound witness failed under the
old regex segmentation before the correction. The source-code exception list and
scanner patterns are unchanged. The corrected Python suite reports 1,301 passed,
3 skipped and the one optional live SimAlign test deselected in 45.992 seconds
(`/private/tmp/p6-radio-final2-python.xml`); the original scanner failure remains
preserved in `/private/tmp/p6-radio-final-python.log`.

The same checkpoint's required JavaScript checks passed: 1,352 tests passed and
7 skipped in 102.05 seconds, with lint, root/mobile typechecks and coverage mapping
all exit 0 (`/private/tmp/p6-radio-final2-{js,lint,typecheck,coverage}.log`). These are
repository checks; they do not render the media player or bake any audio.
