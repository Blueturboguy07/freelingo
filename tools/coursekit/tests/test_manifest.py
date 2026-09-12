"""The signed manifest: what install.ts requires, and what the surfaces render.

The manifest is the one document that crosses from this build into the app, and the
ed25519 signature is over its exact bytes. So the tests here are about agreement with a
file in another language (`packages/core/src/packs/install.ts`) and about the facts the
plan's §Data model says a manifest carries — provenance percentages, the validator
report, the per-corpus licence rows resolved from the OPUS legacy pages, the share-alike
declaration, and `ledgerUnit` exactly once.
"""

from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path
from typing import Any

from coursekit.config import AUDIO_BUDGET_MB
from coursekit.config.g9 import MANIFEST_REQUIRED_FIELDS, PACK_DB_FILENAME
from coursekit.packbuild.manifest import (
    accent_claim_for,
    build_manifest,
    ledger_unit_declarations,
    licence_rows,
    licence_url_for,
    manifest_bytes,
    manifest_violations,
    share_alike_declaration,
)
from coursekit.packbuild.sqlite import (
    build_rows,
    fixture_inputs,
    repo_root,
    write_pack,
)

INSTALL_TS = repo_root() / "packages/core/src/packs/install.ts"


def _built(tmp_path: Path) -> dict[str, Any]:
    inputs = fixture_inputs()
    database = write_pack(tmp_path / PACK_DB_FILENAME, build_rows(inputs))
    audio = repo_root() / "packages/core/src/packs/__fixtures__/es-mini/audio"
    return build_manifest(inputs, database, audio_dir=audio)


# ---------------------------------------------------------------------------
# Agreement with install.ts
# ---------------------------------------------------------------------------


def test_the_required_fields_are_the_ones_install_ts_actually_parses() -> None:
    """Read out of `install.ts`, not remembered.

    `parsePackManifest` refuses a manifest missing any of these, and the refusal is the
    `unverified` pack state — a download the learner is told to retry, forever, because
    retrying cannot add a field. Reading the interface means a rename over there is a red
    test here rather than a pack nobody can install.
    """
    source = INSTALL_TS.read_text(encoding="utf-8")
    interface = re.search(r"export interface PackManifest \{(.+?)\n\}", source, re.S)
    assert interface is not None, "install.ts no longer declares `interface PackManifest`"
    declared = re.findall(r"readonly (\w+)\??:", interface.group(1))
    assert set(declared) == set(MANIFEST_REQUIRED_FIELDS)


def test_a_built_manifest_has_every_required_field(tmp_path: Path) -> None:
    manifest = _built(tmp_path)
    for field in MANIFEST_REQUIRED_FIELDS:
        assert field in manifest
    assert manifest_violations(manifest) == []


def test_the_payload_digest_is_over_the_file_that_shipped(tmp_path: Path) -> None:
    """`payloadSha256` is what the installer compares the staged bytes against."""
    import hashlib

    manifest = _built(tmp_path)
    payload = (tmp_path / PACK_DB_FILENAME).read_bytes()
    assert manifest["payloadSha256"] == hashlib.sha256(payload).hexdigest()
    assert manifest["payloadBytes"] == len(payload)


def test_the_bytes_that_get_signed_are_stable(tmp_path: Path) -> None:
    """Sorted keys, two-space indent, UTF-8 as itself, one trailing newline.

    The app parses the manifest it downloaded and never re-serialises it, because a JSON
    round-trip through a different serialiser is a different byte string and a broken
    signature. This is the side that has to be deterministic.
    """
    manifest = _built(tmp_path)
    once = manifest_bytes(manifest)
    assert once == manifest_bytes(json.loads(once.decode("utf-8")))
    assert once.endswith(b"\n")
    assert "á".encode() in manifest_bytes({"x": "á"})


# ---------------------------------------------------------------------------
# What the surfaces render
# ---------------------------------------------------------------------------


def test_provenance_is_the_shipped_split_not_the_ledgers(tmp_path: Path) -> None:
    """S001 renders `{{n}}% machine-authored`; S137 repeats it.

    Over the sentences that ship. A denominator of G0's quarter-million-row ledger would
    round every authored share to zero, which is the flattering direction.
    """
    manifest = _built(tmp_path)
    provenance = manifest["provenance"]
    assert provenance["sentences"] == 6
    assert provenance["machineAuthoredPct"] == 16.67
    assert round(provenance["corpusPct"] + provenance["machineAuthoredPct"]) == 100


def test_the_cefr_claim_follows_the_q8_ruling(tmp_path: Path) -> None:
    """es has a lexicon to check against, so the card may say CEFR. de and ja may not."""
    assert _built(tmp_path)["cefrClaim"] == "A1 · CEFR-checked"


def test_the_defect_rate_and_sample_size_ride_along(tmp_path: Path) -> None:
    """S001 and S137 show the MEASURED wrong-item rate, not a promise."""
    manifest = _built(tmp_path)
    assert manifest["defectRate"] == 0.0133
    assert manifest["reviewerSampleItems"] == 300


