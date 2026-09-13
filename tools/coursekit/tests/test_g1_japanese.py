"""Japanese G1 persists a total joined script population, never a loose sidecar."""

from copy import deepcopy

import pytest
from test_g1_analyze import run_stage

from coursekit import __version__
from coursekit.adapters.sudachi_ja import JapaneseAnalysis, SudachiJaAdapter
from coursekit.artifacts import artifact_path, dedup_hash, read_records, sentence_id, write_records
from coursekit.config import TOOL_NAME
from coursekit.inputs import MissingInput
from coursekit.japanese_script import ScriptAnalysisError, validate_script_analysis
from coursekit.runlog import RunLog, read_entries
from coursekit.stages import STAGES
from coursekit.stages import g1_analyze as stage


def seed(texts):
    rows = [
        {
            "schema_version": 1,
            "sentence_id": sentence_id("ja", text),
            "lang": "ja",
            "l1": "en",
            "text": text,
            "translation": "Original structural test fixture.",
            "source_id": "tatoeba",
            "corpus": "test fixture",
            "corpus_version": "original-2026-09-13",
            "licence": "CC-BY-2.0-FR",
            "licence_verdict": "shippable",
            "attribution_required": True,
            "attribution_owner": "test author",
            "token_count": 4,
            "dedup_hash": dedup_hash(text),
        }
        for text in texts
    ]
    write_records("ingested_sentence", rows, lang="ja")
    with RunLog("ja").stage("g0", tool=TOOL_NAME, tool_version=__version__) as entry:
        entry.record_output("ingested_sentence")
        entry.written = len(rows)
    return rows


def test_INV_PACK_40_43_real_G1_writes_both_outputs_and_the_exact_shared_population():
    originals = seed(["国家公務員です。", "朝ご飯を食べます。"])
    result, entry = run_stage(stage.analyze, "g1", "ja")
    assert result.ok, result.message
    analysed = list(read_records("analysed_sentence", lang="ja"))
    scripts = list(read_records("japanese_script_analysis", lang="ja"))
    assert (
        [row["sentence_id"] for row in analysed]
        == [row["sentence_id"] for row in scripts]
        == [row["sentence_id"] for row in originals]
    )
    for analysis, script, source in zip(analysed, scripts, originals, strict=True):
        validate_script_analysis(script, analysis, text=source["text"])
    assert entry.outputs == ["analysed_sentence", "japanese_script_analysis"]
    assert entry.notes["paired_script_rows"] == 2
    assert entry.notes["script_reading_review_status"] == "unreviewed"
    assert entry.notes["ledger"]["ledger_unit"] == "morpheme_mode_a"
    assert entry.notes["adapter"]["split_mode"] == "A"
    assert "japanese_script_analysis" in STAGES.get("g1").writes


def test_INV_PACK_40_length_rejection_removes_the_same_row_from_both_artifacts():
    # 20 retained,1 shorter than the unchanged Japanese4-unit minimum: under5% drift.
    originals = seed([" " * i + "国家公務員です。" for i in range(20)] + ["猫です。"])
    result, entry = run_stage(stage.analyze, "g1", "ja")
    assert result.ok, result.message
    expected = [row["sentence_id"] for row in originals[:-1]]
    assert [r["sentence_id"] for r in read_records("analysed_sentence", lang="ja")] == expected
    assert [
        r["sentence_id"] for r in read_records("japanese_script_analysis", lang="ja")
    ] == expected
    assert entry.rejected == 1
    assert entry.notes["paired_script_rows"] == 20


