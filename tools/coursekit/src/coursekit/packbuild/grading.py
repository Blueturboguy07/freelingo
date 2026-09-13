"""Pure production grading assembly; no fixture defaults, downloads or pack writes.

Frozen wire revision 1, 2026-09-13. The caller supplies actual G9 rows, structured
G7 drafts and independently reviewed catalogs. ``approval_check`` MUST call the
upstream proof validator for the current complete G6 run; this module proves exact
bindings, not language quality. A digest or a caller-authored boolean is not review.
Dictionary sources retain their own licences and raw evidence. Word rows are streamed
again at G9 insertion; consume them completely inside the pack transaction, so a
changed source raises before commit. No millions-of-words Set is constructed.
"""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any

from ..config.g7 import SHAPES as PIPELINE_SHAPES
from .itemid import canonical_json

# Actual LessonPlayer hides these prompts via EXERCISE_REGISTRY.requiresAudio.
# Captured 2026-09-13; speaking and chat prompts remain visible even with audioRef.
HIDDEN_AUDIO_PROMPT_TYPES = frozenset(
    {"listenTapWhatYouHear", "listenTypeWhatYouHear", "listenMissingWord", "listenAndRespond"}
)
WIRE_VERSION = 1
NORMALIZATION_ID = "core-grading-lookup-v1"
SOURCE_SHAPES = {shape.id: shape for shape in PIPELINE_SHAPES}
PROFILE_FIELDS = {"profileId", "responseLanguage", "configuration"}
PROVENANCE_FIELDS = {
    "sourceId",
    "sourceSha256",
    "sourceUrl",
    "license",
    "notice",
    "normalizationId",
    "normalizationSha256",
    "policySha256",
}
CONFIG_FIELDS = {
    "orthographicEquivalences",
    "spaceless",
    "noWordBoundaries",
    "noWordDelimiter",
    "readingsBySurface",
    "japaneseNormalisation",
    "diacriticsContrastive",
    "contrastiveDiacritics",
    "typoGuards",
    "targetLanguageWords",
    "functionClassTokens",
    "targetScriptRanges",
    "scriptOnlyAnswers",
    "wordBankJoinDelimiter",
    "openResponseLengthUnit",
    "registerSlot",
}
LESSON_FIELDS = {
    "unitId",
    "lessonIndex",
    "profileId",
    "register",
    "punctuationEquivalenceClass",
    "gradedPunctuation",
    "taughtInflections",
    "openResponseMinimumLength",
}
DRAFT_FIELDS = {
    "shapeEvidence",
    "record",
    "shapeId",
    "sourceId",
    "sourceSha256",
    "approvalId",
    "approvalSha256",
    "profileId",
    "responseLanguage",
    "surfaceIds",
    "schedulerSurfaces",
    "gradable",
    "presentation",
    "explanation",
}
PRESENTATION_FIELDS = {
    "itemId",
    "type",
    "instruction",
    "prompt",
    "language",
    "promptLanguage",
    "acceptedAnswers",
    "options",
    "bank",
    "pairs",
    "audioRef",
    "audioText",
    "trace",
    "hints",
    "slowAudioRef",
    "requiresIme",
    "accentCharacters",
    "introduction",
    "tip",
    "hard",
}
GRADABLE_FIELDS = {
    "family",
    "gaps",
    "pairs",
    "tiles",
    "orderedTileIds",
    "targetLexemeId",
    "targetLexemeSurface",
    "prompt",
    "requiredLexemeIds",
    "readingSurfaceNote",
    "sameReadingSurfaces",
    "rubySpans",
    "schedulerFacet",
}
# Exact G7 shape -> existing core family and ExerciseType. No prompt parsing.
SHAPES = {
    "picture_select": ("select", "pictureSelect"),
    "meaning_select": ("select", "meaningSelect"),
    "match_pairs": ("match", "matchPairs"),
    "word_bank_forward": ("word-bank", "wordBankTranslate"),
    "word_bank_reverse": ("word-bank", "wordBankTranslate"),
    "typed_translate_forward": ("typed-translate", "typedTranslate"),
    "typed_translate_reverse": ("typed-translate", "typedTranslate"),
    "complete_the_chat": ("select", "completeChat"),
    "tap_what_you_hear": ("word-bank", "listenTapWhatYouHear"),
    "type_what_you_hear": ("listening", "listenTypeWhatYouHear"),
    "listen_for_the_missing_word": ("gap-fill", "listenMissingWord"),
    "fill_in_the_blank": ("gap-fill", "gapFillSelect"),
    "complete_the_translation": ("gap-fill", "gapFillTyped"),
    "type_the_word_ending": ("gap-fill", "typeWordEnding"),
    "read_and_respond": ("read-and-respond", "readAndRespond"),
    "listen_and_respond": ("listen-and-respond", "listenAndRespond"),
    "speak_this_sentence": ("speaking", "speakSentence"),
}