def test_the_validator_report_distinguishes_clean_from_never_ran(tmp_path: Path) -> None:
    """S002 summarises it, and those are the two states it must never confuse."""
    report = _built(tmp_path)["validatorReport"]
    assert report["V10"]["status"] == "ok"
    assert set(report) >= {"V1", "V10", "F1", "F3"}


def test_the_opus_licence_row_points_at_the_legacy_page(tmp_path: Path) -> None:
    """OPUS grants no blanket licence and its API returns no licence field.

    So the per-corpus row comes from `opus.nlpl.eu/legacy/{CORPUS}-{VERSION}.php`, and a
    manifest that recorded "OPUS" would be recording nothing at all.
    """
    assert licence_url_for("nllb", "es") == "https://opus.nlpl.eu/legacy/NLLB-v1.php"
    rows = {row["sourceId"]: row for row in _built(tmp_path)["licences"]}
    assert rows["nllb"]["licenceUrl"] == "https://opus.nlpl.eu/legacy/NLLB-v1.php"
    assert rows["nllb"]["verdict"] == "oracle_only"


def test_an_unresolved_licence_row_fails_the_manifest(tmp_path: Path) -> None:
    manifest = _built(tmp_path)
    manifest["licences"] = [*manifest["licences"], {"sourceId": "mystery", "licence": "UNRESOLVED"}]
    assert any("UNRESOLVED" in line for line in manifest_violations(manifest))


def test_share_alike_is_declared_for_the_derived_ordering(tmp_path: Path) -> None:
    """hermitdave is CC BY-SA-4.0 and the ordering derived from it ships in the pack.

    The obligation is inherited either way; what is not acceptable is inheriting it
    silently, so the manifest states it in words a human can act on.
    """
    declared = {row["sourceId"] for row in share_alike_declaration(fixture_inputs())}
    assert "hermitdave" in declared
    rows = {row["sourceId"]: row for row in licence_rows(fixture_inputs())}
    assert rows["hermitdave"]["shareAlike"] is True
    assert rows["tatoeba"]["shareAlike"] is False


# ---------------------------------------------------------------------------
# The gates
# ---------------------------------------------------------------------------


def test_ledger_unit_is_declared_exactly_once(tmp_path: Path) -> None:
    """INV-PACK-40 / EC-PACK-37: one declaration, read by every token consumer.

    Two is the failure it guards — one consumer reads the top-level value, another reads
    a per-unit copy somebody added for convenience, and the same number quietly means two
    things (a `ja` lesson teaching three content words inside a budget written for
    lemmas).
    """
    manifest = _built(tmp_path)
    assert manifest["ledgerUnit"] == "lemma"
    assert ledger_unit_declarations(manifest) == 1

    doubled = {**manifest, "provenance": {**manifest["provenance"], "ledgerUnit": "morpheme"}}
    assert any("exactly once" in line for line in manifest_violations(doubled))

    missing = {key: value for key, value in manifest.items() if key != "ledgerUnit"}
    assert any("declared 0 times" in line for line in manifest_violations(missing))


def test_the_audio_budget_covers_all_three_pipelines(tmp_path: Path) -> None:
    """INV-PACK-15, and R14's correction: the inherited model counted lessons only."""
    manifest = _built(tmp_path)
    assert manifest["audio"]["budgetMb"] == AUDIO_BUDGET_MB
    assert set(manifest["audio"]["bytesByPipeline"]) == {"lesson", "story", "radio"}

    over = {**manifest, "audioBytes": (AUDIO_BUDGET_MB + 1) * 1024 * 1024}
    assert any("INV-PACK-15" in line for line in manifest_violations(over))

    partial = {**manifest, "audio": {**manifest["audio"], "bytesByPipeline": {"lesson": 1}}}
    assert any("story, radio" in line for line in manifest_violations(partial))


def test_the_audio_block_declares_an_accent_claim_and_no_locale(tmp_path: Path) -> None:
    """Founder ruling B6, carried into the artefact a device actually reads.

    The bank is baked on Kokoro, which publishes no locale sub-tag for its Spanish
    voices, so `es-ES` was a claim nothing in the toolchain could falsify. What the pack
    says instead is its language plus how much is known about the accent — and the gate
    refuses the two ways that can go wrong: a claim nobody has evidence for, and no
    claim at all.

    It rides inside the existing `audio` block rather than as a new top-level field
    because `install.ts::parsePackManifest` reads a fixed list of top-level fields and
    tolerates every other key, so no schema bump and no pack-state change is involved.
    """
    manifest = _built(tmp_path)
    assert manifest["audio"]["accentClaim"] == "unverified"
    assert "locale" not in manifest
    assert manifest_violations(manifest) == []

    for bad in ("peninsular", "", None):
        broken = {**manifest, "audio": {**manifest["audio"], "accentClaim": bad}}
        assert any("accentClaim" in line for line in manifest_violations(broken)), bad
    missing = {**manifest, "audio": {
        key: value for key, value in manifest["audio"].items() if key != "accentClaim"
    }}
    assert any("accentClaim" in line for line in manifest_violations(missing))

    # The claim is read from the cast, which is where the decision lives, and a pack
    # with no cast to read gets the WEAKEST claim rather than a stronger one.
    assert accent_claim_for("es") == "unverified"
    assert accent_claim_for("xx") == "unverified"


