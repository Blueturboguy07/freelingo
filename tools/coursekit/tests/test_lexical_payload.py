"""Explicit original lexical identities; these tests certify no production review."""

import pytest


def test_INV_ECO_27_aggregate_objective_is_not_implicit_word_countability():
    from test_grading_payload import fixture

    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    inputs.lexical_catalog = None
    inputs.drafts[0].pop("lexicalBindings", None)
    with pytest.raises(GradingBuildError, match="lexical"):
        build_grading_payload(inputs)


def test_INV_ECO_27_writer_rejects_a_payload_without_explicit_lexical_bindings(tmp_path):
    import copy
    from dataclasses import replace

    from test_grading_sqlite import population

    from coursekit.packbuild.grading import content_hash
    from coursekit.packbuild.sqlite import write_pack

    rows, payload, credits = population()
    runtime = copy.deepcopy(payload.runtime_items)
    runtime[0].pop("lexicalBindings", None)
    payload = replace(
        payload,
        runtime_items=runtime,
        provenance={**payload.provenance, "runtimeSha256": content_hash(runtime)},
    )
    destination = tmp_path / "old.sqlite"
    destination.write_bytes(b"previous immutable pack")
    with pytest.raises(ValueError, match="lexical"):
        write_pack(destination, rows, grading=payload, grading_credits=credits)
    assert destination.read_bytes() == b"previous immutable pack"


def test_INV_ECO_27_explicit_lexical_identity_keeps_aggregate_scheduling_separate():
    from test_grading_payload import fixture

    from coursekit.packbuild.grading import build_grading_payload
    from coursekit.packbuild.itemid import item_id

    inputs = fixture()
    row = build_grading_payload(inputs).runtime_items[0]
    binding = row["lexicalBindings"][0]
    assert binding["schedulerItemId"] == row["itemId"] == "i_existing"
    assert binding["lexemeId"] == "lx:cantar:VERB"
    assert binding["wordItemId"] == item_id(binding["semantic"]) != row["itemId"]
    assert binding["semantic"]["prompt"] == "to sing"
    assert binding["surface"] == "Quiero cantar."
    assert binding["countable"] is True


@pytest.mark.parametrize(
    "fault",
    [
        "missing-catalog",
        "no-review",
        "self-review",
        "stale-review",
        "hash",
        "meaning",
        "tags",
        "concept",
        "grapheme",
        "countable-integer",
        "countable-particle",
        "countable-bound",
        "countable-character",
        "classification",
        "language",
        "lemma",
        "pos",
        "lexeme-id",
        "source-hash",
        "source-id",
        "source-missing",
        "unknown",
    ],
)
def test_INV_ECO_27_lexical_catalog_is_independently_reviewed_and_source_bound(fault):
    from test_grading_payload import fixture, reviewed

    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    row = inputs.lexical_catalog[0]
    if fault == "missing-catalog":
        inputs.lexical_catalog = None
    if fault == "no-review":
        row.pop("review")
    if fault == "self-review":
        row["review"]["reviewer"] = row["author"]
    if fault == "stale-review":
        row["review"]["sha256"] = "0" * 64
    if fault == "hash":
        row["wordItemId"] = "i_" + "0" * 16
    if fault == "meaning":
        row["semantic"]["prompt"] = "a different meaning"
    if fault == "tags":
        row["semantic"]["lexemes"] = ["querer"]
    if fault == "concept":
        row["semantic"]["grammarConcepts"] = ["g1"]
    if fault == "grapheme":
        row["semantic"]["graphemes"] = ["g"]
    if fault == "countable-integer":
        row["countable"] = 1
    if fault.startswith("countable-") and fault != "countable-integer":
        row["classification"] = {
            "countable-particle": "particle",
            "countable-bound": "bound-morpheme",
            "countable-character": "character",
        }[fault]
    if fault == "classification":
        row["classification"] = "guess"
    if fault == "language":
        row["language"] = "en"
    if fault == "lemma":
        row["lemma"] = "querer"
    if fault == "pos":
        row["pos"] = "NOUN"
    if fault == "lexeme-id":
        row["lexemeId"] = "unknown"
    if fault == "source-hash":
        row["sources"][0]["sourceSha256"] = "0" * 64
    if fault == "source-id":
        row["sources"][0]["sourceId"] = "unknown"
    if fault == "source-missing":
        row["sources"] = []
    if fault == "unknown":
        row["guessed"] = True
    if fault not in {"no-review", "self-review", "stale-review", "missing-catalog"}:
        inputs.lexical_catalog[0] = reviewed(
            {k: v for k, v in row.items() if k not in {"author", "review"}}
        )
    with pytest.raises(GradingBuildError, match="lexical"):
        build_grading_payload(inputs)


