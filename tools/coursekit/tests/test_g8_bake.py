"""The G8 stage: what gets a clip, and the budget arithmetic INV-PACK-15 asserts.

The budget tests are the ones that matter here, and the committed falsifier is
`falsifiers/INV-PACK-15.json`. Review R14's finding was not that somebody computed a
size wrong; it was that the size was computed against ONE of three denominators while
Stories and Radio ride the same cast, the same validators and the same budget. A
manifest carrying only a lesson row is comfortably inside 120 MB and is exactly the
shape of the estimate that was refuted, so "all three pipelines are present and sized"
is the property under test, not "the total is small enough".

The stage's rendering half is not unit-tested with a mock engine. Mocking Kokoro would
test the mock: the properties that matter — that the shipped Opus file measures within
tolerance of the target, that `opusenc` accepts what the levelling produces — are only
true of real audio, and `test_inv_aud_08_a_real_clip_survives_the_whole_chain` runs the real one
when the weights are on the machine.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from coursekit.config import (
    ARTIFACT_SCHEMA_VERSION,
    AUDIO_BUDGET_MB,
    AUDIO_PIPELINES,
    OPUS_BITRATE_KBPS,
)
from coursekit.config.g7 import GAP_MARKER, SHAPES
from coursekit.config.g8 import (
    AUDIO_BUDGET_BYTES,
    BUDGET_HEADROOM_BYTES,
    BYTES_PER_MB,
    BYTES_PER_SECOND_AT_BITRATE,
    CAST_SAMPLE_TEXT,
    LESSON_ROLE,
    MASTER_MAX_PASSES,
    PEAK_CEILING_DBFS,
    PIPELINE_RESERVED_BYTES,
    SPOKEN_TEXT_SOURCE,
)
from coursekit.exercises.shapes import prompt_for, shape
from coursekit.inputs import group_is_installed
from coursekit.stages.g8_bake import build_manifest, plan_utterances, spoken_text
from coursekit.tts.cast import load_cast, rebake_key

FALSIFIERS = Path(__file__).parent / "falsifiers"
PACK15 = json.loads((FALSIFIERS / "INV-PACK-15.json").read_text(encoding="utf-8"))["input"]


def _shaped(shape_id: str, body: str, answer: str, index: int = 1) -> dict[str, Any]:
    """One exercise record of a NAMED SHAPE, with the prompt that shape really renders.

    A hand-written prompt is no longer enough: G8 decodes the shape from the instruction
    line, because a coarse type is up to four shapes and they do not speak the same
    string (`SPOKEN_TEXT_SOURCE`). `prompt_for` is the same renderer G7 uses, so a
    record built here is a record the stage could have written.
    """
    chosen = shape(shape_id)
    hint = "perro" if "{hint}" in chosen.instruction else None
    return _exercise(
        chosen.type,
        prompt_for(shape_id, lang="es", body=body, hint=hint),
        answer,
        index,
    )


def _exercise(kind: str, prompt: str, answer: str, index: int = 1) -> dict[str, Any]:
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "lang": "es",
        "exercise_id": f"{index:016x}",
        "unit_index": 1,
        "lesson_index": 1,
        "type": kind,
        "prompt": prompt,
        "accepted_answers": [answer],
        "distractors": [],
        "alignment": [],
        "item_tags": {"lemmas": ["x"], "grammar_concepts": []},
        "audio_ref": None,
        "register": "neutral",
        "source_sentence_id": None,
    }


def _entry(pipeline: str, byte_count: int, clip_id: str, duration_ms: int = 2000) -> dict[str, Any]:
    return {
        "clip_id": clip_id,
        "role": LESSON_ROLE,
        "voice": "ef_dora:1.000@1.000",
        "engine": "kokoro",
        "engine_pin": "model-files-v1.0",
        "pipeline": pipeline,
        "role_sample": False,
        "text": "Hola.",
        "path": f"bank/{clip_id}.opus",
        "sha256": "0" * 64,
        "bytes": byte_count,
        "duration_ms": duration_ms,
        "loudness_lufs": -16.0,
        "loudness_gated": True,
        "peak_dbfs": -1.0,
        "limiter_reduction_db": 0.0,
    }


# ---------------------------------------------------------------------------
# Planning — V7's "every renderable string has audio", at the source
# ---------------------------------------------------------------------------


def test_every_cast_role_gets_a_sample_clip_even_with_no_exercises() -> None:
    """S002 plays a sample per speaker, so three of four voices are not dead weight."""
    cast = load_cast("es")
    planned = plan_utterances(cast, [])
    assert {u.role_id for u in planned} == set(CAST_SAMPLE_TEXT)
    assert all(u.role_sample for u in planned)


def test_two_exercises_showing_one_sentence_share_one_file() -> None:
    cast = load_cast("es")
    text = "El gato duerme en la silla."
    planned = plan_utterances(
        cast,
        [
            _shaped("tap_what_you_hear", "", text, 1),
            _shaped("type_what_you_hear", "", text, 2),
        ],
    )
    lesson = [u for u in planned if not u.role_sample]
    assert len(lesson) == 1
    assert lesson[0].clip_id == rebake_key(cast, LESSON_ROLE, text)


def test_a_shape_with_no_audio_asks_for_no_clip() -> None:
    """A clip nothing plays is bytes inside the 120 MB budget doing nothing.

    It used to happen wholesale: the plan was keyed by coarse TYPE, `translate` and
    `word_bank` mapped to a field, and NO shape of either type declares `needs_audio` —
    so every typed translation and every word bank in the course was baked and played by
    nothing. `match`'s exclusion is the one that was always deliberate: the grid's audio
    is per tile at P6, and pretending a pair has one spoken string would hand V7 a clip
    nothing plays.
    """
    cast = load_cast("es")
    silent = [
        _shaped("typed_translate_forward", "The dog runs.", "El perro corre.", 1),
        _shaped("word_bank_forward", "The dog runs.", "El perro corre.", 2),
        _shaped("match_pairs", "perro", "perro = dog", 3),
        _shaped("fill_in_the_blank", f"El {GAP_MARKER} corre.", "perro", 4),
    ]
    assert all(spoken_text(record) is None for record in silent)
    assert all(u.role_sample for u in plan_utterances(cast, silent))


def test_every_shape_that_declares_audio_says_where_its_clip_comes_from() -> None:
    """The keys ARE the audio-bearing shapes, asserted against the table.

    A shape that declares `needs_audio` and is missing from `SPOKEN_TEXT_SOURCE` is a
    record G8 cannot name a clip for; a key that is not audio-bearing is a clip nothing
    plays. Both used to be possible because the two tables were keyed differently.
    """
    assert set(SPOKEN_TEXT_SOURCE) == {item.id for item in SHAPES if item.needs_audio}


def test_the_missing_word_drill_speaks_the_whole_sentence() -> None:
    """S038 is "audio plus a sentence with one gap" (`deep/01` §S038).

    Its accepted answer is ONE TOKEN, so a plan keyed by coarse type baked the token and
    left the sentence G7 named unbaked — measured on the real course: 198 of 198
    `audio_ref` values dangling and `sqlite3.IntegrityError: FOREIGN KEY constraint
    failed` out of G9. The sentence is recovered from the rendered body, which keeps its
    punctuation, so the recovery is the sentence byte for byte.
    """
    cast = load_cast("es")
    sentence = "¿Dónde está la estación de tren?"
    gapped = sentence.replace("estación", GAP_MARKER)
    record = _shaped("listen_for_the_missing_word", gapped, "estación", 1)
    assert spoken_text(record) == sentence
    planned = [u for u in plan_utterances(cast, [record]) if not u.role_sample]
    assert [u.clip_id for u in planned] == [rebake_key(cast, LESSON_ROLE, sentence)]


def test_a_speak_prompts_clip_is_the_sentence_not_the_instruction() -> None:
    """`prompt` is `instruction\\nbody`, so the type-keyed table baked the instruction.

    A clip of "Speak this sentence. El pan está caliente." is a clip with an English
    sentence in a Spanish bank, and it is what shipped for every `speak` and every
    `translate` record before the source was named per shape.
    """
    sentence = "El pan está caliente."
    record = _shaped("speak_this_sentence", sentence, sentence, 1)
    assert "Speak this sentence" in record["prompt"]
    assert spoken_text(record) == sentence


def test_the_plan_is_ordered_by_clip_id_not_by_exercise() -> None:
    """A manifest ordered by exercise index reshuffles wholesale when G7 reorders, and
    a re-bake's diff stops being "the clips that changed"."""
    cast = load_cast("es")
    planned = plan_utterances(
        cast, [_shaped("type_what_you_hear", "", f"Frase {n}.", n) for n in range(10)]
    )
    assert [u.clip_id for u in planned] == sorted(u.clip_id for u in planned)


