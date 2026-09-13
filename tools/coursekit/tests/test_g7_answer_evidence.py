"""G7 consumes whole-pair G6 approval, and only anchored spans for S039 typing."""

from dataclasses import replace
from types import SimpleNamespace

import pytest

from coursekit.answer_evidence import ApprovedAnswers
from coursekit.exercises.distractors import AlternativesIndex, DistractorPool
from coursekit.stages.g7_expand import ResolvedSlot, _grammar_draft, _sentence_draft, _target_tokens


def slot(text="No veo nada.", spanish=(), english=()):
    import re

    tokens = []
    for match in re.finditer(r"\w+|[^\w\s]", text):
        surface = match.group()
        tokens.append(
            {
                "surface": surface,
                "lemma": "ver" if surface == "veo" else surface.lower(),
                "pos": "VERB" if surface == "veo" else "ADV" if surface.isalpha() else "PUNCT",
                "morph": "",
                "start": match.start(),
                "end": match.end(),
            }
        )
    analysis = {
        "tokens": tokens,
        "lemmas": [t["lemma"] for t in tokens],
        "display_tokens": [t["surface"] for t in tokens if t["pos"] != "PUNCT"],
    }
    translation = "I don't see anything."
    answers = ApprovedAnswers(
        spanish=(text, *spanish),
        english_reverse_only=(translation, *english),
        spanish_analysis_by_surface={text: analysis},
        evidence_hash="a" * 64,
    )
    return ResolvedSlot(text, translation, "b" * 16, analysis, None, approved_answers=answers)


def draft(source, shape_id="typed_translate_forward", *, grammar=False):
    inputs = SimpleNamespace(lang="es", pool=DistractorPool())
    common = dict(
        inputs=inputs,
        shape_id=shape_id,
        unit=1,
        lesson=1,
        concept="negation",
        slot=source,
        target_tokens=_target_tokens(source),
        lemmas=source.analysis["lemmas"],
        register="tu",
        alternatives=AlternativesIndex(),
    )
    if grammar:
        return _grammar_draft(**common)
    return _sentence_draft(
        **common,
        text=source.text,
        translation=source.translation,
        source_tokens=source.translation.split(),
        audio="c" * 16,
    )


@pytest.mark.parametrize(
    "shape_id,expected",
    [
        ("typed_translate_forward", ("No veo nada.", "No veo ninguna cosa.")),
        ("typed_translate_reverse", ("I don't see anything.", "I see nothing.")),
        ("type_what_you_hear", ("No veo nada.",)),
        ("speak_this_sentence", ("No veo nada.",)),
    ],
)
def test_INV_GRD_03_whole_answer_direction_is_explicit(shape_id, expected):
    source = slot(spanish=("No veo ninguna cosa.",), english=("I see nothing.",))
    result = draft(source, shape_id)
    assert result.accepted_answers == expected
    assert result.source_sentence_id == source.source_id


@pytest.mark.parametrize("grammar", [False, True])
def test_INV_GRD_03_S039_only_reconstructible_approved_whole_answers_yield_spans(grammar):
    source = slot(spanish=("No veo ninguna cosa.", "Nada veo.", "No veo nada!", "No veo ."))
    result = draft(source, "complete_the_translation", grammar=grammar)
    assert result.body == "I don't see anything.\nNo veo ____."
    assert result.accepted_answers == ("nada", "ninguna cosa")
    assert result.source_sentence_id == source.source_id
    for span in result.accepted_answers:
        assert (
            result.body.split("\n", 1)[1].replace("____", span) in source.approved_answers.spanish
        )


@pytest.mark.parametrize("grammar", [False, True])
def test_INV_GRD_03_S039_empty_suffix_does_not_drop_the_last_character(grammar):
    source = slot("Eso es azul", spanish=("Eso es de color azul", "Azul es eso"))
    result = draft(source, "complete_the_translation", grammar=grammar)
    assert result.body.endswith("Eso es ____")
    assert result.accepted_answers == ("azul", "de color azul")


def test_INV_GRD_03_S039_requires_exact_source_offsets():
    source = slot(spanish=("No veo ninguna cosa.",))
    source.analysis["tokens"][2]["start"] = 0
    with pytest.raises(ValueError, match="span|offset"):
        draft(source, "complete_the_translation")


def test_INV_GRD_03_no_g7_only_prodrop_or_legacy_alternate_generation():
    source = slot("Ella come pan.")
    source.analysis["tokens"][0].update(pos="PRON", morph="Number=Sing|Person=3|PronType=Prs")
    source.analysis["tokens"][1].update(pos="VERB", morph="Number=Sing|Person=3|VerbForm=Fin")
    source = replace(source, accepted_alternates=("Ella está comiendo pan.",))
    assert draft(source).accepted_answers == ("Ella come pan.",)


