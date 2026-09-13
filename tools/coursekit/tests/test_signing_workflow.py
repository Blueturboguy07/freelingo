"""The CI publication boundary: inspect the executable steps, not comment prose."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[3]
WORKFLOW = yaml.safe_load((REPO / ".github/workflows/pack-ci.yml").read_text())


def steps(job):
    return WORKFLOW["jobs"][job]["steps"]


def index_of(job, command):
    return next(i for i, step in enumerate(steps(job)) if command in step.get("run", ""))


def test_inv_pack_18_candidate_build_survives_validation_and_signing_failures():
    build = steps("build-es")
    assert not any("coursekit sign" in step.get("run", "") for step in build)
    upload = next(
        step for step in build if step.get("with", {}).get("name", "").startswith("es-build-")
    )
    assert upload["with"]["path"] == "build/es"
    assert upload["with"]["if-no-files-found"] == "error"
    assert build.index(upload) > index_of("build-es", "coursekit sample es")
    assert WORKFLOW["jobs"]["validate-es"]["needs"] == ["pipeline-ready", "build-es"]


def test_inv_pack_18_final_manifest_is_validated_repacked_signed_then_loaded():
    order = [
        index_of("validate-es", cmd)
        for cmd in [
            "coursekit validate es",
            "derive_review",
            "coursekit pack es",
            "coursekit sign es",
            "pnpm vitest run --project core src/packs/real-pack.test.ts",
        ]
    ]
    assert order == sorted(order) and len(set(order)) == len(order)
    gate = steps("validate-es")[order[1]]["run"]
    assert "gate_passed" in gate
    upload = next(
        step
        for step in steps("validate-es")
        if step.get("with", {}).get("name", "").startswith("es-pack-")
    )
    assert "PACK_SIGNING_AVAILABLE" in upload["if"]
    assert upload["with"]["if-no-files-found"] == "error"
    assert steps("validate-es").index(upload) > order[-1]


@pytest.mark.parametrize("with_audio", [True, False])
def test_inv_pack_18_final_archive_contains_playable_audio_or_collection_fails(
    tmp_path, with_audio
):
    # Execute the workflow's collection code against an independently constructed tree.
    root = tmp_path / "build/es"
    for name in [
        "g9/pack.sqlite",
        "g9/manifest.json",
        "validator-report.json",
        "sample-300.jsonl",
        "sample-summary.json",
        "runlog.jsonl",
        "ci-source.json",
    ]:
        file = root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text("{}\n")
    scores = tmp_path / "content/es/review/scores.jsonl"
    scores.parent.mkdir(parents=True)
    scores.write_text("{}\n")
    if with_audio:
        audio = root / "g9/audio/throwaway.opus"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(b"test-opus-bytes")
    step = next(
        step for step in steps("validate-es") if step.get("name") == "Collect the pack artefacts"
    )
    result = subprocess.run(
        ["bash", "-c", step["run"]],
        cwd=tmp_path,
        env={**os.environ, "GITHUB_WORKSPACE": str(tmp_path)},
        capture_output=True,
        text=True,
    )
    assert (result.returncode == 0) is with_audio, result.stdout + result.stderr
    if with_audio:
        assert (tmp_path / "es-pack/audio/throwaway.opus").read_bytes() == b"test-opus-bytes"
