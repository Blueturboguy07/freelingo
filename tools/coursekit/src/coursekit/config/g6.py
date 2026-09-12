"""Constants owned by G6, validate-language — and V8, its validator.

Three engines, each of which can be absent, and the whole point of INV-PACK-14 is that
an absent engine is **named** rather than counted as a clean run.

## The LanguageTool numbers here are measured, not copied

`deep/10` §S6 says Japanese is "spell check only (no grammar checks)" and builds V8's
degradation on it. The adversarial review's **R1** found that backwards: the live table's
columns are `Language | XML rules | Java rules | Spell check | Confusion pairs | Activity`,
the ✓ read as "grammar checks" is the **Spell check** column, and the quoted sentence is
about **Norwegian**.

Rather than copy the corrected row, this lane re-derived it against a real
LanguageTool 6.6 server — `languagetool-server.jar` from the 6.6 zip (build `f3e8d91`,
2025-03-27) under Java 22.0.1, port 8081, run 2026-09-12. `SPELLCHECK_PROBE` below
carries the full measurement table.

So **Spanish has both**: 1,644 XML grammar rules AND its own Morfologik spell checker
(`MORFOLOGIK_RULE_ES`, under `es` and `es-ES` alike). For `es` V8 degrades to nothing at
all — which is what "re-derive rather than copy" turns up, and is not what either the
spec or its correction says on its own. Japanese raises nothing for a nonce token across
four differently-shaped probes, so it degrades on exactly one axis,
`spellcheck_engine: none`.

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

#: The inverse, which `scope2/00` §2.4 does NOT name and which is the more likely of the
#: two in practice: LanguageTool is a jar somebody can start in one command, while a
#: KenLM band needs a trained model over a corpus G0 produces. The adversarial pass ran
#: exactly this configuration — sidecar up, no `--set kenlm_model` — and V8 blocked it
#: with a message naming `perplexity_only`, i.e. it asked the operator to name the
#: fallback after the engine that was *missing*. A degradation with no name is the hole
#: INV-PACK-14 is about, and "the spec only named one direction" is not a reason for the
#: other direction to be nameless.
DEGRADED_TO_GRAMMAR_ONLY: Final[str] = "grammar_only"

#: missing engine field -> the name of the state it leaves the run in. Both directions
#: are a **warning**, never a block: one engine that can find an error did run, the pack
#: is weaker rather than unchecked, and the manifest carries which. Only the empty
#: intersection (`ENGINES_THAT_CAN_FIND_AN_ERROR` all `none`) blocks.
DEGRADATION_NAMES: Final[dict[str, str]] = {
    "grammar_engine": DEGRADED_TO_PERPLEXITY_ONLY,
    "perplexity_engine": DEGRADED_TO_GRAMMAR_ONLY,
}

#: Engine ids that are a stand-in rather than the engine they imitate. `mock_lt` is a
#: real HTTP server speaking the LanguageTool API so `pack-ci.yml` needs no JDK; it is
#: not LanguageTool, and a pack validated entirely against it has not met 1,644 XML
#: rules. V8 may not block on it (CI would then have no way to exercise G6 at all) and
#: must not stay silent about it either, so it is a named warning that reaches the
#: manifest and INV-PACK-55's pack card.
MOCK_ENGINE_IDS: Final[tuple[str, ...]] = ("mock_lt",)

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
#:
#: **Where the nonce sits in the sentence changes the answer**, which is the kind of
#: thing only running the jar tells you. Measured against LanguageTool 6.6 on
#: 2026-09-12 (`java -cp languagetool-server.jar org.languagetool.server.HTTPServer
#: --port 8081`, build f3e8d91, `/v2/languages` -> 60 entries):
#:
#: | probe | matches |
#: | ----- | ------- |
#: | es `Yo xqzptv en la casa.` | `MORFOLOGIK_RULE_ES` / misspelling / TYPOS |
#: | es-ES, same text | `MORFOLOGIK_RULE_ES` / misspelling / TYPOS |
#: | es `La casa es blanco.` | `CONCORDANCIAS_ATRIBUTO` / inconsistency / AGREEMENT_VERBS |
#: | es `La casa es blanca y yo vivo con mi hermano.` | `[]` |
#: | de-DE `Ich xqzptv in dem Haus.` | `GERMAN_SPELLER_RULE` / misspelling / TYPOS |
#: | ja-JP `わたしは xqzptv にいます。` | `[]` |
#: | ja-JP, three further nonce shapes | `[]` each |
#: | **fr `Je xqzptv dans la maison.`** | **`JE_VERBE` / uncategorized / CAT_GRAMMAIRE** |
#: | fr `La maison xqzptv est grande.` | `FR_SPELLING_RULE` / misspelling / TYPOS |
#:
#: The French row is the correction. A nonce token straight after `Je` is claimed by the
#: `JE_VERBE` grammar rule, which reports `uncategorized`, so the speller never fires and
#: the probe concludes **French has no spell checker** — untrue, and it would have
#: degraded every French pack on an axis that works. Moving the nonce out of the verb
#: slot raises `FR_SPELLING_RULE`. This is exactly why the capability is probed rather
#: than tabulated, and also why the probe SENTENCE is a measured constant rather than
#: whatever reads naturally.
SPELLCHECK_PROBE: Final[dict[str, str]] = {
    "es": "Yo xqzptv en la casa.",
    # NOT "Je xqzptv dans la maison." — see the table above.
    "fr": "La maison xqzptv est grande.",
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
# What a degradation costs
# ---------------------------------------------------------------------------

#: Named fallback -> what the pack lost, and the one command that gives it back. Here
#: rather than beside `DEGRADATION_NAMES` only because the KenLM remedy quotes
#: `KENLM_ORDER` and a constant may not be read before it is declared.
#:
#: A warning that names a state without naming the remedy gets read once and normalised;
#: this is the sentence a reviewer sees in the validator report and in the manifest.
DEGRADATION_COST: Final[dict[str, str]] = {
    DEGRADED_TO_PERPLEXITY_ONLY: (
        "no grammar rule was applied, so naturalness rests on the perplexity band alone. "
        "Start a LanguageTool sidecar and pass --set languagetool_url=<url>."
    ),
    DEGRADED_TO_GRAMMAR_ONLY: (
        "nothing measured how UNLIKE the training corpus a sentence is, which is the axis "
        "that catches text a rule set finds well-formed. Train a KenLM model "
        f"(`{KENLM_TRAIN_BINARY} -o {KENLM_ORDER}` over the oracle text, then "
        f"`{KENLM_BUILD_BINARY}`) and pass --set {KENLM_MODEL_OPTION}=<path>."
    ),
}

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
    "review_defect",
    "perplexity_out_of_band",
    "grammar",
    "backtranslation",
)

#: Exact corpus pairs refuted by the P2 B3 agent-scored sample on 2026-09-12. These are
#: pairs, not lexical substitutions: both source sentences have valid translations and
#: both English glosses fit other Spanish sentences. G6 narrows only the reviewed pair.
B3_REVIEW_DEFECT_PAIRS: Final[frozenset[tuple[str, str]]] = frozenset(
    {
        ("No encuentro mi cartera.", "I lost my wallet."),
        ("Hoy tendremos pescado de cena.", "We have fish for dinner today."),
    }
)
