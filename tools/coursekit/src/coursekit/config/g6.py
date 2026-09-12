"""Constants owned by G6, validate-language — and V8, its validator.

Three engines, each of which can be absent, and the whole point of INV-PACK-14 is that
an absent engine is **named** rather than counted as a clean run.

## The LanguageTool numbers here are measured, not copied

`deep/10` §S6 says Japanese is "spell check only (no grammar checks)" and builds V8's
degradation on it. The adversarial review's **R1** found that backwards: the live table's
columns are `Language | XML rules | Java rules | Spell check | Confusion pairs | Activity`,
the ✓ read as "grammar checks" is the **Spell check** column, and the quoted sentence is
about **Norwegian**.

Rather than copy the corrected row, this lane re-derived it against a local
LanguageTool 6.6 server (`languagetool-server.jar`, Java 22, port 8081, 2026-09-12):

| Probe | Result |
| ----- | ------ |
| es `La casa es blanca y yo vivo con mi hermano.` | `matches: []` |
| es `La casa es blanco.` | `CONCORDANCIAS_ATRIBUTO` / `inconsistency` / `AGREEMENT_VERBS` |
| es `Yo xqzptv en la casa.` | `MORFOLOGIK_RULE_ES` / `misspelling` / `TYPOS` |
| ja-JP `わたしは xqzptv にいます。` | `matches: []` — nothing for a nonce token |
| `/v2/languages` | 60 entries; `es`, `es-ES`, `fr`, `de-DE`, `ja-JP` all present |

So **Spanish has both**: 1,644 XML grammar rules AND its own Morfologik spell checker.
For `es` V8 degrades to nothing at all — which is what "re-derive rather than copy"
turns up, and is not what either the spec or its correction says on its own. Japanese
degrades on exactly one axis, `spellcheck_engine: none`.

`SPELLCHECK_PROBE` is in this file because that inversion has now been got wrong once by
reading a table: the capability is **probed at run time against the server that is
actually going to run**, and whatever comes back is what V8 records. A version bump, a
different jar, a language pack somebody did not install — each shows up as a changed
probe result rather than as a constant that is still true on paper.

## Perplexity bands are percentiles, not perplexities

An absolute band ("es: 20-400") is meaningless without naming the model that produced
it, and a band trained against one build of KenLM and enforced against another is a V8
that drifts with no diff — which is why `pyproject.toml` pins KenLM to a commit. So the
band is **derived from the training run**: hold out a slice of the same oracle text,
score it, and take these percentiles. What is tunable is how much of the oracle's own
tail to call unnatural.

Owner: p2-g5-g6-gapfill-language
"""

from __future__ import annotations

from typing import Final

# ---------------------------------------------------------------------------
# Engine selection
# ---------------------------------------------------------------------------

DEFAULT_PERPLEXITY_ENGINE: Final[str] = "kenlm"
DEFAULT_GRAMMAR_ENGINE: Final[str] = "languagetool"
DEFAULT_BACKTRANSLATION_ENGINE: Final[str] = "agent_rubric"

#: `--set <key>=<engine id>`. Tests point the grammar key at `mock_lt`, which is a real
#: local HTTP server speaking the LanguageTool API, so pytest needs neither Java nor a
#: jar and the HTTP path is still the path under test.
PERPLEXITY_ENGINE_OPTION: Final[str] = "perplexity_engine"
GRAMMAR_ENGINE_OPTION: Final[str] = "grammar_engine"
BACKTRANSLATION_ENGINE_OPTION: Final[str] = "backtranslation_engine"

#: Where the KenLM binary model and its derived band live, and where the LanguageTool
#: sidecar is listening. All three are `--set` keys because all three are properties of
#: the machine doing the build, not of the course.
KENLM_MODEL_OPTION: Final[str] = "kenlm_model"
KENLM_BAND_OPTION: Final[str] = "kenlm_band"
LANGUAGETOOL_URL_OPTION: Final[str] = "languagetool_url"

#: What an engine that did not run is called, everywhere. INV-PACK-14 turns on this
#: string being written down rather than an engine field being absent: a missing key
#: reads as "old runlog", and a validator that cannot tell "clean" from "did not run"
#: reports the same green either way.
ENGINE_NONE: Final[str] = "none"

#: The four engine fields INV-PACK-14 is about, and the shape of the contract between
#: G6's runlog entry and V8. All four are written on every run — an absent key reads as
#: "an old runlog", and telling "clean" from "did not run" is the whole invariant.
ENGINE_FIELDS: Final[tuple[str, ...]] = (
    "grammar_engine",
    "spellcheck_engine",
    "perplexity_engine",
    "backtranslation_engine",
)

#: The two whose simultaneous absence means nothing was checked. `spellcheck_engine`
#: is not among them: Japanese has no spell checker at all and still gets 735 grammar
#: rules, so its absence is a named degradation rather than a dead validator. Nor is
#: back-translation, which in this environment is a rubric rather than an engine.
ENGINES_THAT_CAN_FIND_AN_ERROR: Final[tuple[str, ...]] = (
    "grammar_engine",
    "perplexity_engine",
)

#: The named fallback V8 degrades to when a grammar engine is missing but perplexity
#: ran. `scope2/00` §2.4: "degrades to perplexity-only". Named, so the manifest and
#: S137 can say which of the two a pack got.
DEGRADED_TO_PERPLEXITY_ONLY: Final[str] = "perplexity_only"

# ---------------------------------------------------------------------------
# LanguageTool
# ---------------------------------------------------------------------------