def test_INV_PACK_02_item_ids_are_content_hashes_of_the_semantic_fields(
    tmp_path: Path,
) -> None:
    """[INV-PACK-02] additive-only within a major version, because ids are content.

    "Item ids are content-hashed and additive-only within a major version." The quarantine
    half is `packages/core`'s; the PACK half is this: an id is a hash of the item's
    semantic fields, so a rebuild that changes nothing produces the same id set, and a
    rebuild that adds an exercise ADDS an id and moves none of the others. A positional
    id would remap a learner's FSRS history onto a different sentence on any rebuild that
    reordered the file — which is the same failure INV-PACK-41 describes for a
    presentation-only edit, one layer up.
    """
    first = _built(tmp_path)
    second = _built(tmp_path / "again")
    assert first["itemIds"] == second["itemIds"]
    assert first["itemIds"] and all(
        re.fullmatch(r"i_[0-9a-f]{16}", item) for item in first["itemIds"]
    )
    assert len(set(first["itemIds"])) == len(first["itemIds"])

    # Additive: one more exercise, one more id, and every existing id untouched.
    inputs = fixture_inputs()
    extra = dict(inputs.exercises[0])
    extra["exercise_id"] = "f" * 16
    extra["prompt"] = "Translate this sentence\nThe bread is cold."
    extra["accepted_answers"] = ["El pan está frío."]
    grown = replace(inputs, exercises=(*inputs.exercises, extra))
    database = write_pack(tmp_path / "grown" / PACK_DB_FILENAME, build_rows(grown))
    audio = repo_root() / "packages/core/src/packs/__fixtures__/es-mini/audio"
    after = build_manifest(grown, database, audio_dir=audio)
    assert set(first["itemIds"]) < set(after["itemIds"])
    assert len(after["itemIds"]) == len(first["itemIds"]) + 1


def test_the_codec_and_bitrate_are_declared(tmp_path: Path) -> None:
    """R13: the inherited 35-40 MB figure was ~14 kbps, which no codec delivers."""
    audio = _built(tmp_path)["audio"]
    assert audio["codec"] == "opus"
    assert audio["bitrateKbps"] == 20


def test_item_ids_must_be_content_hashes(tmp_path: Path) -> None:
    """A positional id would remap a learner's FSRS history onto another sentence."""
    manifest = _built(tmp_path)
    assert manifest["itemIds"] and all(
        re.fullmatch(r"i_[0-9a-f]{16}", item) for item in manifest["itemIds"]
    )
    assert any(
        "not content hashes" in line
        for line in manifest_violations({**manifest, "itemIds": ["413"]})
    )
    duplicated = {**manifest, "itemIds": [manifest["itemIds"][0], manifest["itemIds"][0]]}
    assert any("duplicate" in line for line in manifest_violations(duplicated))


def test_a_manifest_missing_an_install_field_reports_only_that(tmp_path: Path) -> None:
    """The first failure a reader needs is the one that stops the install."""
    manifest = {key: value for key, value in _built(tmp_path).items() if key != "payloadSha256"}
    violations = manifest_violations(manifest)
    assert violations == ["manifest has no payloadSha256; install.ts requires it by that name"]


def test_the_cefr_claim_carries_its_boolean_so_the_app_has_one_to_branch_on(
    tmp_path: Path,
) -> None:
    """The sentence and the boolean are two renderings of one fact (plan §Rulings, Q8).

    `CourseManifest.cefrChecked` in `packages/core` is a boolean, and the path lane builds
    the learner-facing section-card chip from it. Until this field existed that boolean
    had no source in the pack at all: the pack carried `cefrClaim` as prose, the path lane
    carried the boolean, and the same claim had two independent owners that had already
    drifted apart on their separator. Both halves are now derived from one predicate.
    """
    from coursekit.config.g9 import CEFR_CLAIM_CHECKED, CEFR_CLAIM_FREQUENCY
    from coursekit.packbuild.sqlite import cefr_checked, meta_rows

    manifest = _built(tmp_path)
    assert manifest["cefrChecked"] is True
    assert manifest["cefrClaim"] == CEFR_CLAIM_CHECKED
    assert manifest_violations(manifest) == []

    # The pack's own `meta` carries the same pair, because a pack opened after install is
    # opened on its own and S001/S137 render this without the manifest beside them.
    meta = {row["key"]: row["value"] for row in meta_rows(fixture_inputs())}
    assert meta["cefr_checked"] == "1"
    assert meta["cefr_claim"] == manifest["cefrClaim"]

    # And the false branch is real, not theoretical: de and ja have no CEFR resource.
    assert cefr_checked("es") is True
    assert cefr_checked("ja") is False
    assert CEFR_CLAIM_FREQUENCY.endswith("frequency-ordered")
