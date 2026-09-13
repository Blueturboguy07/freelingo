"""The review quarantine is exact, reproducible, and independent of sample row ids."""

from coursekit.pair_quality import pair_content_hash, reviewed_pair, reviewed_pairs

ROUND_FOUR_ROWS = (
    ("Yo soy mal señor.", "I am a bad gentleman."),
    ("Son pocos, no muchos.", "There are few, not many."),
    ("En un país, veinte ciudades.", "Twenty cities in a country."),
    ("Mi hermana está en la izquierda.", "My sister is on the left."),
    # The pinned sample manifested this same source pair as two exercise rows.
    ("Mi hermana está en la izquierda.", "My sister is on the left."),
    ("Cuatro por cinco, veinte.", "Four times five is 20."),
    ("¿De dónde es?", "Where are you from?"),
    ("Hoy es buena fecha.", "Today would be good."),
    ("¿Qué quieres de postre?", "What would you like for dessert?"),
    ("Entró en el banco y cambió el dinero.", "He went to the bank and changed his money."),
    ("Tienes tres lápices.", "You have three pens."),
    ("Esta mochila azul está pesada.", "This blue backpack is heavy."),
    ("Voy a entrar al museo.", "I'm going in the museum."),
    (
        "Me perdí tratando de llegar a la biblioteca.",
        "I got lost trying to find the library.",
    ),
    ("¿Tenía bocadillos para comer?", "Did he have sandwiches for lunch?"),
)


def test_INV_PACK_10_round_four_rows_resolve_to_exact_reviewed_content_hashes() -> None:
    assert len(ROUND_FOUR_ROWS) == 15
    assert len({pair_content_hash(*pair) for pair in ROUND_FOUR_ROWS}) == 14
    assert all(reviewed_pair("es", *pair) is not None for pair in ROUND_FOUR_ROWS)


def test_INV_PACK_10_review_resource_hashes_are_self_authenticating() -> None:
    findings = reviewed_pairs("es")
    assert len(findings) == 16  # 14 round-four pairs plus two preserved B3 findings.
    assert all(
        content_hash == pair_content_hash(finding.text, finding.translation)
        for content_hash, finding in findings.items()
    )


def test_INV_PACK_10_review_quarantine_does_not_reject_nearby_valid_pair() -> None:
    assert reviewed_pair("es", "¿De dónde es?", "Where is he from?") is None


def test_INV_PACK_10_canonically_equivalent_reviewed_text_cannot_escape() -> None:
    import unicodedata

    text, translation = "¿De dónde es?", "Where are you from?"
    assert reviewed_pair("es", unicodedata.normalize("NFD", text), translation) is not None


def test_review_resources_follow_the_content_root_and_reload_edits(tmp_path, monkeypatch) -> None:
    import json

    text, translation = "Un caso.", "One case."
    row = {
        "content_hash": pair_content_hash(text, translation),
        "text": text,
        "translation": translation,
        "root_cause": "test witness",
        "review": "test-only",
    }
    for name in ("first", "second"):
        directory = tmp_path / name / "es" / "review"
        directory.mkdir(parents=True)
        (directory / "rejected-pairs.jsonl").write_text(
            json.dumps(row) + "\n" if name == "first" else "", encoding="utf-8"
        )
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path / "first"))
    assert reviewed_pair("es", text, translation) is not None
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path / "second"))
    assert reviewed_pair("es", text, translation) is None
    (tmp_path / "second/es/review/rejected-pairs.jsonl").write_text(
        json.dumps(row) + "\n", encoding="utf-8"
    )
    assert reviewed_pair("es", text, translation) is not None


def test_review_resource_rejects_tampered_hash_and_duplicate_rows(tmp_path, monkeypatch) -> None:
    import json

    import pytest

    text, translation = "Un caso.", "One case."
    row = {
        "content_hash": "0" * 64,
        "text": text,
        "translation": translation,
        "root_cause": "test",
        "review": "test-only",
    }
    directory = tmp_path / "es/review"
    directory.mkdir(parents=True)
    path = directory / "rejected-pairs.jsonl"
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path))
    path.write_text(json.dumps(row) + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="content_hash"):
        reviewed_pairs("es")
    row["content_hash"] = pair_content_hash(text, translation)
    path.write_text((json.dumps(row) + "\n") * 2, encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate"):
        reviewed_pairs("es")
