"""G6 validate-language and V8, and the invariant about telling clean from silent.

**INV-PACK-14** — "V8 records which engines actually ran per language (`grammar_engine`,
`spellcheck_engine`) and degrades to the named fallback. A validator that reports
'0 errors' when no engine ran fails this gate."

Every case in `falsifiers/INV-PACK-14.json` produces zero errors on at least one axis.
Three of them are a course that was really checked, six are a machine that checked
nothing or half of it, one is a course whose validation run crashed halfway, and one is
Japanese, where a missing spell checker is correct and expected. A V8 that returns an
empty finding list for all of them is green in CI and ships a pack whose validator report
is about nothing.

So the falsifier corpus drives the test: each case is a G6 runlog entry, written into a
real runlog, read back by the real validator, and checked against what the invariant says
must happen to it.

**Both degradation directions are in the corpus, and that is not symmetry for its own
sake.** The first version of this file covered only "grammar engine missing" and the
suite was green over nine cases while `_degraded_to` had no name at all for the inverse —
a grammar engine up and no KenLM model, which is the likelier configuration at P2. V8
then blocked that run and told the operator to name the fallback `perplexity_only`, after
the engine that was missing. `test_INV_PACK_14_no_kenlm_model_degrades_to_grammar_only_
and_is_not_blocked` runs it live rather than replaying the runlog.
"""

from __future__ import annotations

import json
import re
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
    DEGRADATION_COST,
    DEGRADATION_NAMES,
    DEGRADED_TO_GRAMMAR_ONLY,
    DEGRADED_TO_PERPLEXITY_ONLY,
    ENGINE_FIELDS,
    ENGINE_NONE,
    G6_REJECT_AXES,
    KENLM_BAND_FILENAME,
    MOCK_ENGINE_IDS,
    SPELLCHECK_PROBE,
)
from coursekit.engines.kenlm import band_from_scores
from coursekit.engines.mock_lt import MockLanguageTool, mock_languagetool_server
from coursekit.runlog import RunLog, StageEntry, read_entries, tool_fingerprint
from coursekit.stages import STAGES, StageContext, StageResult
from coursekit.stages.g6_validate_language import _axis
from coursekit.validators import VALIDATORS, ValidatorContext

FALSIFIERS = Path(__file__).parent / "falsifiers"


@pytest.mark.parametrize(
    ("text", "translation"),
    [
        ("No encuentro mi cartera.", "I lost my wallet."),
        ("Hoy tendremos pescado de cena.", "We have fish for dinner today."),
    ],
)
def test_INV_PACK_10_b3_exact_corpus_mistranslations_are_rejected_before_g7(
    text: str, translation: str
) -> None:
    """[INV-PACK-10] reviewed bad pairs are discarded, never broadly rewritten."""
    row = {"text": text, "translation": translation}

    axis, detail = _axis(row, "es", None, None, None, [])

    assert axis == "review_defect"
    from coursekit.pair_quality import pair_content_hash

    assert detail == {
        "content_hash": pair_content_hash(text, translation),
        "text": text,
        "translation": translation,
        "review": "P2 B3 2026-09-12",
        "root_cause": "mistranslation" if text == "No encuentro mi cartera." else "tense mismatch",
    }
    assert re.fullmatch(r"[0-9a-f]{64}", detail["content_hash"])


@pytest.mark.parametrize(
    ("text", "translation"),
    [
        ("Yo soy mal señor.", "I am a bad gentleman."),
        ("Son pocos, no muchos.", "There are few, not many."),
        ("En un país, veinte ciudades.", "Twenty cities in a country."),
        ("Mi hermana está en la izquierda.", "My sister is on the left."),
    ],
)
def test_INV_PACK_10_round_four_authored_defects_are_discarded_not_repaired(
    text: str, translation: str
) -> None:
    row = {"text": text, "translation": translation}

    axis, detail = _axis(row, "es", None, None, None, [])

    assert axis == "review_defect"
    assert detail["content_hash"]
    assert row == {"text": text, "translation": translation}


