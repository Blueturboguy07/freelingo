# Reviewed conversation contract

Declared 2026-09-13. This is build evidence for P2; it does not change the frozen
exercise or SQLite schema. It does not approve any concrete dialogue, claim audio
was heard, or replace the scored 300-item review. Agent reviews remain provisional.

## Authoring and explicit plan

The caller first loads its authored `authoring/conversation-plan.json` with
`load_conversation_plan(lang, selected_sources, path=...)`. The JSON object has
exactly `schema_version: 1`, `lang`, canonical ISO `authored_on`, nonblank `author`
and `rationale`, and `expected_slots` as an explicit array of coordinate arrays.
Unit and lesson indices are positive integers; G4 slot indices are zero based and
must be nonnegative integers. Boolean coordinates, duplicates, missing/unselected
slots, unknown fields and missing files fail. An explicit empty array is allowed.
This file records the caller's plan, not successful review rows or language approval.

The caller supplies the returned `expected_slots`: exact `(unit_index, lesson_index, slot_index)`
occurrences from its independently chosen conversation plan. The loader requires one
reviewed row for each planned occurrence and refuses extras, duplicates and missing
rows. An explicitly empty plan has a different digest from a nonempty plan. Never
derive the plan from accepted rows in `conversations.jsonl` or silently drop a chat
because its evidence fails. Even non-chat selected slots are bound by the full
`source_population_digest`.

`resolve_conversation_roles(selected_reply, first_turn_source_id,
wrong_reply_source_id, ingested, analysed)` returns `first_turn`, `correct_reply`
and `wrong_reply`, each with `.snapshot()`, original `.source` and `.analysis`.
The correct reply is exactly the chosen `SelectedSource`. First and wrong roles must
join existing shippable G0/G1 records with the original owner and licence. Their
text IDs and complete analysis spans must match. All three texts are distinct.
No reserve candidate or newly invented text can stand in for a role.

An authored JSONL row has exactly these fields:

- `schema_version: 1`, `selected_reply: selected_reply.snapshot()`.
- `roles`: all three named roles, each `{source: role.snapshot(), pair: ...}`.
  A pair has an integer rubric `score`, explicit `judgement`, and whole-sentence
  `register` (`neutral` or the destination's `tu`/`usted` value). Morphology alone
  is not proof that an ambiguous sentence is neutral.
- `correct_reply_rationale` and `wrong_reply_rationale`: concrete reasons the
  correct reply answers this first turn and the wrong reply fails in this context.
  Independently inspect the actual dialogue, including plausible alternative readings.
- `author`, `licence: "CC-BY-NC-SA-4.0"`, ISO `authored_on`, and `review`.
  Authoring licence does not replace any original role source licence.
- `review`: distinct `reviewer`, `verdict: "accepted"`, a specific `note`, and
  `content_hash: conversation_content_hash(row)`. Every authored field, placement,
  source/analysis digest and contextual judgement is bound. Changed content requires
  new independent review. Hashing a judgement is identity evidence, not proof that
  the judgement is linguistically correct.

Call `load_conversation_evidence(lang, selected_sources, ingested, analysed,
expected_slots, path=...)`. It returns rows, named role objects and the exact
population, plan and reviewed-evidence digests.

## G6 producer

`build_conversation_approval(lang, selected_sources, evidence,
checks_by_slot_and_role, run_id=...)` expects exactly every planned slot and role.
Each role has two ordered surface proofs: Spanish `forward` then its English
translation `reverse_only`. These direction labels reuse the shared language proof
format; they do not make the English translation a learner answer in the chat.

Each proof is `{use, text, analysis, checks}`. Spanish requires the existing
`ledger`, `register`, `length`, `duplicate`, `pair`, `grammar`, `perplexity` axes;
at least one Spanish language engine must actually run. English has `pair` and
English `grammar` checks and no borrowed Spanish analysis. Each axis declares its
actual engine, language, requested/available flags, pass result and details, as in
`answer_evidence.validate_surface_proof`. Pair details bind the exact review hash
and score. Length details bind minimum, maximum, measured shared-ledger count and
the current destination POS digest. A requested unavailable engine never passes.

Every Spanish role uses the reply destination's unchanged known/new allowance,
one-new-item budget and register policy. Only `correct_reply` must contain every
reserved target lemma. First/wrong can omit targets; they cannot introduce words
outside the allowance. Corpus roles retain the strict three-token minimum. A chosen
authored reply retains its existing POS-proven B9 length floor. Analyses must equal
the exact current role analysis, and all surfaces use the original shared counter.

Contextual dialogue review supplements language checks. It does not make arbitrary
ungrammatical fragments valid or waive grammar, register, length or vocabulary checks.
A wrong reply must be a valid sentence/pair that is wrong for this context, not a
misspelling or false translation. Ordinary translation-answer callers still require
all target lemmas; extraction of `SurfacePolicy` does not loosen their checks.

`conversation_exposure_accounting(selected_sources, roles_by_slot)` combines all
canonical selected slot/text occurrences with extra role slot/text occurrences.
The selected correct reply collapses at its own slot, as do format siblings. The
same text in another actual slot remains an exposure. Same-unit duplicates block;
cross-unit repeated exposures use the existing 5% ceiling and the unchanged count
of selected slots as denominator. No extra role becomes another selected sentence
for V11, another target for V4, or another scheduled item for FSRS. The report carries
explicit occurrences and the denominator for downstream inspection.

`write_conversation_approval(lang, approval)` writes
`g6/conversation-approval.json` atomically and returns the `conversation_approval`
note G6 must attach to its successful run. The note binds run ID, byte SHA256 and
population/evidence/plan digests. G6 must not claim success before all checks pass.

## G7 and signed-pack consumers

`load_validated_conversation_evidence(lang, selected_sources, ingested, analysed,
expected_slots, path=..., evidence=None, g6_entry=None)` reloads the current authored
file and actual role inputs. Cached arguments cannot bypass this rebind. It requires
the latest actual successful G6 after successful G0–G5, exact output bytes and a
rebuilt approval equal to the stored output. A later failed upstream or G6 attempt,
changed plan, edited pair, missing role or changed output invalidates it.

Each `ApprovedConversation` supplies named `roles`, `selected_reply`, `evidence_hash`,
`population_digest`, `plan_digest`, `first_turn_audio_text`, `reply_taught_lemmas`
and `all_role_exposure_lemmas`. G7 uses the first-turn text as the chat body and audio
input, the canonical reply as its sole accepted answer, and the reviewed wrong reply
as its sole distractor. G8 must bake that same first-turn text through its existing
cast key. This contract does not itself decode or verify audio.

`conversation_sources_for_exercise(exercise, approved_by_slot, selected_sources)`
accepts the existing serialized exercise format: type `cloze` with the instruction
and body produced by `prompt_for("complete_the_chat", ...)`. It resolves the reply
by actual unit, lesson and source ID; zero or multiple matching selected occurrences
fail. There is no invented exercise slot field. It checks the full population and
plan, review, language/register, exact prompt, canonical answer and sole wrong reply,
then returns the named roles with original source rows.

G9 uses `CONVERSATION_META_PREFIX` (`conversation:`) plus exercise ID for existing
signed meta, retaining role source IDs and review/population evidence hashes. All
unique role source rows belong in shipped sentences and provenance/credits. V10/V12
must inspect these shipped texts/licences. V1/V2 use all-role exposure while V3/V4 and
FSRS retain reply-only taught content. V9 consumes role occurrences using the existing
selected-slot denominator. These are consumer obligations; this contract changes no
G6, G7, G8, G9 or validator consumers by itself.
