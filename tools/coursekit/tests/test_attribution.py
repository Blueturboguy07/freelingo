"""INV-PACK-17 — an attribution-requiring asset with no reachable credit fails the build.

The falsifier is `tests/falsifiers/INV-PACK-17.json`, and it covers all three kinds the
invariant names, because each one is forgotten by a different person: a sentence (the
corpus nobody re-read the terms of), a voice (whose engine's licence is not its voices'
licence — review R7), and a derived list (which has no row of its own anywhere else and
reaches the learner as the order the units are taught in).

The build half is here. The read half — "reachable from the rendered credits surface" —
is `packages/core/src/packs/loader.test.ts`, because the surface is what ships and the
builder is not.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from coursekit.artifacts import sentence_id
from coursekit.config import PACK_LICENCE
from coursekit.config.g9 import CREDITS_SURFACE_SCREEN
from coursekit.packbuild.attribution import (
    attribution_violations,
    credit_rows,
    is_share_alike,
    licence_for_source,
    source_url,
)
from coursekit.packbuild.sqlite import PackInputs

FALSIFIER = json.loads(
    (Path(__file__).parent / "falsifiers" / "INV-PACK-17.json").read_text(encoding="utf-8")
)


def _inputs(case: dict[str, Any]) -> PackInputs:
    """Turn a falsifier case into `PackInputs`, filling only what the gate reads."""
    sentences = tuple(
        {
            "sentence_id": entry["sentence_id"],
            "text": entry["text"],
            "translation": entry["text"],
            "source_id": entry["source_id"],
            "licence": entry["licence"],
            "attribution_required": entry["attribution_required"],
            "attribution_owner": entry["attribution_owner"],
        }
        for entry in case["sentences"]
    )
    selected = tuple(
        {
            "unit_index": 1,
            "lesson_index": 1,
            "slot_index": index,
            "sentence_id": entry["sentence_id"],
            "provenance": "corpus",
            "gap": False,
            "grammar_concept": "present-estar",
        }
        for index, entry in enumerate(case["sentences"])
    )
    candidates = tuple(
        {
            "text": entry["text"],
            "translation": entry["text"],
            "accepted": entry["accepted"],
            "provenance": "llm",
        }
        for entry in case["candidates"]
    )
    clips = tuple(
        {
            "clip_id": entry["clip_id"],
            "text": "x",
            "voice_id": "v1",
            "engine": entry["engine"],
            "codec": "opus",
            "bitrate_kbps": 20,
            "duration_ms": 1000,
            "bytes": 100,
            "path": f"audio/{entry['clip_id']}.opus",
            "licence": entry["licence"],
            "pipeline": "lesson",
        }
        for entry in case["clips"]
    )
    return PackInputs(
        lang="es",
        pack_id="freelingo-es",
        course_id="en-es",
        major=0,
        version="0.1.0",
        sentences=sentences,
        selected=selected,
        candidates=candidates,
        clips=clips,
        licences=tuple(case["licences"]),
    )


@pytest.mark.parametrize("case", FALSIFIER["cases"], ids=lambda case: case["why"][:60])
def test_INV_PACK_17_falsifier(case: dict[str, Any]) -> None:
    """[INV-PACK-17] every attributed sentence, voice and derived list has an owner."""
    violations = attribution_violations(_inputs(case))
    assert sorted(violations) == sorted(case["violations"]), violations


def test_INV_PACK_17_the_clean_case_credits_all_three_kinds() -> None:
    """[INV-PACK-17] a sentence, an authored sentence and a derived list all get a row.

    Asserted positively as well as negatively: a gate that only ever proves "no
    violations" passes just as well when `credit_rows` returns nothing at all.
    """
    clean = FALSIFIER["cases"][0]
    rows = credit_rows(_inputs(clean))
    assert [row["source_id"] for row in rows] == clean["creditedSources"]
    assert [row["source_id"] for row in rows if row["share_alike"]] == clean["shareAlike"]
    assert {row["kind"] for row in rows} == {"sentence", "derived-list"}
    assert all(row["owner"].strip() for row in rows)


def test_a_voice_never_inherits_its_engines_licence() -> None:
    """Review R7: Piper is GPL-3.0 code whose one Japanese voice is CC BY-NC-SA.

    So an engine nobody declared resolves to "attribution required, no owner", which
    fails the build. The safe default for a licence question is stop, never assume CC0.
    """
    assert licence_for_source(_inputs(FALSIFIER["cases"][1]), "voice:azure", "NOASSERTION") == (
        None,
        True,
    )


def test_cc0_is_the_one_licence_that_needs_nothing() -> None:
    assert licence_for_source(_inputs(FALSIFIER["cases"][1]), "unknown", "CC0-1.0") == (None, False)


def test_authored_sentences_are_credited_to_the_project_under_the_pack_licence() -> None:
    """CC BY-NC-SA has a BY clause: "we wrote it" is not "nobody needs crediting"."""
    rows = credit_rows(_inputs(FALSIFIER["cases"][0]))
    authored = next(row for row in rows if row["source_id"] == "freelingo_authored")
    assert authored["licence"] == PACK_LICENCE
    assert authored["owner"]
    assert authored["share_alike"] is True


def test_only_shipped_sentences_are_credited() -> None:
    """A pack ships what G4 selected, not G0's quarter-million-row ledger.

    Crediting the ledger would list corpora the learner never meets and, because a
    licence obligation attaches to what you distribute, create obligations for nothing.
    """
    case = FALSIFIER["cases"][0]
    inputs = _inputs(case)
    unused = {
        "sentence_id": sentence_id("es", "No seleccionada."),
        "text": "No seleccionada.",
        "translation": "Not selected.",
        "source_id": "opensubtitles",
        "licence": "NOASSERTION",
        "attribution_required": True,
        "attribution_owner": "OpenSubtitles.org",
    }
    with_extra = PackInputs(
        **{
            **{field: getattr(inputs, field) for field in inputs.__slots__},
            "sentences": (*inputs.sentences, unused),
        }
    )
    assert "opensubtitles" not in {row["source_id"] for row in credit_rows(with_extra)}


def test_share_alike_is_a_named_list_not_a_substring_search() -> None:
    assert is_share_alike("CC-BY-SA-4.0")
    assert is_share_alike("CC-BY-NC-SA-4.0")
    assert not is_share_alike("CC-BY-2.0-FR")
    assert not is_share_alike("Apache-2.0")


def test_a_credits_url_never_renders_a_placeholder() -> None:
    """`SOURCES` stores `{lang}`/`{iso3}` because one row serves four courses."""
    url = source_url("tatoeba", "es")
    assert url is not None and "{" not in url and "spa" in url


def test_the_credits_screen_id_is_recorded_even_though_the_map_lacks_it() -> None:
    """S152 is not in `deep/00-PRODUCT-MAP.md`, which stops at S151.

    Recorded here and in `pack-schema.ts` rather than in a review comment, because this
    constant is what P4 will grep for when the map finally owes it a row.
    """
    assert CREDITS_SURFACE_SCREEN == "S152"
