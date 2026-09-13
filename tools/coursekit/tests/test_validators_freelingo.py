"""F1, F3, F4 and F5, each against a defect a careless gate would pass.

The failure these tests exist to prevent is not a wrong validator; it is four registered
validators that return `[]`. `pack-ci.yml`'s `pipeline-ready` job refuses to build a pack
while any id in `config.VALIDATOR_IDS` is unregistered, so the cheapest way to turn the
workflow green is to write four functions that check nothing — and the workflow cannot
tell that apart from a pipeline that works.

So every test below plants something specific: a corpus read under a `forbidden` verdict,
a sentence whose source has no recorded permit, oracle-only text in the shipped ledger, an
attributed sentence with no credits row, a manifest signed by the wrong key, a manifest
signed and then edited. Each asserts the validator BLOCKS, and each has a partner asserting
the clean case does not — a gate that fails on everything is as useless as one that fails
on nothing, and only the pair distinguishes them.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from nacl.signing import SigningKey

from coursekit.artifacts import stage_dir, write_records
from coursekit.config import PACK_STAGE_ID, VALIDATOR_IDS
from coursekit.config.g0 import INGEST_CORPORA_BY_LANGUAGE, UNRESOLVED_LICENCE
from coursekit.config.g9 import MANIFEST_FILENAME
from coursekit.runlog import LicenceRow, RunLog
from coursekit.signing import sign_manifest, trusted_public_key_spki
from coursekit.validators import VALIDATORS, ValidatorContext
from coursekit.validators.freelingo import (
    attribution_reachable,
    characters_cover_every_taught_glyph,
    ingest_licence_allow_list,
    manifest_signature_verifies,
)

TOOL = "coursekit-test"


def _entry(lang: str = "es"):  # noqa: ANN202 — StageEntry, built by the runlog's contract
    log = RunLog(lang)
    with log.stage("F1", tool=TOOL, tool_version="0") as entry:
        pass
    return entry


def _ctx(lang: str = "es") -> ValidatorContext:
    return ValidatorContext(lang=lang, entry=_entry(lang))


def _write_g0_runlog(
    lang: str = "es",
    *,
    status: str = "ok",
    rows: list[LicenceRow] | None = None,
) -> None:
    """A g0 entry with the licence rows a real ingest would have recorded."""
    if rows is None:
        rows = [
            LicenceRow(
                source_id=corpus,
                licence="CC-BY-2.0-FR" if corpus == "tatoeba" else "ODC-By-1.0",
                verdict="shippable" if corpus == "tatoeba" else "oracle_only",
                attribution_required=True,
                attribution_owner="Tatoeba contributors",
            )
            for corpus in INGEST_CORPORA_BY_LANGUAGE[lang]
        ]
    log = RunLog(lang)
    with log.stage("g0", tool=TOOL, tool_version="0") as entry:
        for row in rows:
            entry.record_licence(row)
        entry.record_output("ingested_sentence")
        entry.status = status
    if status != "ok":
        # `stage()` writes `ok` unless the body raised; the entry is re-appended with the
        # status this test needs, which is what a crashed ingest leaves behind.
        entry.status = status
        log.append(entry)


def _sentence(**overrides: Any) -> dict[str, Any]:
    row = {
        "schema_version": 1,
        "sentence_id": "a" * 16,
        "lang": "es",
        "l1": "en",
        "text": "El gato duerme en la silla.",
        "translation": "The cat sleeps on the chair.",
        "source_id": "tatoeba",
        "corpus": "tatoeba",
        "corpus_version": "2026-09-05",
        "licence": "CC-BY-2.0-FR",
        "licence_verdict": "shippable",
        "attribution_required": True,
        "attribution_owner": "Tatoeba contributors",
        "token_count": 6,
        "dedup_hash": "b" * 32,
    }
    row.update(overrides)
    return row


# ---------------------------------------------------------------------------
# All five exist — the thing that was actually broken
# ---------------------------------------------------------------------------


def test_every_validator_in_the_ledger_is_registered() -> None:
    """[INV-PACK-13] `pipeline-ready` skips build-es while one id is unregistered.

    This was the state the merged P2 tree arrived in: V1-V12 and F2 registered, F1, F3,
    F4 and F5 not, so `pipeline-ready` reported `ready=false` and `build-es` and
    `validate-es` never ran. Both jobs were green, because a skipped job is green.
    """
    assert VALIDATORS.missing(VALIDATOR_IDS) == ()


# ---------------------------------------------------------------------------
# F1 — INV-PACK-13
# ---------------------------------------------------------------------------


def test_INV_PACK_13_f1_passes_a_run_whose_corpora_were_all_permitted() -> None:
    """[INV-PACK-13] the clean case, so the refusals below mean something.

    Without this, a validator that returned a finding unconditionally would satisfy every
    other test in this section.
    """
    _write_g0_runlog()
    write_records("ingested_sentence", [_sentence()], lang="es")
    write_records("selected_item", [_selected("a" * 16)], lang="es")
    assert ingest_licence_allow_list(_ctx()) == []


def test_INV_PACK_13_f1_blocks_a_corpus_read_under_a_forbidden_verdict() -> None:
    """[INV-PACK-13] a `forbidden` licence row means the gate was walked around.

    `resolve()` refuses a forbidden source before a request is made, so this row cannot
    exist in an honest run — which is exactly why its presence is blocking rather than
    filtered: the text is already on disk by the time anything downstream could drop it.
    """
    _write_g0_runlog(
        rows=[
            LicenceRow(
                source_id="tatoeba",
                licence="CC-BY-2.0-FR",
                verdict="shippable",
                attribution_required=True,
                attribution_owner="Tatoeba contributors",
            ),
            LicenceRow(
                source_id="nllb",
                licence="CC-BY-NC-ND-4.0",
                verdict="forbidden",
                attribution_required=True,
                attribution_owner="TED",
            ),
        ]
    )
    write_records("ingested_sentence", [_sentence()], lang="es")
    write_records("selected_item", [_selected("a" * 16)], lang="es")
    findings = ingest_licence_allow_list(_ctx())
    assert [f.severity for f in findings] == ["blocking"]
    assert "forbidden" in findings[0].message


def test_INV_PACK_13_f1_blocks_a_source_that_shipped_rows_with_no_recorded_permit() -> None:
    """[INV-PACK-13] sentences from a corpus the runlog never licensed.

    The shape of a gate bypass that leaves the licence table looking perfect: every
    configured corpus is on record, and the ledger also holds rows from a third one.
    """
    _write_g0_runlog()
    write_records(
        "ingested_sentence",
        [_sentence(), _sentence(sentence_id="c" * 16, source_id="ted2020", corpus="ted2020")],
        lang="es",
    )
    write_records("selected_item", [_selected("a" * 16)], lang="es")
    findings = ingest_licence_allow_list(_ctx())
    assert any("ted2020" in f.message and f.severity == "blocking" for f in findings)


ORACLE_ROW = {
    "sentence_id": "d" * 16,
    "source_id": "nllb",
    "corpus": "nllb",
    "licence": "ODC-By-1.0",
    "licence_verdict": "oracle_only",
}


def _selected(sentence_id: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "lang": "es",
        "unit_index": 1,
        "lesson_index": 1,
        "slot_index": 0,
        "sentence_id": sentence_id,
        "provenance": "corpus",
        "gap": False,
        "new_lemmas": ["gato"],
        "known_lemmas": ["el"],
        "grammar_concept": "concept-1",
        "accepted_alternates": [],
    }


def test_INV_PACK_13_f1_does_not_fire_on_oracle_only_text_in_the_INGEST_ledger() -> None:
    """[INV-PACK-13] NLLB in `ingested_sentence` is the designed path, not a violation.

    Written first because the first version of this validator got it backwards and fired
    on the first real `es` build: 1,000 NLLB rows, every one legitimate. `oracle_only` is
    NOT refused at ingest — the plan ingests NLLB, capped, to inform frequency, KenLM and
    the alignment priors — and `inputs.forbid_unshippable` is what stops it at G4. A gate
    that refuses the designed path gets muted, which is worse than one that never ran.
    """
    _write_g0_runlog()
    write_records("ingested_sentence", [_sentence(), _sentence(**ORACLE_ROW)], lang="es")
    write_records("selected_item", [_selected("a" * 16)], lang="es")
    assert ingest_licence_allow_list(_ctx()) == []


def test_INV_PACK_13_f1_blocks_oracle_only_text_in_the_SELECTED_set() -> None:
    """[INV-PACK-13] the same row, selected for a lesson slot, is the violation.

    Identical ingest, one extra `selected_item` pointing at the NLLB sentence. That is
    the line the ODC-By crawl-text question draws (plan risk 2), and a validator that
    only looked at licences would report this run clean.
    """
    _write_g0_runlog()
    write_records("ingested_sentence", [_sentence(), _sentence(**ORACLE_ROW)], lang="es")
    write_records("selected_item", [_selected("a" * 16), _selected("d" * 16)], lang="es")
    findings = ingest_licence_allow_list(_ctx())
    assert any("oracle_only" in f.message for f in findings)
    assert all(f.severity == "blocking" for f in findings)


def test_INV_PACK_13_f1_warns_rather_than_passes_when_there_is_no_selection_to_check() -> None:
    """[INV-PACK-13] "I could not check" is the honest third thing, and it is recorded."""
    _write_g0_runlog()
    write_records("ingested_sentence", [_sentence()], lang="es")
    findings = ingest_licence_allow_list(_ctx())
    assert [f.severity for f in findings] == ["warning"]
    assert "did not run" in findings[0].message


def test_INV_PACK_13_f1_blocks_a_run_with_no_g0_entry_at_all() -> None:
    """[INV-PACK-13] no record is not a clean record.

    The most likely way this validator would have passed vacuously: run it on a language
    nobody has built, get an empty runlog, get no findings.
    """
    findings = ingest_licence_allow_list(_ctx())
    assert len(findings) == 1
    assert "no g0 entry" in findings[0].message


def test_INV_PACK_13_f1_blocks_an_attributed_sentence_with_no_owner() -> None:
    """[INV-PACK-13] INV-PACK-17's input, checked at the ingest record."""
    _write_g0_runlog()
    write_records(
        "ingested_sentence",
        [_sentence(attribution_required=True, attribution_owner=None)],
        lang="es",
    )
    write_records("selected_item", [_selected("a" * 16)], lang="es")
    findings = ingest_licence_allow_list(_ctx())
    assert any("name" in f.message and "owner" in f.message for f in findings)