@pytest.mark.parametrize("fault", ["missing", "stale_hash", "wrong_source", "bad_span"])
def test_INV_PACK_47_stale_or_missing_pair_fails_before_either_artifact_write(fault, monkeypatch):
    originals = seed(["国家公務員です。"])
    real = SudachiJaAdapter()
    pair = real.analyse_with_script(
        sentence_id=originals[0]["sentence_id"], text=originals[0]["text"]
    )
    script = deepcopy(pair.script)
    if fault == "missing":
        script = None
    elif fault == "stale_hash":
        script["analysis_sha256"] = "0" * 64
    elif fault == "wrong_source":
        script["sentence_id"] = "f" * 16
    else:
        script["mode_c_tokens"][0]["end"] -= 1

    class Broken:
        fingerprint = real.fingerprint
        require_self_test = real.require_self_test

        def analyse_with_script(self, **kwargs):
            return JapaneseAnalysis(pair.analysed, script)

    monkeypatch.setattr(stage, "adapter_for", lambda lang: Broken())
    with pytest.raises(ScriptAnalysisError):
        run_stage(stage.analyze, "g1", "ja")
    assert not artifact_path("ja", "analysed_sentence").exists()
    assert not artifact_path("ja", "japanese_script_analysis").exists()
    assert read_entries("ja", stage="g1")[-1]["status"] == "failed"
    assert read_entries("ja", stage="g1")[-1]["counts"]["read"] == 1


def test_INV_PACK_51_OOV_rejection_is_counted_and_preserves_remaining_pair():
    seed(["国家公務員です。", "三本あります。"])
    result, entry = run_stage(stage.analyze, "g1", "ja")
    assert result.ok, result.message
    assert entry.read == 2 and entry.written == 1 and entry.rejected == 1
    assert len(list(read_records("japanese_script_analysis", lang="ja"))) == 1
    assert any("OOV" in reason for reason in entry.notes["source_rejection_reasons"])


def test_INV_PACK_06_missing_paired_adapter_interface_is_a_named_failure(monkeypatch):
    seed(["国家公務員です。"])
    real = SudachiJaAdapter()

    class Unpaired:
        fingerprint = real.fingerprint
        require_self_test = real.require_self_test

        def analyse(self, **kwargs):
            raise AssertionError("Japanese G1 must never call the unpaired API")

    monkeypatch.setattr(stage, "adapter_for", lambda lang: Unpaired())
    with pytest.raises(MissingInput, match="paired"):
        run_stage(stage.analyze, "g1", "ja")
    assert read_entries("ja", stage="g1")[-1]["status"] == "failed"


@pytest.mark.parametrize("fault", ["duplicate", "foreign_language"])
def test_INV_PACK_40_G0_population_identity_must_be_unambiguous(fault):
    rows = seed(["国家公務員です。"])
    if fault == "duplicate":
        rows.append(deepcopy(rows[0]))
    else:
        rows[0]["lang"] = "fr"
    write_records("ingested_sentence", rows, lang="ja")
    with pytest.raises(ScriptAnalysisError):
        run_stage(stage.analyze, "g1", "ja")
    assert not artifact_path("ja", "analysed_sentence").exists()
    assert not artifact_path("ja", "japanese_script_analysis").exists()


def test_INV_PACK_51_all_OOV_failure_still_records_actual_rejection_counts():
    seed(["三本あります。"])
    result, entry = run_stage(stage.analyze, "g1", "ja")
    assert not result.ok
    assert entry.read == 1 and entry.written == 0 and entry.rejected == 1
    assert any("OOV" in reason for reason in entry.notes["source_rejection_reasons"])
    assert read_entries("ja", stage="g1")[-1]["status"] == "failed"


def test_INV_PACK_06_stage_fingerprint_must_equal_every_paired_analysis(monkeypatch):
    seed(["国家公務員です。"])
    real = SudachiJaAdapter()

    class Drifted:
        require_self_test = real.require_self_test
        analyse_with_script = real.analyse_with_script

        def fingerprint(self):
            return {**real.fingerprint(), "version": "future"}

    monkeypatch.setattr(stage, "adapter_for", lambda lang: Drifted())
    with pytest.raises(ScriptAnalysisError, match="fingerprint"):
        run_stage(stage.analyze, "g1", "ja")
    assert not artifact_path("ja", "analysed_sentence").exists()
