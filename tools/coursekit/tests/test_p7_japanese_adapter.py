"""P7's real pinned analyzer emits a paired, still-unreviewed Japanese record."""

from copy import deepcopy

import pytest

from coursekit.artifacts import sentence_id
from coursekit.inputs import MissingInput


def api():
    from coursekit.adapters import sudachi_ja

    return sudachi_ja


def pair(text):
    return (
        api().SudachiJaAdapter().analyse_with_script(sentence_id=sentence_id("ja", text), text=text)
    )


def test_INV_PACK_40_mode_A_counts_each_compound_item_and_C_keeps_display_together():
    from coursekit.ledger import count_units

    result = pair("国家公務員です。")
    assert [t["surface"] for t in result.analysed["tokens"]] == ["国家", "公務", "員", "です", "。"]
    assert result.analysed["display_tokens"] == ["国家公務員", "です"]
    assert count_units(result.analysed) == 4
    assert result.script["reading_review_status"] == "unreviewed"


def test_INV_PACK_51_inflected_surface_keeps_the_dictionary_linked_lemma_reading():
    result = pair("朝ご飯を食べます。")
    index, token = next(
        (i, t) for i, t in enumerate(result.analysed["tokens"]) if t["surface"] == "食べ"
    )
    assert token["lemma"] == "食べる"
    assert token["normalized_form"] == "食べる"
    assert token["reading"] == "タベル"
    assert result.script["mode_a_surface_readings"][index]["reading"] == "タベ"
    assert token["pos"] == "VERB"
    assert "連用形" in token["morph"]


def test_INV_PACK_47_paired_script_offsets_reproduce_the_exact_whitespace_source():
    from coursekit.japanese_script import validate_script_analysis

    text = "  国家公務員です。  "
    result = pair(text)
    proof = validate_script_analysis(result.script, result.analysed, text=text)
    assert result.analysed["tokens"][0]["start"] == 2
    assert proof.mode_a_to_mode_c == (0, 0, 0, 1, 2)
    assert all(text[t["start"] : t["end"]] == t["surface"] for t in result.analysed["tokens"])


def test_INV_PACK_52_tts_candidate_is_kana_and_never_the_display_text():
    result = pair("国家公務員です。")
    assert result.script["tts_reading"] == "コッカコウムインデス。"
    assert result.script["tts_reading"] != result.script["text"]


def test_INV_PACK_51_synthetic_counter_OOV_is_rejected_by_name_without_guessing_reading():
    with pytest.raises(MissingInput, match="OOV"):
        pair("三本あります。")


@pytest.mark.parametrize("text", ["", "   ", "。"])
def test_INV_PACK_40_empty_nonlexical_source_cannot_become_an_analysis(text):
    with pytest.raises(MissingInput):
        pair(text)


@pytest.mark.parametrize("package", ["sudachipy", "sudachidict-core", "spacy"])
def test_INV_PACK_06_each_real_analyzer_dependency_is_checked_before_a_row(package, monkeypatch):
    module = api()
    installed = module._installed_versions()
    installed[package] = "future"
    monkeypatch.setattr(module, "_installed_versions", lambda: installed)
    with pytest.raises(MissingInput, match=package):
        module.SudachiJaAdapter().fingerprint()


def test_INV_PACK_06_fingerprint_names_dictionary_and_POS_mapping_version():
    fingerprint = api().SudachiJaAdapter().fingerprint()
    assert fingerprint == {
        "name": "sudachipy",
        "version": "0.6.11",
        "model": "sudachidict_core-20260723+spacy-pos-3.8.16",
        "split_mode": "A",
    }


def test_INV_PACK_06_unknown_POS_mapping_rejects_instead_of_inventing_NOUN():
    with pytest.raises(MissingInput, match="POS"):
        api()._ud_pos([("unexpected", "*", "*", "*", "*", "*")], ["未知"])


def test_INV_PACK_06_unmeasured_selftest_is_a_named_hard_gate(monkeypatch):
    module = api()
    monkeypatch.setattr(module, "JAPANESE_SELFTEST", ())
    with pytest.raises(MissingInput, match="self-test"):
        module.SudachiJaAdapter().require_self_test()


def test_INV_PACK_06_selftest_binds_complete_pair_not_just_lemma_spelling(monkeypatch):
    module = api()
    adapter = module.SudachiJaAdapter()
    text = "国家公務員です。"
    result = adapter.analyse_with_script(sentence_id=sentence_id("ja", text), text=text)
    expected = module.pair_digest(result)
    monkeypatch.setattr(module, "JAPANESE_SELFTEST", ((text, expected),))
    monkeypatch.setattr(
        module, "JAPANESE_SELFTEST_DIGEST", module.selftest_corpus_digest(((text, expected),))
    )
    altered = deepcopy(result.analysed)
    altered["tokens"][0]["reading"] = "ベツ"
    monkeypatch.setattr(
        module.SudachiJaAdapter,
        "analyse_with_script",
        lambda *args, **kwargs: module.JapaneseAnalysis(altered, result.script),
    )
    with pytest.raises(module.AdapterSelfTestFailed):
        adapter.require_self_test()


def test_INV_PACK_40_G1_lookup_exposes_only_the_paired_analysis_API():
    from coursekit.stages.g1_analyze import adapter_for

    adapter = adapter_for("ja")
    assert callable(adapter.analyse_with_script)
    assert not hasattr(adapter, "analyse")


def test_INV_PACK_06_real_selftest_corpus_is_measured_nonempty_and_passes():
    module = api()
    assert len(module.JAPANESE_SELFTEST) == 15
    module.SudachiJaAdapter().require_self_test()


def test_INV_PACK_06_selftest_table_changes_cannot_silently_move_ledger_identity(monkeypatch):
    module = api()
    monkeypatch.setattr(module, "JAPANESE_SELFTEST", (("別の文。", "0" * 64),))
    with pytest.raises(module.AdapterSelfTestFailed, match="corpus digest"):
        module.SudachiJaAdapter().require_self_test()