@pytest.mark.parametrize(
    "fault",
    [
        "missing",
        "empty",
        "duplicate",
        "no-review",
        "self-review",
        "stale-review",
        "source-id",
        "source-hash",
        "exercise-id",
        "scheduler-id",
        "surface-id",
        "lexeme-id",
        "word-id",
        "extra",
    ],
)
def test_INV_ECO_27_surface_bindings_are_exact_reviewed_events_not_all_tags(fault):
    from test_grading_payload import fixture, reviewed

    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    draft = inputs.drafts[0]
    row = draft["lexicalBindings"][0]
    if fault == "missing":
        draft.pop("lexicalBindings")
    if fault == "empty":
        draft["lexicalBindings"] = []
    if fault == "duplicate":
        draft["lexicalBindings"] *= 2
    if fault == "no-review":
        row.pop("review")
    if fault == "self-review":
        row["review"]["reviewer"] = row["author"]
    if fault == "stale-review":
        row["review"]["sha256"] = "0" * 64
    mapping = {
        "source-id": "sourceId",
        "source-hash": "sourceSha256",
        "exercise-id": "exerciseId",
        "scheduler-id": "schedulerItemId",
        "surface-id": "surfaceId",
        "lexeme-id": "lexemeId",
        "word-id": "wordItemId",
    }
    if fault in mapping:
        row[mapping[fault]] = "unknown"
    if fault == "extra":
        row["fromFirstTag"] = True
    if fault in mapping or fault == "extra":
        draft["lexicalBindings"][0] = reviewed(
            {k: v for k, v in row.items() if k not in {"author", "review"}}
        )
    with pytest.raises(GradingBuildError, match="lexical"):
        build_grading_payload(inputs)


@pytest.mark.parametrize("classification", ["particle", "bound-morpheme", "character"])
def test_INV_ECO_27_explicit_exclusions_are_preserved_as_false(classification):
    from test_grading_payload import fixture, reviewed

    from coursekit.packbuild.grading import build_grading_payload

    inputs = fixture()
    declaration = inputs.lexical_catalog[0]
    declaration.update(classification=classification, countable=False)
    inputs.lexical_catalog[0] = reviewed(
        {k: v for k, v in declaration.items() if k not in {"author", "review"}}
    )
    binding = build_grading_payload(inputs).runtime_items[0]["lexicalBindings"][0]
    assert binding["countable"] is False and binding["classification"] == classification


def test_INV_ECO_13_shared_semantics_hash_identically_without_language_salt():
    from test_grading_payload import digest, reviewed

    from coursekit.packbuild.lexical import validate_lexical_catalog

    semantic = {
        "prompt": "animal",
        "preferredSurface": "animal",
        "register": "neutral",
        "lexemes": ["animal"],
        "grammarConcepts": [],
        "graphemes": [],
    }
    results = []
    for lang in ["es", "fr"]:
        source = {
            "lang": lang,
            "text": "animal",
            "analysis": {"tokens": [{"lemma": "animal", "pos": "NOUN"}]},
        }
        declaration = reviewed(
            {
                "lexemeId": "lx:animal:NOUN",
                "lemma": "animal",
                "pos": "NOUN",
                "language": lang,
                "wordItemId": "i_" + digest(semantic)[:16],
                "semantic": semantic,
                "countable": True,
                "classification": "word",
                "sources": [{"sourceId": "original", "sourceSha256": digest(source)}],
            }
        )
        actual = validate_lexical_catalog(
            [declaration],
            language=lang,
            sources={"original": source},
            lexemes={"lx:animal:NOUN": {"lemma": "animal", "pos": "NOUN"}},
        )
        results.append(actual["lx:animal:NOUN"]["wordItemId"])
    assert len(set(results)) == 1