def test_INV_PACK_10_b3_rejection_is_exact_not_a_lexical_ban() -> None:
    """[INV-PACK-10] nearby valid wallet/fish pairs remain eligible for engine checks."""
    for row in (
        {"text": "No encuentro mi cartera.", "translation": "I can't find my wallet."},
        {
            "text": "Hoy tendremos pescado de cena.",
            "translation": "We will have fish for dinner today.",
        },
        {"text": "Perdí mi cartera.", "translation": "I lost my wallet."},
    ):
        assert _axis(row, "es", None, None, None, []) == (None, {})


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
                "accepted_alternates": [],
                "author": "agent",
                "generated_at": "2026-09-12",
                "accepted": accepted,
                "reject_reason": None if accepted else "length",
                "provenance": "llm",
                "analysis": None,
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

    Same headline number in every case — zero errors on at least one axis. Only three of
    them are a pass, and which three is decided by what the runlog says ran, never by the
    count. A case whose `expect` names a fallback also has to see that name in a finding:
    "degrades to the NAMED fallback" is not satisfied by not blocking.
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
        return

    assert not blocking(findings), (
        f"{case['name']}: V8 blocked a run it should have passed. {case['because']} "
        f"Findings: {[f.message for f in findings]}"
    )
    for name in DEGRADATION_NAMES.values():
        if f"naming {name}" in case["expect"]:
            assert any(
                finding.severity == "warning" and name in finding.message for finding in findings
            ), (
                f"{case['name']}: V8 passed the run without naming the fallback {name!r}. "
                f"Findings: {[(f.severity, f.message) for f in findings]}"
            )


def test_INV_PACK_14_the_corpus_covers_both_verdicts_and_both_degradation_directions() -> None:
    """[INV-PACK-14] A corpus of all-blocking cases is satisfied by a V8 that always blocks.

    And a corpus that only ever loses the grammar engine is satisfied by a V8 that has no
    name for losing the other one — which is exactly what happened: nine cases, a green
    suite, and `_degraded_to` returning `''` for a grammar-only run. So the corpus must
    carry each direction in both its named and its unnamed form, and this test is what
    keeps that true when somebody trims the file.
    """
    cases = falsifier_cases()
    verdicts = {case["expect"] for case in cases}
    assert len(cases) >= 11
    assert any(verdict == "blocking" for verdict in verdicts)
    assert any(verdict.startswith("no blocking") for verdict in verdicts)

    for missing, name in DEGRADATION_NAMES.items():
        alive = [
            case
            for case in cases
            if case.get("notes", {}).get(missing) == ENGINE_NONE
            and case.get("g6_status") == "ok"
            and all(
                case["notes"].get(other) != ENGINE_NONE
                for other in DEGRADATION_NAMES
                if other != missing
            )
        ]
        named = [case for case in alive if case["notes"].get("degraded_to") == name]
        unnamed = [case for case in alive if case["notes"].get("degraded_to") == ""]
        assert named, f"no case has {missing} absent and the fallback named {name!r}"
        assert unnamed, f"no case has {missing} absent and the fallback left unnamed"
        expected = f"no blocking finding, and a warning naming {name}"
        assert {case["expect"] for case in named} == {expected}
        assert {case["expect"] for case in unnamed} == {"blocking"}


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