def test_the_target_string_is_the_target_language_side() -> None:
    """The listening family grades the learner against the TARGET sentence; baking the
    English prompt would produce a bank of English audio that every other check passes."""
    cast = load_cast("es")
    planned = plan_utterances(
        cast, [_shaped("tap_what_you_hear", "", "¿Dónde está la estación?")]
    )
    texts = {u.text for u in planned if not u.role_sample}
    assert texts == {"¿Dónde está la estación?"}


def test_the_committed_falsifier_for_this_invariant_names_itself() -> None:
    """Same identity clause as `test_cast.py`'s, for INV-PACK-15's corpus."""
    raw = json.loads((FALSIFIERS / "INV-PACK-15.json").read_text(encoding="utf-8"))
    assert raw["invariant"] == "INV-PACK-15"
    assert raw["source"] == ["EC-PACK-15", "EC-PACK-16"]
    assert raw["why"].strip()
    assert {"lessonsOnly", "allThree", "overBudget", "noCodecRow"} <= set(PACK15)
    assert PACK15["budgetMb"] == AUDIO_BUDGET_MB
    assert PACK15["bitrateKbps"] == OPUS_BITRATE_KBPS
    # The falsifier's own arithmetic must be the arithmetic the tool uses, or the
    # fixture stops describing the bug it was written for.
    assert PACK15["allThree"]["declared_bytes"] == sum(
        row["reserved_bytes"] for row in PACK15["allThree"]["pipelines"].values()
    )


