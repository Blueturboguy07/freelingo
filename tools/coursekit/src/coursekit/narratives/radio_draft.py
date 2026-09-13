"""Compile explicit Radio occurrences into a reviewable, deliberately nonplayable draft.

No question receives atMs or audioUri here. The measured-audio finalizer owns those
fields. A lemma claim never selects a token occurrence, target ID, or inflection.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any

from ..config.narratives import RADIO_LISTEN_PROMPT, RADIO_MATCH_PROMPT
from ..ledger import is_lexical_pos
from .compiler import NarrativeError
from .radio import RadioPreparation, _closed, _require, _text, radio_preparation_hash
from .targets import RadioPackTargets, _identity


@dataclass(frozen=True)
class RadioDraft:
    content: dict[str, Any]
    evidence: dict[str, Any]
    author: str
    requires: tuple[str, ...] = ("review", "curriculum-validation", "audio")

    def review_candidate(self) -> dict[str, Any]:
        return copy.deepcopy(
            {
                "id": self.content["id"],
                "author": self.author,
                "content": self.content,
                "evidence": self.evidence,
            }
        )


def compile_radio_draft(
    prepared: RadioPreparation, plan: dict[str, Any], targets: RadioPackTargets
) -> RadioDraft:
    """All plans are explicit authoring inputs awaiting independent review.

    Question ordering and words are retained. Listen windows use whole declared source
    segments through the question boundary; every offered word heard in that window
    must be marked correct, so an extra valid distractor cannot be hidden by the count.
    """
    try:
        _closed(
            plan,
            {
                "schemaVersion",
                "sourceSha256",
                "preparationSha256",
                "packSha256",
                "author",
                "introEndSegment",
                "questions",
            },
            "Radio plan",
        )
        _require(
            type(plan["schemaVersion"]) is int and plan["schemaVersion"] == 1,
            "Radio plan: unsupported revision.",
        )
        _require(
            plan["sourceSha256"] == prepared.source_hash
            and plan["preparationSha256"] == radio_preparation_hash(prepared),
            "Radio plan: stale source/analysis/cast evidence.",
        )
        _require(
            plan["packSha256"] == targets.pack_sha256
            and prepared.source["language"] == targets.language,
            "Radio plan: wrong target pack snapshot/language.",
        )
        author = _text(plan["author"], "Radio plan author")
        source = prepared.source
        segments = source["segments"]
        order = {s["id"]: i for i, s in enumerate(segments)}
        intro = plan["introEndSegment"]
        _require(
            isinstance(intro, str) and intro in order, "Radio plan: actual intro boundary required."
        )
        _require(
            all(
                s["character_id"] == source["show"]["host_character_id"]
                for s in segments[: order[intro] + 1]
            ),
            "Radio plan: declared intro includes a non-host segment.",
        )
        _require(
            isinstance(plan["questions"], list)
            and len(plan["questions"]) == len(source["questions"]),
            "Radio plan: complete exact question plans required.",
        )
        plan_by = {}
        for row in plan["questions"]:
            _require(
                isinstance(row, dict)
                and isinstance(row.get("id"), str)
                and row["id"] not in plan_by,
                "Radio plan: duplicate or malformed question identity.",
            )
            plan_by[row["id"]] = row
        _require(
            set(plan_by) == {q["id"] for q in source["questions"]},
            "Radio plan: question identity mismatch.",
        )
        evidence_targets = []
        occurrences = []

        def bind(row, lemma, anchor, *, occurrence_required=True, first_segment=None):
            _closed(row, {"lemma", "target", "occurrence"}, "Radio target occurrence plan")
            _require(row["lemma"] == lemma, "Radio target: ordered source lexical claim changed.")
            ref = _closed(
                row["target"],
                {"exerciseId", "schedulerItemId", "surfaceId"},
                "Radio target reference",
            )
            target = targets.resolve(ref["exerciseId"], ref["schedulerItemId"], ref["surfaceId"])
            lexical = target["lexical"]
            scheduler = target["scheduler"]
            _identity(lexical, (lexical["lemma"], lexical["pos"]), source["language"])
            _require(
                lexical["lemma"] == lemma
                and lexical["classification"] == "word"
                and scheduler["kind"] == "lexeme"
                and scheduler["itemRef"] == lexical["lexemeId"]
                and scheduler["itemId"] == lexical["schedulerItemId"]
                and all(scheduler[k] == lexical[k] for k in ("surfaceId", "surface", "language")),
                "Radio target: surface is not the declared lexical content target.",
            )
            _require(
                type(target["unitIndex"]) is int and target["unitIndex"] <= source["unit_index"],
                "Radio target: future curriculum target.",
            )
            evidence_targets.append(copy.deepcopy(target))
            occurrence = row["occurrence"]
            if occurrence is None:
                _require(
                    not occurrence_required, "Radio target: exact heard occurrence is missing."
                )
                return target, None
            _closed(occurrence, {"segmentId", "tokenIndex"}, "Radio occurrence")
            segment_id = occurrence["segmentId"]
            index = occurrence["tokenIndex"]
            _require(
                isinstance(segment_id, str)
                and segment_id in order
                and order[segment_id] <= order[anchor]
                and (first_segment is None or order[segment_id] >= order[first_segment]),
                "Radio target: occurrence is outside the exact listening window.",
            )
            tokens = prepared.analyses["segment:" + segment_id]["tokens"]
            _require(
                type(index) is int and 0 <= index < len(tokens),
                "Radio target: invalid exact token index.",
            )
            token = tokens[index]
            _require(
                is_lexical_pos(token["pos"])
                and (token["lemma"], token["pos"], token["surface"])
                == (lexical["lemma"], lexical["pos"], lexical["surface"]),
                "Radio target: exact token lemma/POS/surface mismatch.",
            )
            fact = {
                "segmentId": segment_id,
                "tokenIndex": index,
                "token": copy.deepcopy(token),
                "exerciseId": ref["exerciseId"],
                "schedulerItemId": scheduler["itemId"],
                "surfaceId": scheduler["surfaceId"],
            }
            occurrences.append(fact)
            return target, fact

        compiled = []
        for question in source["questions"]:
            qid = question["id"]
            qplan = plan_by[qid]
            kind = question["kind"]
            anchor = question["after_segment"]
            _require(
                order[anchor] > order[intro],
                "Radio plan: question precedes the end of the host intro.",
            )
            base = {"id": qid, "kind": kind, "afterSegment": anchor}
            if kind == "comprehension":
                _closed(qplan, {"id", "targets"}, "Radio comprehension plan")
                claims = question["target_lemmas"]
                rows = qplan["targets"]
                _require(
                    isinstance(rows, list) and len(rows) == len(claims),
                    "Radio comprehension: exact targets required.",
                )
                item_ids = []
                for row, lemma in zip(rows, claims, strict=True):
                    target, _ = bind(row, lemma, anchor)
                    _require(
                        any(
                            (t["lemma"], t["pos"]) == (lemma, target["lexical"]["pos"])
                            for t in prepared.analyses["question:" + qid + ":accepted"]["tokens"]
                        ),
                        "Radio comprehension: target absent from authored accepted answer.",
                    )
                    item_ids.append(target["scheduler"]["itemId"])
                options = [
                    {"id": f"{qid}:option:{i}", "text": text}
                    for i, text in enumerate([question["accepted"], *question["distractors"]])
                ]
                compiled.append(
                    {
                        **base,
                        "prompt": question["prompt"],
                        "options": options,
                        "correctOptionId": options[0]["id"],
                        "itemIds": list(dict.fromkeys(item_ids)),
                    }
                )
            elif kind == "matching":
                _closed(qplan, {"id", "pairs"}, "Radio matching plan")
                rows = qplan["pairs"]
                pairs = question["pairs"]
                _require(
                    isinstance(rows, list) and len(rows) == len(pairs),
                    "Radio matching: exact displayed pairs required.",
                )
                result = []
                for i, (row, pair) in enumerate(zip(rows, pairs, strict=True)):
                    target, _ = bind(row, pair["lemma"], anchor)
                    result.append(
                        {
                            "id": f"{qid}:pair:{i}",
                            "left": target["lexical"]["surface"],
                            "right": pair["translation"],
                            "itemIds": [target["scheduler"]["itemId"]],
                        }
                    )
                _require(
                    len({r["left"] for r in result}) == len(result),
                    "Radio matching: duplicate displayed surface.",
                )
                compiled.append({**base, "prompt": RADIO_MATCH_PROMPT, "pairs": result})
            else:
                _closed(qplan, {"id", "listenFromSegment", "tiles"}, "Radio selection plan")
                first = qplan["listenFromSegment"]
                _require(
                    isinstance(first, str)
                    and first in order
                    and order[intro] < order[first] <= order[anchor],
                    "Radio selection: explicit post-intro listening window required.",
                )
                rows = qplan["tiles"]
                lemmas = question["tile_lemmas"]
                correct = set(question["correct_lemmas"])
                _require(
                    isinstance(rows, list) and len(rows) == len(lemmas),
                    "Radio selection: every displayed tile needs an explicit target.",
                )
                heard = [
                    t
                    for segment in segments[order[first] : order[anchor] + 1]
                    for t in prepared.analyses["segment:" + segment["id"]]["tokens"]
                    if is_lexical_pos(t["pos"])
                ]
                tiles = []
                correct_ids = []
                for i, (row, lemma) in enumerate(zip(rows, lemmas, strict=True)):
                    is_correct = lemma in correct
                    target, occurrence = bind(
                        row, lemma, anchor, occurrence_required=is_correct, first_segment=first
                    )
                    lexical = target["lexical"]
                    actual = any(t["lemma"] == lemma and t["pos"] == lexical["pos"] for t in heard)
                    _require(
                        actual == is_correct,
                        "Radio selection: declared distractor is heard, or correct word is absent.",
                    )
                    _require(
                        is_correct or occurrence is None,
                        "Radio selection: unheard distractor cannot declare an occurrence.",
                    )
                    tile_id = f"{qid}:tile:{i}"
                    token_id = (
                        f"{occurrence['segmentId']}:{occurrence['tokenIndex']}"
                        if occurrence is not None
                        else lexical["surfaceId"]
                    )
                    tiles.append(
                        {
                            "id": tile_id,
                            "text": lexical["surface"],
                            "tokenId": token_id,
                            "contentToken": True,
                            "itemIds": [target["scheduler"]["itemId"]],
                        }
                    )
                    if is_correct:
                        correct_ids.append(tile_id)
                _require(
                    len({t["text"] for t in tiles}) == len(tiles),
                    "Radio selection: duplicate displayed surface.",
                )
                compiled.append(
                    {
                        **base,
                        "prompt": RADIO_LISTEN_PROMPT.format(count=question["count"]),
                        "count": question["count"],
                        "tiles": tiles,
                        "correctTileIds": correct_ids,
                    }
                )
        content = {
            "schemaVersion": 1,
            "id": source["id"],
            "title": source["title"],
            "language": source["language"],
            "unitIndex": source["unit_index"],
            "show": {
                "id": source["show"]["id"],
                "title": source["show"]["title"],
                "hostCharacterId": source["show"]["host_character_id"],
            },
            "l1Ratio": source["l1_ratio"],
            "targetDurationMs": source["target_duration_ms"],
            "segments": [
                {
                    "id": s["id"],
                    "text": s["text"],
                    "characterId": s["character_id"],
                    "language": source["language"],
                }
                for s in segments
            ],
            "questions": compiled,
        }
        evidence = {
            "source": copy.deepcopy(source),
            "sourceSha256": prepared.source_hash,
            "preparationSha256": plan["preparationSha256"],
            "castSha256": prepared.cast_sha256,
            "analyses": copy.deepcopy(prepared.analyses),
            "plan": copy.deepcopy(plan),
            "packSha256": targets.pack_sha256,
            "targets": evidence_targets,
            "occurrences": occurrences,
        }
        return RadioDraft(content, evidence, author)
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        if isinstance(exc, NarrativeError):
            raise
        raise NarrativeError(
            f"Radio draft: missing or malformed explicit source evidence: {exc}"
        ) from exc
