# Canonical sources and noncanonical accepted answers

Declared 2026-09-13. The canonical source is the selected teaching occurrence;
an independently reviewed nonpreferred accepted paraphrase is presentation data
(INV-PACK-41). Its presence does not create a selected source or teaching credit.

The primary framework §2.3 and `deep/10` S1 place the 3–12-token window at source
ingestion. The reviewed-alternate contract frozen in `cfe12ed` requires the same
meaning, unit register, vocabulary allowance and new-item budget, plus independent
G6 analysis/language/meaning proof. It does not require every alternate to repeat
all reserved canonical lemmas or to use the canonical source's length window.
The earlier shared helper incorrectly inferred those extra requirements.

`SurfacePolicy.from_source(source)` preserves the canonical source's minimum,
maximum 12, destination known/new allowance, unit/register and length POS digest.
`noncanonical_answer_policy(policy)` preserves that same allowance and register but
uses `NONCANONICAL_ANSWER_MIN_TOKENS = 1` and
`NONCANONICAL_ANSWER_MAX_TOKENS = None`. One means an actual lexical unit measured
by the shared ledger; empty or punctuation-only strings cannot pass. `None` records
that no independent maximum for accepted paraphrases is declared. It does not change
the canonical source maximum or the dialogue-role policy.

G5/G6 callers must select the noncanonical policy only for an explicit, independently
reviewed nonpreferred Spanish answer. They pass `required_target_lemmas=frozenset()`
for that answer and retain the full reserved target set for the canonical source.
Every surface still needs exact text-bound analysis, the unchanged known/new and
one-new-item checks, destination register, bilingual pair review and actual configured
language checks. G6 `length.detail` binds the applicable minimum, nullable maximum,
actual shared-ledger count and unchanged destination POS digest. A stale proof with
the old source window is not silently reinterpreted as an alternate proof.

Thus `Yo soy español.` may accept reviewed `Soy español.`, and `Ella es buena.` may
accept reviewed `Es buena.` without changing their canonical sources or scheduled
tags. A known synonym may omit the source target, but an out-of-window synonym still
fails. A valid thirteen-token paraphrase can be approved while a thirteen-token
canonical A1 source still fails its existing maximum. These are acceptance examples,
not automatic paraphrase-generation rules or exemptions from language quality.

Canonical sources remain subject to V9 duplicate/repetition checks. Optional accepted
answer sets may overlap across distinct canonical slots; this does not add canonical
exposures or alter the V9 selected denominator. Duplicate spellings within one reviewed
answer set still fail, and the preferred canonical answer remains index zero.
`ApprovedAnswers` and the G7 consumer API are unchanged. Fixed shapes, listening,
conversation roles, audio, FSRS identity and actual teaching credit do not gain optional
answers merely because this shared policy exists.

This correction does not touch the separate open-response minimum-length/required-word
grade in deep/01 S9 (INV-SEC-04), and it does not establish any new pack, G6, audio or
300-item sample result.