#: The `longCode` the server answers to, from `/v2/languages` on LanguageTool 6.6.
#: `de` and `ja` resolve only under a region tag on that list, so a bare code is not a
#: safe default for all four.
LANGUAGETOOL_LONG_CODE: Final[dict[str, str]] = {
    "es": "es",
    "fr": "fr",
    "de": "de-DE",
    "ja": "ja-JP",
}

#: XML grammar rule counts, `dev.languagetool.org/languages`, re-verified by the
#: adversarial pass to the digit. Recorded so V8 can say how thin a ruleset it ran, not
#: so it can decide whether one exists — that is probed.
LANGUAGETOOL_XML_RULE_COUNTS: Final[dict[str, int]] = {
    "fr": 6984,
    "de": 5224,
    "es": 1644,
    "ja": 735,
}

#: A sentence carrying one nonce token that no dictionary can hold. If the server
#: answers with a misspelling match, this language has a spell checker; if it answers
#: with nothing, it does not. That is the whole probe, and it is why `ja` is known to
#: have no spell checker here without anybody reading a column heading.
SPELLCHECK_PROBE: Final[dict[str, str]] = {
    "es": "Yo xqzptv en la casa.",
    "fr": "Je xqzptv dans la maison.",
    "de": "Ich xqzptv in dem Haus.",
    "ja": "わたしは xqzptv にいます。",
}

#: How LanguageTool labels a spelling match: `rule.issueType` and `rule.category.id`.
#: Measured on 6.6 for `MORFOLOGIK_RULE_ES`.
SPELLCHECK_ISSUE_TYPE: Final[str] = "misspelling"
SPELLCHECK_CATEGORY_ID: Final[str] = "TYPOS"

#: Which `issueType` values block per language, and which are warnings.
#:
#: French carries 6,984 XML rules to Spanish's 1,644 — 4.2x — so one global threshold
#: is wrong by that factor in false positives, exactly as §S6 says. The asymmetry is
#: encoded as *which categories are enforced*, not as an error budget: a sentence with
#: one real agreement error is not more acceptable in French.
BLOCKING_ISSUE_TYPES: Final[dict[str, tuple[str, ...]]] = {
    # Both engines present and both trusted.
    "es": ("misspelling", "grammar", "inconsistency"),
    # Same two engines; style and typography demoted, because a ruleset this dense
    # fires on register choices an A1 authoring pass makes deliberately.
    "fr": ("misspelling", "grammar", "inconsistency"),
    "de": ("misspelling", "grammar", "inconsistency"),
    # 735 rules, no spell checker. `misspelling` is listed and will never fire; a
    # thin ruleset means fewer catches, never a looser threshold.
    "ja": ("misspelling", "grammar", "inconsistency"),
}

#: Hosts a build must never send a batch to. The public endpoint is rate-limited and
#: `deep/10` §S6 is explicit that a 6,000-item batch must not go near it; the sidecar
#: is the supported shape and LGPL is fine out-of-process. A URL on one of these fails
#: the engine loudly rather than getting the build throttled halfway through.
FORBIDDEN_LANGUAGETOOL_HOSTS: Final[tuple[str, ...]] = (
    "languagetool.org",
    "api.languagetool.org",
    "api.languagetoolplus.com",
)

LANGUAGETOOL_TIMEOUT_SECONDS: Final[float] = 30.0

# ---------------------------------------------------------------------------
# KenLM
# ---------------------------------------------------------------------------

#: `lmplz -o 5`, §S6's order.
KENLM_ORDER: Final[int] = 5

#: The band, as percentiles of the held-out oracle slice's own perplexity. Five per
#: cent of natural sentences score outside it by construction, which is the intended
#: reading: the band says "unlike the corpus", not "wrong".
PERPLEXITY_BAND_PERCENTILES: Final[tuple[float, float]] = (5.0, 95.0)

#: The filename the band is written to beside the binary model, so a model and the band
#: enforced against it travel together.
KENLM_BAND_FILENAME: Final[str] = "band.json"

#: The binaries `lmplz` and `build_binary` are built from the kenlm source tree with
#: cmake; the pip package ships the query module only. Named here so the "not
#: installed" message is the fix.
KENLM_TRAIN_BINARY: Final[str] = "lmplz"
KENLM_BUILD_BINARY: Final[str] = "build_binary"

# ---------------------------------------------------------------------------
# Back-translation
# ---------------------------------------------------------------------------

#: The rubric is 0-4 (`content/<lang>/gapfill-rubric.md`). 3 is "the meaning survives
#: the round trip with at most a register or article difference"; 2 is where the
#: English a learner is shown stops being what the Spanish says.
BACKTRANSLATION_MIN_SCORE: Final[int] = 3
BACKTRANSLATION_SCORE_RANGE: Final[tuple[int, int]] = (0, 4)

#: Recorded on every run, verbatim, in the runlog and therefore in the manifest. There
#: is no hosted model in this environment, so this check is an Opus agent's own
#: judgement written down against a published rubric — it is NOT a model round-trip,
#: and a reader of the pack must not be able to mistake one for the other.
BACKTRANSLATION_AUTHORSHIP: Final[str] = "agent-authored rubric score, not a model round-trip"

# ---------------------------------------------------------------------------
# The G6 reject axes
# ---------------------------------------------------------------------------

#: Prefixed so a `reject_reason` written by G6 can never be confused with one written
#: by G5 — they are different stages rejecting for different reasons, and the manifest
#: reports the split.
G6_REJECT_PREFIX: Final[str] = "g6:"

G6_REJECT_AXES: Final[tuple[str, ...]] = (
    "perplexity_out_of_band",
    "grammar",
    "backtranslation",
)