# ---------------------------------------------------------------------------
# F3 — INV-PACK-17
# ---------------------------------------------------------------------------


def test_INV_PACK_17_f3_blocks_a_pack_with_nothing_in_it() -> None:
    """[INV-PACK-17] "no violations over an empty ledger" is the vacuous pass.

    Written first because it is the one a reviewer cannot see in a green run: the credits
    check over zero sentences returns zero violations, every time.
    """
    findings = attribution_reachable(_ctx())
    assert len(findings) == 1
    assert findings[0].severity == "blocking"
    assert "no ingested_sentence records" in findings[0].message


def test_INV_PACK_17_f3_blocks_a_shipped_sentence_with_an_unresolved_licence(
    make_es_build,
) -> None:
    """[INV-PACK-17] an UNRESOLVED licence has no owner and cannot be credited.

    Not "a sentence whose credits row is missing", which `credit_rows` makes structurally
    impossible — it builds the credits FROM the sentences, so a sentence source always has
    a row. The reachable failures are the ones where there is nothing to build a row out
    of, and this is the first: the per-corpus licence came from the OPUS legacy page and
    never resolved, so the pack ships text with no licence and the credits surface has
    nothing to name.
    """
    make_es_build(licence=UNRESOLVED_LICENCE)
    findings = attribution_reachable(_ctx())
    assert findings, "an unresolved licence must block"
    assert all(f.severity == "blocking" for f in findings)
    assert any("UNRESOLVED" in f.message for f in findings)


