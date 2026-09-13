"""Shared fixtures: the es-mini corpus, an isolated build root, and a clean registry.

Two of these exist to stop a test lying:

- `isolated_build_root` points `COURSEKIT_BUILD_ROOT` at a tmp_path for every test, so
  a runlog test cannot pass because a previous run left an entry behind, and no test
  ever writes into the repository's own `build/`.
- `empty_registry` clears the stage and validator registries. The exit-2 rule is only
  interesting if it can be shown *both* ways — 2 with nothing registered, 0 with
  everything — and a registry that is empty only because P2 has not landed yet proves
  nothing.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

import pytest

from coursekit.config import BUILD_ROOT_ENV_VAR
from coursekit.stages import STAGES
from coursekit.validators import VALIDATORS

FIXTURES = Path(__file__).parent / "fixtures"
ES_MINI = FIXTURES / "es-mini"

#: The fixture's tokeniser, restated here rather than imported, so the test recomputes
#: `frequency.tsv` instead of agreeing with whatever the generator happened to do.
TOKEN_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def tokens(text: str) -> list[str]:
    return [match.group(0).lower() for match in TOKEN_RE.finditer(text)]


@pytest.fixture(autouse=True)
def isolated_build_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "build"
    monkeypatch.setenv(BUILD_ROOT_ENV_VAR, str(root))
    return root


@pytest.fixture
def empty_registry() -> Iterator[None]:
    """Run with no stages or validators registered, then restore discovery.

    Teardown calls `restore_for_tests()`, not `reset_for_tests()` again. The two are
    different operations and the difference is load-bearing: reset suppresses discovery
    so "empty" stays empty, restore evicts the discovered modules from `sys.modules` so
    the next lookup re-runs their registrations. Calling reset twice left every later
    test in the session with a permanently empty registry — green, and testing nothing.
    """
    STAGES.reset_for_tests()
    VALIDATORS.reset_for_tests()
    yield
    STAGES.restore_for_tests()
    VALIDATORS.restore_for_tests()


# ---------------------------------------------------------------------------
# A synthetic, well-formed run directory
# ---------------------------------------------------------------------------
#
# `es-mini` is a G0 *ledger*: 200 real sentences with real licences. The pack-level
# validators (V10-V12) and `coursekit sample` need something else — a whole run, from
# selection through exercises to pack rows, with a difficulty curve that is known by
# construction. So this builder writes one, deliberately synthetic and deliberately
# boring: letters-only invented words whose frequency decile is exactly the unit index,
# so `mean difficulty` is `(u + 3) + u` and monotone by arithmetic rather than by luck.
#
# Every record goes through `coursekit.artifacts.write_records`, so a build that drifts
# from the frozen contract fails here rather than in the validator under test.


def _letters(number: int) -> str:
    """A letters-only base-26 rendering. The difficulty tokeniser drops digits."""
    out = ""
    number += 1
    while number:
        number, remainder = divmod(number - 1, 26)
        out = chr(ord("a") + remainder) + out
    return out


def _word(unit: int, index: int) -> str:
    return f"q{_letters(unit)}z{_letters(index)}"


def _band(decile: int) -> str:
    if decile <= 4:
        return "A1"
    if decile <= 7:
        return "A2"
    if decile <= 9:
        return "B1"
    return "B2"


@pytest.fixture
def make_es_build():
    """Write a complete synthetic `es` run directory. Returns the builder."""
    from coursekit.artifacts import dedup_hash, sentence_id, write_records
    from coursekit.config import EXERCISE_TYPES

    def build(
        *,
        units: int = 4,
        per_unit: int = 6,
        llm_every: int = 4,
        licence: str = "CC-BY-4.0",
        attribution_owner: str | None = "Freelingo contributors",
        rtl: bool | None = False,
        with_exercises: bool = True,
        with_pack_rows: bool = True,
        extra_character: str = "",
        difficulty_of_unit=None,
    ) -> dict[str, object]:
        ingested: list[dict] = []
        selected: list[dict] = []
        candidates: list[dict] = []
        exercises: list[dict] = []
        banded: list[dict] = []
        seen_words: dict[str, int] = {}

        for unit in range(1, units + 1):
            decile = difficulty_of_unit(unit) if difficulty_of_unit else min(unit, 10)
            for slot in range(per_unit):
                tokens = [_word(unit, k) for k in range(unit + 2)]
                tokens.append(_word(unit, 100 + slot))
                for token in tokens:
                    seen_words.setdefault(token, decile)
                text = " ".join(tokens) + extra_character
                translation = f"unit {unit} slot {slot}"
                is_llm = llm_every > 0 and slot % llm_every == 0
                identifier = sentence_id("es", text)
                if is_llm:
                    candidates.append(
                        {
                            "schema_version": 1,
                            "lang": "es",
                            "candidate_id": identifier,
                            "unit_index": unit,
                            "lesson_index": 1,
                            "slot_index": slot,
                            "text": text,
                            "translation": translation,
                            "accepted_alternates": [],
                            "author": "opus-agent",
                            "generated_at": "2026-09-11T00:00:00+00:00",
                            "accepted": True,
                            "reject_reason": None,
                            "provenance": "llm",
                            # Nullable, not optional: this fixture's rows are never
                            # expanded by G7, so the analysis it would read is absent
                            # rather than wrong.
                            "analysis": None,
                        }
                    )
                    selected.append(
                        {
                            "schema_version": 1,
                            "lang": "es",
                            "unit_index": unit,
                            "lesson_index": 1,
                            "slot_index": slot,
                            "sentence_id": None,
                            "provenance": "llm",
                            "gap": True,
                            "new_lemmas": [tokens[0]],
                            "known_lemmas": tokens[1:],
                            "grammar_concept": f"concept-{unit}",
                            "accepted_alternates": [],
                        }
                    )
                else:
                    ingested.append(
                        {
                            "schema_version": 1,
                            "sentence_id": identifier,
                            "lang": "es",
                            "l1": "en",
                            "text": text,
                            "translation": translation,
                            "source_id": "freelingo-fixture",
                            "corpus": "freelingo-synthetic",
                            "corpus_version": "2026-09-11",
                            "licence": licence,
                            "licence_verdict": "shippable",
                            "attribution_required": attribution_owner is not None,
                            "attribution_owner": attribution_owner,
                            "token_count": len(tokens),
                            "dedup_hash": dedup_hash(text),
                        }
                    )
                    selected.append(
                        {
                            "schema_version": 1,
                            "lang": "es",
                            "unit_index": unit,
                            "lesson_index": 1,
                            "slot_index": slot,
                            "sentence_id": identifier,
                            "provenance": "corpus",
                            "gap": False,
                            "new_lemmas": [tokens[0]],
                            "known_lemmas": tokens[1:],
                            "grammar_concept": f"concept-{unit}",
                            "accepted_alternates": [],
                        }
                    )
                if with_exercises:
                    exercises.append(
                        {
                            "schema_version": 1,
                            "lang": "es",
                            "exercise_id": sentence_id("ex", f"{unit}:{slot}"),
                            "unit_index": unit,
                            "lesson_index": 1,
                            "type": EXERCISE_TYPES[(unit + slot) % len(EXERCISE_TYPES)],
                            "prompt": translation,
                            "accepted_answers": [text],
                            "distractors": [tokens[0]],
                            "alignment": [[0, 0]],
                            "item_tags": {
                                "lemmas": tokens,
                                "grammar_concepts": [f"concept-{unit}"],
                            },
                            "audio_ref": None,
                            "register": "neutral",
                            "source_sentence_id": identifier,
                        }
                    )

        for rank, (word, decile) in enumerate(sorted(seen_words.items()), start=1):
            banded.append(
                {
                    "schema_version": 1,
                    "lang": "es",
                    "lemma": word,
                    "pos": "NOUN",
                    "rank": rank,
                    "frequency": 1000 - rank,
                    "decile": decile,
                    "band": _band(decile),
                    "band_source": "frequency_decile",
                    "band_source_licence": None,
                }
            )

        write_records("ingested_sentence", ingested, lang="es")
        write_records("selected_item", selected, lang="es")
        write_records("candidate", candidates, lang="es")
        write_records("banded_lemma", banded, lang="es")
        if with_exercises:
            write_records("exercise", exercises, lang="es")
        if with_pack_rows:
            rows = [
                {
                    "schema_version": 1,
                    "lang": "es",
                    "table": "meta",
                    "row_id": "pack_version",
                    "payload": {"value": "0.1.0"},
                }
            ]
            if rtl is not None:
                rows.append(
                    {
                        "schema_version": 1,
                        "lang": "es",
                        "table": "meta",
                        "row_id": "rtl",
                        "payload": {"value": rtl},
                    }
                )
            write_records("pack_row", rows, lang="es")

        return {
            "ingested": ingested,
            "selected": selected,
            "candidates": candidates,
            "exercises": exercises,
            "banded": banded,
        }

    return build
