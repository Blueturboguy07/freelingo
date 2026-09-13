# Spanish production grading carrier — revision 1

Frozen interface, 2026-09-13. This directory documents the producer contract; it does
**not** contain a completed production policy, ranked surface catalog, explanations,
or current language approvals. The existing RED Spanish pack remains diagnostic.
No fixture vocabulary, preferred-answer index or old prompt parser supplies these
missing fields. A missing input raises `GradingBuildError`.

## Callable boundary and ownership

`coursekit.packbuild.grading.build_grading_payload(GradingBuildInputs)` returns a
`GradingPayload` with `metadata`, `runtime_items`, `provenance` and `word_rows()`.
It performs no downloads, database writes, build-root discovery or default policy
selection. The current producer supports Spanish courses with Spanish and English
response profiles. Other languages and script/reading item shapes fail explicitly.

Root integrates the shared G7 carrier, G9 tables and `LoadedPack` read side. Pass the
actual rows G9 will write, including `exercise_id`, `item_id`, `unit_id`,
`lesson_index`, `prompt`, `accepted_answers_json`, the complete `exercise_tags`
(`exercise_item_tag`) rows, and actual declared lexeme IDs
with lemma/POS. The producer never reconstructs a semantic item ID from a label.
Each actual exercise needs exactly one matching draft. Source placement, current
accepted set and rendered instruction/body must agree with those actual rows.

`approval_check(source, approval)` is a **required trust boundary**, supplied by the
G9 adapter. It must call the real validator for the current complete selected
population and successful G6 run, or the independently reviewed glossary proof for
a lexical item. It must validate all projected `spanish`, `english` and `pairs`
surfaces against that proof, its exact source snapshot and current run. Merely
checking a run ID, digest, status, or caller-authored success boolean is insufficient.
This pure producer cannot independently reproduce language-engine execution.

Every source snapshot contains its exact `unit_index`/`lesson_index`, `lang`, canonical
`text`/`translation`, and contextual analysis when token claims are made. A match
source binds all five reviewed glossary entries. Each approval projection has
`sourceSha256`, a nonblank `runId`, the language-specific approved surface arrays,
and exact `pairs` when relevant. Additional upstream proof fields are preserved in
its hash. SHA256 is over UTF-8 canonical JSON (sorted keys, no spaces, Unicode
preserved), excluding only a review row's own `review` field when hashing a review.

## `grading:v1` metadata

The existing closed root remains:

```text
{schemaVersion:1, packId, courseId, packVersion,
 profiles:[{profileId,responseLanguage,configuration}],
 lessons:[{unitId,lessonIndex,profileId,register,punctuationEquivalenceClass,
   gradedPunctuation,taughtInflections,openResponseMinimumLength}],
 exercises:[{exerciseId,unitId,lessonIndex,profileId,responseLanguage}]}
```

`configuration` contains all the required fields declared in the core decoder;
absence never chooses a fixture or default language. Producer inputs set
`targetLanguageWords:null` only as a required placeholder, which the verified
`DictionaryInput` replaces. That null is never shipped.

The dictionary carrier is a closed discriminated object:

```text
{kind:'inline',words:string[],count,sha256,provenance}
{kind:'table',table:'grading_word',profileId,count,sha256,provenance}
provenance = {sourceId,sourceSha256,sourceUrl,license,notice,
              normalizationId,normalizationSha256,policySha256}
```

Raw word arrays fail the new carrier. All SHA fields use lowercase 64-digit hex.
The normalized dictionary digest covers unique UTF-8/BINARY-sorted surfaces, each
followed by LF. Words cannot contain CR, LF, NUL or unpaired surrogates. An inline
set verifies its count and digest. A table reference verifies its actual count and
uses the already install-verified signed SQLite payload for content integrity; it
does **not** claim to rehash millions of words whenever a lesson opens.

Root-owned table design:

```sql
CREATE TABLE grading_word (
  profile_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  PRIMARY KEY (profile_id, surface)
) WITHOUT ROWID;
```

`DictionaryInput` accepts restartable `source_chunks()` and sorted `surfaces()`
iterators, declared count/digest and provenance. It verifies the raw source hash,
then consumes the normalized stream to its count/hash end check. `word_rows()`
rechecks the streams on insertion. Consume it **completely inside the G9 transaction**;
a source change must abort rather than leave a partial word table. The producer
checks integrity of the supplied normalized artifact, not its linguistic coverage.
The producer also requires `policySha256 == content_hash(dictionary_policy(profile, lessons))`.
That exported projection binds the response language, the five normalization profile
fields and every matching lesson’s exact punctuation policy (ordered by unit ID and
lesson index). Changing a response or lesson policy invalidates the dictionary proof.
The normalization build must call the actual core `tier1Normalise` and
`foldThroughDiacritics` implementations with the explicit response/lesson policies,
preserve raw spellings and union every relevant lesson-policy lookup form. Empty
normalized strings are excluded explicitly; the raw evidence is preserved.

The runtime exposes a truthful `ReadonlySet`: exact parameterized indexed `has`,
verified `size`, and keyset-paged values/keys/entries/iteration/forEach. Pages contain
at most 256 rows; no complete multi-million-word Set is materialized.

## Structured draft and runtime row

Each input draft has these required fields:

```text
{record,shapeId,shapeEvidence,sourceId,sourceSha256,approvalId,approvalSha256,
 profileId,responseLanguage,surfaceIds,schedulerSurfaces,gradable,presentation,explanation,
 schedulerObjective?}
```

`record` is the current G7 record. `gradable` supplies the existing core
`GradableItem` fields other than `itemId` and top-level `accepted`, which are joined
from actual SQL rows and the reviewed surface catalog. Exact target-lexeme ID and
contextual surface must be paired; omit both only when the item teaches no single
target lexeme. Open responses require declared, actually taught keyword IDs.
Spanish shapes have meaning scheduler facets; no Japanese readings/ruby are guessed.

`presentation` is the exact existing `LessonChallenge` contract from
`packages/core/src/presentation/index.ts`: instruction and prompt are separate,
item/type/language/accepted answers bind to the actual exercise. Audio shapes require
the exact built audio reference. Optional rendering fields are checked, and controls
from another input shape are rejected. Assets still require the normal G8/G9 asset
and licence checks; a nonblank URI alone does not certify a baked file.

`shapeEvidence` is one of:

- `{kind:'simple'}` for ordinary typed, select, listening, speaking and open responses.
- `{kind:'word-bank',solutions:[{surfaceId,tileIds}]}`. Every accepted answer must be
  constructible from distinct tile occurrences under the declared join delimiter;
  grader and displayed tiles have the same exact IDs/text. Repeated words retain
  distinct occurrence IDs.
- `{kind:'gap-fill',template,gapIds,sourceSpan:{start,end}}`. The current Spanish
  producer supports the one proven gap emitted by G7. Offsets are Unicode code-point
  offsets over the exact source text. Replacing that span with the configured marker
  must produce the displayed template; every completed answer must have current
  language approval. Unsupported multi-gap cross products fail explicitly.
- `{kind:'match'}`. Exactly five semantic pairs must match the current approved pair
  set and authored accepted mapping. Visible left/right occurrence IDs are distinct
  from semantic lexeme IDs. Select shapes additionally bind visible options to the
  authored distractor set and exactly one accepted option.

A reviewed surface row is:

```text
{surfaceId,language,surface,rank,introduction,sourceIds,author,
 review:{reviewer,verdict:'accepted',sha256}}
introduction = null | {exerciseId,unitId,lessonIndex,when:'prompt'|'wrong-feedback'}
```

