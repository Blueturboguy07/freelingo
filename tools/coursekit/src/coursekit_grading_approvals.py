"""Current source approvals for the grading producer; no parallel truth store.

This adapter composes the authoritative artifact, glossary and G6 answer loaders.
Its projections are ephemeral transport objects, not independently issuable proofs.
No supplied score/run ID or old agent review can replace those current loaders.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Mapping
from copy import deepcopy
from pathlib import Path

from coursekit.answer_evidence import load_validated_answer_evidence
from coursekit.config.answer_evidence import ANSWER_APPROVAL_PATH, ANSWER_EVIDENCE_PATH
from coursekit.config.lexeme_glosses import GLOSSARY_RELATIVE_PATH
from coursekit.lexeme_glosses import load_glossary
from coursekit.selected_sources import (
    evidence_digest,
    resolve_selected_sources,
    source_population_digest,
)
from coursekit.stages.g6_population import expected_selected_slots

from coursekit.artifacts import _repo_root, artifact_path, read_records, run_dir, validate_record
from coursekit.config.g5 import CONTENT_ROOT_DIRNAME, CONTENT_ROOT_ENV_VAR
from coursekit.registers import _sentence_tokens, sentence_register_matches, unit_register
from coursekit.runlog import read_entries
from coursekit.stages.g1_analyze import adapter_for


class ApprovalAdapterError(ValueError):
    """Source evidence is missing, stale, incomplete or unsupported."""


def require(ok, reason):
    if not ok:
        raise ApprovalAdapterError(reason)


def _index(rows, key):
    result = {}
    for row in rows:
        identity = row[key]
        require(identity not in result, f"duplicate {key}")
        result[identity] = row
    return result


def _slot(row):
    values = tuple(row[k] for k in ("unit_index", "lesson_index", "slot_index"))
    require(all(type(v) is int for v in values), "invalid selected coordinates")
    return values


def _latest(lang, count):
    entries = list(read_entries(lang))
    latest = {entry["stage"]: (i, entry) for i, entry in enumerate(entries)}
    cursor = -1
    result = []
    for i in range(count):
        name = f"g{i}"
        require(name in latest, f"missing current {name}")
        position, entry = latest[name]
        require(position > cursor and entry["status"] == "ok", f"failed or stale {name}")
        cursor = position
        result.append(entry)
    return result


def _curriculum(lang):
    units = list(read_records("unit_assignment", lang=lang))
    selected = list(read_records("selected_item", lang=lang))
    banded = list(read_records("banded_lemma", lang=lang))
    require(units and banded, "missing G2/G3 declaration")
    slots = {_slot(row): row for row in selected}
    require(len(slots) == len(selected), "duplicate selected slot")
    require(set(slots) == set(expected_selected_slots(units)), "incomplete G3/G4 population")
    require(
        all(row["lang"] == lang for row in [*units, *selected, *banded]), "foreign language source"
    )
    return units, selected, banded


def _content_root():
    return Path(os.environ.get(CONTENT_ROOT_ENV_VAR, _repo_root() / CONTENT_ROOT_DIRNAME))


def _fingerprint(lang, kinds, *, content_paths=(), run_paths=()):
    paths = [artifact_path(lang, kind) for kind in kinds]
    paths += [_content_root() / lang / name for name in content_paths]
    paths += [run_dir(lang) / name for name in run_paths]
    result = []
    for path in paths:
        with path.open("rb") as handle:
            result.append((str(path.resolve()), hashlib.file_digest(handle, "sha256").hexdigest()))
    return result


class GradingApprovalAdapter:
    """Callable as GradingBuildInputs.approval_check, with fresh checks on every call.

    Current roots come only from coursekit's existing build/content environment.
    There is no override for successful G6, reviewers, analysis or partial rows.
    Re-reading avoids treating a cached success as proof after source/run changes.
    """

    def __init__(self, lang: str):
        require(lang == "es", "only the declared Spanish grading source policy is supported")
        self.lang = lang

    def project_lexical(self, source: Mapping):
        """A standalone lemma uses current G2 + independent supported glossary senses.

        Only the reviewed citation is projected. Contextual alternates in the
        glossary remain decoy exclusions; accepted-answer additions need exact
        independently reviewed answer-set evidence in a later projection.
        This is not a G5 sentence fill: it neither consumes a candidate slot nor
        lowers its raw floor/length policy. Original G1 POS remains untouched when
        reviewed G2 intended POS differs (e.g. hola INTJ vs isolated PROPN).
        """
        require(isinstance(source, Mapping), "lexical source must be a mapping")
        required = {
            "analysis",
            "author",
            "g2",
            "lang",
            "lemma",
            "lesson_index",
            "lexeme_id",
            "license",
            "pos",
            "reviewedGlossary",
            "selectedSlot",
            "sourceKind",
            "text",
            "translation",
            "unit_index",
        }
        require(set(source) == required, "unsupported lexical source fields")
        require(source["sourceKind"] == "lexical-authoring-proposal", "not a lexical source")
        before = _latest(self.lang, 5)
        kinds = ("banded_lemma", "unit_assignment", "selected_item")
        files = _fingerprint(self.lang, kinds, content_paths=(GLOSSARY_RELATIVE_PATH,))
        units, selected, banded = _curriculum(self.lang)
        slot = _slot(source["selectedSlot"])
        current = {_slot(row): row for row in selected}.get(slot)
        require(current == source["selectedSlot"], "source belongs to another G4 slot/window")
        require(
            source["lang"] == self.lang
            and (source["unit_index"], source["lesson_index"]) == slot[:2],
            "source placement/language mismatch",
        )
        unit = _index(units, "unit_index")[slot[0]]
        require(
            current["grammar_concept"] == unit["grammar_concept"], "source unit concept mismatch"
        )
        lemma = source["lemma"]
        row = _index(banded, "lemma").get(lemma)
        require(
            row is not None and source["g2"] == row and source["pos"] == row["pos"],
            "stale G2 lexical declaration",
        )
        require(
            source["text"] == lemma and source["lexeme_id"] == f"lx:{lemma}:{row['pos']}",
            "source must be the exact declared citation lemma",
        )
        require(
            lemma in set(current["known_lemmas"]) | set(current["new_lemmas"]),
            "lexeme outside destination window",
        )
        require(
            set(current["new_lemmas"]).issubset({lemma}), "lexical source omits destination target"
        )
        require(
            not set(current["known_lemmas"]) & set(current["new_lemmas"]),
            "ambiguous destination ledger",
        )
        gloss = load_glossary(self.lang).get((self.lang, lemma, row["pos"]))
        require(gloss is not None, "missing independently accepted current glossary sense")
        path = _content_root() / self.lang / GLOSSARY_RELATIVE_PATH
        originals = [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        original = next(
            g
            for g in originals
            if (g["lang"], g["lemma"], g["pos"]) == (self.lang, lemma, row["pos"])
        )
        require(source["reviewedGlossary"] == original, "stale complete glossary review snapshot")
        require(
            source["translation"] == gloss.citation_gloss,
            "canonical source meaning differs from glossary",
        )
        require(
            source["license"] == original["licence"]
            and isinstance(source["author"], str)
            and source["author"].strip(),
            "missing source authorship/license",
        )
        analysis = source["analysis"]
        validate_record("analysed_sentence", analysis)
        require(analysis["lang"] == self.lang, "foreign lexical analysis")
        tokens = _sentence_tokens(source["text"], analysis)
        require(
            len(tokens) == 1 and tokens[0]["lemma"] == lemma,
            "lexical source must have one exact lemma",
        )
        actual = adapter_for(self.lang).analyse(
            sentence_id=analysis["sentence_id"], text=source["text"]
        )
        require(actual == analysis, "source differs from actual pinned analysis")
        require(
            sentence_register_matches(self.lang, unit, source["text"], analysis),
            "lexical source register mismatch",
        )
        require(_latest(self.lang, 5) == before, "upstream changed while validating lexical source")
        require(
            _fingerprint(self.lang, kinds, content_paths=(GLOSSARY_RELATIVE_PATH,)) == files,
            "source files changed while validating lexical source",
        )
        return {
            "schemaVersion": 1,
            "kind": "reviewed-glossary",
            "sourceId": analysis["sentence_id"],
            "sourceSha256": evidence_digest(source),
            "runId": before[-1]["run_id"],
            "upstream": [{"stage": e["stage"], "runId": e["run_id"]} for e in before],
            "slot": list(slot),
            "register": unit_register(self.lang, unit),
            "g2Sha256": evidence_digest(row),
            "unitSha256": evidence_digest(unit),
            "selectedSha256": evidence_digest(current),
            "glossarySha256": evidence_digest(original),
            "spanish": [lemma],
            "english": [gloss.citation_gloss],
        }

    def selected_sources(self):
        """All actual post-G6 selected occurrences, never a supplied first-unit subset."""
        try:
            before = _latest(self.lang, 7)
            kinds = (
                "banded_lemma",
                "unit_assignment",
                "selected_item",
                "ingested_sentence",
                "analysed_sentence",
            )
            if artifact_path(self.lang, "candidate").is_file():
                kinds += ("candidate",)
            files = _fingerprint(
                self.lang,
                kinds,
                content_paths=(ANSWER_EVIDENCE_PATH,),
                run_paths=(ANSWER_APPROVAL_PATH,),
            )
            units, selected, banded = _curriculum(self.lang)
            sources = resolve_selected_sources(
                self.lang,
                selected,
                list(read_records("candidate", lang=self.lang))
                if any(r["gap"] for r in selected)
                else [],
                list(read_records("ingested_sentence", lang=self.lang)),
                list(read_records("analysed_sentence", lang=self.lang)),
                units,
                banded,
            )
            approved = load_validated_answer_evidence(self.lang, sources)
            require(_latest(self.lang, 7) == before, "G6 changed while validating population")
            require(
                _fingerprint(
                    self.lang,
                    kinds,
                    content_paths=(ANSWER_EVIDENCE_PATH,),
                    run_paths=(ANSWER_APPROVAL_PATH,),
                )
                == files,
                "source files changed while validating G6 population",
            )
            current_by_slot = {_slot(row): row for row in selected}
            population = source_population_digest(sources)
            result = {}
            for selected_source in sources:
                answer = approved[selected_source.slot]
                source = {
                    "sourceKind": "selected-source",
                    "lang": self.lang,
                    "unit_index": selected_source.unit_index,
                    "lesson_index": selected_source.lesson_index,
                    "text": selected_source.text,
                    "translation": selected_source.translation,
                    "analysis": deepcopy(selected_source.analysis),
                    "selectedSlot": deepcopy(current_by_slot[selected_source.slot]),
                    "selectedSource": selected_source.snapshot(),
                    "provenance": deepcopy(selected_source.source),
                }
                proof = {
                    "schemaVersion": 1,
                    "kind": "g6-selected",
                    "sourceId": selected_source.source_id,
                    "sourceSha256": evidence_digest(source),
                    "runId": before[-1]["run_id"],
                    "slot": list(selected_source.slot),
                    "populationSha256": population,
                    "evidenceSha256": answer.evidence_hash,
                    "spanish": list(answer.spanish),
                    "english": list(answer.english_reverse_only),
                }
                result[selected_source.slot] = {
                    "sourceId": selected_source.source_id,
                    "source": source,
                    "approval": proof,
                }
            return result
        except (KeyError, TypeError, ValueError, OSError, RuntimeError) as exc:
            raise ApprovalAdapterError(
                f"current selected source approval unavailable: {exc}"
            ) from exc

    def __call__(self, source, approval) -> bool:
        """Exact projection equality rejects extra forms/pairs and relabeled source IDs."""
        try:
            if not isinstance(source, Mapping) or not isinstance(approval, Mapping):
                return False
            if source.get("sourceKind") == "lexical-authoring-proposal":
                expected = self.project_lexical(source)
            elif source.get("sourceKind") == "selected-source":
                current = self.selected_sources()[_slot(source["selectedSlot"])]
                require(source == current["source"], "selected canonical source snapshot changed")
                expected = current["approval"]
            else:
                return False
            return expected == approval
        except (KeyError, TypeError, ValueError, OSError, RuntimeError, StopIteration):
            return False