@pytest.mark.parametrize("difference", ["semantic", "countable", "classification"])
def test_INV_ECO_13_truncated_word_hash_does_not_hide_conflicting_declarations(difference):
    import copy

    from coursekit.packbuild.grading import GradingBuildError
    from coursekit.packbuild.lexical import consistent_word_identity

    row = {
        "wordItemId": "i_" + "a" * 16,
        "semantic": {"prompt": "sing"},
        "countable": False,
        "classification": "word",
    }
    identities = {}
    consistent_word_identity(row, identities)
    other = copy.deepcopy(row)
    if difference == "semantic":
        other["semantic"]["prompt"] = "another meaning"
    if difference == "countable":
        other["countable"] = True
    if difference == "classification":
        other["classification"] = "particle"
    with pytest.raises(GradingBuildError, match="conflicting"):
        consistent_word_identity(other, identities)


@pytest.mark.parametrize(
    "fault", ["definition", "surface", "proof", "countable", "missing", "semantic"]
)
def test_INV_ECO_27_writer_rechecks_lexical_joins_and_preserves_original_bytes(tmp_path, fault):
    import copy
    from dataclasses import replace

    from test_grading_sqlite import population

    from coursekit.packbuild.grading import content_hash
    from coursekit.packbuild.sqlite import write_pack

    rows, payload, credits = population()
    runtime = copy.deepcopy(payload.runtime_items)
    binding = runtime[0]["lexicalBindings"][0]
    if fault == "definition":
        binding["pos"] = "NOUN"
    if fault == "surface":
        binding["surface"] = "unobserved"
    if fault == "proof":
        binding["proof"]["sourceSha256"] = "0" * 64
    if fault == "countable":
        binding["classification"] = "particle"
    if fault == "missing":
        runtime[0]["lexicalBindings"] = []
    if fault == "semantic":
        binding["semantic"]["prompt"] = "different meaning"
    payload = replace(
        payload,
        runtime_items=runtime,
        provenance={**payload.provenance, "runtimeSha256": content_hash(runtime)},
    )
    path = tmp_path / "old.sqlite"
    path.write_bytes(b"previous immutable pack")
    with pytest.raises(ValueError, match="lexical"):
        write_pack(path, rows, grading=payload, grading_credits=credits)
    assert path.read_bytes() == b"previous immutable pack"


def test_INV_ECO_27_catalog_validator_itself_checks_exact_source_hash():
    from test_grading_payload import fixture, reviewed

    from coursekit.packbuild.grading import GradingBuildError
    from coursekit.packbuild.lexical import validate_lexical_catalog

    inputs = fixture()
    declaration = inputs.lexical_catalog[0]
    declaration["sources"][0]["sourceSha256"] = "0" * 64
    inputs.lexical_catalog[0] = reviewed(
        {k: v for k, v in declaration.items() if k not in {"author", "review"}}
    )
    with pytest.raises(GradingBuildError, match="stale source snapshot"):
        validate_lexical_catalog(
            inputs.lexical_catalog,
            language="es",
            sources=inputs.sources,
            lexemes={r["lexeme_id"]: r for r in inputs.lexemes},
        )


def test_INV_ECO_27_writer_requires_frozen_lexical_catalog_provenance(tmp_path):
    from dataclasses import replace

    from test_grading_sqlite import population

    from coursekit.packbuild.sqlite import write_pack

    rows, payload, credits = population()
    provenance = dict(payload.provenance)
    provenance.pop("lexicalCatalogSha256")
    payload = replace(payload, provenance=provenance)
    path = tmp_path / "old.sqlite"
    path.write_bytes(b"previous immutable pack")
    with pytest.raises(ValueError, match="lexical"):
        write_pack(path, rows, grading=payload, grading_credits=credits)
    assert path.read_bytes() == b"previous immutable pack"
