"""Diffable Story DSL to the P6 wire format. No language quality is inferred by parsing."""

from __future__ import annotations

import hashlib
import re
import shlex
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from ..ledger import is_lexical_pos
from ..validators import Finding


class NarrativeError(ValueError):
    """Named invalid or missing narrative input; never silently repaired."""


@dataclass(frozen=True)
class CompiledStory:
    document: dict[str, Any]
    analyses: dict[str, dict[str, Any]]
    translations: dict[str, str]
    findings: tuple[Finding, ...]
    author: str
    source_hash: str


def _offset(text: str) -> int:
    """Wire ranges are JavaScript UTF-16 offsets, not Python code-point offsets."""
    return len(text.encode("utf-16-le")) // 2


def parse_markup(raw: str) -> tuple[str, list[dict], list[dict]]:
    chars: list[str] = []
    stack: list[tuple[str, int, bool]] = []
    hidden: list[dict] = []
    choices: list[dict] = []
    i = 0
    while i < len(raw):
        char = raw[i]
        if raw[i : i + 2] in ("[[", "]]", "((", "))"):
            chars.append(char)
            i += 2
            continue
        if char in "[(":
            correct = char == "(" and raw[i + 1 : i + 2] == "+"
            stack.append((char, _offset("".join(chars)), correct))
            i += 2 if correct else 1
            continue
        if char in "])":
            if not stack or stack[-1][0] != ("[" if char == "]" else "("):
                raise NarrativeError("Unbalanced story markup.")
            kind, start, correct = stack.pop()
            span = {"start": start, "end": _offset("".join(chars))}
            if span["start"] == span["end"]:
                raise NarrativeError("Empty story range.")
            if kind == "[":
                hidden.append(span)
            else:
                choices.append(dict(span, correct=correct))
            i += 1
            continue
        chars.append(" " if char == "~" else char)
        i += 1
    if stack:
        raise NarrativeError("Unbalanced story markup.")
    return (
        "".join(chars),
        sorted(hidden, key=lambda s: s["start"]),
        sorted(choices, key=lambda s: s["start"]),
    )


def _slice(text: str, start: int, end: int) -> str:
    return text.encode("utf-16-le")[start * 2 : end * 2].decode("utf-16-le")


def _blocks(source: str) -> list[tuple[str, list[str]]]:
    blocks: list[tuple[str, list[str]]] = []
    for raw in source.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        header = re.fullmatch(r"\[([A-Z_]+)\]", line)
        if header:
            blocks.append((header.group(1), []))
        elif not blocks:
            raise NarrativeError("Story text appears before [DATA].")
        else:
            blocks[-1][1].append(line)
    return blocks


