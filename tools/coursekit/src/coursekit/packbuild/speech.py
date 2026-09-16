"""Derive speech units only from current source-approved native analyses.

The caller must first verify the complete upstream approval, including the exact
``speech`` projection. This module proves source/analysis/accepted-set joins; it
cannot approve meaning, pronunciation, or a model's analysis by hashing it.
"""

from __future__ import annotations

import copy
import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any

from jsonschema import Draft202012Validator

from ..artifacts import CANDIDATE_ANALYSIS, sentence_id, validate_record
from ..config.speech import SPEECH_ALGORITHMS, SPEECH_SCHEMA_VERSION
from ..japanese_script import validate_script_analysis
from ..ledger import is_lexical_pos, ledger_unit, speaking_tokens
from .grading import GradingBuildError, content_hash, fields, sha, surface_id, text


class SpeechBuildError(GradingBuildError):
    """A speaking item lacks exact approved source evidence."""


def require(condition, detail):
    if not condition:
        raise SpeechBuildError("speech: " + detail)


def build_speech_evidence(
    *,
    language: str,
    source_id: str,
    source: Mapping[str, Any],
    source_sha256: str,
    approval: Mapping[str, Any],
    accepted: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Return revision 1; no tokenizer, dictionary lookup, engine call or file write.

    ``approval.speech`` is ``{policy, analyses:[{text, analysis, japaneseScript?}]}``.
    Each analysis is the exact native G1 record or G5 candidate-analysis object.
    Japanese currently requires its G1 record because its paired script contract
    binds that full record, and an independently verified reading approval belongs
    to the caller's current approval validator. A script's ``unreviewed`` field is
    retained honestly and is never itself a pronunciation approval.
    """
    try:
        return _build(language, source_id, source, source_sha256, approval, accepted)
    except SpeechBuildError:
        raise
    except Exception as exc:
        # Artifact/ledger/JSON-shape failures are named build input errors, not
        # permission to fall back to displayed words or invent an empty proof.
        raise SpeechBuildError(f"speech: invalid source evidence ({exc})") from exc


def _build(language, source_id, source, source_sha256, approval, accepted):
    text(source_id, "speech source identity")
    sha(source_sha256, "speech source digest")
    require(source_sha256 == content_hash(source), "stale source digest")
    require(source.get("lang") == language, "source language mismatch")
    proof = fields(approval.get("speech"), {"policy", "analyses"}, "speech approval")
    policy = fields(
        proof["policy"],
        {
            "algorithm",
            "threshold",
            "fallback",
            "fallbackThreshold",
            "ignoredPunctuation",
            "fillers",
        },
        "speech policy",
    )
    require(
        all(policy[key] == value for key, value in SPEECH_ALGORITHMS.items()),
        "unsupported algorithm/threshold",
    )
    for key in ("ignoredPunctuation", "fillers"):
        values = policy[key]
        require(
            isinstance(values, list) and all(isinstance(v, str) and v.strip() for v in values),
            "invalid explicit normalization",
        )
        require(len(set(values)) == len(values), "duplicate normalization entries")
    punctuation = set(policy["ignoredPunctuation"])
    require(
        all(len(v) == 1 and unicodedata.category(v).startswith("P") for v in punctuation),
        "non-punctuation normalization",
    )
    analyses = proof["analyses"]
    require(isinstance(analyses, list), "analyses missing")
    by_text = {}
    for entry in analyses:
        fields(entry, {"text", "analysis"}, "speech analysis", {"japaneseScript"})
        written = text(entry["text"], "speech reference")
        require(written not in by_text, "duplicate analyzed surface")
        by_text[written] = entry
    require(isinstance(accepted, Sequence) and bool(accepted), "accepted spoken set missing")
    surfaces = [row["surface"] for row in accepted]
    require(
        len(set(surfaces)) == len(surfaces) and set(surfaces) == set(by_text),
        "analysis population differs from accepted spoken set",
    )
    references = []
    for form in accepted:
        written = text(form["surface"], "spoken surface")
        require(
            form["surfaceId"] == surface_id(language, written), "accepted surface identity mismatch"
        )
        entry = by_text[written]
        raw = entry["analysis"]
        require(isinstance(raw, Mapping), "native analysis missing")
        if "analyser" in raw:
            require(language != "ja", "Japanese paired evidence requires exact G1 analysis")
            Draft202012Validator(CANDIDATE_ANALYSIS).validate(raw)
            analysed = {"lang": language, "adapter": raw["analyser"], "tokens": raw["tokens"]}
        else:
            validate_record("analysed_sentence", raw)
            require(
                raw["lang"] == language and raw["sentence_id"] == sentence_id(language, written),
                "analysis text/language identity mismatch",
            )
            analysed = raw
        if written == source.get("text"):
            require(raw == source.get("analysis"), "canonical analysis differs from current source")
        units = speaking_tokens(analysed)
        native = analysed["tokens"]
        lexical = []
        previous = 0
        for index, token in enumerate(native):
            start, end = token["start"], token["end"]
            require(
                type(start) is int
                and type(end) is int
                and previous <= start < end <= len(written)
                and written[start:end] == token["surface"],
                "stale or overlapping source token span",
            )
            require(not written[previous:start].strip(), "analysis omits source text")
            previous = end
            if is_lexical_pos(token["pos"]):
                lexical.append((index, token))
            else:
                require(
                    all(c.isspace() or c in punctuation for c in token["surface"]),
                    "unscored source text is not declared punctuation",
                )
        require(not written[previous:].strip(), "analysis omits source tail")
        require(bool(units) and len(lexical) == len(units), "expected ledger units missing")
        require(list(units) == raw["lemmas"], "native lemma sequence differs from stored tokens")
        ref = {
            "surfaceId": form["surfaceId"],
            "text": written,
            "tokens": [],
            "sourceId": source_id,
            "sourceSha256": source_sha256,
            "analysisSha256": content_hash(raw),
            "adapterFingerprint": content_hash(analysed["adapter"]),
        }
        readings = None
        if language == "ja":
            script = entry.get("japaneseScript")
            validate_script_analysis(script, raw, text=written)
            readings = script["mode_a_surface_readings"]
            ref.update(reading=script["tts_reading"], japaneseScriptSha256=content_hash(script))
        else:
            require("japaneseScript" not in entry, "undeclared Japanese reading channel")
        for unit, (index, token) in zip(units, lexical, strict=True):
            value = {"unit": unit, **{key: token[key] for key in ("surface", "start", "end")}}
            if readings is not None:
                value["reading"] = readings[index]["reading"]
            ref["tokens"].append(value)
        references.append(ref)
    return {
        "schemaVersion": SPEECH_SCHEMA_VERSION,
        "language": language,
        "ledgerUnit": ledger_unit(language),
        "policy": copy.deepcopy(policy),
        "references": references,
    }