def test_INV_PACK_17_f3_blocks_a_voice_clip_whose_engine_nothing_credits(
    make_es_build,
) -> None:
    """[INV-PACK-17] a bank is an attributed asset too, and it is the one that gets missed.

    Sentences carry their own owner and `credit_rows` builds a row from it, so a sentence
    almost cannot be uncredited. A CLIP carries a licence and no owner: the owner comes
    from the run's licence table under `voice:<engine>`, and a run that baked audio on an
    engine nobody declared ships a voice bank nobody is credited for. The credits screen
    looks complete because every sentence on it is.

    `azure` rather than `kokoro`: Kokoro is in `SOURCES` and declares
    `attribution_required=False`, so a Kokoro bank is legitimately uncredited and planting
    one here would test nothing. An undeclared engine is the case `licence_for_source`
    answers "attribution required, no owner" — the safe default for a licence question
    being "stop", never "assume CC0".
    """
    make_es_build()
    write_records(
        "baked_clip",
        [
            {
                "schema_version": 1,
                "lang": "es",
                "clip_id": "f" * 16,
                "text": "El gato duerme.",
                "voice_id": "es-ES-ElviraNeural",
                "engine": "azure",
                "codec": "opus",
                "bitrate_kbps": 20,
                "duration_ms": 1500,
                "bytes": 4000,
                "path": "bank/ffffffffffffffff.opus",
                "licence": "CC-BY-4.0",
                "pipeline": "lesson",
            }
        ],
        lang="es",
    )
    findings = attribution_reachable(_ctx())
    assert any("voice clip" in f.message for f in findings), [f.message for f in findings]
    assert all(f.severity == "blocking" for f in findings)