The surface ID is `sf_` plus the first 32 hex characters of the canonical JSON hash
of `[language, exactSurface]`. Rank is explicitly authored; array position never
supplies it. `sourceIds` permits a legitimate spelling shared by several reviewed
sources. Review must be independent and hash-matching. Introduction is an exact
presentation witness or explicit null, not an implicit prelearned state.

An explanation is an independently reviewed
`{exerciseId,text,sourceId,author,review}` row. It must be authored explanatory
content, not a copied prompt or generic fallback. The pure producer validates its
binding and review; the independent reviewer is responsible for its meaning.

Taught occurrences explicitly name
`{exerciseId,lexemeId,surface,sourceId,tokenIndex,unitId,lessonIndex}`. They join an
actual selected/presented source, exact contextual token and span, and actual
exercise placement. Mere corpus/reserve analysis does not count. A lesson view must
match the cumulative evidence through that precise lesson and response language;
future forms cannot leak backward. The app still records learner introductions
only from actual exposure events; loading this catalog does not preintroduce it.

Output runtime rows are closed revision-1 payloads:

```text
{schemaVersion:1,exerciseId,itemId,unitId,lessonIndex,profileId,responseLanguage,
 proof:{sourceId,sourceSha256,approvalId,approvalSha256,draftSha256},
 gradable,presentation,schedulerSurfaces,introductions:[{surfaceId,surface,language,when:'prompt'|'wrong-feedback'}],explanation:string}
```

Root chooses their shared SQL carrier. The producer also emits metadata/runtime/
surface-catalog/teaching hashes and dictionary proofs for build provenance.

## Dictionary candidate evidence and remaining production work