def test_INV_PACK_14_no_kenlm_model_degrades_to_grammar_only_and_is_not_blocked(
    es_after_g5: list[dict[str, Any]], spanish_sidecar: str
) -> None:
    """[INV-PACK-14] The other direction, run live rather than replayed from the corpus.

    This is the configuration an operator most likely has at P2: a LanguageTool sidecar
    is one command, and a perplexity band needs a KenLM model trained over a corpus G0
    has not produced yet. Before `grammar_only` had a name, this exact run produced
    `degraded_to: ''` and V8 blocked it with *"perplexity_engine did not run and G6 named
    the fallback as ''"* — a message asking for the name of the opposite degradation.

    What must happen instead: G6 names the state, V8 warns rather than blocks, and the
    warning carries what the pack lost and the command that gives it back.
    """
    result = run_g6({"grammar_engine": "mock_lt", "languagetool_url": spanish_sidecar})
    assert result.ok, result.message
    notes = read_entries("es", stage="g6")[-1]["notes"]
    assert notes["grammar_engine"].startswith("mock_lt/")
    assert notes["perplexity_engine"] == ENGINE_NONE
    assert notes["degraded_to"] == DEGRADED_TO_GRAMMAR_ONLY

    findings = run_v8()
    assert not blocking(findings), [finding.message for finding in findings]
    warned = [
        finding
        for finding in findings
        if finding.severity == "warning" and DEGRADED_TO_GRAMMAR_ONLY in finding.message
    ]
    assert warned, [(finding.severity, finding.message) for finding in findings]
    assert DEGRADATION_COST[DEGRADED_TO_GRAMMAR_ONLY] in warned[0].message
    assert DEGRADED_TO_PERPLEXITY_ONLY not in warned[0].message, (
        "the warning names the engine that was missing rather than the one that survived"
    )
    assert read_entries("es", stage="V8")[-1]["notes"]["degraded_to"] == DEGRADED_TO_GRAMMAR_ONLY


def test_INV_PACK_14_every_degradation_direction_has_a_name_and_a_cost() -> None:
    """[INV-PACK-14] Neither engine may go missing without the state having a name.

    `scope2/00` §2.4 names `perplexity_only` and nothing else, and the first version of
    this lane encoded exactly that: one constant, one comparison, and no name at all for
    the inverse. The gate is therefore stated over the whole set of engines that can find
    an error rather than over the one the spec happened to mention.
    """
    from coursekit.config.g6 import ENGINES_THAT_CAN_FIND_AN_ERROR

    assert set(DEGRADATION_NAMES) == set(ENGINES_THAT_CAN_FIND_AN_ERROR)
    assert len(set(DEGRADATION_NAMES.values())) == len(DEGRADATION_NAMES)
    for name in DEGRADATION_NAMES.values():
        assert DEGRADATION_COST[name].strip(), f"{name} has no stated cost"


def test_INV_PACK_14_a_mock_engine_is_a_warning_and_never_a_silent_pass(
    es_after_g5: list[dict[str, Any]], spanish_sidecar: str, kenlm_model: Path
) -> None:
    """[INV-PACK-14] The gate distinguishes a stand-in from the engine it imitates.

    `mock_lt` counts as an engine that can find an error, which is what lets `pack-ci.yml`
    exercise G6 with no JDK. Left there, a pack validated entirely against a forty-line
    mock would pass V8 exactly as one validated against 1,644 XML rules. It may not block
    — CI would then have no way to run G6 at all — so it is a named warning that reaches
    the runlog, the manifest and INV-PACK-55's pack card.
    """
    run_g6(full_options(spanish_sidecar, kenlm_model))
    findings = run_v8()
    assert not blocking(findings)
    mock_warnings = [
        finding
        for finding in findings
        if finding.severity == "warning" and "stand-in" in finding.message
    ]
    assert mock_warnings, [(finding.severity, finding.message) for finding in findings]
    assert any(engine in mock_warnings[0].message for engine in MOCK_ENGINE_IDS)
    assert mock_warnings[0].detail["mock_engines"]


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