def test_INV_PACK_17_f3_warns_when_nothing_requires_attribution_at_all(
    make_es_build,
) -> None:
    """[INV-PACK-17] an all-CC0 pack satisfies the credits check trivially.

    Reported as a warning rather than passed silently: the real Tatoeba CC0 subset for
    Spanish is 2,266 bytes, so a `es` pack with no attributed source has almost certainly
    lost the flag rather than earned the exemption.
    """
    make_es_build(licence="CC0-1.0", attribution_owner=None)
    findings = attribution_reachable(_ctx())
    assert [f.severity for f in findings] == ["warning"]
    assert "trivially satisfied" in findings[0].message


# ---------------------------------------------------------------------------
# F4 — INV-PACK-18
# ---------------------------------------------------------------------------


def _write_manifest(manifest: dict[str, Any], lang: str = "es") -> Path:
    target = stage_dir(lang, PACK_STAGE_ID) / MANIFEST_FILENAME
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return target


BARE_MANIFEST = {"packId": "freelingo-es", "version": "0.1.0", "ledgerUnit": "lemma"}


def test_INV_PACK_18_f4_blocks_when_there_is_no_manifest_to_check() -> None:
    """[INV-PACK-18] a signature check with nothing to check is not a pass."""
    findings = manifest_signature_verifies(_ctx())
    assert len(findings) == 1
    assert findings[0].severity == "blocking"


def test_INV_PACK_18_f4_warns_rather_than_blocks_on_an_unsigned_manifest() -> None:
    """[INV-PACK-18] an unsigned pack is `unverified`, never `corrupt`.

    GitHub does not expose `PACK_SIGNING_KEY` to a pull request from a fork, so an
    unsigned build is an expected CI state and a blocking finding would turn every fork's
    CI red for something that is not a defect. The device is where it is refused.
    """
    _write_manifest(dict(BARE_MANIFEST))
    ctx = _ctx()
    findings = manifest_signature_verifies(ctx)
    assert [f.severity for f in findings] == ["warning"]
    assert ctx.entry.notes["signature_state"] == "unverified"