class GradingBuildError(ValueError):
    """Named missing, stale or inconsistent production grading evidence."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise GradingBuildError(message)


def fields(row: Any, required: set[str], where: str, optional: set[str] | None = None):
    require(isinstance(row, Mapping), f"{where}: expected object")
    require(
        required <= row.keys() <= required | (optional or set()),
        f"{where}: missing or unknown fields",
    )
    return row


def text(value: Any, where: str) -> str:
    require(isinstance(value, str) and bool(value.strip()), f"{where}: missing nonblank text")
    return value


def number(value: Any, where: str, minimum=1) -> int:
    require(type(value) is int and minimum <= value <= 2**53 - 1, f"{where}: invalid integer")
    return value


def sha(value: Any, where: str) -> str:
    text(value, where)
    require(
        len(value) == 64 and all(c in "0123456789abcdef" for c in value), f"{where}: invalid SHA256"
    )
    return value


def content_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def surface_id(language: str, surface: str) -> str:
    """Stable presentation identity; never changes the semantic item_id or rank."""
    return "sf_" + content_hash([text(language, "surface language"), text(surface, "surface")])[:32]


def string_list(value: Any, where: str, *, nonempty=False) -> list[str]:
    require(isinstance(value, list) and (bool(value) or not nonempty), f"{where}: expected list")
    result = [text(row, where) for row in value]
    require(len(set(result)) == len(result), f"{where}: duplicate entry")
    return result


def reviewed(row: Any, required: set[str], where: str):
    fields(row, required | {"author", "review"}, where)
    author = text(row["author"], where)
    review = fields(row["review"], {"reviewer", "verdict", "sha256"}, where + " review")
    reviewer = text(review["reviewer"], where)
    require(
        author.strip().casefold() != reviewer.strip().casefold(),
        f"{where}: review must be independent",
    )
    require(review["verdict"] == "accepted", f"{where}: missing accepted review")
    require(
        review["sha256"] == content_hash({k: v for k, v in row.items() if k != "review"}),
        f"{where}: stale review",
    )


@dataclass
class DictionaryInput:
    profile_id: str
    provenance: Mapping[str, Any]
    count: int
    sha256: str
    surfaces: Callable[[], Iterable[str]]
    source_chunks: Callable[[], Iterable[bytes]]

    def words(self):
        """Sorted unique rows plus an end-of-stream integrity check; no full Set."""
        fields(self.provenance, PROVENANCE_FIELDS, "dictionary provenance")
        for key in PROVENANCE_FIELDS:
            (sha if key.endswith("Sha256") else text)(self.provenance[key], "dictionary " + key)
        require(
            self.provenance["normalizationId"] == NORMALIZATION_ID,
            "dictionary: unsupported normalization",
        )
        number(self.count, "dictionary count")
        sha(self.sha256, "dictionary digest")
        raw = hashlib.sha256()
        for chunk in self.source_chunks():
            require(isinstance(chunk, bytes), "dictionary source must supply bytes")
            raw.update(chunk)
        require(
            raw.hexdigest() == self.provenance["sourceSha256"],
            "dictionary raw source hash mismatch",
        )
        digest = hashlib.sha256()
        previous = None
        count = 0
        for word in self.surfaces():
            text(word, "dictionary surface")
            require(not any(c in word for c in "\r\n\0"), "dictionary: invalid surface encoding")
            try:
                encoded = word.encode("utf-8")
            except UnicodeEncodeError as exc:
                raise GradingBuildError("dictionary: invalid Unicode surface") from exc
            require(
                previous is None or previous < encoded, "dictionary: duplicate or unsorted surface"
            )
            previous = encoded
            digest.update(encoded + b"\n")
            count += 1
            yield word
        require(
            count == self.count and digest.hexdigest() == self.sha256,
            "dictionary count/content hash mismatch",
        )


@dataclass
class GradingBuildInputs:
    identity: Mapping[str, Any]
    units: Sequence[Mapping[str, Any]]
    lexemes: Sequence[Mapping[str, Any]]
    exercises: Sequence[Mapping[str, Any]]
    profiles: Sequence[Mapping[str, Any]]
    lessons: Sequence[Mapping[str, Any]]
    drafts: Sequence[Mapping[str, Any]]
    sources: Mapping[str, Mapping[str, Any]]
    approvals: Mapping[str, Mapping[str, Any]]
    surface_catalog: Sequence[Mapping[str, Any]]
    teaching: Sequence[Mapping[str, Any]]
    dictionaries: Sequence[DictionaryInput]
    approval_check: Callable[[Mapping[str, Any], Mapping[str, Any]], bool] | None


@dataclass(frozen=True)
class GradingPayload:
    metadata: Mapping[str, Any]
    runtime_items: tuple[Mapping[str, Any], ...]
    provenance: Mapping[str, Any]
    _dictionaries: tuple[DictionaryInput, ...]

    def word_rows(self):
        for dictionary in self._dictionaries:
            for word in dictionary.words():
                yield dictionary.profile_id, word


def index(rows, key, where):
    require(
        isinstance(rows, Sequence) and not isinstance(rows, (str, bytes)),
        f"{where}: expected records",
    )
    result = {}
    for row in rows:
        require(isinstance(row, Mapping), f"{where}: expected record")
        identity = text(row.get(key), where)
        require(identity not in result, f"{where}: duplicate {identity}")
        result[identity] = row
    return result


def dictionary_policy(
    profile: Mapping[str, Any], lessons: Sequence[Mapping[str, Any]]
) -> Mapping[str, Any]:
    """Exact normalization input projection for the real-core dictionary build.

    No implementation of Spanish/English normalization lives in Python. The build
    invokes the actual core functions for these policies and preserves their hash.
    """
    config = profile["configuration"]
    return {
        "normalizationId": NORMALIZATION_ID,
        "responseLanguage": profile["responseLanguage"],
        "profile": {
            key: copy.deepcopy(config[key])
            for key in (
                "orthographicEquivalences",
                "spaceless",
                "japaneseNormalisation",
                "diacriticsContrastive",
                "contrastiveDiacritics",
            )
        },
        "lessons": [
            {
                key: copy.deepcopy(row[key])
                for key in (
                    "unitId",
                    "lessonIndex",
                    "punctuationEquivalenceClass",
                    "gradedPunctuation",
                )
            }
            for row in sorted(lessons, key=lambda row: (row["unitId"], row["lessonIndex"]))
            if row["profileId"] == profile["profileId"]
        ],
    }


def check_policy(config):
    fields(config, CONFIG_FIELDS, "profile configuration")
    require(
        config["targetLanguageWords"] is None, "dictionary must come from verified source input"
    )
    for key in (
        "spaceless",
        "noWordBoundaries",
        "noWordDelimiter",
        "japaneseNormalisation",
        "diacriticsContrastive",
        "scriptOnlyAnswers",
    ):
        require(type(config[key]) is bool, f"policy {key}: expected boolean")
    for key in ("contrastiveDiacritics", "functionClassTokens"):
        string_list(config[key], "policy " + key)
    require(
        all(len(mark) == 1 for mark in config["contrastiveDiacritics"]),
        "policy: diacritic must be a character",
    )
    for key in ("orthographicEquivalences", "readingsBySurface"):
        require(isinstance(config[key], list), f"policy {key}: expected list")
        keys = []
        for pair in config[key]:
            require(isinstance(pair, list) and len(pair) == 2, f"policy {key}: expected pair")
            keys.append(text(pair[0], key))
            text(pair[1], key)
        require(len(set(keys)) == len(keys), f"policy {key}: duplicate key")
    register = config["registerSlot"]
    if register is not None:
        fields(register, {"suffixesByRegister", "advisoryNote"}, "register policy")
        text(register["advisoryNote"], "register advisory")
        suffixes = register["suffixesByRegister"]
        require(isinstance(suffixes, Mapping) and bool(suffixes), "register suffixes missing")
        seen = set()
        for name, values in suffixes.items():
            text(name, "register name")
            for suffix in string_list(values, "register suffix", nonempty=True):
                require(suffix not in seen, "register: ambiguous suffix")
                seen.add(suffix)
    guards = fields(
        config["typoGuards"],
        {
            "rejectRealTargetWord",
            "rejectEditOnTargetLexeme",
            "minimumLength",
            "lengthUnit",
            "preserveMoraCount",
        },
        "typo policy",
    )
    for key in ("rejectRealTargetWord", "rejectEditOnTargetLexeme", "preserveMoraCount"):
        require(type(guards[key]) is bool, "typo policy: expected boolean")
    number(guards["minimumLength"], "typo minimum")
    require(guards["lengthUnit"] in {"characters", "mora"}, "typo length unit")
    require(config["openResponseLengthUnit"] in {"characters", "tokens"}, "response length unit")
    require(isinstance(config["wordBankJoinDelimiter"], str), "word bank delimiter missing")
    require(not config["spaceless"] or config["wordBankJoinDelimiter"] == "", "spaceless delimiter")
    require(
        not config["noWordDelimiter"] or config["readingsBySurface"], "reading dictionary missing"
    )
    require(
        isinstance(config["targetScriptRanges"], list) and config["targetScriptRanges"],
        "script ranges missing",
    )
    for pair in config["targetScriptRanges"]:
        require(isinstance(pair, list) and len(pair) == 2, "invalid script range")
        low = number(pair[0], "script range", 0)
        high = number(pair[1], "script range", low)
        require(high <= 0x10FFFF, "invalid Unicode range")


def validate_shape(
    gradable,
    presentation,
    forms,
    lexemes,
    draft,
    profile,
    approved_surfaces,
    source,
    approved_pairs,
):
    """Exact typed joins over structured producer data; never parse a saved prompt."""
    family = gradable["family"]
    common = {"family", "targetLexemeId", "targetLexemeSurface", "schedulerFacet"}
    extra = {
        "word-bank": {"tiles"},
        "gap-fill": {"gaps"},
        "match": {"pairs"},
        "read-and-respond": {"prompt", "requiredLexemeIds"},
        "listen-and-respond": {"prompt", "requiredLexemeIds"},
    }.get(family, set())
    require(gradable.keys() <= common | extra, "gradable: fields do not belong to family")
    require(
        gradable.get("schedulerFacet", "meaning") == "meaning",
        "Spanish grading: unsupported scheduler facet",
    )
    require(
        ("targetLexemeId" in gradable) == ("targetLexemeSurface" in gradable),
        "target lexeme: ID and contextual surface must be paired",
    )
    require(draft["responseLanguage"] in {"es", "en"}, "producer: unsupported response language")
    for key in ("instruction", "prompt", "language"):
        text(presentation[key], "presentation " + key)
    for key in ("requiresIme", "hard"):
        if key in presentation:
            require(type(presentation[key]) is bool, "presentation: invalid boolean")
    for key in ("audioRef", "audioText", "slowAudioRef", "promptLanguage", "tip"):
        if key in presentation:
            text(presentation[key], "presentation " + key)
    require(
        "trace" not in presentation,
        "Spanish grading: trace geometry is not a supported source shape",
    )
    if "introduction" in presentation:
        require(
            presentation["introduction"]
            in {"word", "phrase", "grammar", "character", "counter", "particle"},
            "presentation: invalid introduction kind",
        )
    if "accentCharacters" in presentation:
        require(
            all(
                len(ch) == 1
                for ch in string_list(presentation["accentCharacters"], "accent characters")
            ),
            "presentation: invalid accent character",
        )
    if "hints" in presentation:
        require(isinstance(presentation["hints"], list), "presentation: invalid hints")
        for hint in presentation["hints"]:
            fields(hint, {"token", "meanings"}, "hint")
            text(hint["token"], "hint token")
            string_list(hint["meanings"], "hint meanings", nonempty=True)
    if draft["shapeId"] in {
        "tap_what_you_hear",
        "type_what_you_hear",
        "listen_for_the_missing_word",
        "listen_and_respond",
    }:
        require(
            presentation.get("audioRef") == draft["record"].get("audio_ref")
            and bool(presentation.get("audioRef")),
            "audio: exact built reference missing",
        )
    # The caller's current approval validator establishes these checked surfaces.
    # Fixed input derivations must also reconstruct one of them exactly.
    approved = approved_surfaces
    evidence = draft["shapeEvidence"]
    if family == "word-bank":
        fields(evidence, {"kind", "solutions"}, "word bank evidence")
        require(evidence["kind"] == family, "word bank: wrong evidence kind")
        require(
            isinstance(gradable.get("tiles"), list) and gradable["tiles"],
            "word bank: exact tile evidence missing",
        )
        tiles = index(gradable["tiles"], "tileId", "word bank tile")
        for tile in tiles.values():
            fields(tile, {"tileId", "text"}, "word bank tile")
            text(tile["text"], "word bank tile")
        bank = presentation.get("bank")
        require(isinstance(bank, list) and bank, "word bank: visible bank missing")
        visible = index(bank, "id", "visible bank tile")
        for tile in visible.values():
            fields(tile, {"id", "text"}, "visible bank tile")
        require(
            {key: row["text"] for key, row in tiles.items()}
            == {key: row["text"] for key, row in visible.items()},
            "word bank: grader/visible tile mismatch",
        )
        solutions = evidence["solutions"]
        require(isinstance(solutions, list) and solutions, "word bank: solutions missing")
        solved = set()
        accepted = {row["surfaceId"]: row["surface"] for row in forms}
        for solution in solutions:
            fields(solution, {"surfaceId", "tileIds"}, "word bank solution")
            ids = string_list(solution["tileIds"], "word bank solution", nonempty=True)
            require(
                all(key in tiles for key in ids) and solution["surfaceId"] in accepted,
                "word bank solution: unknown identity",
            )
            rendered = profile["configuration"]["wordBankJoinDelimiter"].join(
                tiles[key]["text"] for key in ids
            )
            require(
                rendered == accepted[solution["surfaceId"]],
                "word bank solution: accepted surface is not constructible",
            )
            solved.add(solution["surfaceId"])
        require(solved == accepted.keys(), "word bank: accepted answer missing tile solution")
    elif family == "gap-fill":
        fields(evidence, {"kind", "template", "gapIds", "sourceSpan"}, "gap evidence")
        require(
            evidence["kind"] == family and evidence["template"] == presentation["prompt"],
            "gap: fixed displayed template mismatch",
        )
        # Current Spanish G7 emits one blank. Reject unsupported multi-gap derivation
        # instead of claiming one slot's proof certifies a cross product of answers.
        gaps = gradable.get("gaps")
        require(
            isinstance(gaps, list) and len(gaps) == 1,
            "gap: current Spanish source requires one proven gap",
        )
        gap = fields(gaps[0], {"gapId", "accepted"}, "gap")
        require(
            string_list(evidence["gapIds"], "gap IDs", nonempty=True) == [gap["gapId"]],
            "gap: stale identity/order",
        )
        require(gap["accepted"] == forms, "gap: accepted forms/ranks differ from reviewed catalog")
        from ..config.g7 import GAP_MARKER

        span = fields(evidence["sourceSpan"], {"start", "end"}, "gap source span")
        start = number(span["start"], "gap source start", 0)
        end = number(span["end"], "gap source end", start + 1)
        require(
            end <= len(source["text"])
            and source["text"][:start] + GAP_MARKER + source["text"][end:] == evidence["template"],
            "gap: stale source span/template",
        )
        require(
            forms[0]["surface"] == source["text"][start:end],
            "gap: canonical answer differs from source span",
        )
        require(
            evidence["template"].count(GAP_MARKER) == 1, "gap: exactly one visible marker required"
        )
        require(
            all(
                evidence["template"].replace(GAP_MARKER, form["surface"]) in approved
                for form in forms
            ),
            "gap: reconstruction lacks current language approval",
        )
    elif family == "match":
        fields(evidence, {"kind"}, "match evidence")
        require(evidence["kind"] == family, "match: wrong evidence kind")
        pairs, shown = gradable.get("pairs"), presentation.get("pairs")
        require(
            isinstance(pairs, list)
            and len(pairs) == 5
            and isinstance(shown, list)
            and len(shown) == 5,
            "match: exactly five actual and visible pairs required",
        )
        require(pairs == approved_pairs, "match: pair meanings lack exact current approval")
        lefts, rights, visible_lefts, visible_rights = set(), set(), set(), set()
        from ..config.g7 import MATCH_PAIR_SEPARATOR

        combined = []
        for pair, visible in zip(pairs, shown, strict=True):
            fields(pair, {"leftLexemeId", "rightLexemeId", "left", "right", "facet"}, "match pair")
            fields(
                visible, {"leftItemId", "leftId", "rightId", "left", "right"}, "visible match pair"
            )
            require(
                pair["leftLexemeId"] in lexemes and pair["rightLexemeId"] in lexemes,
                "match: unknown semantic identity",
            )
            require(pair["facet"] == "meaning", "Spanish match: unsupported reading facet")
            require(
                visible["leftItemId"] == pair["leftLexemeId"]
                and (visible["left"], visible["right"]) == (pair["left"], pair["right"]),
                "match: visible/semantic pair mismatch",
            )
            for value, seen in (
                (pair["leftLexemeId"], lefts),
                (pair["rightLexemeId"], rights),
                (visible["leftId"], visible_lefts),
                (visible["rightId"], visible_rights),
            ):
                text(value, "match identity")
                require(value not in seen, "match: duplicate identity")
                seen.add(value)
            combined.append(
                text(pair["left"], "match text")
                + MATCH_PAIR_SEPARATOR
                + text(pair["right"], "match text")
            )
        require(
            combined == [row["surface"] for row in forms],
            "match: pair mapping differs from reviewed accepted set",
        )
    else:
        fields(evidence, {"kind"}, "simple shape evidence")
        require(evidence["kind"] == "simple", "simple shape: wrong evidence kind")
    if family == "select" or draft["shapeId"] in {
        "fill_in_the_blank",
        "listen_for_the_missing_word",
    }:
        options = presentation.get("options")
        require(isinstance(options, list) and options, "select: exact options missing")
        indexed = index(options, "id", "option")
        texts = []
        for row in indexed.values():
            fields(row, {"id", "text"}, "option", {"imageUri", "imageDescription"})
            texts.append(text(row["text"], "option text"))
            for key in ("imageUri", "imageDescription"):
                if key in row:
                    text(row[key], "option image")
        require(len(texts) == len(set(texts)), "select: indistinguishable duplicate options")
        require(
            sum(value in texts for value in [row["surface"] for row in forms]) == 1,
            "select: must display exactly one accepted option",
        )
        distractors = draft["record"].get("distractors")
        require(
            isinstance(distractors, list) and set(texts) == {forms[0]["surface"], *distractors},
            "select: visible options differ from authored distractors",
        )
        if draft["shapeId"] == "picture_select":
            require(
                all(
                    row.get("imageUri") and row.get("imageDescription") for row in indexed.values()
                ),
                "picture select: image asset evidence missing",
            )
    allowed_presentation = (
        {"options"}
        if family == "select"
        or draft["shapeId"] in {"fill_in_the_blank", "listen_for_the_missing_word"}
        else {"bank"}
        if family == "word-bank"
        else {"pairs"}
        if family == "match"
        else set()
    )
    require(
        not ({"options", "bank", "pairs"} & presentation.keys()) - allowed_presentation,
        "presentation: controls do not belong to shape",
    )


def build_grading_payload(inputs: GradingBuildInputs) -> GradingPayload:
    """Assemble complete evidence or fail by name; never return a partial payload."""
    try:
        return _build_grading_payload(inputs)
    except GradingBuildError:
        raise
    except (KeyError, TypeError, AttributeError, IndexError, UnicodeError) as exc:
        raise GradingBuildError(f"malformed grading input: {type(exc).__name__}") from exc


def _build_grading_payload(inputs: GradingBuildInputs) -> GradingPayload:
    fields(inputs.identity, {"packId", "courseId", "version", "lang"}, "pack identity")
    for value in inputs.identity.values():
        text(value, "pack identity")
    require(inputs.identity["lang"] == "es", "producer currently requires a Spanish course")
    require(callable(inputs.approval_check), "approval validator is required")
    units = index(inputs.units, "unit_id", "unit")
    lexemes = index(inputs.lexemes, "lexeme_id", "lexeme")
    exercises = index(inputs.exercises, "exercise_id", "exercise")
    require(bool(exercises), "exercise population is empty")
    profiles = index(inputs.profiles, "profileId", "profile")
    dictionaries = {}
    for source in inputs.dictionaries:
        require(
            source.profile_id in profiles and source.profile_id not in dictionaries,
            "dictionary profile missing or duplicate",
        )
        frozen = replace(source, provenance=copy.deepcopy(source.provenance))
        for _ in frozen.words():
            pass
        dictionaries[source.profile_id] = frozen
    require(dictionaries.keys() == profiles.keys(), "dictionary missing for response profile")
    profile_rows = []
    for profile_id, profile in profiles.items():
        fields(profile, PROFILE_FIELDS, "profile")
        text(profile["responseLanguage"], "response language")
        check_policy(profile["configuration"])
        row = copy.deepcopy(profile)
        dictionary = dictionaries[profile_id]
        row["configuration"]["targetLanguageWords"] = {
            "kind": "table",
            "table": "grading_word",
            "profileId": profile_id,
            "count": dictionary.count,
            "sha256": dictionary.sha256,
            "provenance": copy.deepcopy(dictionary.provenance),
        }
        profile_rows.append(row)
    # An occurrence proves a taught form, not every analysis or reserve in the corpus.
    teaching = []
    for row in inputs.teaching:
        fields(
            row,
            {
                "exerciseId",
                "lexemeId",
                "surface",
                "sourceId",
                "tokenIndex",
                "unitId",
                "lessonIndex",
            },
            "teaching occurrence",
        )
        require(
            row["lexemeId"] in lexemes and row["unitId"] in units,
            "teaching occurrence: unknown identity",
        )
        source = inputs.sources.get(row["sourceId"])
        require(source is not None, "teaching occurrence: missing source")
        require(
            source.get("unit_index") == units[row["unitId"]]["unit_index"]
            and source.get("lesson_index") == row["lessonIndex"],
            "teaching occurrence: stale placement",
        )
        exercise = exercises.get(row["exerciseId"])
        drafts = [
            draft
            for draft in inputs.drafts
            if draft.get("record", {}).get("exercise_id") == row["exerciseId"]
        ]
        require(
            exercise is not None and len(drafts) == 1,
            "teaching occurrence: actual presented exercise missing",
        )
        draft = drafts[0]
        presentation = draft.get("presentation", {})
        shown = [
            presentation.get("prompt"),
            presentation.get("audioText"),
            *presentation.get("acceptedAnswers", []),
        ]
        require(
            draft.get("sourceId") == row["sourceId"] and source.get("text") in shown,
            "teaching occurrence: selected source was not presented",
        )
        require(
            (exercise["unit_id"], exercise["lesson_index"]) == (row["unitId"], row["lessonIndex"]),
            "teaching occurrence: wrong presented placement",
        )
        token_index = number(row["tokenIndex"], "teaching token index", 0)
        tokens = source.get("analysis", {}).get("tokens", [])
        require(token_index < len(tokens), "teaching token is missing")
        token = tokens[token_index]
        lexeme = lexemes[row["lexemeId"]]
        require(
            token.get("surface") == row["surface"]
            and token.get("lemma") == lexeme.get("lemma")
            and token.get("pos") == lexeme.get("pos"),
            "teaching occurrence: wrong contextual lexeme",
        )
        start, end = token.get("start"), token.get("end")
        require(
            type(start) is int
            and type(end) is int
            and 0 <= start < end <= len(source.get("text", ""))
            and source["text"][start:end] == row["surface"],
            "teaching occurrence: stale source span",
        )
        teaching.append(row)
    lessons = {}
    for row in inputs.lessons:
        fields(row, LESSON_FIELDS, "lesson policy")
        require(
            row["unitId"] in units and row["profileId"] in profiles, "lesson: unknown unit/profile"
        )
        number(row["lessonIndex"], "lesson index")
        number(row["openResponseMinimumLength"], "response minimum")
        key = (row["unitId"], row["lessonIndex"], row["profileId"])
        require(key not in lessons, "lesson view duplicate")
        require(
            any(
                e["unit_id"] == row["unitId"] and e["lesson_index"] == row["lessonIndex"]
                for e in exercises.values()
            ),
            "lesson missing from actual exercises",
        )
        for name in ("punctuationEquivalenceClass", "gradedPunctuation"):
            require(
                all(len(ch) == 1 for ch in string_list(row[name], name)),
                "punctuation must be individual characters",
            )
        require(
            not set(row["punctuationEquivalenceClass"]) & set(row["gradedPunctuation"]),
            "punctuation: graded/equivalent overlap",
        )
        if row["register"] is not None:
            register = text(row["register"], "lesson register")
            detector = profiles[row["profileId"]]["configuration"]["registerSlot"]
            require(
                detector is not None and register in detector["suffixesByRegister"],
                "lesson register: detector missing",
            )
        declared = {}
        for inflection in row["taughtInflections"]:
            fields(inflection, {"lexemeId", "surfaces"}, "taught inflection")
            require(
                inflection["lexemeId"] in lexemes and inflection["lexemeId"] not in declared,
                "taught inflection: unknown/duplicate lexeme",
            )
            declared[inflection["lexemeId"]] = set(
                string_list(inflection["surfaces"], "taught inflection", nonempty=True)
            )
        expected = {}
        language = profiles[row["profileId"]]["responseLanguage"]
        for occurrence in teaching:
            source = inputs.sources[occurrence["sourceId"]]
            if source["lang"] != language:
                continue
            if (units[occurrence["unitId"]]["unit_index"], occurrence["lessonIndex"]) <= (
                units[row["unitId"]]["unit_index"],
                row["lessonIndex"],
            ):
                expected.setdefault(occurrence["lexemeId"], set()).add(occurrence["surface"])
        require(declared == expected, "taught inflection: missing, future or unobserved surface")
        lessons[key] = copy.deepcopy(row)
    for profile_id, profile in profiles.items():
        require(
            dictionaries[profile_id].provenance["policySha256"]
            == content_hash(dictionary_policy(profile, inputs.lessons)),
            "dictionary: normalization policy hash mismatch",
        )
    catalog = index(inputs.surface_catalog, "surfaceId", "surface catalog")
    for row in catalog.values():
        reviewed(
            row,
            {"surfaceId", "language", "surface", "rank", "introduction", "sourceIds"},
            "surface rank/introduction",
        )
        require(
            row["surfaceId"] == surface_id(row["language"], row["surface"]),
            "surface identity mismatch",
        )
        number(row["rank"], "surface rank", 0)
        require(
            all(
                source in inputs.sources
                for source in string_list(row["sourceIds"], "surface source IDs", nonempty=True)
            ),
            "surface: missing source",
        )
        intro = row["introduction"]
        if intro is not None:
            fields(intro, {"exerciseId", "unitId", "lessonIndex", "when"}, "surface introduction")
            require(
                intro["when"] in {"prompt", "wrong-feedback"},
                "surface introduction: unknown display event",
            )
            exercise = exercises.get(intro["exerciseId"])
            require(
                exercise is not None
                and (exercise["unit_id"], exercise["lesson_index"])
                == (intro["unitId"], intro["lessonIndex"]),
                "surface introduction: stale/missing exercise",
            )
    runtime, bindings, seen = [], [], set()
    for draft in inputs.drafts:
        fields(draft, DRAFT_FIELDS, "runtime draft/explanation")
        record = draft["record"]
        exercise_id = record.get("exercise_id")
        exercise = exercises.get(exercise_id)
        require(
            exercise is not None and exercise_id not in seen,
            "runtime draft: unknown/duplicate exercise",
        )
        seen.add(exercise_id)
        unit_id, lesson_index = exercise["unit_id"], exercise["lesson_index"]
        require(
            unit_id in units
            and record.get("unit_index") == units[unit_id]["unit_index"]
            and record.get("lesson_index") == lesson_index,
            "runtime draft: stale placement",
        )
        try:
            actual_answers = json.loads(exercise["accepted_answers_json"])
        except (TypeError, ValueError) as exc:
            raise GradingBuildError("exercise: malformed accepted answers") from exc
        require(
            record.get("accepted_answers") == actual_answers
            and record.get("prompt") == exercise["prompt"],
            "runtime draft: stale actual exercise content",
        )
        profile = profiles.get(draft["profileId"])
        require(
            profile is not None and profile["responseLanguage"] == draft["responseLanguage"],
            "runtime draft: wrong response profile",
        )
        require(
            (unit_id, lesson_index, draft["profileId"]) in lessons,
            "runtime draft: exact lesson view missing",
        )
        source = inputs.sources.get(draft["sourceId"])
        require(
            source is not None and content_hash(source) == draft["sourceSha256"],
            "runtime draft: source missing/stale",
        )
        require(
            source.get("unit_index") == units[unit_id]["unit_index"]
            and source.get("lesson_index") == lesson_index,
            "runtime draft: source placement mismatch",
        )
        require(
            record.get("source_sentence_id") in {None, draft["sourceId"]},
            "runtime draft: source identity mismatch",
        )
        approval = inputs.approvals.get(draft["approvalId"])
        require(
            approval is not None and content_hash(approval) == draft["approvalSha256"],
            "runtime draft: approval missing/stale",
        )
        require(
            approval.get("sourceSha256") == draft["sourceSha256"] and bool(approval.get("runId")),
            "runtime draft: approval source/run missing",
        )
        require(
            inputs.approval_check(source, approval) is True,
            "runtime draft: current language approval rejected",
        )
        spec = SHAPES.get(draft["shapeId"])
        require(spec is not None, "runtime draft: unsupported shape")
        source_spec = SOURCE_SHAPES[draft["shapeId"]]
        require(
            record.get("type") == exercise.get("type") == source_spec.type,
            "runtime draft: source/SQL/shape type mismatch",
        )
        gradable = fields(draft["gradable"], {"family"}, "gradable", GRADABLE_FIELDS - {"family"})
        require(gradable["family"] == spec[0], "runtime draft: wrong grading family")
        require(
            json.loads(exercise["distractors_json"]) == record.get("distractors", [])
            and exercise["audio_id"] == draft["presentation"].get("audioRef")
            and exercise["source_sentence_id"] in {None, draft["sourceId"]},
            "runtime draft: actual exercise distractors/audio/source mismatch",
        )
        presentation = fields(
            draft["presentation"],
            {"itemId", "type", "instruction", "prompt", "language", "acceptedAnswers"},
            "presentation",
            PRESENTATION_FIELDS
            - {"itemId", "type", "instruction", "prompt", "language", "acceptedAnswers"},
        )
        require(
            presentation["itemId"] == exercise["item_id"]
            and presentation["type"] == spec[1]
            and presentation["language"] == draft["responseLanguage"],
            "presentation: stale item/type/language",
        )
        require(
            presentation["instruction"] + "\n" + presentation["prompt"] == record["prompt"]
            and presentation["acceptedAnswers"] == actual_answers,
            "presentation: stale instruction/body/answers",
        )
        forms = []
        for surface in string_list(draft["surfaceIds"], "accepted surface IDs", nonempty=True):
            row = catalog.get(surface)
            require(
                row is not None
                and row["language"] == draft["responseLanguage"]
                and draft["sourceId"] in row["sourceIds"],
                "accepted surface: missing or wrong evidence",
            )
            forms.append({"surfaceId": surface, "surface": row["surface"], "rank": row["rank"]})
        require(
            [row["surface"] for row in forms] == actual_answers,
            "accepted surface catalog differs from authored set",
        )
        for key in ("targetLexemeId",):
            if key in gradable:
                require(gradable[key] in lexemes, "target lexeme: unknown exact identity")
        if "targetLexemeSurface" in gradable:
            require(
                "targetLexemeId" in gradable
                and any(
                    t.get("surface") == gradable["targetLexemeSurface"]
                    and t.get("lemma") == lexemes[gradable["targetLexemeId"]]["lemma"]
                    and t.get("pos") == lexemes[gradable["targetLexemeId"]]["pos"]
                    for t in source.get("analysis", {}).get("tokens", [])
                ),
                "target lexeme: missing contextual surface",
            )
        if spec[0] in {"read-and-respond", "listen-and-respond"}:
            required = string_list(
                gradable.get("requiredLexemeIds"), "required lexemes", nonempty=True
            )
            require(
                all(
                    key in lexemes
                    and any(
                        row["lexemeId"] == key
                        for row in lessons[(unit_id, lesson_index, draft["profileId"])][
                            "taughtInflections"
                        ]
                    )
                    for key in required
                )
                and gradable.get("prompt") == presentation["prompt"],
                "open response: missing keyword/prompt evidence",
            )
        if spec[0] not in {"gap-fill", "match"}:
            approved = approval.get(
                "english" if draft["responseLanguage"] == "en" else "spanish", []
            )
            require(
                all(row["surface"] in approved for row in forms),
                "accepted answer lacks current language approval",
            )
        validate_shape(
            gradable,
            presentation,
            forms,
            lexemes,
            draft,
            profile,
            approval.get("english" if draft["responseLanguage"] == "en" else "spanish", []),
            source,
            approval.get("pairs", []),
        )
        # Authorship explicitly chooses canonical targets; response direction never
        # infers a scheduling language or substitutes the first accepted answer.
        targets = (
            {pair["leftLexemeId"]: pair["left"] for pair in gradable["pairs"]}
            if spec[0] == "match"
            else {exercise["item_id"]: None}
        )
        require(
            isinstance(draft["schedulerSurfaces"], list) and draft["schedulerSurfaces"],
            "scheduler surfaces: explicit mappings missing",
        )
        scheduler_surfaces, scheduler_keys = [], set()
        for binding in draft["schedulerSurfaces"]:
            fields(binding, {"itemId", "surfaceId", "canonical"}, "scheduler surface binding")
            row = catalog.get(binding["surfaceId"])
            require(
                row is not None
                and binding["itemId"] in targets
                and type(binding["canonical"]) is bool
                and row["language"] == inputs.identity["lang"]
                and draft["sourceId"] in row["sourceIds"],
                "scheduler surface: missing/wrong source, target, or language",
            )
            key = (binding["itemId"], binding["surfaceId"])
            require(key not in scheduler_keys, "scheduler surface: duplicate mapping")
            scheduler_keys.add(key)
            scheduler_surfaces.append(
                {**binding, "surface": row["surface"], "language": row["language"]}
            )
        for target, displayed in targets.items():
            mappings = [row for row in scheduler_surfaces if row["itemId"] == target]
            require(
                sum(row["canonical"] for row in mappings) == 1,
                "scheduler surface: exactly one canonical required",
            )
            if spec[0] == "match":
                require(
                    len(mappings) == 1 and mappings[0]["surface"] == displayed,
                    "scheduler surface: actual match target differs",
                )
            else:
                expected_ids = (
                    set(draft["surfaceIds"])
                    if draft["responseLanguage"] == inputs.identity["lang"]
                    else set()
                )
                require(
                    expected_ids <= {row["surfaceId"] for row in mappings}
                    and all(
                        row["canonical"] or row["surfaceId"] in expected_ids for row in mappings
                    ),
                    "scheduler surface: accepted target mapping missing or unsupported",
                )
                canonical = next(row for row in mappings if row["canonical"])
                require(
                    canonical["surfaceId"] in expected_ids
                    or canonical["surface"] in approval.get("spanish", []),
                    "scheduler surface: canonical lacks current target-language approval",
                )
        explanation = draft["explanation"]
        reviewed(explanation, {"exerciseId", "text", "sourceId"}, "explanation")
        require(
            explanation["exerciseId"] == exercise_id
            and explanation["sourceId"] == draft["sourceId"],
            "explanation: stale binding",
        )
        text(explanation["text"], "explanation")
        introductions = []
        for row in catalog.values():
            intro = row["introduction"]
            if intro is None or intro["exerciseId"] != exercise_id:
                continue
            require(draft["sourceId"] in row["sourceIds"], "introduction: wrong source binding")
            if intro["when"] == "prompt":
                require(
                    presentation["type"] not in HIDDEN_AUDIO_PROMPT_TYPES
                    and "promptLanguage" in presentation
                    and row["surface"] == presentation["prompt"]
                    and row["language"] == presentation["promptLanguage"],
                    "introduction: prompt is hidden, different, or lacks explicit language",
                )
            else:
                require(
                    row["surface"] == presentation["acceptedAnswers"][0]
                    and row["language"] == presentation["language"],
                    "introduction: wrong feedback does not display this surface",
                )
            introductions.append(
                {key: row[key] for key in ("surfaceId", "surface", "language")}
                | {"when": intro["when"]}
            )
        runtime.append(
            {
                "schemaVersion": WIRE_VERSION,
                "exerciseId": exercise_id,
                "itemId": exercise["item_id"],
                "unitId": unit_id,
                "lessonIndex": lesson_index,
                "profileId": draft["profileId"],
                "responseLanguage": draft["responseLanguage"],
                "proof": {
                    "sourceId": draft["sourceId"],
                    "sourceSha256": draft["sourceSha256"],
                    "approvalId": draft["approvalId"],
                    "approvalSha256": draft["approvalSha256"],
                    "draftSha256": content_hash(draft),
                },
                "gradable": {
                    "itemId": exercise["item_id"],
                    **copy.deepcopy(gradable),
                    "accepted": forms,
                },
                "presentation": copy.deepcopy(presentation),
                "introductions": introductions,
                "schedulerSurfaces": scheduler_surfaces,
                "explanation": explanation["text"],
            }
        )
        bindings.append(
            {
                "exerciseId": exercise_id,
                "unitId": unit_id,
                "lessonIndex": lesson_index,
                "profileId": draft["profileId"],
                "responseLanguage": draft["responseLanguage"],
            }
        )
    require(seen == exercises.keys(), "runtime draft: incomplete actual exercise population")
    metadata = {
        "schemaVersion": WIRE_VERSION,
        "packId": inputs.identity["packId"],
        "courseId": inputs.identity["courseId"],
        "packVersion": inputs.identity["version"],
        "profiles": profile_rows,
        "lessons": list(lessons.values()),
        "exercises": bindings,
    }
    provenance = {
        "schemaVersion": WIRE_VERSION,
        "metadataSha256": content_hash(metadata),
        "runtimeSha256": content_hash(runtime),
        "exerciseRowsSha256": content_hash(
            sorted(inputs.exercises, key=lambda row: row["exercise_id"])
        ),
        "surfaceCatalogSha256": content_hash(inputs.surface_catalog),
        "teachingSha256": content_hash(inputs.teaching),
        "dictionaryProofs": [copy.deepcopy(row.provenance) for row in dictionaries.values()],
    }
    return GradingPayload(metadata, tuple(runtime), provenance, tuple(dictionaries.values()))
