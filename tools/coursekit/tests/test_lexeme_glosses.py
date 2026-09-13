"""Reviewed original glossary evidence, independent of sentence alignment."""

import copy
import json
from pathlib import Path

import pytest

from coursekit.lexeme_glosses import GlossaryError, gloss_content_hash, load_glossary


def authored(*, review: bool = True) -> dict:
    row = {"schema_version": 1, "lang": "es", "lemma": "costa", "pos": "NOUN",
           "citation_gloss": "coast", "valid_alternates": ["shore"],
           "sense_evidence": "Singular noun for the land beside the sea.",
           "author": "Original glossary author", "licence": "CC-BY-NC-SA-4.0", "review": None}
    if review:
        row["review"] = {"reviewer": "Independent reviewer", "verdict": "accepted",
                         "note": "Checked meaning, POS, alternatives and citation form.",
                         "content_hash": gloss_content_hash(row)}
    return row


def write_glossary(root: Path, rows: list[dict]) -> Path:
    path = root / "es" / "authoring" / "lexeme-glosses.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))
    return path


def test_INV_PACK_40_reviewed_gloss_keeps_exact_lemma_pos_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path))
    write_glossary(tmp_path, [authored()])
    entries = load_glossary("es")
    assert set(entries) == {("es", "costa", "NOUN")}
    entry = entries[("es", "costa", "NOUN")]
    assert entry.citation_gloss == "coast"
    assert entry.meanings == frozenset({"coast", "shore"})
    assert ("es", "costa", "VERB") not in entries


@pytest.mark.parametrize("status", ["missing", "pending", "rejected"])
def test_INV_PACK_10_unreviewed_or_rejected_gloss_never_becomes_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, status: str,
) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path))
    if status != "missing":
        row = authored(review=status != "pending")
        if status == "rejected":
            row["review"]["verdict"] = "rejected"
        write_glossary(tmp_path, [row])
    assert load_glossary("es") == {}


@pytest.mark.parametrize(("field", "value"), [
    ("citation_gloss", "west"), ("valid_alternates", ["west"]), ("pos", "VERB"),
    ("lemma", "oeste"), ("sense_evidence", "Changed sense after review."),
])
def test_INV_PACK_10_gloss_review_cannot_be_reused_after_semantic_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str, value: object,
) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path))
    row = authored()
    row[field] = value
    write_glossary(tmp_path, [row])
    with pytest.raises(GlossaryError, match="review.*hash"):
        load_glossary("es")


@pytest.mark.parametrize(("field", "value"), [
    ("valid_alternates", "shore"), ("valid_alternates", [None]),
    ("valid_alternates", ["coast"]), ("valid_alternates", ["shore", "SHORE"]),
    ("pos", "PUNCT"), ("licence", "unknown"), ("citation_gloss", ""),
    ("sense_evidence", ""), ("review", {}), ("lang", "fr"),
])
def test_INV_PACK_10_malformed_gloss_is_a_named_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str, value: object,
) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path))
    row = authored(review=False)
    row[field] = value
    write_glossary(tmp_path, [row])
    with pytest.raises(GlossaryError):
        load_glossary("es")


def test_INV_PACK_10_self_review_and_duplicate_keys_are_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path))
    row = authored()
    row["review"]["reviewer"] = row["author"]
    write_glossary(tmp_path, [row])
    with pytest.raises(GlossaryError, match="independent"):
        load_glossary("es")
    write_glossary(tmp_path, [authored(), authored()])
    with pytest.raises(GlossaryError, match="duplicate"):
        load_glossary("es")


def test_INV_PACK_40_glossary_isolated_by_content_root_and_current_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    first, second = tmp_path / "first", tmp_path / "second"
    write_glossary(first, [authored()])
    row = authored()
    row["citation_gloss"], row["valid_alternates"] = "shore", ["coast"]
    row["review"]["content_hash"] = gloss_content_hash(row)
    write_glossary(second, [row])
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(first))
    assert load_glossary("es")[("es", "costa", "NOUN")].citation_gloss == "coast"
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(second))
    assert load_glossary("es")[("es", "costa", "NOUN")].citation_gloss == "shore"
    write_glossary(second, [])
    assert load_glossary("es") == {}


def test_INV_PACK_40_gloss_hash_binds_authored_fields_but_not_review_metadata() -> None:
    first = authored()
    second = copy.deepcopy(first)
    second["review"]["note"] = "A fuller independent note."
    assert gloss_content_hash(first) == gloss_content_hash(second)


def test_INV_PACK_40_reviewed_pos_grouping_preserves_ambiguity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from coursekit.lexeme_glosses import load_glossary_by_lemma

    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path))
    noun = authored()
    noun["lemma"], noun["citation_gloss"], noun["valid_alternates"] = "bajo", "bass", []
    noun["review"]["content_hash"] = gloss_content_hash(noun)
    adjective = copy.deepcopy(noun)
    adjective["pos"], adjective["citation_gloss"] = "ADJ", "low"
    adjective["review"]["content_hash"] = gloss_content_hash(adjective)
    write_glossary(tmp_path, [noun, adjective])
    groups = load_glossary_by_lemma("es")
    assert set(groups) == {"bajo"}
    assert {entry.pos for entry in groups["bajo"]} == {"NOUN", "ADJ"}
