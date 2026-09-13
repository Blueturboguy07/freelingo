# Spanish pack review — round 5, first candidate

GATE: RED. This is a complete Codex agent review of the immutable CI candidate built
from `fca9a57bb0203fc52084c97f09aec5d582bc8d6e`, pack workflow run
[34734954606](https://github.com/Blueturboguy07/freelingo/actions/runs/34734954606),
attempt 1. It is not a paid native-speaker review and does not score the next build.

**PROVISIONAL (unreviewed by a paid native speaker)**

The fixed seed was 20260913, chosen before review. All 300 rows from the stratified
5,763-exercise population were individually inspected. The exact sample SHA256 is
`f114eb4965a37dedd43141a6914e8074f0a1ba5a27e5cc48758bb07e29fab613`.
All 300 scores join the exact exercise IDs and content fingerprints, including the
CI audio hashes (the locally baked Mac audio bytes differ).

| Verdict | Count | Fraction of this draw |
| --- | ---: | ---: |
| Wrong | 101 | 33.67% |
| Awkward | 17 | 5.67% |
| OK | 182 | 60.67% |

Reviewers were the Codex root agent and two independent Codex agents. Root reviewed
rows 1–100 and row 120; the upstream agent reviewed 101–200 except its own authored
row 120; the independent audit agent reviewed 201–300. No author reviewed its own new
Spanish candidate. Root and the audit agent then reconciled inconsistent judgments
across the entire draw. The initial 67-wrong draft was never a published gate result;
its preserved rows and all 34 verdict changes make the reconciliation inspectable.

Each row was judged as its actual input shape. Typed answers were checked with one
ordinary, clearly valid missing-answer witness where present, including common
contraction expansions, explicit subjects, gender/number interpretations and ordinary
synonyms. The rubric's “single most obvious” wording does not require an exhaustive
paraphrase dictionary. The actual core grader rejected the proposed witnesses even
under relaxed typo/omission guards; a counterexample that the grader accepted was not
counted. Fixed word-bank tiles and cloze stems were respected. All eight malformed
Complete-the-chat rows were judged consistently against S037's conversational reply
contract, rather than as free translation exercises.

Wrong meanings include costa=west, servir=it, morado=shirt, conducir=faster,
colgar=me, mínimo=all and competir=today. Missing valid typed answers and an ambiguous
subject reading also contribute to the measured result. Naturalness/register-only
findings remain awkward. Audio existence and hashes were checked, but no reviewer
heard the audio: every accent_consistency value is null, with no claimed accent or
cast-distinctness pass. The written review is not auditory evidence.

The immutable sample, final scores, original draft, adjudication, actual-grader probe,
candidate provenance and failed CI validator report are preserved together under
`history/p2-round5-attempt1/`. Current scores are bound to this candidate only. Any
content or audio change requires fresh matching review evidence before it can pass.
