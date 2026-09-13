"""Kit declarations cannot turn absent source inputs into a passing pack."""

from __future__ import annotations

import hashlib

import pytest
import yaml


def module():
    from coursekit import kits

    return kits


def declaration(lang="fr"):
    required = {
        "curriculum": {"path": "curriculum.yaml", "sha256": None},
        "cast": {"path": "cast.yaml", "sha256": None},
    }
    if lang == "ja":
        required.update(
            {
                name: {"path": f"{name}.json", "sha256": None}
                for name in ("characters", "furigana", "strokes", "romanization", "alignment_gold")
            }
        )
    return {
        "schema_version": 1,
        "language": lang,
        "title": {"fr": "French", "de": "German", "ja": "Japanese"}[lang],
        "beta": lang == "ja",
        "claim": "cefr_checked" if lang == "fr" else "frequency_ordered",
        "inputs": required,
    }


def write(tmp_path, value):
    path = tmp_path / "kit.yaml"
    path.write_text(yaml.safe_dump(value), encoding="utf8")
    return path


@pytest.mark.parametrize("lang", ["fr", "de", "ja"])
def test_INV_PACK_40_kit_reads_single_ledger_declaration(lang, tmp_path):
    from coursekit.ledger import ledger_declaration

    kit = module().load_kit(write(tmp_path, declaration(lang)))
    assert kit.ledger == ledger_declaration(lang)
    assert kit.beta is (lang == "ja")
    assert kit.claim_label == (
        "A1 · CEFR-checked"
        if lang == "fr"
        else "Beginner · frequency-ordered" + (" · beta" if lang == "ja" else "")
    )


@pytest.mark.parametrize("lang", ["de", "ja"])
def test_INV_PACK_55_no_cefr_claim_without_resource(lang, tmp_path):
    row = declaration(lang)
    row["claim"] = "cefr_checked"
    with pytest.raises(module().KitError, match="claim"):
        module().load_kit(write(tmp_path, row))


def test_INV_PACK_16_japanese_kit_cannot_hide_script_inputs_or_beta(tmp_path):
    for change in ("characters", "furigana", "strokes", "romanization", "alignment_gold", "beta"):
        row = declaration("ja")
        if change == "beta":
            row["beta"] = False
        else:
            del row["inputs"][change]
        with pytest.raises(module().KitError):
            module().load_kit(write(tmp_path, row))


def test_INV_PACK_06_absent_or_unpinned_inputs_cannot_report_ready(tmp_path):
    kit = module().load_kit(write(tmp_path, declaration()))
    report = module().inspect_kit_inputs(kit)
    assert not report.ready
    assert set(report.missing) == {"curriculum", "cast"}
    (tmp_path / "curriculum.yaml").write_text("arbitrary")
    (tmp_path / "cast.yaml").write_text("arbitrary")
    report = module().inspect_kit_inputs(kit)
    assert not report.ready
    assert set(report.unpinned) == {"curriculum", "cast"}
    with pytest.raises(module().KitError, match="inputs"):
        module().require_kit_inputs(kit)


def test_INV_PACK_06_exact_input_hash_detects_changed_bytes(tmp_path):
    row = declaration()
    for name, value in row["inputs"].items():
        content = f"original {name}".encode()
        (tmp_path / value["path"]).write_bytes(content)
        value["sha256"] = hashlib.sha256(content).hexdigest()
    kit = module().load_kit(write(tmp_path, row))
    report = module().require_kit_inputs(kit)
    assert report.ready
    assert report.scope == "input_integrity_only"
    (tmp_path / "cast.yaml").write_text("changed")
    assert module().inspect_kit_inputs(kit).stale == ("cast",)
    with pytest.raises(module().KitError, match="cast"):
        module().require_kit_inputs(kit)


@pytest.mark.parametrize("path", ["../outside.yaml", "/tmp/outside.yaml"])
def test_INV_PACK_13_kit_inputs_cannot_escape_declared_directory(path, tmp_path):
    row = declaration()
    row["inputs"]["cast"]["path"] = path
    with pytest.raises(module().KitError, match="path"):
        module().load_kit(write(tmp_path, row))


def test_INV_PACK_13_symlink_escape_is_not_a_local_input(tmp_path):
    outside = tmp_path.parent / (tmp_path.name + "-outside")
    outside.write_text("foreign")
    (tmp_path / "cast.yaml").symlink_to(outside)
    with pytest.raises(module().KitError, match="path"):
        module().load_kit(write(tmp_path, declaration()))


def test_INV_PACK_13_input_symlink_retarget_after_load_is_rechecked(tmp_path):
    row = declaration()
    source = tmp_path / "original.yaml"
    source.write_text("original")
    link = tmp_path / "cast.yaml"
    link.symlink_to(source)
    kit = module().load_kit(write(tmp_path, row))
    outside = tmp_path.parent / (tmp_path.name + "-elsewhere")
    outside.write_text("changed")
    link.unlink()
    link.symlink_to(outside)
    with pytest.raises(module().KitError, match="path"):
        module().inspect_kit_inputs(kit)
