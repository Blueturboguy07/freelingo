"""G6 validate-language and V8, and the invariant about telling clean from silent.

**INV-PACK-14** — "V8 records which engines actually ran per language (`grammar_engine`,
`spellcheck_engine`) and degrades to the named fallback. A validator that reports
'0 errors' when no engine ran fails this gate."

Every case in `falsifiers/INV-PACK-14.json` produces the same headline number. Two of
them are a clean course, four are a machine that checked nothing or checked half of it,
and one is Japanese, where a missing spell checker is correct and expected. A V8 that
returns an empty finding list for all seven is green in CI and ships a pack whose
validator report is about nothing.

So the falsifier corpus drives the test: each case is a G6 runlog entry, written into a
real runlog, read back by the real validator, and checked against what the invariant says
must happen to it.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from test_engines import arpa_over, spanish_sentences, words
from test_g5_gapfill import (
    REAL_CANDIDATES,
    authored_rows,
    ensure_registered,
    es_adapter,  # noqa: F401 - a fixture, used by name
    gap_list,
    run_g5,
    stage_g4,
)

from coursekit.artifacts import read_records, write_records
from coursekit.config.g6 import (
    BACKTRANSLATION_MIN_SCORE,
    DEGRADED_TO_PERPLEXITY_ONLY,
    ENGINE_FIELDS,
    ENGINE_NONE,
    G6_REJECT_AXES,
    KENLM_BAND_FILENAME,
)
from coursekit.engines.kenlm import band_from_scores
from coursekit.engines.mock_lt import MockLanguageTool, mock_languagetool_server
from coursekit.runlog import RunLog, StageEntry, read_entries, tool_fingerprint
from coursekit.stages import STAGES, StageContext, StageResult
from coursekit.validators import VALIDATORS, ValidatorContext

FALSIFIERS = Path(__file__).parent / "falsifiers"


# ---------------------------------------------------------------------------
# A whole Spanish run: G4 -> G5 -> G6
# ---------------------------------------------------------------------------


@pytest.fixture
def es_after_g5(es_adapter: None) -> Iterator[list[dict[str, Any]]]:  # noqa: F811
    rows = authored_rows(REAL_CANDIDATES)
    stage_g4("es", gap_list(rows))
    result = run_g5()
    assert result.ok, result.message
    yield rows


@pytest.fixture
def kenlm_model(tmp_path: Path) -> Path:
    """A real KenLM model over the authored course, with its band derived from it."""
    pytest.importorskip("kenlm", reason="the 'lm' dependency group is not installed")
    from coursekit.engines.kenlm import KenLMEngine

    sentences = spanish_sentences()
    model = arpa_over(sentences, tmp_path / "es.arpa")
    engine = KenLMEngine(model_path=model, band=(0.0, float("inf")))
    engine.probe("es")
    low, high = band_from_scores([engine.perplexity(sentence) for sentence in sentences])
    (tmp_path / KENLM_BAND_FILENAME).write_text(
        json.dumps({"model": model.name, "order": 2, "band": [low, high], "percentiles": [5, 95]}),
        encoding="utf-8",
    )
    return model


@pytest.fixture
def spanish_sidecar() -> Iterator[str]:
    vocabulary = frozenset(word for text in spanish_sentences() for word in words(text))
    rules = MockLanguageTool(known_words=vocabulary)
    with mock_languagetool_server(rules) as url:
        yield url


def run_g6(options: dict[str, str], lang: str = "es") -> StageResult:
    ensure_registered()
    stage = STAGES.get("g6")
    assert stage is not None, "g6 is not registered"
    log = RunLog(lang)
    with log.stage("g6", tool="test", tool_version="0") as entry:
        result = stage.run(StageContext(lang=lang, runlog=log, entry=entry, options=dict(options)))
        if not result.ok:
            entry.status = "failed"
    return result


def run_v8(lang: str = "es") -> list[Any]:
    ensure_registered()
    validator = VALIDATORS.get("V8")
    assert validator is not None, "V8 is not registered"
    log = RunLog(lang)
    with log.stage("V8", tool="test", tool_version="0") as entry:
        return validator.run(ValidatorContext(lang=lang, entry=entry))


def blocking(findings: list[Any]) -> list[Any]:
    return [finding for finding in findings if finding.severity == "blocking"]


def full_options(sidecar: str, model: Path) -> dict[str, str]:
    return {
        "grammar_engine": "mock_lt",
        "languagetool_url": sidecar,
        "kenlm_model": str(model),
    }


# ---------------------------------------------------------------------------
# INV-PACK-14 — the falsifier corpus
# ---------------------------------------------------------------------------


def _write_g6_entry(lang: str, status: str, notes: dict[str, Any]) -> None:
    log = RunLog(lang)
    entry = StageEntry(
        lang=lang,
        stage="g6",
        run_id=log.run_id,
        started_at="2026-09-12T00:00:00+00:00",
        tool="test",
        tool_version="0",
        platform=tool_fingerprint(),
        status=status,
        finished_at="2026-09-12T00:00:01+00:00",
        notes=notes,
    )
    log.append(entry)


def _minimal_candidates(lang: str, accepted: bool) -> None:
    write_records(
        "candidate",
        [
            {
                "schema_version": 1,
                "lang": lang,
                "candidate_id": "0" * 16,
                "unit_index": 1,
                "lesson_index": 1,
                "slot_index": 0,
                "text": "Yo como pan.",
                "translation": "I eat bread.",
                "author": "agent",
                "generated_at": "2026-09-12",
                "accepted": accepted,
                "reject_reason": None if accepted else "length",
                "provenance": "llm",
            }
        ],
        lang=lang,
    )


def falsifier_cases() -> list[dict[str, Any]]:
    corpus = json.loads((FALSIFIERS / "INV-PACK-14.json").read_text(encoding="utf-8"))
    return corpus["cases"]


@pytest.mark.parametrize("case", falsifier_cases(), ids=lambda case: case["name"])
def test_INV_PACK_14_v8_never_reports_a_pass_over_a_run_that_checked_nothing(
    case: dict[str, Any],
) -> None:
    """[INV-PACK-14] Each committed runlog shape gets the verdict the invariant demands.

    Same headline number in every case — zero grammar errors. Only two of them are a
    pass, and which two is decided by what the runlog says ran, never by the count.
    """
    lang = "ja" if "Japanese" in case["name"] else "es"
    _minimal_candidates(lang, accepted=True)
    if case.get("g6_entry", "present") is not None:
        _write_g6_entry(lang, case.get("g6_status", "ok"), case.get("notes", {}))

    findings = run_v8(lang)
    if case["expect"] == "blocking":
        assert blocking(findings), (
            f"{case['name']}: V8 reported no blocking finding. {case['because']}"
        )
    else:
        assert not blocking(findings), (
            f"{case['name']}: V8 blocked a run it should have passed. {case['because']} "
            f"Findings: {[f.message for f in findings]}"
        )


def test_INV_PACK_14_the_corpus_covers_both_verdicts() -> None:
    """[INV-PACK-14] A corpus of all-blocking cases is satisfied by a V8 that always blocks."""
    cases = falsifier_cases()
    verdicts = {case["expect"] for case in cases}
    assert len(cases) >= 8
    assert any(verdict == "blocking" for verdict in verdicts)
    assert any(verdict.startswith("no blocking") for verdict in verdicts)


def test_INV_PACK_14_japanese_degrades_on_spellcheck_and_says_so() -> None:
    """[INV-PACK-14] R1's correction, as a V8 finding rather than a comment.

    `deep/10` §S6 had Japanese as spell-check-only and gave V8 a `grammar_engine: none`
    fallback. It is the inverse: 735 XML grammar rules, no spell checker. So a Japanese
    pack must not be blocked for the missing spell checker, and the absence must still
    reach the manifest.
    """
    case = next(case for case in falsifier_cases() if "Japanese" in case["name"])
    _minimal_candidates("ja", accepted=True)
    _write_g6_entry("ja", "ok", case["notes"])
    findings = run_v8("ja")
    assert not blocking(findings)
    assert any(
        finding.severity == "info" and "spell checker" in finding.message for finding in findings
    )
    recorded = read_entries("ja", stage="V8")[-1]["notes"]
    assert recorded["grammar_engine"].endswith("ja-JP")
    assert recorded["spellcheck_engine"] == ENGINE_NONE


def test_INV_PACK_14_v8_copies_all_four_engine_fields_into_its_own_entry(
    es_after_g5: list[dict[str, Any]], spanish_sidecar: str, kenlm_model: Path
) -> None:
    """[INV-PACK-14] The manifest and the pack card read V8's entry, not G6's."""
    run_g6(full_options(spanish_sidecar, kenlm_model))
    run_v8()
    notes = read_entries("es", stage="V8")[-1]["notes"]
    assert all(field in notes for field in ENGINE_FIELDS)
    assert notes["grammar_engine"].startswith("mock_lt/")
    assert notes["perplexity_engine"].startswith("kenlm/")
    assert "not a model round-trip" in notes["backtranslation_engine"]
    assert notes["ran"] is True


def test_INV_PACK_14_a_mock_grammar_engine_announces_itself_in_the_artefact(
    es_after_g5: list[dict[str, Any]], spanish_sidecar: str, kenlm_model: Path
) -> None:
    """[INV-PACK-14] Running against the mock is allowed; hiding it is not.

    `mock_lt` exists so `pack-ci.yml` can exercise G6 without a JDK. The engine id it
    reports is what V8 records and what INV-PACK-55 renders on the pack card, so a course
    validated against the mock says so on the screen a learner reads.
    """
    run_g6(full_options(spanish_sidecar, kenlm_model))
    run_v8()
    assert "mock_lt" in read_entries("es", stage="V8")[-1]["notes"]["grammar_engine"]


# ---------------------------------------------------------------------------
# Degradation
# ---------------------------------------------------------------------------


def test_no_sidecar_degrades_to_the_named_fallback(
    es_after_g5: list[dict[str, Any]], kenlm_model: Path
) -> None:
    """`scope2/00` §2.4's "degrades to perplexity-only", written down rather than implied."""
    result = run_g6({"kenlm_model": str(kenlm_model)})
    assert result.ok, result.message
    notes = read_entries("es", stage="g6")[-1]["notes"]
    assert notes["grammar_engine"] == ENGINE_NONE
    assert notes["degraded_to"] == DEGRADED_TO_PERPLEXITY_ONLY

    findings = run_v8()
    assert not blocking(findings)
    assert any(DEGRADED_TO_PERPLEXITY_ONLY in finding.message for finding in findings)


