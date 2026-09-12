"""Constants owned by the two tail commands, `sample` (H1) and `sign` (INV-PACK-18).

`scope2/00` §2.4 lists H1 beneath V1-V12: "stratified sample of N items reviewed by a
native speaker; measured defect rate written into the manifest". §2.6 then makes the
consequence explicit — the trust marking a learner sees is the *level*, the *defect
rate* and, for anything the project did not review, a label saying so.

This run has no paid native reviewer, so the honest label is the one below and it is a
constant rather than a sentence somebody retypes. Two carriers exist today —
`docs/pack-provenance.md` and `tools/coursekit/README.md`, both asserted verbatim by
`tests/test_sample.py` — and two are future work: the S001 pack card (P3) and the pack
manifest's `review` block, which S137 renders (the p2-g9 lane). A string that will end up
in four places and is typed four times is a string that says something different in one
of them.

Owner: p2-validate-sample-ci
"""

from __future__ import annotations

from typing import Final

# ---------------------------------------------------------------------------
# The stratified reviewer sample (H1)
# ---------------------------------------------------------------------------

#: The dimensions the draw stratifies over, in the order strata keys are built.
#:
#: Unit alone is not enough. A sample that is uniform over units but drawn only from
#: `translate` exercises measures nothing about the word bank, and one drawn only from
#: corpus sentences measures nothing about the gap-filled ones — which are the rows most
#: likely to be wrong, and the whole reason a defect rate is published.
SAMPLE_STRATA: Final[tuple[str, ...]] = ("unit_index", "exercise_type", "provenance")

#: The recorded seed. A sample that cannot be redrawn cannot be audited: a reviewer who
#: scores 300 items and a maintainer who re-runs the draw must get the same 300.
SAMPLE_SEED: Final[int] = 20260911

#: Filenames under the language's run root.
SAMPLE_FILENAME_TEMPLATE: Final[str] = "sample-{n}.jsonl"
SAMPLE_SUMMARY_FILENAME: Final[str] = "sample-summary.json"

#: Where the reviewer's rubric and scores live, relative to the repository root.
REVIEW_DIR_TEMPLATE: Final[str] = "content/{lang}/review"
RUBRIC_FILENAME: Final[str] = "RUBRIC.md"
SCORES_FILENAME: Final[str] = "scores.jsonl"

#: Every verdict a scored row may carry. `wrong` is the numerator of the wrong-item
#: rate; `awkward` is recorded and reported separately, because folding "a native
#: speaker would not say it this way" into the same number as "this is not Spanish"
#: makes the published figure mean nothing.
REVIEW_VERDICTS: Final[tuple[str, ...]] = ("ok", "awkward", "wrong")

#: The verdicts that count as a wrong item for `MAX_DEFECT_RATE`.
DEFECT_VERDICTS: Final[tuple[str, ...]] = ("wrong",)

#: The dimensions a reviewer scores each item on. Defined here, spelled out in RUBRIC.md.
#:
#: `accent_consistency` is the sixth and it was added at the P2 round-3 integration, not
#: by the lane that wrote the rubric: **founder ruling B6** made Kokoro the voice engine
#: and replaced the `locale: es-ES` claim with `language: es` + `accent_claim:
#: unverified`, and the ruling's own sentence — "the reviewer rubric checks accent
#: consistency" — makes the review the only check on the accent there now is.
#: `content/es/review/RUBRIC.md` §`accent_consistency` scores it and
#: `docs/owned/p2r3-provenance-docs.json` filed the exact spelling as a cross-lane
#: contract, because that lane could not edit this file.
#:
#: It is not cosmetic. `sample.py::read_scores` raises `ScoreError` on ANY `dimensions`
#: key outside this tuple and the caller turns that into exit 4 — so a rubric and a
#: constant that disagree do not produce a slightly wrong rate, they produce **no rate
#: for the whole sheet**, including the five text dimensions that were scored correctly.
#: The reviewer lane was already writing against the rubric when this landed.
#:
#: The spelling is the rubric's, deliberately: a dimension called `accent` in a file
#: about Spanish text reads first as the orthographic diacritic (INV-PACK-10's own test
#: is `a_candidate_one_accent_from_correct_is_discarded_not_corrected`), and the
#: two-word snake form is already precedented by `answer_set`.
#:
#: An accent finding is not a wrong item: RUBRIC.md gives an
#: `accent_consistency`-only failure the `awkward` verdict, and `DEFECT_VERDICTS` counts
#: only `wrong`, so adding the dimension cannot move a published rate on its own. What it
#: can still not do is be scored from the sheet at all — `SampleItem` carries no clip
#: reference and no voice role (`docs/P2-BLOCKERS.md` B18) — which is why the rubric also
#: documents a `note:`-prefixed fallback.
REVIEW_DIMENSIONS: Final[tuple[str, ...]] = (
    "meaning",
    "grammar",
    "naturalness",
    "register",
    "answer_set",
    "accent_consistency",
)