def _metadata(lines: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in lines:
        if "=" not in line:
            raise NarrativeError("DATA entries must be key=value.")
        key, value = line.split("=", 1)
        if key in result:
            raise NarrativeError(f"Duplicate DATA key {key}.")
        result[key] = value.strip()
    return result


def compile_story(
    source: str,
    *,
    analyse: Callable[[str], dict[str, Any]],
    item_ids: Mapping[str, str],
    introduced_surfaces: set[str] | None = None,
) -> CompiledStory:
    blocks = _blocks(source)
    names = [name for name, _ in blocks]
    if any(names.count(name) != 1 for name in ("DATA", "HEADER", "MATCH")):
        raise NarrativeError("A story requires exactly one DATA, HEADER and MATCH.")
    if names[0] != "DATA" or names[1] != "HEADER":
        raise NarrativeError("DATA and HEADER must open a story.")
    if names[-1] != "MATCH":
        raise NarrativeError("MATCH must be last.")
    data = _metadata(blocks[0][1])
    required = (
        "id",
        "language",
        "unit",
        "fromLanguageName",
        "author",
        "narrator_register",
        "cover",
    )
    if any(not data.get(key) for key in required):
        raise NarrativeError(f"DATA requires {', '.join(required)}.")
    if data["language"] == "ja" and introduced_surfaces is None:
        raise NarrativeError("Japanese MATCH needs introduced surfaces and Mode-A analysis.")
    elements: list[dict[str, Any]] = []
    analyses: dict[str, dict[str, Any]] = {}
    translations: dict[str, str] = {}
    findings: list[Finding] = []
    occurred: set[str] = set()

    def ids(lemmas: list[str]) -> list[str]:
        missing = [lemma for lemma in lemmas if lemma not in item_ids]
        if missing:
            raise NarrativeError(f"No active pack item id for {', '.join(missing)}.")
        return list(dict.fromkeys(item_ids[lemma] for lemma in lemmas))

    def text_content(
        raw: str, hint_line: str | None, eid: str
    ) -> tuple[dict, list[dict], list[dict]]:
        text, hidden, choices = parse_markup(raw)
        analysis = analyse(text)
        tokens = analysis.get("tokens", [])
        if not tokens or any(
            text[token["start"] : token["end"]] != token["surface"] for token in tokens
        ):
            raise NarrativeError(f"Missing or stale exact-span analysis for {eid}.")
        boundaries = {_offset(text[: token[key]]) for token in tokens for key in ("start", "end")}
        for span in [*hidden, *choices]:
            if span["start"] not in boundaries or span["end"] not in boundaries:
                raise NarrativeError(f"Range crosses a morpheme boundary at {eid}.")
        analyses[eid] = analysis
        occurred.update(token["lemma"] for token in tokens if is_lexical_pos(token["pos"]))
        hints: list[dict] = []
        if hint_line is not None:
            grouped, _, _ = parse_markup(raw.replace("~", "\uf000"))
            # Source segmentation belongs to the supplied analyzer. Only an authored
            # tilde joins adjacent lexical spans into a phrase hint; no regex invents
            # word boundaries inside compounds or scripts without spaces.
            words: list[dict[str, int]] = []
            for token in tokens:
                if not is_lexical_pos(token["pos"]):
                    continue
                start, end = token["start"], token["end"]
                between = grouped[words[-1]["end"] : start] if words else ""
                if words and between and all(char == "\uf000" for char in between):
                    words[-1]["end"] = end
                else:
                    words.append({"start": start, "end": end})
            # This is the DSL's gloss-field lexer, not target-language tokenization.
            # Tilde is the only in-field phrase separator; quotes/escapes stay literal.
            lexer = shlex.shlex(hint_line.removeprefix("~"), posix=True)
            lexer.whitespace_split = True
            lexer.commenters = lexer.quotes = lexer.escape = ""
            glosses = list(lexer)
            if len(words) != len(glosses):
                raise NarrativeError(
                    f"Hint alignment count differs at {eid}: "
                    f"{len(words)} words, {len(glosses)} hints."
                )
            hints = [
                {
                    "start": _offset(text[: word["start"]]),
                    "end": _offset(text[: word["end"]]),
                    "gloss": gloss.replace("~", " "),
                }
                for word, gloss in zip(words, glosses, strict=True)
            ]
        return {"text": text, "hints": hints, "ruby": []}, hidden, choices

    for index, (name, lines) in enumerate(blocks[1:], start=1):
        eid = f"{data['id']}:{index}"
        base = {"id": eid, "lineIndex": index - 1}
        if name == "HEADER":
            raw = next((line[1:].strip() for line in lines if line.startswith(">")), "")
            content, _, _ = text_content(
                raw,
                next((source_line for source_line in lines if source_line.startswith("~")), None),
                eid,
            )
            elements.append(dict(base, type="HEADER", content=content))
            translations[eid] = data["fromLanguageName"]
            continue
        if name == "MATCH":
            pairs: list[dict] = []
            for line in lines:
                if "<>" not in line:
                    continue
                left, right = (
                    part.strip() for part in line.removeprefix("-").strip().split("<>", 1)
                )
                lemma_set = [
                    t["lemma"]
                    for t in analyse(left)["tokens"]
                    if t["pos"] not in ("PUNCT", "SYM", "SPACE")
                ]
                if not lemma_set or not set(lemma_set) <= occurred:
                    raise NarrativeError(f"MATCH pair {left!r} did not occur in the story.")
                if introduced_surfaces is not None and left not in introduced_surfaces:
                    raise NarrativeError(f"MATCH surface {left!r} was not introduced.")
                pairs.append(
                    {
                        "id": f"{eid}:pair{len(pairs)}",
                        "left": left,
                        "right": right,
                        "itemIds": ids(lemma_set),
                    }
                )
            if not pairs:
                raise NarrativeError("MATCH requires at least one pair.")
            if len(pairs) != 5:
                findings.append(
                    Finding(
                        "INV-PACK-09",
                        "warning",
                        "MATCH convention is five pairs; renderer shows at most five.",
                        eid,
                    )
                )
            elements.append(dict(base, type="MATCH", pairs=pairs))
            continue
        known = {
            "LINE",
            "SELECT_PHRASE",
            "CONTINUATION",
            "ARRANGE",
            "POINT_TO_PHRASE",
            "MULTIPLE_CHOICE",
        }
        if name not in known:
            elements.append(dict(base, type="ERROR", message=f"Unknown story block [{name}]."))
            findings.append(
                Finding("INV-PACK-09", "warning", f"Unknown block [{name}] retained inline.", eid)
            )
            continue
        prompt = next((line[1:].strip() for line in lines if line.startswith(">")), "")
        speaker = next(
            (
                re.fullmatch(r"Speaker([\w-]+):\s*(.+)", line)
                for line in lines
                if line.startswith("Speaker")
            ),
            None,
        )
        content = None
        hidden: list[dict] = []
        choices: list[dict] = []
        if name != "MULTIPLE_CHOICE":
            if speaker is None and name != "LINE":
                raise NarrativeError(f"{name} requires a speaker line.")
            raw = speaker.group(2) if speaker else prompt
            line_id = eid if name == "LINE" else eid + ":line"
            content, hidden, choices = text_content(
                raw,
                next((source_line for source_line in lines if source_line.startswith("~")), None),
                line_id,
            )
            translation = next((line[1:].strip() for line in lines if line.startswith("=")), "")
            if not translation:
                raise NarrativeError(f"Missing authored bilingual translation at {line_id}.")
            translations[line_id] = translation
            line = dict(
                base,
                id=line_id,
                type="LINE",
                kind="CHARACTER" if speaker else "PROSE",
                content=content,
                hidden=hidden,
                receptiveOnly=True,
            )
            if speaker:
                line["characterId"] = speaker.group(1)
            elements.append(line)
            if name == "LINE":
                continue
        tags = next(
            (line.removeprefix("@tags=").split("|") for line in lines if line.startswith("@tags=")),
            [],
        )
        if not tags:
            raise NarrativeError(f"Missing explicit item tags at {eid}.")
        challenge = dict(base, prompt=prompt, itemIds=ids(tags))
        if name in ("SELECT_PHRASE", "CONTINUATION", "MULTIPLE_CHOICE"):
            options = [
                {
                    "id": f"{eid}:option{i}",
                    "text": line[1:].strip(),
                    "correct": line.startswith("+"),
                }
                for i, line in enumerate(
                    source_line for source_line in lines if source_line.startswith(("+", "-"))
                )
            ]
            correct = [option for option in options if option["correct"]]
            if len(correct) != 1 or len(options) < 2 or len(options) > 4:
                raise NarrativeError(f"{name} needs one correct option and two to four options.")
            if name == "SELECT_PHRASE" and len(options) != 3:
                raise NarrativeError("SELECT_PHRASE needs three phonetic options.")
            challenge.update(
                type="MULTIPLE_CHOICE" if name == "MULTIPLE_CHOICE" else "SELECT_PHRASE",
                options=[{k: v for k, v in option.items() if k != "correct"} for option in options],
                correctOptionId=correct[0]["id"],
            )
            if name != "MULTIPLE_CHOICE":
                if not hidden:
                    raise NarrativeError(f"{name} requires a hidden span.")
                challenge["challengeType"] = (
                    "continuation" if name == "CONTINUATION" else "selectPhrase"
                )
                if name == "CONTINUATION":
                    # Actual omitted speech is carried separately; no fabricated keypoints.
                    pieces = []
                    cursor = 0
                    for span in hidden:
                        if span["start"] > cursor:
                            pieces.append(_slice(content["text"], cursor, span["start"]))
                        cursor = max(cursor, span["end"])
                    pieces.append(_slice(content["text"], cursor, _offset(content["text"])))
                    elements[-1]["spokenText"] = "".join(pieces).strip()
        elif name == "POINT_TO_PHRASE":
            correct = [choice for choice in choices if choice["correct"]]
            if len(correct) != 1:
                raise NarrativeError("POINT_TO_PHRASE needs one marked correct range.")
            ranges = [
                dict(start=choice["start"], end=choice["end"], id=f"{eid}:range{i}")
                for i, choice in enumerate(choices)
            ]
            challenge.update(
                type="POINT_TO_PHRASE",
                ranges=ranges,
                correctRangeId=ranges[choices.index(correct[0])]["id"],
            )
        elif name == "ARRANGE":
            if not hidden or not choices:
                raise NarrativeError("ARRANGE requires hidden tiles.")
            tiles = [
                {
                    "id": f"{eid}:tile{i}",
                    "text": _slice(content["text"], choice["start"], choice["end"]),
                }
                for i, choice in enumerate(choices)
            ]
            challenge.update(
                type="ARRANGE",
                tiles=list(reversed(tiles)),
                correctTileIds=[tile["id"] for tile in tiles],
            )
        elements.append(challenge)
    digest = hashlib.sha256(source.encode()).hexdigest()
    document = {
        "schemaVersion": 1,
        "id": data["id"],
        "revision": digest,
        "language": data["language"],
        "unitIndex": int(data["unit"]),
        "title": data["fromLanguageName"],
        "targetTitle": elements[0]["content"]["text"],
        "narratorRegister": data["narrator_register"],
        "covers": {
            key: data.get("cover_" + key, data["cover"]) for key in ("active", "locked", "gilded")
        },
        "elements": elements,
        "bakedAudioComplete": False,
    }
    return CompiledStory(document, analyses, translations, tuple(findings), data["author"], digest)