def test_no_engine_at_all_is_a_blocking_v8_not_a_clean_one(
    es_after_g5: list[dict[str, Any]],
) -> None:
    """The invariant's own sentence, driven end to end from a real G5 output."""
    result = run_g6({})
    assert result.ok, result.message
    notes = read_entries("es", stage="g6")[-1]["notes"]
    assert notes["grammar_engine"] == ENGINE_NONE
    assert notes["perplexity_engine"] == ENGINE_NONE
    # The rubric axis still runs — it needs no server and no model, and it found two
    # candidates whose round trip drifts. That is exactly why it is not in
    # ENGINES_THAT_CAN_FIND_AN_ERROR: a rubric an agent wrote is not a language engine,
    # and a pack must not ship on it alone.
    assert notes["rejected_by_axis"]["grammar"] == 0
    assert notes["rejected_by_axis"]["perplexity_out_of_band"] == 0

    findings = run_v8()
    assert blocking(findings)
    assert "zero errors from nothing" in blocking(findings)[0].message


def test_an_engine_that_was_requested_and_could_not_run_fails_the_stage(
    es_after_g5: list[dict[str, Any]], kenlm_model: Path
) -> None:
    """Not requested and requested-but-broken produce the same zero and different exits."""
    result = run_g6({"kenlm_model": str(kenlm_model), "languagetool_url": "http://127.0.0.1:9"})
    assert not result.ok
    assert "INV-PACK-14" in result.message
    notes = read_entries("es", stage="g6")[-1]["notes"]
    assert notes["grammar_engine"] == ENGINE_NONE
    assert notes["checked"] == 0