# ---------------------------------------------------------------------------
# Trust marking — the honesty string (§2.6)
# ---------------------------------------------------------------------------

#: The reviewer classes a defect rate may have been measured by.
REVIEWER_KIND_PAID_NATIVE: Final[str] = "paid-native-speaker"
REVIEWER_KIND_AGENT: Final[str] = "opus-agent-reviewer"

#: The kinds `gate_passed()` will accept a rate from, and the only two that exist.
#:
#: **Founder ruling B3, 2026-09-12**: *"P3 proceeds. The 300-item sample is scored by an
#: Opus reviewer as `REVIEWER_KIND_AGENT`; the manifest and S001 card carry
#: `PROVISIONAL (unreviewed by a paid native speaker)` verbatim; `gate_passed()` accepts
#: an agent-scored rate ≤ 2 % for the automated run; the paid native review is a release
#: prerequisite listed in `docs/RELEASE.md`."*
#:
#: So the gate no longer refuses an agent-scored rate — and it is a MEMBERSHIP test, not
#: a truthy one. A block whose `reviewer_kind` is `""`, `None` or some third string
#: nobody defined is a rate whose measurer is unrecorded, and the ruling turns on WHO
#: measured it: a rate that passes while its provenance is unknown is the same lie as a
#: rate with the provisional note stripped off.
RECORDED_REVIEWER_KINDS: Final[tuple[str, ...]] = (
    REVIEWER_KIND_PAID_NATIVE,
    REVIEWER_KIND_AGENT,
)

#: The exact string `docs/pack-provenance.md` and the coursekit README carry today, and
#: the pack card (S001) and the manifest's `review` block will carry, while the rate has
#: not been measured by a paid native speaker. Not a paraphrase, not a tooltip: this run
#: scored its own sample, and a learner reading "measured wrong-item rate 1.3%" has to be
#: able to see who measured it.
PROVISIONAL_DEFECT_RATE_NOTE: Final[str] = "PROVISIONAL (unreviewed by a paid native speaker)"

#: The marking a pack the project did not build carries (§2.6, community local build).
COMMUNITY_PACK_NOTE: Final[str] = "Community-built, unvalidated"

# ---------------------------------------------------------------------------
# Signing (INV-PACK-18)
# ---------------------------------------------------------------------------

#: The CI secret holding the ed25519 private key. Mirrors `PACK_SIGNING_SECRET_NAME` in
#: `packages/schema/src/signing.ts`; `tests/test_signing.py` asserts the two agree, so a
#: rename on either side fails the build instead of producing unsigned packs.
PACK_SIGNING_KEY_ENV: Final[str] = "PACK_SIGNING_KEY"

#: The committed public key, relative to the repository root. Shipped inside the app.
PACK_SIGNING_PUBLIC_KEY_PATH: Final[str] = "packages/schema/keys/pack-signing.pub"

#: ed25519, per the plan's Signing section. No other algorithm is accepted.
PACK_SIGNING_ALGORITHM: Final[str] = "ed25519"

#: The 12-byte DER prefix of an ed25519 SubjectPublicKeyInfo, as hex: SEQUENCE,
#: AlgorithmIdentifier (OID 1.3.101.112, no parameters), then a 32-byte BIT STRING.
#: The app's parser in `packages/schema/src/signing.ts` carries the same bytes.
ED25519_SPKI_PREFIX_HEX: Final[str] = "302a300506032b6570032100"
ED25519_SPKI_LENGTH: Final[int] = 44
ED25519_SEED_LENGTH: Final[int] = 32
ED25519_SIGNATURE_LENGTH: Final[int] = 64

#: The manifest key the signature block is written under, and the keys inside it.
#: The signature is computed over the manifest with this key REMOVED, canonicalised as
#: sorted-key JSON — so a verifier reconstructs the signed bytes from the shipped file
#: without a second copy of the manifest riding alongside it.
MANIFEST_SIGNATURE_KEY: Final[str] = "signature"
MANIFEST_FILENAME: Final[str] = "manifest.json"