# ---------------------------------------------------------------------------
# INV-PACK-15 — the budget
# ---------------------------------------------------------------------------


def test_inv_pack_15_the_manifest_charges_every_pipeline() -> None:
    """[INV-PACK-15] all three pipelines, each sized, summed against the budget.

    The falsifier is `lessonsOnly`: 50 MB against 120 MB looks comfortable and is the
    exact shape review R14 refuted.
    """
    cast = load_cast("es")
    manifest = build_manifest(cast, [_entry("lesson", 5_000, "a" * 16)])
    budget = manifest["budget"]

    assert set(budget["pipelines"]) == set(AUDIO_PIPELINES)
    assert len(budget["pipelines"]) == 3, PACK15["lessonsOnly"]["note"]
    for pipeline in AUDIO_PIPELINES:
        assert budget["pipelines"][pipeline]["reserved_bytes"] > 0
        assert budget["pipelines"][pipeline]["assumption"]

    expected = sum(PIPELINE_RESERVED_BYTES.values())
    assert budget["declared_bytes"] == expected
    assert budget["budget_bytes"] == AUDIO_BUDGET_BYTES


def test_a_pipeline_that_outgrows_its_reservation_is_charged_what_it_costs() -> None:
    """Otherwise a lesson bank at 90 MB hides behind a 50 MB promise."""
    cast = load_cast("es")
    over = PACK15["overBudget"]["pipelines"]["lesson"]["baked_bytes"]
    manifest = build_manifest(cast, [_entry("lesson", over, "b" * 16)])
    pipelines = manifest["budget"]["pipelines"]
    assert pipelines["lesson"]["charged_bytes"] == over
    assert manifest["budget"]["declared_bytes"] > AUDIO_BUDGET_BYTES
    assert manifest["budget"]["headroom_bytes"] < 0


def test_the_three_reservations_fit_inside_the_budget() -> None:
    """The arithmetic R13 found nobody had done, as a test rather than a paragraph.

    50.0 + 27.0 + 21.0 = 98.0 MB against 120. If a future edit to the assumptions
    breaks that, it breaks here and not at P6 with a bank already baked.
    """
    assert BUDGET_HEADROOM_BYTES > 0
    assert sum(PIPELINE_RESERVED_BYTES.values()) < AUDIO_BUDGET_BYTES
    assert AUDIO_BUDGET_MB * BYTES_PER_MB == AUDIO_BUDGET_BYTES