# ---------------------------------------------------------------------------
# What G6 actually does to the candidates
# ---------------------------------------------------------------------------


def test_g6_narrows_the_surviving_set_and_changes_no_text(
    es_after_g5: list[dict[str, Any]], spanish_sidecar: str, kenlm_model: Path
) -> None:
    """[INV-PACK-10] Flipping `accepted` is not patching; the text is byte-identical."""
    before = {row["candidate_id"]: row["text"] for row in read_records("candidate", lang="es")}
    run_g6(full_options(spanish_sidecar, kenlm_model))
    after = {row["candidate_id"]: row["text"] for row in read_records("candidate", lang="es")}
    assert before == after
    assert read_entries("es", stage="g6")[-1]["notes"]["text_unchanged"] is True


def test_a_candidate_below_the_rubric_minimum_is_narrowed_by_name(
    es_after_g5: list[dict[str, Any]], spanish_sidecar: str, kenlm_model: Path
) -> None:
    """The back-translation axis, over the two rows the author scored 2.

    Both are real round-trip hazards rather than planted ones: `Nosotros nos llamamos
    Ana y Carlos.` comes back as "we call ourselves", and `El pan de la cocina es nuevo.`
    comes back as "new bread", which is not what a Spanish speaker said.
    """
    survived_g5 = {row["text"] for row in read_records("candidate", lang="es") if row["accepted"]}
    low = {
        row["text"]
        for row in es_after_g5
        if row["backtranslation"]["score"] < BACKTRANSLATION_MIN_SCORE
        and row["text"] in survived_g5
    }
    assert low, "the authored file no longer exercises the back-translation axis"

    run_g6(full_options(spanish_sidecar, kenlm_model))
    narrowed = {
        row["text"]: row["reject_reason"]
        for row in read_records("candidate", lang="es")
        if not row["accepted"]
    }
    for text in low:
        assert narrowed.get(text) == "g6:backtranslation", text


