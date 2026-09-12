"""The cast contract and the re-bake key.

`test_inv_aud_08_the_rebake_key_includes_the_engine` is the load-bearing one. It is INV-AUD-08's
second clause and the committed falsifier is `falsifiers/INV-AUD-08.json`: a clip
identical in character, voice, line and bitrate, re-baked by a different synthesiser.
If that reuses the old hash then every file name, every manifest row and every sha256
in the bank still looks current while one character's voice has changed mid-course, and
nothing downstream can see it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml

from coursekit.config.g8 import (
    ACCENT_CLAIMS,
    BAKE_ENGINE_BY_LANGUAGE,
    CAST_ROLES,
    CAST_SAMPLE_TEXT,
    KOKORO_SPANISH_VOICES,
    LOUDNESS_TOLERANCE_LU,
    TARGET_LUFS,
)
from coursekit.inputs import ForbiddenSource, MissingInput, group_is_installed
from coursekit.tts.cast import CastError, cast_path, load_cast, rebake_key

FALSIFIERS = Path(__file__).parent / "falsifiers"
AUD08 = json.loads((FALSIFIERS / "INV-AUD-08.json").read_text(encoding="utf-8"))["input"]


def _raw() -> dict[str, Any]:
    return yaml.safe_load(cast_path("es").read_text(encoding="utf-8"))


def _write(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, raw: dict[str, Any]) -> None:
    """Point the loader at a mutated copy of the real cast."""
    from coursekit.config.g8 import CAST_FILENAME, CONTENT_ROOT_ENV_VAR

    target = tmp_path / "es"
    target.mkdir(parents=True, exist_ok=True)
    (target / CAST_FILENAME).write_text(yaml.safe_dump(raw, allow_unicode=True), encoding="utf-8")
    monkeypatch.setenv(CONTENT_ROOT_ENV_VAR, str(tmp_path))


# ---------------------------------------------------------------------------
# The committed cast
# ---------------------------------------------------------------------------


def test_the_committed_spanish_cast_loads() -> None:
    cast = load_cast("es")
    assert cast.engine == BAKE_ENGINE_BY_LANGUAGE["es"] == "kokoro"
    assert cast.accent_claim == "unverified"
    assert [role.id for role in cast.roles] == list(CAST_ROLES)
    assert cast.target_lufs == TARGET_LUFS
    assert cast.tolerance_lu == LOUDNESS_TOLERANCE_LU


def test_every_role_has_a_sample_line() -> None:
    """S002's `sample-playing` state is "sample sentence + speaker".

    Without a line per role, three of the four cast voices ship in a pack that no
    surface ever plays, and V7's "every audio file has a string" holds for them only
    because nothing baked them.
    """
    cast = load_cast("es")
    assert set(CAST_SAMPLE_TEXT) == {role.id for role in cast.roles}
    assert all(text.strip() for text in CAST_SAMPLE_TEXT.values())


def test_the_cast_records_the_azure_override_as_a_founder_decision() -> None:
    """The plan's "Azure as the voice vendor" line is superseded, and it says so.

    Plan §Approval lists Azure among the things approving the plan accepted, so baking
    on Kokoro is a founder-visible override of an approved line and not an
    implementation detail. The previous round recorded the CONSEQUENCE (D-CAST-ES-01,
    the locale claim) without recording the OVERRIDE, so a reader of this file could not
    tell that a plan line had died. D-CAST-ES-00 is that record; this keeps it.
    """
    raw = _raw()
    decisions = {entry["id"]: entry for entry in raw["decisions"]}
    override = decisions["D-CAST-ES-00"]
    assert "Azure" in override["supersedes"], "the superseded plan line must be quoted"
    assert "Kokoro" in override["decision"]
    # And the engine the file actually declares is the one the decision names.
    assert raw["engine"] == "kokoro"
    assert load_cast("es").engine == "kokoro"


def test_the_cast_records_r15_as_a_decision_not_a_table_cell() -> None:
    """R15: a mixed-accent cast inside one course is a founder-visible choice.

    The Kokoro version of the finding is sharper than the Polly one — Kokoro publishes
    no locale sub-tag for its Spanish voices at all — so the file has to say what it
    does and does not claim. Asserted on the file rather than trusted, because a
    decision block is exactly the kind of thing a later edit deletes.
    """
    raw = _raw()
    decisions = {entry["id"]: entry for entry in raw["decisions"]}
    assert "D-CAST-ES-01" in decisions
    assert decisions["D-CAST-ES-01"]["review"] == "R15"
    assert "locale" in decisions["D-CAST-ES-01"]["decision"]
    assert any(entry.get("invariant") == "INV-AUD-08" for entry in raw["decisions"])


def test_the_committed_cast_declares_a_language_and_an_accent_claim_and_no_locale() -> None:
    """Founder ruling B6, asserted on the committed FILE and not only on the loader.

    The loader refusing `locale:` is half of it; the other half is that the file people
    read and copy for fr/de/ja does not still carry the key. `es-ES` was vendor-backed
    under Azure Neural (a locale sub-tag per voice) and became unfalsifiable under
    Kokoro, which publishes none — so what the file claims now is the language, plus
    how much is known about the accent, which is nothing until the reviewer sample.
    """
    raw = _raw()
    assert "locale" not in raw
    assert raw["language"] == "es"
    assert raw["accent_claim"] == "unverified"
    assert ACCENT_CLAIMS == ("unverified",), (
        "a second accent claim may exist only when the evidence that produces it does "
        "— the 300-item native-reviewer sample (B3)"
    )
    # And the decision block records the supersession rather than quietly dropping it.
    decisions = {entry["id"]: entry for entry in raw["decisions"]}
    assert "B6" in decisions["D-CAST-ES-01"]["decision"]


def test_kokoro_ships_three_spanish_voices_and_the_cast_knows_it() -> None:
    """Four roles over three stock vectors is D-CAST-ES-02's whole reason to exist.

    When the `tts` group is installed this reads the real voice pack, so the day Kokoro
    ships a fourth Spanish voice the decision is re-opened by a red test rather than by
    somebody happening to look.
    """
    cast = load_cast("es")
    used = {voice for role in cast.roles for voice, _ in role.weights}
    assert used == set(KOKORO_SPANISH_VOICES)
    assert sum(1 for role in cast.roles if role.stock) == 2, "two stock, two blends"

    if not group_is_installed("tts"):
        pytest.skip("the tts group is not installed; the config-level claim is asserted above")
    from coursekit.tts.kokoro import build, spanish_voices

    engine = build("es")
    if not engine.model_path.exists() or not engine.voices_path.exists():
        pytest.skip("kokoro weights are not on this machine")
    real = tuple(v for v in engine.voices() if v.startswith(("ef_", "em_")))
    assert real == spanish_voices(), (
        f"the voice pack now carries {real}; D-CAST-ES-02 assumed {spanish_voices()}"
    )


def test_the_committed_falsifier_for_this_invariant_names_itself() -> None:
    """The identity clause the repo's own falsifier gate applies to the TypeScript
    corpus, applied here by hand.

    `packages/core/src/journey/falsifier-corpus.ts` walks `packages/` only
    (`CORPUS_ROOTS`) and looks for a directory called `__falsifiers__`, so it cannot see
    this lane's corpus at all. Until that gate learns about `tools/`, this is what stops
    a fixture filed under the wrong id from reading as coverage.
    """
    raw = json.loads((FALSIFIERS / "INV-AUD-08.json").read_text(encoding="utf-8"))
    assert raw["invariant"] == "INV-AUD-08"
    assert raw["source"] == "EC-PACK-52"
    assert raw["why"].strip()
    assert raw["mustNotBe"].strip()
    assert set(AUD08) == {"sameVoiceDifferentEngine", "samePinDifferentRelease", "driftedClip"}


# ---------------------------------------------------------------------------
# INV-AUD-08: the re-bake key
# ---------------------------------------------------------------------------


def test_inv_aud_08_the_rebake_key_includes_the_engine() -> None:
    """[INV-AUD-08] a voice-identical clip on a different engine is a different clip.

    The committed falsifier (`falsifiers/INV-AUD-08.json`, `sameVoiceDifferentEngine`):
    same character, same voice spec, same line, same bitrate; only the synthesiser
    changed. EC-PACK-52 is that clip reusing the old hash.
    """
    case = AUD08["sameVoiceDifferentEngine"]
    before = load_cast("es")
    assert before.engine == case["engineBefore"]

    from dataclasses import replace

    after = replace(before, engine=case["engineAfter"])
    key_before = rebake_key(before, case["role"], case["text"])
    key_after = rebake_key(after, case["role"], case["text"])
    assert key_before != key_after, (
        "a clip re-baked by a different engine kept its id: every file name and every "
        "sha256 in the bank still looks current while the audio is a different voice"
    )


def test_inv_aud_08_the_rebake_key_includes_the_engine_pin() -> None:
    """[INV-AUD-08] a weights release moves every style vector; the voice id does not."""
    from dataclasses import replace

    case = AUD08["samePinDifferentRelease"]
    before = load_cast("es")
    after = replace(before, engine_pin=case["pinAfter"])
    assert rebake_key(before, "narrator", "Hola") != rebake_key(after, "narrator", "Hola")


def test_inv_aud_08_the_rebake_key_changes_with_voice_rate_text_and_loudness() -> None:
    """[INV-AUD-08] every input to the audio is in the key, and nothing else is."""
    from dataclasses import replace

    cast = load_cast("es")
    base = rebake_key(cast, "narrator", "Hola")

    assert base != rebake_key(cast, "adult_male", "Hola"), "voice"
    assert base != rebake_key(cast, "narrator", "Hola."), "text"
    assert base != rebake_key(replace(cast, target_lufs=-18.0), "narrator", "Hola"), "loudness"
    assert base != rebake_key(replace(cast, bitrate_kbps=24), "narrator", "Hola"), "bitrate"

    # The accent claim is a claim about the COURSE (D-CAST-ES-01, ruling B6), not an
    # input to synthesis. Hashing it would re-bake a whole bank for a label change —
    # and it would mean a reviewer's verdict, arriving months later, silently
    # invalidated every clip in the bank.
    assert base == rebake_key(replace(cast, accent_claim="reviewer_verified"), "narrator", "Hola")


def test_one_edited_line_re_renders_exactly_one_file() -> None:
    """The content-addressing claim, as arithmetic rather than as prose."""
    cast = load_cast("es")
    lines = [f"Frase número {n}." for n in range(50)]
    before = {rebake_key(cast, "narrator", line) for line in lines}
    lines[17] = "Frase número diecisiete, corregida."
    after = {rebake_key(cast, "narrator", line) for line in lines}
    assert len(before - after) == 1
    assert len(after - before) == 1
    assert len(before & after) == 49


def test_a_blend_is_order_independent() -> None:
    """Two machines must not disagree because a YAML mapping iterated differently."""
    cast = load_cast("es")
    young = cast.role("young")
    assert young.voice_id == "ef_dora:0.450+em_alex:0.550@1.080"
    assert list(young.weights) == sorted(young.weights)


# ---------------------------------------------------------------------------
# What the loader refuses
# ---------------------------------------------------------------------------


def test_weights_that_do_not_sum_to_one_are_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = _raw()
    raw["roles"][3]["weights"] = {"em_alex": 0.55, "ef_dora": 0.55}
    _write(tmp_path, monkeypatch, raw)
    with pytest.raises(CastError, match="sum to"):
        load_cast("es")


def test_a_missing_role_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    raw = _raw()
    raw["roles"] = raw["roles"][:3]
    _write(tmp_path, monkeypatch, raw)
    with pytest.raises(CastError, match="expected exactly"):
        load_cast("es")


def test_a_cast_that_still_declares_a_locale_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ruling B6. The key is not ignored — the FILE is refused, and the error says why.

    Ignoring it would leave a regional claim sitting in a cast that nothing reads and
    nothing enforces, which is the state the ruling exists to end. `es-MX` is the case
    that used to be caught (a locale contradicting EC-PACK-17's one-per-course rule);
    the declared `es-ES` is now caught too, and that is the point.
    """
    for value in ("es-MX", "es-ES"):
        raw = _raw()
        raw["locale"] = value
        _write(tmp_path, monkeypatch, raw)
        with pytest.raises(CastError, match="ruling B6"):
            load_cast("es")