def test_inv_pack_15_the_budget_has_a_bitrate_beside_it() -> None:
    """[INV-PACK-15] R13's finding: 8,000 utterances inside 35-40 MB is 4.4 KB each.

    The refutation only exists because the figure can be divided by something. The
    bytes-per-second constant is that something, and the old budget fails against it.
    """
    assert BYTES_PER_SECOND_AT_BITRATE == 2500.0
    lesson_seconds = 8_000 * 2.5
    assert lesson_seconds * BYTES_PER_SECOND_AT_BITRATE == 50_000_000
    assert lesson_seconds * BYTES_PER_SECOND_AT_BITRATE > 40 * BYTES_PER_MB, (
        "the inherited 35-40 MB budget must not fit the inherited utterance count"
    )


def test_inv_pack_15_the_manifest_carries_codec_bitrate_and_total_bytes() -> None:
    """[INV-PACK-15] the three fields the invariant names, by name."""
    cast = load_cast("es")
    manifest = build_manifest(cast, [_entry("lesson", 4_321, "c" * 16)])
    assert manifest["codec"] == "opus"
    assert manifest["bitrate_kbps"] == 20
    assert manifest["totals"]["bytes"] == 4_321


def test_inv_pack_15_the_manifest_names_the_number_s002_and_s133_render() -> None:
    """[INV-PACK-15] the manifest says WHICH size is the learner-facing one.

    The invariant puts two sizes in one file: what the bank costs to download
    (`totals.megabytes`) and what the budget reserves across three pipelines, two of
    which do not exist yet (`budget.declared_mb`, 98.0 today against 0.145 baked). The
    product map has S133 rendering "38 MB audio" and S002 a download state, and nothing
    in either says which number that is. A screen that quoted the reservation would tell
    a learner a 0.145 MB download costs 98 MB — wrong by 675x, in the direction that
    loses the install. INV-PACK-55 renders it at P4; this is the field it renders.
    """
    cast = load_cast("es")
    manifest = build_manifest(cast, [_entry("lesson", 4_321, "d" * 16)])
    totals = manifest["totals"]

    assert totals["learner_facing_field"] == "totals.megabytes"
    # The named field resolves, and it is the baked size rather than the reservation.
    assert totals["megabytes"] == round(4_321 / BYTES_PER_MB, 3)
    assert totals["megabytes"] != manifest["budget"]["declared_mb"]
    assert "budget.declared_mb" in totals["learner_facing_note"]


def test_the_manifest_records_the_cast_and_the_engine_pin() -> None:
    """A manifest that names the voices but not the engine cannot show EC-PACK-52."""
    cast = load_cast("es")
    manifest = build_manifest(cast, [])
    assert manifest["engine"] == "kokoro"
    assert manifest["engine_pin"] == cast.engine_pin
    assert [row["role"] for row in manifest["cast"]] == [role.id for role in cast.roles]
    assert all(row["voice"] for row in manifest["cast"])


# ---------------------------------------------------------------------------
# INV-AUD-08 — the whole chain, on real audio
# ---------------------------------------------------------------------------