The locally installed LanguageTool 6.6 exporter provides Spanish POS dictionary 2.3
and English POS dictionary 0.6. These are separately licensed dictionary sources,
not the engine-only attribution row or CC BY-NC-SA course prose. Preserve their
upstream LGPL 2.1 notices and underlying English Moby/WordNet/12dicts notices in the
source registry and reachable credits. Source projects:
[Spanish](https://github.com/jaumeortola/spanish-dict-tools),
[English](https://github.com/languagetool-org/english-pos-dict),
[documented exporter](https://dev.languagetool.org/developing-a-tagger-dictionary.html).

A diagnostic candidate policy using the actual core functions produced 5,835,773
Spanish keys (SHA256 `27ce13faa806edcc9826f80bbb40dff9560e469bb410a78f49b9e0e65581e5b3`)
and 248,264 English keys (SHA256
`cbe61937ccac3320723ee8ebc2ecdf7968fd38584e8e4a1c7b12ad3f327801ad`). The English comma
and period entries produced two excluded empty normalization results; their raw
entries remain. This is measured preparation, **not** a production course-policy
approval or a claim that a finite dictionary contains every valid word.

Remaining production inputs: independently reviewed profile declarations, actual
current G6/glossary approvals, structured G7 drafts, explicit ranks/introduction
witnesses/explanations, source/credit integration and G9/LoadedPack runtime rows.
Fixtures prove executable joins and failure behavior only. No RED pack is rebuilt
or certified by this checkpoint.

Introduction witnesses are independently reviewed full visible surfaces, bound to the
same source and exact exercise placement. A `prompt` witness must equal the full
presentation prompt with an explicit matching `promptLanguage` and must be visible
under the actual player predicate (listening transcripts are hidden; chat and speaking
prompts remain visible). It may be outside the response-language accepted forms.
A `wrong-feedback` witness must equal `acceptedAnswers[0]` in the response language;
hidden alternatives never count. The app records a witness only after that named
surface is actually displayed, and only in the course target language. Decoding or
loading an item never introduces any surface, and a correct answer does not imply
that the wrong-answer feedback was shown.

The draft must explicitly declare `schedulerSurfaces:[{itemId,surfaceId,canonical}]`
using reviewed catalog IDs. The runtime expands each to
`{itemId,kind,itemRef,surfaceId,surface,language,canonical}` in the target course language. Ordinary
items have exactly one canonical for their actual SQL item ID and include every
accepted target-language form, so a matched Spanish alternative is scheduled under
its own exact surface. English reverse answers keep the explicit Spanish canonical.
Wrong attempts and successful nonmatching open responses use that canonical; they do
not imply that it was introduced. Match grids declare one canonical displayed target
form for each of the five semantic left lexeme IDs. Extra unaccepted alternatives,
missing current accepted forms, foreign-language targets, and unreviewed source
bindings fail. These declarations never replace the independent display receipts.


Every ordinary draft additionally supplies an independently reviewed
`schedulerObjective:{exerciseId,sourceId,sourceSha256,kind,itemRef,author,review}`.
`kind` is `lexeme` or `grammarConcept` for current Spanish shapes, and `itemRef`
names the actual declared lexeme ID or grammar-concept ID. It is joined to the
exact exercise tag; raw lemma tags resolve through the declared lexeme's lemma/POS.
A lexical objective must occur in its exact source analysis. A grammar objective
must equal the actual unit's declared concept. A sentence's mixed tags do not
identify its primary objective: missing review fails rather than choosing the
first tag. Match grids instead use each actual approved left lexeme, with no
ordinary objective declaration. The existing aggregate exercise `itemId` remains
the scheduler identity; the source objective proves its kind without changing it.
All alternate surfaces of one target retain the same objective. Script/grapheme
objectives remain unsupported until their actual source carrier is implemented.

`exerciseTagsSha256` binds all supplied tag rows ordered by exercise ID/kind/ref.
`objectiveDefinitionsSha256` binds all unit ID/index/grammar-concept fields and
lexeme ID/lemma/POS fields, sorted by ID. The writer compares both projections
against the actual inserted SQLite rows, along with the existing full exercise
row digest, before committing. This catches same-ID source-definition changes.

Speaking items require a current approval projection:

```text
speech:{policy:{algorithm:'stored-unit-f1-v1',threshold:0.7,
 fallback:'normalized-levenshtein-v1',fallbackThreshold:0.7,
 ignoredPunctuation:string[],fillers:string[]},
 analyses:[{text,analysis,japaneseScript?}]}
```

The mandatory current `approval_check` must validate these exact surfaces, native
analyses, and explicit normalization policy against the full upstream proof.
For Japanese it must also establish current independent reading approval; the
paired script's honest `unreviewed` field is structural evidence, not that approval.
There are no default punctuation/filler lists or invented readings. The pure
producer currently assembles Spanish courses; its separate speech helper also
validates already supplied Japanese evidence without making Japanese packs ready.

Each accepted spoken surface has exactly one native G1 record or G5 candidate
analysis. The canonical analysis must equal the source snapshot's analysis, and
alternates need their own. The producer derives ordered, duplicate-preserving units
from `ledger.speaking_tokens`, carrying exact code-point spans. Japanese requires
the full G1 analysis plus its validated paired script: contextual Mode-A token
readings and the exact whole-sentence reading are carried separately from the
analyzer's dictionary-linked lemma readings. Analysis, adapter, script and source
hashes bind those facts; no runtime tokenizer or reanalysis is used.

The optional runtime field `speech:SpeechEvidence` is mandatory for the speaking
family and forbidden elsewhere. The decoder checks its closed fields, spans,
accepted-surface IDs/order, exact source proof, response/target language and actual
pack `ledger_unit`. The speaking grader consumes only actual recognizer segments
(`segment`, `startTimeMillis`, `endTimeMillis`, `confidence`) when they align with
the full transcript. Otherwise it compares the exact written/baked reading through
the declared character fallback. Accepted speech returns the actual matched surface
ID. Empty normalized audio is distinct from a failed pronunciation; the existing
native/session amplitude gate remains upstream. Unit tests and synthetic SQLite
roundtrips do not claim that native speech was heard or production content approved.