def test_a_grammar_match_narrows_a_candidate(
    es_after_g5: list[dict[str, Any]], kenlm_model: Path
) -> None:
    """A blocking issue type removes the candidate; a non-blocking one does not."""
    rules = MockLanguageTool(
        known_words=frozenset(word for text in spanish_sentences() for word in words(text)),
        grammar_triggers={
            "Yo como pan": (
                "MOCK_AGREEMENT",
                "inconsistency",
                "AGREEMENT_VERBS",
                "planted agreement error",
            ),
            "El parque está cerca": (
                "MOCK_STYLE",
                "style",
                "STYLE",
                "planted style note",
            ),
        },
    )
    with mock_languagetool_server(rules) as url:
        run_g6(
            {
                "grammar_engine": "mock_lt",
                "languagetool_url": url,
                "kenlm_model": str(kenlm_model),
            }
        )

    # "Yo como pan." is authored twice — once to be kept and once as the `duplicate`
    # axis's over-generation — so the row that matters is the one G5 let through.
    rows = list(read_records("candidate", lang="es"))
    triggered = [row for row in rows if row["text"] == "Yo como pan."]
    assert "g6:grammar" in {row["reject_reason"] for row in triggered}
    style = [row for row in rows if row["text"] == "El parque está cerca." and row["accepted"]]
    assert style, "a style note is not a blocking issue type for Spanish"


def test_a_candidate_outside_the_perplexity_band_is_narrowed(
    es_after_g5: list[dict[str, Any]], kenlm_model: Path
) -> None:
    """A band tight enough to reject something proves the axis is wired to the model."""
    run_g6({"kenlm_model": str(kenlm_model), "kenlm_band": "0,1"})
    reasons = {
        row["reject_reason"] for row in read_records("candidate", lang="es") if not row["accepted"]
    }
    assert "g6:perplexity_out_of_band" in reasons
    notes = read_entries("es", stage="g6")[-1]["notes"]
    assert notes["rejected_by_axis"]["perplexity_out_of_band"] > 0
    assert notes["perplexity_observed"]["max"] > 1


def test_every_g6_reject_reason_is_prefixed_and_declared(
    es_after_g5: list[dict[str, Any]], spanish_sidecar: str, kenlm_model: Path
) -> None:
    """G5's reasons and G6's must stay distinguishable; the manifest reports the split."""
    run_g6(full_options(spanish_sidecar, kenlm_model))
    g6_reasons = {
        row["reject_reason"]
        for row in read_records("candidate", lang="es")
        if not row["accepted"] and row["reject_reason"].startswith("g6:")
    }
    assert g6_reasons
    assert all(reason[3:] in G6_REJECT_AXES for reason in g6_reasons)


def test_a_slot_left_with_no_survivor_blocks_v8(
    es_after_g5: list[dict[str, Any]], kenlm_model: Path
) -> None:
    """A slot is never filled by a rejected candidate, and the pack does not ship short."""
    run_g6({"kenlm_model": str(kenlm_model), "kenlm_band": "0,1"})
    notes = read_entries("es", stage="g6")[-1]["notes"]
    assert notes["slots_without_survivor"]
    assert blocking(run_v8())


def test_g6_refuses_to_run_before_g5(es_adapter: None) -> None:  # noqa: F811
    from coursekit.runlog import UpstreamStageMissing

    with pytest.raises(UpstreamStageMissing, match="g5"):
        run_g6({})


def test_the_rubric_is_published_beside_the_candidates() -> None:
    """The score is only reviewable if the scale it was given against is readable.

    `content/es/gapfill-rubric.md` has to say, in the artefact rather than in a commit
    message, that this axis is an agent's judgement and not a model round trip.
    """
    rubric = REAL_CANDIDATES.parent / "gapfill-rubric.md"
    text = rubric.read_text(encoding="utf-8")
    assert "not a model round-trip" in text
    assert str(BACKTRANSLATION_MIN_SCORE) in text
    for score in range(5):
        assert f"| {score} " in text, f"the rubric does not define score {score}"