def test_inv_aud_08_a_real_clip_survives_the_whole_chain() -> None:
    """[INV-AUD-08] synthesise -> master -> encode -> DECODE -> measure, within tolerance.

    The measurement is taken on the decoded Opus file. Measuring the encoder's input
    instead would prove nothing about the file in the pack, which is the assumption the
    invariant's word "measures" exists to forbid.
    """
    if not group_is_installed("tts"):
        pytest.skip("the tts group is not installed")
    import shutil

    if shutil.which("opusenc") is None or shutil.which("opusdec") is None:
        pytest.skip("opus-tools is not on PATH")

    from coursekit.tts.kokoro import build
    from coursekit.tts.loudness import master, measure_lufs, peak_dbfs
    from coursekit.tts.transcode import decode, encode

    cast = load_cast("es")
    engine = build("es")
    if not engine.model_path.exists() or not engine.voices_path.exists():
        pytest.skip("kokoro weights are not on this machine")

    text = "Buenos días, ¿cómo estás?"
    samples, rate = engine.synthesise(text, cast.role("narrator"))
    levelled, reduction = master(
        samples,
        rate,
        cast.target_lufs,
        ceiling_dbfs=PEAK_CEILING_DBFS,
        tolerance_lu=cast.tolerance_lu,
        max_passes=MASTER_MAX_PASSES,
    )
    assert peak_dbfs(levelled) <= PEAK_CEILING_DBFS + 1e-6
    assert reduction >= 0.0

    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        clip_id = rebake_key(cast, "narrator", text)
        clip = encode(levelled, rate, clip_id, Path(tmp))
        assert clip.path.name == f"{clip_id}.opus"
        decoded, decoded_rate = decode(clip.path)
        measured = measure_lufs(decoded, decoded_rate)

    drift = abs(measured.lufs - cast.target_lufs)
    assert drift <= cast.tolerance_lu, (
        f"the SHIPPED clip measured {measured.lufs:.2f} LUFS, {drift:.2f} LU from the "
        f"declared {cast.target_lufs}"
    )
    # And the encode actually held the declared bitrate, within the slack a VBR
    # encoder needs on a two-second clip.
    implied_kbps = clip.bytes * 8 / (len(decoded) / decoded_rate) / 1000
    assert 12 <= implied_kbps <= 34, implied_kbps


def test_inv_aud_08_loudness_is_measured_on_the_decoded_file() -> None:
    """[INV-AUD-08] the falsifier's `driftedClip`, as an assertion about the chain.

    A clip whose PCM was normalised to -16 and whose decoded Opus measures -19.6 is
    EC-PACK-52. The stage compares the DECODED reading with the tolerance, so this test
    pins the fact that the two readings are taken on different signals and only the
    second one gates.
    """
    from coursekit.stages import g8_bake

    source = Path(g8_bake.__file__).read_text(encoding="utf-8")
    measure_line = source.index("decoded, decoded_rate = decode(clip.path)")
    assert source.index("measured = measure_lufs(decoded", measure_line) > measure_line
    assert "measure_lufs(samples" not in source, (
        "the gate must not read the synthesiser's output; that is the assumption "
        "INV-AUD-08 forbids"
    )


# ---------------------------------------------------------------------------
# INV-AUD-08 clause 1, in a job with no weights: a real encode/decode round trip
# ---------------------------------------------------------------------------
#
# `test_inv_aud_08_a_real_clip_survives_the_whole_chain` above is the honest end-to-end
# proof and it needs the `tts` group plus 354 MB of Kokoro weights, neither of which
# `pack-ci.yml` installs (pyproject's `[tool.uv] default-groups` deliberately excludes
# `tts`). The test directly above it is a SOURCE-TEXT test: it reads `g8_bake.py` as a
# string. A refuter's finding, in full: that would pass a rewrite that measured the
# pre-encode PCM under a different variable name, so in CI the only thing standing behind
# "every packed clip MEASURES within tolerance" was a string search.
#
# This closes that. It needs numpy (which arrives with the `nlp` group spaCy pulls, so CI
# has it) and opus-tools (one apt line, already in `pack-bake.yml`) and nothing else: the
# synthesiser is replaced by a synthetic voiced signal, and everything after it —
# `master` -> `encode` -> `decode` -> `measure_lufs` -> tolerance — is the shipping chain,
# unmocked.
#
# It also pins the two halves apart, which is the clause the source test was standing in
# for. Two alignment-free facts do that: the file on disk carries ~18 kbps for 3.4 s
# (7.7 KB where the PCM was 163 KB), and the samples that came back differ from the ones
# that went in by a peak of ~0.09 — a 20 kbps encode of speech is not a copy. A reading
# taken off that array cannot have come from the encoder's input.
#
# (`opusdec` returns the ORIGINAL rate, not 48 kHz: the codec runs at 48 kHz internally
# and opusenc records the input rate in the Ogg header, which opusdec resamples back to
# unless `--rate` overrides it. Measured here, 24 kHz in gives 24 kHz out.)

#: Set in pack-ci.yml. Without it a machine with no opus-tools skips; with it, a job whose
#: `apt-get install opus-tools` silently failed goes RED instead of green-with-a-skip —
#: the whole point of this test is to be the guard that CI actually runs.
REQUIRE_OPUS_TOOLS = "COURSEKIT_REQUIRE_OPUS_TOOLS"


