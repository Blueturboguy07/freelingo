"""Curriculum POS declarations require exact independently reviewed glossary evidence."""

from collections import Counter
from pathlib import Path

import pytest
from test_g1_analyze import ES_MINI, run_stage, seed_g0
from test_lexeme_glosses import authored, write_glossary

from coursekit.artifacts import artifact_path, read_records, write_records
from coursekit.inputs import MissingInput
from coursekit.lexeme_glosses import GlossaryError, gloss_content_hash
from coursekit.stages import g2_band
from coursekit.stages.g1_analyze import analyze


def declared(lemma: str, pos: str, *, review: bool = True) -> dict:
    row = authored(review=False)
    row.update(lemma=lemma, pos=pos)
    if review:
        row["review"] = {
            "reviewer": "Independent POS reviewer",
            "verdict": "accepted",
            "note": "Checked the intended lexical POS, distinct from token homographs.",
            "content_hash": gloss_content_hash(row),
        }
    return row


@pytest.mark.parametrize(
    ("lemma", "observed", "intended"),
    [
        ("hola", "PROPN", "INTJ"),
        ("lápiz", "PROPN", "NOUN"),
        ("tos", "PROPN", "NOUN"),
        ("señor", "PROPN", "NOUN"),
        ("magdalena", "PROPN", "NOUN"),
        ("partir", "NOUN", "VERB"),
        ("pesar", "NOUN", "VERB"),
        ("salvo", "NOUN", "ADP"),
        ("cuándo", "SCONJ", "ADV"),
        ("cómo", "SCONJ", "ADV"),
        ("dónde", "PRON", "ADV"),
        ("doña", "PROPN", "NOUN"),
    ],
)
def test_INV_PACK_51_reviewed_intended_pos_overrides_only_the_lemma_index(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    lemma: str,
    observed: str,
    intended: str,
) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path))
    row = declared(lemma, intended)
    write_glossary(tmp_path, [row])
    counts = Counter({(lemma, observed): 77, ("zorro", "NOUN"): 77, ("ave", "NOUN"): 80})
    before = counts.copy()
    result, notes = g2_band.reviewed_pos_index("es", counts)
    assert result == Counter({(lemma, intended): 77, ("zorro", "NOUN"): 77, ("ave", "NOUN"): 80})
    assert counts == before
    assert [(lemma, count) for lemma, _, count in g2_band.rank(result)] == [
        (lemma, count) for lemma, _, count in g2_band.rank(before)
    ]
    assert notes["reviewed_pos_scope"] == "lemma_index_only"
    assert notes["frequency_is_sense_specific"] is False
    assert notes["reviewed_pos_overrides"] == [
        {
            "lemma": lemma,
            "from_pos": observed,
            "to_pos": intended,
            "content_hash": row["review"]["content_hash"],
            "author": row["author"],
            "reviewer": row["review"]["reviewer"],
        }
    ]


@pytest.mark.parametrize("state", ["missing", "pending", "rejected"])
def test_INV_PACK_10_unaccepted_glossary_cannot_change_index_pos(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    state: str,
) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path))
    if state != "missing":
        row = declared("hola", "INTJ", review=state != "pending")
        if state == "rejected":
            row["review"]["verdict"] = "rejected"
        write_glossary(tmp_path, [row])
    counts = Counter({("hola", "PROPN"): 100})
    result, notes = g2_band.reviewed_pos_index("es", counts)
    assert result == counts
    assert notes["reviewed_pos_overrides"] == []


def test_INV_PACK_10_pos_edit_after_review_cannot_override_index(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path))
    row = declared("hola", "NOUN")
    row["pos"] = "INTJ"
    write_glossary(tmp_path, [row])
    with pytest.raises(GlossaryError, match="review.*hash"):
        g2_band.reviewed_pos_index("es", Counter({("hola", "PROPN"): 100}))


@pytest.mark.parametrize("reverse", [False, True])
def test_INV_PACK_51_multiple_reviewed_pos_are_unresolved_in_any_file_order(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    reverse: bool,
) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path))
    rows = [declared("bajo", "ADP"), declared("bajo", "ADJ")]
    write_glossary(tmp_path, rows[::-1] if reverse else rows)
    with pytest.raises(MissingInput, match="bajo.*ADJ.*ADP.*unresolved"):
        g2_band.reviewed_pos_index("es", Counter({("bajo", "ADP"): 100}))


def test_INV_PACK_51_g2_caller_keeps_original_person_tokens_and_frequency(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path / "content"))
    seed_g0(limit=3)
    run_stage(analyze, "g1")
    analysis = list(read_records("analysed_sentence", lang="es"))[0]
    analysis["tokens"] = [
        {
            "surface": "Magdalena",
            "lemma": "magdalena",
            "pos": "PROPN",
            "morph": "Gender=Fem|Number=Sing",
            "start": 0,
            "end": 9,
        }
    ]
    analysis["lemmas"] = ["magdalena"]
    write_records("analysed_sentence", [analysis], lang="es")
    source = artifact_path("es", "analysed_sentence")
    original = source.read_bytes()
    # Freeze the actual corpus profile and weighted frequency output at the boundary.
    # Magdalena the person remains PROPN in G1; only the requested curriculum sense
    # for magdalena (a small cake) changes the single lemma-index POS.
    counts = Counter({("magdalena", "PROPN"): 112, ("ave", "NOUN"): 10})
    monkeypatch.setattr(
        g2_band,
        "lemmatise_frequency",
        lambda *a, **k: (
            counts,
            {"frequency_skipped": 0},
        ),
    )
    write_glossary(tmp_path / "content", [declared("magdalena", "NOUN")])
    result, entry = run_stage(g2_band.band, "g2", frequency=str(ES_MINI / "frequency.tsv"))
    assert result.ok
    rows = list(read_records("banded_lemma", lang="es"))
    assert [(r["lemma"], r["pos"], r["frequency"]) for r in rows] == [
        ("magdalena", "NOUN", 112),
        ("ave", "NOUN", 10),
    ]
    assert source.read_bytes() == original
    assert counts == Counter({("magdalena", "PROPN"): 112, ("ave", "NOUN"): 10})
    assert entry.notes["frequency_is_sense_specific"] is False