def test_an_accent_claim_outside_the_permitted_set_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing claim is not a pass, and a stronger one needs evidence, not YAML."""
    raw = _raw()
    del raw["accent_claim"]
    _write(tmp_path, monkeypatch, raw)
    with pytest.raises(CastError, match="accent_claim"):
        load_cast("es")

    raw = _raw()
    raw["accent_claim"] = "peninsular"
    _write(tmp_path, monkeypatch, raw)
    with pytest.raises(CastError, match="native-reviewer sample"):
        load_cast("es")


def test_a_loudness_target_the_tool_does_not_enforce_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two declarations of the tolerance is none of them (INV-AUD-08)."""
    raw = _raw()
    raw["loudness"]["target_lufs"] = -19.6
    _write(tmp_path, monkeypatch, raw)
    with pytest.raises(CastError, match="EC-PACK-52"):
        load_cast("es")


def test_a_missing_cast_is_an_error_not_a_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from coursekit.config.g8 import CONTENT_ROOT_ENV_VAR

    monkeypatch.setenv(CONTENT_ROOT_ENV_VAR, str(tmp_path))
    with pytest.raises(CastError, match="cannot pick voices for itself"):
        load_cast("es")


# ---------------------------------------------------------------------------
# R7 — the Piper Japanese refusal
# ---------------------------------------------------------------------------


def test_piper_refuses_japanese() -> None:
    """R7: `ja/ja_JA/hi_fi_captain/medium` is CC BY-NC-SA 4.0.

    The same NC conflict that cut TED2020, and the same exception type, because it is
    the same decision: an NC asset cannot ride in something a commercial fork may
    redistribute, and filtering it later leaves it in every intermediate artefact.
    """
    from coursekit.tts.piper import build

    with pytest.raises(ForbiddenSource, match="CC BY-NC-SA"):
        build("ja")


def test_piper_is_the_german_engine_only() -> None:
    from coursekit.tts.piper import build

    assert build("de").lang == "de"
    with pytest.raises(MissingInput, match="kokoro"):
        build("es")