def test_INV_PACK_10_no_engine_is_handed_a_text_other_than_the_one_on_the_row(
    es_after_g5: list[dict[str, Any]],
    spanish_sidecar: str,
    kenlm_model: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[INV-PACK-10] A repair that happens BEFORE the check leaves the output unchanged.

    `test_g6_narrows_the_surviving_set_and_changes_no_text` proves nothing left G6
    modified. It cannot see the other shape of the same bug: a helper that "cleans up" a
    candidate on the way INTO the grammar engine, so a sentence one accent from correct
    is checked as though it were correct and survives. The emitted text would still be
    byte-identical and the pack would ship the bad sentence.

    The adversarial pass noted that the source scanner covers two modules, so a repair
    helper in `engines/` would be caught only if it reached emitted text. This is the
    behavioural half for that: every string the three engines are handed has to be a
    candidate text, verbatim.
    """
    from coursekit.engines.backtranslation import AgentRubricEngine
    from coursekit.engines.kenlm import KenLMEngine
    from coursekit.engines.languagetool import LanguageToolEngine

    seen: dict[str, list[str]] = {"grammar": [], "perplexity": [], "backtranslation": []}

    def record(name: str, original: Any, index: int) -> Any:
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            seen[name].append(args[index])
            return original(*args, **kwargs)

        return wrapper

    # `index` counts from the bound-method argument list: check(self, lang, text) -> 1
    # once `self` is supplied, in_band(self, text) -> 0, score(self, text) -> 0.
    monkeypatch.setattr(LanguageToolEngine, "check", record("grammar", LanguageToolEngine.check, 2))
    monkeypatch.setattr(KenLMEngine, "in_band", record("perplexity", KenLMEngine.in_band, 1))
    monkeypatch.setattr(
        AgentRubricEngine, "score", record("backtranslation", AgentRubricEngine.score, 1)
    )

    run_g6(full_options(spanish_sidecar, kenlm_model))

    # The grammar engine's capability probe checks one nonce sentence of its own before
    # any candidate — that is how the spell checker is detected rather than assumed — so
    # it is the one string in this set that is legitimately not a candidate.
    authored = {row["text"] for row in read_records("candidate", lang="es")}
    authored.add(SPELLCHECK_PROBE["es"])
    for name, texts in seen.items():
        assert texts, f"the {name} engine was never called, so this test proved nothing"
        strange = sorted(set(texts) - authored)
        assert strange == [], (
            f"the {name} engine was handed text that is on no candidate row: {strange}. "
            f"Something rewrote a candidate on the way into the check."
        )


def test_INV_PACK_08_g6_checks_every_authored_alternate_independently(
    es_after_g5: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """[INV-PACK-08] A set cannot pass because only its preferred surface was checked."""
    import coursekit.stages.g6_validate_language as stage_module

    rows = list(read_records("candidate", lang="es"))
    survivor = next(row for row in rows if row["accepted"])
    survivor["accepted_alternates"] = ["Estoy cansada.", "Vivo en Madrid."]
    write_records("candidate", rows, lang="es")
    seen: list[str] = []

    def recording_axis(row: dict[str, Any], *_args: Any, **_kwargs: Any) -> tuple[None, dict]:
        seen.append(row["text"])
        return None, {}

    monkeypatch.setattr(stage_module, "_axis", recording_axis)
    run_g6({})
    assert survivor["text"] in seen
    assert "Estoy cansada." in seen  # explicitly authored speaker gender
    assert "Vivo en Madrid." in seen  # explicitly authored Spanish pro-drop
    notes = read_entries("es", stage="g6")[-1]["notes"]
    assert notes["checked_answers"] == notes["checked"] + 2


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


# ---------------------------------------------------------------------------
# The real LanguageTool server, and the CI gap it measures (B8)
# ---------------------------------------------------------------------------
#
# Everything above drives the grammar axis through `mock_lt`, which is right for a suite
# that has to run on a runner with no Java. What none of it can tell you is whether the
# `languagetool` engine talks to a real server — and that question stopped being academic
# when `pack-ci.yml`'s `build-es` turned out to name no grammar engine and no KenLM model
# at all, which makes V8 blocking for any content whatsoever (docs/P2-BLOCKERS.md B8).
#
# So this pair is env-gated on a URL, the same shape `test_g2_band.py` uses for ELELex.
# Start one with:
#
#   java -cp LanguageTool-6.6/languagetool-server.jar \
#        org.languagetool.server.HTTPServer --port 8081
#   COURSEKIT_LANGUAGETOOL_URL=http://localhost:8081 uv run pytest -k live_languagetool
#
# The URL is the server BASE, not an endpoint: `LanguageToolEngine` appends `/v2/languages`
# and `/v2/check` itself. Passing `.../v2/check` fails the stage with a 404 on
# `/v2/check/v2/languages` — measured, and the reason this comment spells it out.
#
# Measured 2026-09-12 against LanguageTool 6.6 (build 2025-03-27, Java 22.0.1) on macOS:
# both tests pass. `es` raises MORFOLOGIK_RULE_ES for a nonce token, so Spanish has a
# spell checker as well as grammar rules, and with no KenLM model `degraded_to` is
# `grammar_only` and V8 warns instead of blocking.

LIVE_LANGUAGETOOL_ENV_VAR = "COURSEKIT_LANGUAGETOOL_URL"

live_languagetool = pytest.mark.skipif(
    not __import__("os").environ.get(LIVE_LANGUAGETOOL_ENV_VAR),
    reason=f"set {LIVE_LANGUAGETOOL_ENV_VAR} to a running LanguageTool /v2/check endpoint",
)


@live_languagetool
def test_live_languagetool_spanish_has_a_spell_checker_and_g6_says_so(
    es_after_g5: list[dict[str, Any]],
) -> None:
    """[INV-PACK-14] The engine record names a server that really answered.

    The mock proves the wiring; only a real server proves the claim `config/g6.py` makes
    about Spanish — that it has BOTH grammar rules and a spell checker, so
    `spellcheck_engine` must not be `none` for `es`. A run whose engine record is right
    about a mock and wrong about LanguageTool is a record nobody can act on.
    """
    import os

    url = os.environ[LIVE_LANGUAGETOOL_ENV_VAR]
    result = run_g6({"languagetool_url": url})
    assert result.ok, result.message

    notes = read_entries("es", stage="g6")[-1]["notes"]
    assert notes["grammar_engine"] != ENGINE_NONE, notes
    assert notes["grammar_engine"].startswith("languagetool/"), notes["grammar_engine"]
    assert notes["spellcheck_engine"] != ENGINE_NONE, (
        f"{SPELLCHECK_PROBE!r} found no spelling rule on a live server; either the probe "
        "or config/g6.py's Spanish row is wrong"
    )
    assert notes["grammar_engine"] not in MOCK_ENGINE_IDS


@live_languagetool
def test_live_languagetool_alone_is_enough_to_stop_v8_blocking(
    es_after_g5: list[dict[str, Any]],
) -> None:
    """B8's remedy, proven rather than asserted.

    `build-es` runs `coursekit build es --set max_pairs=...` and names no engine, so both
    `grammar_engine` and `perplexity_engine` are `none` and V8 blocks — "zero errors from
    nothing". The proposed one-step fix is a LanguageTool sidecar and nothing else, with
    KenLM still absent. This test is that exact configuration: if it stops passing, the
    remedy written into docs/P2-BLOCKERS.md B8 is no longer the remedy.
    """
    import os

    result = run_g6({"languagetool_url": os.environ[LIVE_LANGUAGETOOL_ENV_VAR]})
    assert result.ok, result.message

    notes = read_entries("es", stage="g6")[-1]["notes"]
    assert notes["perplexity_engine"] == ENGINE_NONE, "this test is the no-KenLM case"
    assert notes["degraded_to"] == DEGRADED_TO_GRAMMAR_ONLY

    findings = run_v8()
    assert not blocking(findings), [finding.message for finding in findings]


def test_INV_PACK_14_the_invocation_build_es_uses_names_a_language_engine(
    es_after_g5: list[dict[str, Any]],
) -> None:
    """[INV-PACK-14] B8, closed: the workflow itself has to bring an engine.

    This test used to pin the BROKEN state. `.github/workflows/pack-ci.yml`'s `build-es`
    ran `coursekit build es` with no `languagetool_url` and no `kenlm_model`, G6 recorded
    `grammar_engine: none` the way its docstring says it must, and V8 read "zero errors
    from nothing" — so `validate-es` could not exit 0 for any content whatsoever, and
    nobody could see it while G5 was failing one stage earlier.

    The sidecar step landed at the P2 fix integration, so the assertion is inverted: the
    workflow must name an engine, and it must pass the SERVER BASE, because
    `LanguageToolEngine` appends `/v2/languages` and `/v2/check` itself and a URL ending
    in an endpoint fails the stage with a 404 on `/v2/check/v2/languages`.

    The property behind it — no engine at all is a blocking V8 — stays covered by
    `test_no_engine_at_all_is_a_blocking_v8_not_a_clean_one`, which is about G6 rather
    than about the workflow. This one reads the YAML, because the defect was in the YAML.
    """
    workflow = (
        Path(__file__).resolve().parents[3] / ".github" / "workflows" / "pack-ci.yml"
    ).read_text(encoding="utf-8")
    build_es = workflow[workflow.index("Build es (G0-G9)") :]
    invocation = build_es[: build_es.index("\n\n")]
    assert "--set languagetool_url=" in invocation, (
        "build-es names no language engine, so G6 degrades to grammar_engine: none and "
        "V8 blocks the pack with 'zero errors from nothing' (INV-PACK-14). Start the "
        f"LanguageTool sidecar and pass its base URL. Invocation was:\n{invocation}"
    )
    # A regex rather than a whitespace split, and deliberately: INV-PACK-40's grep gate
    # in tests/test_ledger_unit.py reads a whitespace split anywhere under tools/coursekit
    # as a second notion of what a token is, even in a test that is slicing YAML.
    named = re.search(r"--set languagetool_url=(\S+)", invocation)
    assert named is not None
    url = named.group(1)
    assert not url.rstrip("/").endswith(("/v2/check", "/v2/languages")), (
        f"languagetool_url must be the server base, not an endpoint; got {url!r}"
    )
    assert "org.languagetool.server.HTTPServer" in workflow, (
        "the workflow passes a LanguageTool URL and never starts a server at it"
    )


def test_INV_PACK_14_the_rubric_scores_are_read_from_the_shards_as_well(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    es_adapter: None,  # noqa: F811
) -> None:
    """A course whose candidates live only in `content/es/candidates/*.jsonl`.

    This is the shape the P2 fix round shipped: sharding moved every authored row out of
    `content/es/candidates.jsonl` and into one file per authoring lane, and the legacy
    file stopped existing. G6 built its back-translation engine from that one path, so it
    probed a file that was not there, reported `backtranslation_engine: none` and failed
    the stage with "an engine was requested and could not run" — while every score sat on
    disk, one directory across. Zero scores read from a file nobody wrote is exactly the
    "checked nothing" reading INV-PACK-14 exists to catch, so the fix is tested here and
    not only in the engine.
    """
    from coursekit.stages.g5_gapfill import authored_shard_dir

    rows = authored_rows(REAL_CANDIDATES)
    alternate_surface = "Vivo en Madrid."
    alternate_score = 4
    rows[0]["accepted_alternates"] = [
        {
            "text": alternate_surface,
            "backtranslation": {
                **rows[0]["backtranslation"],
                "score": alternate_score,
            },
        }
    ]
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path / "content"))
    shard_dir = authored_shard_dir("es")
    shard_dir.mkdir(parents=True, exist_ok=True)
    (shard_dir / "lane-a.jsonl").write_text(
        "\n".join(json.dumps(row, ensure_ascii=False, sort_keys=True) for row in rows) + "\n",
        encoding="utf-8",
    )
    assert not (shard_dir.parent / "candidates.jsonl").exists()

    stage_g4("es", gap_list(rows))
    assert run_g5().ok

    from coursekit.engines import ENGINES
    from coursekit.stages.g5_gapfill import authored_candidates_paths

    build = ENGINES.get("agent_rubric")
    assert build is not None
    engine = build([str(path) for path in authored_candidates_paths("es")])
    assert engine is not None
    probe = engine.probe("es")
    assert probe["available"], probe["reason"]
    assert probe["detail"]["scored"] == len({row["text"] for row in rows}) + 1
    assert engine.score(rows[0]["text"]) == rows[0]["backtranslation"]["score"]
    assert engine.score(alternate_surface) == alternate_score


def test_INV_PACK_14_rubric_meaning_is_keyed_by_the_exact_bilingual_pair(tmp_path: Path) -> None:
    from coursekit.engines.backtranslation import AgentRubricEngine

    def authored(text, translation, score, alternates=None):
        return {
            "text": text,
            "translation": translation,
            "backtranslation": {
                "score": score,
                "rubric_version": "1",
                "back_translation": translation,
            },
            "accepted_alternates": alternates or [],
        }

    rows = [
        authored("Estoy cansada.", "I am tired.", 2),
        authored("Estoy cansada.", "I am hungry.", 4),
        authored(
            "Yo estoy cansada.",
            "I am tired.",
            4,
            [
                {
                    "text": "Estoy cansada.",
                    "backtranslation": {
                        "score": 4,
                        "rubric_version": "1",
                        "back_translation": "I am tired.",
                    },
                }
            ],
        ),
    ]
    path = tmp_path / "authored.jsonl"
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
    engine = AgentRubricEngine(paths=(path,))
    assert engine.probe("es")["available"]
    # The favorable later judgement cannot overwrite the earlier contrary witness.
    assert engine.score("Estoy cansada.", translation="I am tired.") == 2
    assert engine.score("Estoy cansada.", translation="I am hungry.") == 4
    assert engine.score("Estoy cansada.") is None  # ambiguous without the English side
    assert engine.score("Estoy cansada.", translation="I am happy.") is None
    axis, _ = _axis(
        {"text": "Estoy cansada.", "translation": "I am tired."}, "es", None, None, engine, []
    )
    assert axis == "backtranslation"
    # A reused engine must not keep scores for rows no longer in its input files.
    path.write_text(json.dumps(rows[2]), encoding="utf-8")
    assert engine.probe("es")["available"]
    assert engine.score("Estoy cansada.", translation="I am hungry.") is None


@pytest.mark.parametrize("score", [True, None, -1, 5])
def test_INV_PACK_14_an_alternate_without_a_real_score_cannot_borrow_preferred_evidence(
    tmp_path: Path, score: object
) -> None:
    from coursekit.engines.backtranslation import AgentRubricEngine

    row = {
        "text": "Yo vivo aquí.",
        "translation": "I live here.",
        "backtranslation": {"score": 4, "rubric_version": "1"},
        "accepted_alternates": [{"text": "Vivo aquí.", "backtranslation": {"score": score}}],
    }
    path = tmp_path / "authored.jsonl"
    path.write_text(json.dumps(row), encoding="utf-8")
    probe = AgentRubricEngine(paths=(path,)).probe("es")
    assert not probe["available"]
    assert probe["backtranslation_engine"] == "none"


def test_INV_PACK_08_bad_alternate_narrows_whole_candidate_without_rewriting(
    es_after_g5: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    import coursekit.stages.g6_validate_language as stage_module

    rows = list(read_records("candidate", lang="es"))
    survivor = next(row for row in rows if row["accepted"])
    survivor["accepted_alternates"] = ["Explicit authored bad surface."]
    write_records("candidate", rows, lang="es")
    original = dict(survivor)

    def rejecting_axis(row, *_args, **_kwargs):
        return (
            ("grammar", {"reason": "test witness"})
            if row["text"] == survivor["accepted_alternates"][0]
            else (None, {})
        )

    monkeypatch.setattr(stage_module, "_axis", rejecting_axis)
    assert run_g6({}).ok
    narrowed = next(
        row
        for row in read_records("candidate", lang="es")
        if row["candidate_id"] == survivor["candidate_id"]
    )
    assert narrowed == {**original, "accepted": False, "reject_reason": "g6:grammar"}
    finding = next(
        row
        for row in read_entries("es", stage="g6")[-1]["notes"]["findings"]
        if row["candidate_id"] == survivor["candidate_id"]
    )
    assert finding["answer_kind"] == "alternate"
    assert finding["answer"] == survivor["accepted_alternates"][0]