def test_INV_PACK_18_f4_passes_a_manifest_signed_by_the_committed_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[INV-PACK-18] the success path, and it must reach `verified` in the runlog.

    A test that only asserted "no findings" would also pass against a validator that
    returned `[]` before opening the file, so the recorded state is asserted too.
    """
    key = SigningKey.generate()
    _trust(monkeypatch, key)
    _write_manifest(sign_manifest(dict(BARE_MANIFEST), key=key))
    ctx = _ctx()
    assert manifest_signature_verifies(ctx) == []
    assert ctx.entry.notes["signature_state"] == "verified"


def _spki(key: SigningKey) -> bytes:
    from coursekit.signing import public_key_spki

    return public_key_spki(key)


def _trust(monkeypatch: pytest.MonkeyPatch, key: SigningKey) -> None:
    """Make `key` the committed key, for the function that actually reads it.

    Patched on `manifest_signature_verifies.__globals__`, not by dotted module path, for
    the reason `Registry.restore_for_tests` documents: a restore evicts its modules from
    `sys.modules`, so after `tests/test_cli.py` has run,
    `coursekit.validators.freelingo` is a fresh module object while this file's imported
    function still reads the old one's globals. Written by dotted path first; it passed
    when this file ran alone and failed in the full suite, which is the same afternoon
    `tests/test_g2_band.py` lost.
    """
    monkeypatch.setitem(
        manifest_signature_verifies.__globals__,
        "trusted_public_key_spki",
        lambda *_args, **_kwargs: _spki(key),
    )


def test_INV_PACK_18_f4_blocks_a_manifest_signed_by_a_key_that_is_not_the_shipped_one() -> None:
    """[INV-PACK-18] a valid signature by the wrong key is the attacker's signature.

    The manifest carries its own public key and verifies against it perfectly. What it
    does not do is match the key inside the app, which is the only thing that separates a
    pack the project built from one somebody re-signed.
    """
    stranger = SigningKey.generate()
    _write_manifest(sign_manifest(dict(BARE_MANIFEST), key=stranger))
    assert trusted_public_key_spki() != _spki(stranger)
    findings = manifest_signature_verifies(_ctx())
    assert [f.severity for f in findings] == ["blocking"]


def test_INV_PACK_18_f4_blocks_a_manifest_edited_after_it_was_signed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[INV-PACK-18] the bytes the signature covers are the bytes that shipped."""
    key = SigningKey.generate()
    _trust(monkeypatch, key)
    signed = sign_manifest(dict(BARE_MANIFEST), key=key)
    signed["version"] = "9.9.9"
    _write_manifest(signed)
    findings = manifest_signature_verifies(_ctx())
    assert [f.severity for f in findings] == ["blocking"]


# ---------------------------------------------------------------------------
# F5 — INV-PACK-16
# ---------------------------------------------------------------------------


def test_f5_reports_not_applicable_for_a_language_with_no_character_syllabus() -> None:
    """`es` has no kana and no kanji, and the report must say so rather than say nothing.

    Deliberately not claiming INV-PACK-16: the id is P7's, and a P2 test that claimed it
    would hand the coverage map an owning test for an invariant nothing checks.
    """
    ctx = _ctx("es")
    findings = characters_cover_every_taught_glyph(ctx)
    assert [f.severity for f in findings] == ["info"]
    assert ctx.entry.notes["applicable"] is False


def test_f5_blocks_a_japanese_pack_while_the_characters_stage_does_not_exist() -> None:
    """A ja pack today would teach kanji with no syllabus behind them.

    The branch P7 replaces. It is asserted rather than left as a comment so that deleting
    the refusal without writing the cover check turns this test red — which is the only
    thing standing between "F5 passes" and "F5 was never written".
    """
    ctx = _ctx("ja")
    findings = characters_cover_every_taught_glyph(ctx)
    assert [f.severity for f in findings] == ["blocking"]
    assert "P7" in findings[0].message or "characters" in findings[0].message