def _voiced_signal(rate: int, seconds: float, *, syllables_per_second: float = 4.0) -> Any:
    """A speech-shaped test signal: a 120 Hz glottal-ish stack under a syllable envelope.

    Not a sine. A pure tone is the one signal a 20 kbps Opus encoder reproduces almost
    perfectly, so a round trip on one would pass whatever the encoder did to speech. Five
    harmonics with a 1/k roll-off and a 4 Hz envelope give the encoder a real crest factor
    and a real spectrum to spend its bits on, and the trailing silence gives BS.1770's
    relative gate something to exclude.
    """
    import numpy as np

    t = np.arange(int(rate * seconds), dtype=np.float64) / rate
    carrier = sum(np.sin(2.0 * np.pi * 120.0 * k * t) / k for k in (1, 2, 3, 4, 5))
    envelope = (0.5 * (1.0 - np.cos(2.0 * np.pi * syllables_per_second * t))) ** 1.5
    signal = carrier * envelope
    signal = signal / float(np.max(np.abs(signal))) * 0.5
    return np.concatenate([signal, np.zeros(int(rate * 0.4))])


def _round_trip(samples: Any, rate: int, clip_id: str, tmp_path: Path) -> tuple[Any, int, int]:
    """encode -> decode. Returns the decoded samples, their rate, and the file's bytes."""
    from coursekit.tts.transcode import decode, encode

    clip = encode(samples, rate, clip_id, tmp_path)
    decoded, decoded_rate = decode(clip.path)
    return decoded, decoded_rate, clip.bytes


def _skip_without_opus_tools() -> None:
    import os
    import shutil

    missing = [tool for tool in ("opusenc", "opusdec") if shutil.which(tool) is None]
    if not missing:
        return
    if os.environ.get(REQUIRE_OPUS_TOOLS):
        pytest.fail(
            f"{', '.join(missing)} not on PATH and {REQUIRE_OPUS_TOOLS} is set. "
            f"pack-ci.yml installs opus-tools so this guard RUNS; a skip here would put "
            f"INV-AUD-08 clause 1 back behind a string search."
        )
    pytest.skip(f"opus-tools is not on PATH ({', '.join(missing)})")


def test_inv_aud_08_a_synthetic_clip_measures_on_the_decoded_file(tmp_path: Path) -> None:
    """[INV-AUD-08] master -> encode -> DECODE -> measure lands inside the declared tolerance.

    The behavioural half of clause 1, runnable in a job with no Kokoro weights. Real
    `opusenc`, real `opusdec`, the real meter, the cast's own target and tolerance.
    """
    _skip_without_opus_tools()
    from coursekit.tts.loudness import master, measure_lufs, peak_dbfs

    cast = load_cast("es")
    rate = 24_000  # Kokoro's output rate, so the 24 -> 48 kHz assertion below is the real one
    levelled, reduction = master(
        _voiced_signal(rate, 3.0),
        rate,
        cast.target_lufs,
        ceiling_dbfs=PEAK_CEILING_DBFS,
        tolerance_lu=cast.tolerance_lu,
        max_passes=MASTER_MAX_PASSES,
    )
    assert peak_dbfs(levelled) <= PEAK_CEILING_DBFS + 1e-6
    assert reduction >= 0.0

    import numpy as np

    decoded, decoded_rate, size = _round_trip(levelled, rate, "synthetic-on-target", tmp_path)

    # The measurement came from the SHIPPED file, not from what went into the encoder.
    # Two facts, neither of which needs the two arrays to be sample-aligned:
    #   1. the bytes on disk are a 20 kbps Opus stream, not the 163 KB of PCM that went in;
    #   2. the samples that came back are materially different from the ones that went in,
    #      which is what a lossy encode at this rate does and what a pass-through does not.
    seconds = len(decoded) / decoded_rate
    implied_kbps = size * 8 / seconds / 1000
    assert 12 <= implied_kbps <= 34, implied_kbps
    assert size < levelled.size * 2 / 8, "that is PCM-sized, not a 20 kbps Opus file"
    overlap = min(len(decoded), len(levelled))
    assert float(np.max(np.abs(decoded[:overlap] - levelled[:overlap]))) > 1e-3, (
        "the decoded samples are identical to the encoder's input, so nothing was "
        "actually encoded and this measurement is of the PCM"
    )

    measured = measure_lufs(decoded, decoded_rate)
    assert measured.gated, "a 3.4 s clip must be measured by the gated algorithm"
    drift = abs(measured.lufs - cast.target_lufs)
    assert drift <= cast.tolerance_lu, (
        f"the decoded 20 kbps file measured {measured.lufs:.3f} LUFS, {drift:.3f} LU from "
        f"the declared {cast.target_lufs} (tolerance {cast.tolerance_lu} LU)"
    )