def approve_current_ledger(*, spanish_by_source=None, english_by_source=None):
    """Explicit mock G6 run: real review hashes, sidecar, current runlog and checks.

    This only authors the caller's declared fixture sentences; no production API is
    patched. Alternate analyses must be supplied explicitly by their fixture author.
    """
    import json
    import os
    from pathlib import Path

    from coursekit.answer_evidence import (
        answer_content_hash,
        answer_surfaces,
        build_answer_approval,
        load_answer_evidence,
        write_answer_approval,
    )
    from coursekit.artifacts import read_records
    from coursekit.config.g5 import MAX_TOKENS
    from coursekit.ledger import count_units
    from coursekit.runlog import RunLog
    from coursekit.selected_sources import resolve_selected_sources

    spanish_by_source = spanish_by_source or {}
    english_by_source = english_by_source or {}
    selected = list(read_records("selected_item", lang="es"))
    sources = resolve_selected_sources(
        "es",
        selected=selected,
        candidates=list(read_records("candidate", lang="es"))
        if any(i["gap"] for i in selected)
        else [],
        ingested=read_records("ingested_sentence", lang="es"),
        analysed=read_records("analysed_sentence", lang="es"),
        units=read_records("unit_assignment", lang="es"),
        banded=read_records("banded_lemma", lang="es"),
    )
    rows = []
    for source in sources:
        pair = {
            "score": 4,
            "register": "neutral",
            "judgement": "Explicit fixture whole-pair review.",
        }
        row = {
            "schema_version": 1,
            "source": source.snapshot(),
            "author": "G7 fixture author",
            "licence": "CC-BY-NC-SA-4.0",
            "authored_on": "2026-09-13",
            "rationale": "Declared test source and answer set.",
            "canonical_pair": pair,
            "spanish": [
                {"text": text, "pair": pair} for text in spanish_by_source.get(source.source_id, {})
            ],
            "english_reverse_only": [
                {"text": text, "pair": pair} for text in english_by_source.get(source.source_id, ())
            ],
            "review": None,
        }
        row["review"] = {
            "reviewer": "Independent G7 fixture reviewer",
            "verdict": "accepted",
            "note": "Independently checked explicit fixture answers.",
            "content_hash": answer_content_hash(row),
        }
        rows.append(row)
    path = Path(os.environ["COURSEKIT_CONTENT_ROOT"]) / "es/authoring/answers.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))
    evidence = load_answer_evidence("es", sources)
    checks_by_slot = {}
    for source, row in zip(sources, rows, strict=True):
        proofs = []
        for use, text, _pair in answer_surfaces(source, row):
            forward = use == "forward"
            analysis = (
                (
                    source.analysis
                    if text == source.text
                    else spanish_by_source[source.source_id][text]
                )
                if forward
                else None
            )
            checks = {
                name: {
                    "engine": "declared-fixture",
                    "language": "es" if forward else "en",
                    "requested": True,
                    "available": True,
                    "passed": True,
                    "detail": {"reason": "explicit mock language check"},
                }
                for name in (
                    ["ledger", "register", "length", "duplicate", "pair", "grammar", "perplexity"]
                    if forward
                    else ["pair", "grammar"]
                )
            }
            checks["pair"]["detail"] = {"score": 4, "review_hash": row["review"]["content_hash"]}
            if forward:
                checks["length"]["detail"] = {
                    "minimum": source.minimum_tokens,
                    "maximum": MAX_TOKENS,
                    "count": count_units(
                        {
                            "lang": "es",
                            "tokens": analysis["tokens"],
                            "adapter": analysis.get("adapter", analysis.get("analyser")),
                        }
                    ),
                    "window_pos_digest": source.window_pos_digest,
                }
            proofs.append({"use": use, "text": text, "analysis": analysis, "checks": checks})
        checks_by_slot[source.slot] = proofs
    runlog = RunLog("es")
    with runlog.stage("g5", tool="coursekit", tool_version="explicit-g7-fixture") as entry:
        entry.written = len(sources)
    with runlog.stage("g6", tool="coursekit", tool_version="explicit-g7-fixture") as entry:
        approval = build_answer_approval(
            "es", sources, evidence, checks_by_slot, run_id=entry.run_id
        )
        entry.note(**write_answer_approval("es", approval))
        entry.written = len(sources)
    return sources