def test_inv_pack_15_the_same_input_encodes_to_the_same_bytes(tmp_path: Path) -> None:
    """[INV-PACK-15] the manifest describes bytes, so a no-op rebuild must reproduce them.

    Found by re-running the bake on an unchanged tree: all 23 committed `sha256` values
    moved while every `bytes`, `duration_ms` and `loudness_lufs` stayed identical to the
    last decimal. The cause is opusenc's default RANDOM Ogg stream serial, and the
    consequence is that the manifest's own promise — "everything needed to say whether a
    rebuild produced the same bank" — was false: a reproducibility check would have
    reported the whole bank changed on every run, which is the same as reporting nothing.
    `--serial` (see `OPUS_SERIAL_MASK`) fixes it; this is what keeps it fixed.
    """
    _skip_without_opus_tools()
    import hashlib

    from coursekit.tts.transcode import ogg_serial

    signal = _voiced_signal(24_000, 1.0)
    first = tmp_path / "first"
    second = tmp_path / "second"
    clip_a = _round_trip_file(signal, 24_000, "repro", first)
    clip_b = _round_trip_file(signal, 24_000, "repro", second)

    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()  # noqa: E731
    assert digest(clip_a) == digest(clip_b), (
        "two encodes of identical PCM produced different bytes; the manifest's sha256 "
        "column cannot detect a real drift if it changes on every no-op rebuild"
    )
    # And the serial really is derived from the clip id, so two different clips do not
    # collide on one stream serial.
    assert ogg_serial("repro") != ogg_serial("repro-other")
    assert 0 < ogg_serial("repro") <= 0x7FFFFFFF


def _round_trip_file(samples: Any, rate: int, clip_id: str, directory: Path) -> Path:
    from coursekit.tts.transcode import encode

    return encode(samples, rate, clip_id, directory).path


def test_inv_aud_08_a_mislevelled_clip_fails_the_same_measurement(tmp_path: Path) -> None:
    """[INV-AUD-08] the falsifier's `driftedClip`, driven through real audio.

    The test above proves the chain accepts an on-target clip. On its own that is a test
    an always-true assertion would also pass, so this is the other side: a clip mastered
    4 LU low — EC-PACK-52's shape, a bank that is quietly quiet — must come back OUTSIDE
    the tolerance from the same decode-and-measure the stage runs.
    """
    _skip_without_opus_tools()
    from coursekit.tts.loudness import master, measure_lufs

    cast = load_cast("es")
    rate = 24_000
    wrong_target = cast.target_lufs - 4.0
    levelled, _ = master(
        _voiced_signal(rate, 3.0),
        rate,
        wrong_target,
        ceiling_dbfs=PEAK_CEILING_DBFS,
        tolerance_lu=cast.tolerance_lu,
        max_passes=MASTER_MAX_PASSES,
    )
    decoded, decoded_rate, _ = _round_trip(levelled, rate, "synthetic-four-lu-low", tmp_path)
    measured = measure_lufs(decoded, decoded_rate)

    assert abs(measured.lufs - cast.target_lufs) > cast.tolerance_lu, (
        f"a clip mastered {wrong_target} LUFS measured {measured.lufs:.3f} against a "
        f"{cast.target_lufs} target and was NOT refused — the tolerance "
        f"({cast.tolerance_lu} LU) is not gating anything"
    )
    # ... and it is the level that is wrong, not the meter: the clip landed where it was
    # asked to land, which is what makes the failure above attributable.
    assert abs(measured.lufs - wrong_target) <= cast.tolerance_lu