@pytest.fixture(scope="module")
def actual_grader(tmp_path_factory):
    """Compile the installed core grader once; grade the actual builder output below."""
    import json
    import os
    import shutil
    import subprocess
    from pathlib import Path

    repo = Path(__file__).resolve().parents[3]
    node = shutil.which("node")
    compiler = repo / "node_modules/typescript/bin/tsc"
    if not node or not compiler.exists():
        reason = "Actual core-grader caller check needs installed Node/TypeScript"
        if os.environ.get("COURSEKIT_REQUIRE_CORE_GRADER") == "1":
            pytest.fail(reason)
        pytest.skip(reason)
    output = tmp_path_factory.mktemp("actual-g7-grader")
    compiled = subprocess.run(
        [
            node,
            str(compiler),
            "--ignoreConfig",
            "--target",
            "ES2022",
            "--module",
            "ES2022",
            "--strict",
            "--skipLibCheck",
            "--moduleResolution",
            "bundler",
            "--types",
            "node",
            "--outDir",
            str(output),
            "--rootDir",
            str(repo / "packages/core/src"),
            str(repo / "packages/core/src/grading/grade.ts"),
            str(repo / "packages/core/src/grading/packs/es.ts"),
        ],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    assert compiled.returncode == 0, compiled.stdout + compiled.stderr
    (output / "package.json").write_text('{"type":"module"}')
    bridge = output / "bridge.mjs"
    bridge.write_text("""
import {gradeTypedAnswer, NO_SURFACES_INTRODUCED} from './grading/grade.js';
import {ES_PACK, ES_UNIT} from './grading/packs/es.js';
import {readFileSync} from 'node:fs';
const r = JSON.parse(readFileSync(0, 'utf8'));
const item = {itemId: r.exercise_id, family: r.family,
  accepted: r.accepted_answers.map((surface, rank) => ({surface, rank, surfaceId: String(rank)}))};
process.stdout.write(JSON.stringify(gradeTypedAnswer({pack: ES_PACK, unit: ES_UNIT,
  item, answer: r.answer, learner: NO_SURFACES_INTRODUCED})));
""")

    def grade(exercise, answer):
        record = exercise.to_record()
        record.update(
            answer=answer,
            family="gap-fill"
            if exercise.shape_id == "complete_the_translation"
            else "typed-translate",
        )
        result = subprocess.run(
            [node, str(bridge)],
            input=json.dumps(record),
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)

    return grade


@pytest.mark.parametrize(
    "shape_id,answer",
    [
        ("typed_translate_forward", "No veo ninguna cosa."),
        ("typed_translate_reverse", "I see nothing."),
        ("complete_the_translation", "ninguna cosa"),
    ],
)
def test_INV_GRD_03_actual_grader_accepts_the_emitted_reviewed_variant(
    actual_grader, shape_id, answer
):
    source = slot(spanish=("No veo ninguna cosa.",), english=("I see nothing.",))
    exercise = draft(source, shape_id)
    result = actual_grader(exercise, answer)
    assert (result["tier"], result["wrong"], result["heartCost"]) == (1, False, 0)
    wrong = actual_grader(exercise, "elefantes morados")
    assert (wrong["tier"], wrong["wrong"], wrong["heartCost"]) == (3, True, 1)


@pytest.fixture
def reviewed_ledger(tmp_path, monkeypatch):
    from test_g7_expand import _write_ledger, g7_reviewed_glossary

    g7_reviewed_glossary.__wrapped__(tmp_path, monkeypatch)
    _write_ledger()


def test_INV_GRD_03_G7_loads_real_current_G6_approval_for_corpus_only(reviewed_ledger):
    from coursekit.stages.g7_expand import _load, _resolve

    inputs = _load("es")
    assert len(inputs.approved_answers) == len(inputs.selected) == 5
    for item in inputs.selected:
        source = _resolve(inputs, item)
        key = (item["unit_index"], item["lesson_index"], item["slot_index"])
        assert source.approved_answers == inputs.approved_answers[key]
        assert source.approved_answers.spanish == (source.text,)
        assert source.approved_answers.english_reverse_only == (source.translation,)
        assert inputs.sources[key].window_pos_digest


@pytest.mark.parametrize(
    "mutation", ["spanish", "english", "move_slot", "known", "failed_g6", "later_g4"]
)
def test_INV_GRD_03_G7_refuses_stale_whole_answer_approval(reviewed_ledger, mutation):
    from coursekit.answer_evidence import AnswerEvidenceError
    from coursekit.artifacts import read_records, write_records
    from coursekit.runlog import RunLog
    from coursekit.stages.g7_expand import _load

    if mutation in {"spanish", "english"}:
        rows = list(read_records("ingested_sentence", lang="es"))
        rows[0]["text" if mutation == "spanish" else "translation"] += "!"
        write_records("ingested_sentence", rows, lang="es")
    elif mutation in {"move_slot", "known"}:
        rows = list(read_records("selected_item", lang="es"))
        if mutation == "move_slot":
            rows[0]["slot_index"] = 99
        else:
            rows[0]["known_lemmas"].append("nuevo")
        write_records("selected_item", rows, lang="es")
    else:
        if mutation == "failed_g6":
            with (
                pytest.raises(RuntimeError, match="actual later failure"),
                RunLog("es").stage("g6", tool="coursekit", tool_version="fixture"),
            ):
                raise RuntimeError("actual later failure")
        else:
            with RunLog("es").stage("g4", tool="coursekit", tool_version="fixture"):
                pass
    from coursekit.selected_sources import SourceEvidenceError

    with pytest.raises((AnswerEvidenceError, SourceEvidenceError)):
        _load("es")


def test_INV_GRD_03_resolve_does_not_reuse_another_slots_answer_proof(reviewed_ledger):
    from coursekit.answer_evidence import AnswerEvidenceError
    from coursekit.stages.g7_expand import _load, _resolve

    inputs = _load("es")
    item = dict(inputs.selected[0], slot_index=99)
    with pytest.raises(AnswerEvidenceError, match="exact-slot"):
        _resolve(inputs, item)


def test_INV_GRD_03_explicit_typed_grammar_scaffold_keeps_its_meaning_context(monkeypatch):
    import coursekit.stages.g7_expand as module

    def should_not_run(*args, **kwargs):
        raise AssertionError("typed translation must not become a standalone agreement drill")

    monkeypatch.setattr(module, "_agreement_cloze", should_not_run)
    result = draft(slot(), "complete_the_translation", grammar=True)
    assert result.body.startswith("I don't see anything.\n")


@pytest.mark.parametrize("kind", ["analysed_sentence", "unit_assignment", "banded_lemma"])
def test_INV_GRD_03_G7_cannot_hide_duplicate_source_facts_in_a_dict(reviewed_ledger, kind):
    from coursekit.artifacts import read_records, write_records
    from coursekit.selected_sources import SourceEvidenceError
    from coursekit.stages.g7_expand import _load

    rows = list(read_records(kind, lang="es"))
    write_records(kind, [*rows, rows[0]], lang="es")
    with pytest.raises(SourceEvidenceError, match="duplicate"):
        _load("es")


def test_INV_GRD_03_all_reviewed_directions_and_typed_spans_are_indexed_before_drafts(
    reviewed_ledger,
    monkeypatch,
):
    from test_g7_expand import _ADAPTER, _build, _quality_analysis

    import coursekit.stages.g7_expand as module
    from coursekit.artifacts import dedup_hash, read_records, sentence_id, write_records

    text = "No veo nada."
    alternate = "No veo ninguna cosa."
    sid = sentence_id("es", text)
    ingested = list(read_records("ingested_sentence", lang="es"))
    analysed = list(read_records("analysed_sentence", lang="es"))
    selected = list(read_records("selected_item", lang="es"))
    analysis = _quality_analysis(
        text,
        [
            ("No", "no", "ADV", ""),
            ("veo", "ver", "VERB", "Person=1|Number=Sing|VerbForm=Fin"),
            ("nada", "nada", "PRON", ""),
            (".", ".", "PUNCT", ""),
        ],
    )
    other = _quality_analysis(
        alternate,
        [
            ("No", "no", "ADV", ""),
            ("veo", "ver", "VERB", "Person=1|Number=Sing|VerbForm=Fin"),
            ("ninguna", "ninguno", "DET", ""),
            ("cosa", "cosa", "NOUN", ""),
            (".", ".", "PUNCT", ""),
        ],
    )
    other["analyser"] = _ADAPTER
    ingested.append(
        {
            **ingested[0],
            "sentence_id": sid,
            "text": text,
            "translation": "I don't see anything.",
            "token_count": 3,
            "dedup_hash": dedup_hash(text),
        }
    )
    analysed.append({**analysed[0], **analysis, "sentence_id": sid, "adapter": _ADAPTER})
    selected.append(
        {
            **selected[0],
            "slot_index": 9,
            "sentence_id": sid,
            "new_lemmas": [],
            "known_lemmas": ["no", "ver", "nada", "ninguno", "cosa"],
        }
    )
    for kind, rows in [
        ("ingested_sentence", ingested),
        ("analysed_sentence", analysed),
        ("selected_item", selected),
    ]:
        write_records(kind, rows, lang="es")
    approve_current_ledger(
        spanish_by_source={sid: {alternate: other}}, english_by_source={sid: ["I see nothing."]}
    )
    seen = []

    def inspect_first_draft(inputs, **kwargs):
        for surface in [
            text,
            alternate,
            "I don't see anything.",
            "I see nothing.",
            "nada",
            "ninguna cosa",
        ]:
            assert kwargs["alternatives"].is_alternative("sentence:" + sid, surface), surface
        seen.append(True)
        raise ValueError("checked complete index before first draft")

    monkeypatch.setattr(module, "_sentence_draft", inspect_first_draft)
    result = _build()
    assert seen and "checked complete index" in result.output
