"""G8 — bake the voice bank: synthesise the cast, normalise, transcode, measure, record.

The stage in one line per step:

    plan   -> one utterance per renderable target-language string, plus one cast sample
              per role, each with a content-addressed clip id (`cast.rebake_key`)
    render -> Kokoro (es/fr/ja) or Piper (de), from the pinned weights only
    level  -> master the PCM to the declared target: normalise, look-ahead peak-limit,
              make up, repeat until it converges inside half the tolerance
    encode -> `opusenc` at 20 kbps, written as `<clip_id>.opus`
    verify -> DECODE the shipped file and measure it; correct and re-encode until it
              lands inside the tolerance, and a clip that never does fails the bake
    record -> `baked_clip` rows for the next stage, and `content/<lang>/audio-manifest.json`
              for the repository, the pack manifest and the pack-detail screen

Three properties are the point of the whole stage.

**The bank is content-addressed on its inputs, not its output.** A clip's name is the
re-bake key: a hash of the engine, the engine's pin, the voice spec, the rate, the
codec, the bitrate, the target loudness and the text. One edited line therefore
re-renders one file and leaves every other id alone, and an engine swap re-renders all
of them (INV-AUD-08's second clause). Hashing the encoder's output instead would move
every id in the bank the day opus-tools is upgraded.

**Loudness is measured on what shipped.** Normalising 32-bit PCM and then asserting the
target proves nothing about a 20 kbps Opus file, which is where a clip's level actually
moves. So the verification decodes the written file and measures that.

**The budget covers three pipelines, not one.** Review R14 found the inherited cost and
size model counted lessons only while Stories and Radio ride the same cast and the same
budget. Stories and Radio do not exist until P6, so the manifest carries a NAMED, SIZED
reservation for each — and the lesson bank is asserted against what is left, not against
the whole 120 MB. A zero there would let lessons grow into space the other two pipelines
have already been promised, and the overrun would surface at P6 with the bank baked.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..artifacts import read_records, stage_dir, write_records
from ..config import (
    ARTIFACT_SCHEMA_VERSION,
    AUDIO_BUDGET_MB,
    AUDIO_PIPELINES,
    OPUS_BITRATE_KBPS,
)
from ..config.g7 import GAP_MARKER
from ..config.g8 import (
    AUDIO_BUDGET_BYTES,
    AUDIO_MANIFEST_FILENAME,
    AUDIO_MANIFEST_VERSION,
    BANK_DIRNAME,
    BYTES_PER_MB,
    CAST_SAMPLE_TEXT,
    ENCODE_MAX_PASSES,
    LESSON_ROLE,
    LESSON_SECONDS_PER_UTTERANCE,
    LESSON_UTTERANCE_TARGET,
    MASTER_MAX_PASSES,
    PEAK_CEILING_DBFS,
    PIPELINE_RESERVED_BYTES,
    PIPELINE_RESERVED_SECONDS,
    RADIO_EPISODE_COUNT_RESERVED,
    RADIO_MINUTES_EACH,
    SPOKEN_TEXT_SOURCE,
    STORY_COUNT_RESERVED,
    STORY_MINUTES_EACH,
)
from ..exercises.shapes import shape_of_record
from ..runlog import require_successful
from ..stages import StageContext, StageResult, register_stage
from ..tts import TTS
from ..tts.cast import Cast, load_cast, rebake_key
from ..tts.loudness import master, measure_lufs, trim_gain
from ..tts.transcode import decode, encode, require_tools

__all__ = ["Utterance", "bake", "bank_dir", "manifest_path", "plan_utterances", "spoken_text"]


@dataclass(frozen=True, slots=True)
class Utterance:
    """One thing to say, by one role, for one pipeline."""

    clip_id: str
    role_id: str
    text: str
    pipeline: str
    #: True for the four pack-detail sample lines (S002), which belong to no exercise.
    role_sample: bool


def bank_dir(lang: str) -> Path:
    """`<build root>/<lang>/g8/bank/`. Gitignored: only the manifest is committed."""
    return stage_dir(lang, "g8") / BANK_DIRNAME


def manifest_path(lang: str) -> Path:
    from ..tts.cast import content_root

    return content_root() / lang / AUDIO_MANIFEST_FILENAME


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------


def plan_utterances(cast: Cast, exercises: list[dict[str, Any]]) -> list[Utterance]:
    """Every string that needs a clip, deduplicated, in a stable order.

    Deduplicated by clip id rather than by text: two exercises that show the same
    sentence share one file, which is the other half of content addressing. Ordered by
    clip id so the manifest diff of a re-bake is the clips that changed and nothing
    else — a manifest ordered by exercise index reshuffles wholesale when G7 reorders.
    """
    planned: dict[str, Utterance] = {}

    for role_id, text in CAST_SAMPLE_TEXT.items():
        cast.role(role_id)  # raises if the cast and the sample list disagree
        clip_id = rebake_key(cast, role_id, text)
        planned[clip_id] = Utterance(
            clip_id=clip_id,
            role_id=role_id,
            text=text,
            pipeline="lesson",
            role_sample=True,
        )

    for exercise in exercises:
        text = spoken_text(exercise)
        if text is None:
            continue
        clip_id = rebake_key(cast, LESSON_ROLE, text)
        planned.setdefault(
            clip_id,
            Utterance(
                clip_id=clip_id,
                role_id=LESSON_ROLE,
                text=text,
                pipeline="lesson",
                role_sample=False,
            ),
        )

    return [planned[clip_id] for clip_id in sorted(planned)]


def spoken_text(exercise: Mapping[str, Any]) -> str | None:
    """What this exercise's clip SAYS, or `None` when the shape has no clip.

    The one function G8 and V7 both read, so "every renderable string has audio" and
    "every audio file has a string" are the same join asked from two sides. The shape
    decides — see `SPOKEN_TEXT_SOURCE` for the three defects that came of asking the
    coarse type instead.

    Raises `UnknownShape` for a record whose prompt no shape renders: a record G8 cannot
    place is a record whose audio nobody can name, and guessing is what this whole
    function exists to stop.
    """
    found = shape_of_record(dict(exercise))
    source = SPOKEN_TEXT_SOURCE.get(found.id)
    if source is None:
        if found.needs_audio:  # pragma: no cover - the table test forbids this
            raise ValueError(
                f"{found.id!r} declares needs_audio and SPOKEN_TEXT_SOURCE has no entry "
                f"for it, so nothing can say what its clip is of"
            )
        return None
    answers = [str(answer) for answer in exercise["accepted_answers"]]
    if source == "accepted_answer":
        # The FIRST accepted answer, not all of them. The set is a grading tolerance
        # (Japanese enumerates kanji, kana and katakana forms of one sentence); baking
        # every member would produce several clips of the same spoken line under
        # different ids and a bank several times the budget.
        return answers[0] if answers else None
    parts = str(exercise["prompt"]).split("\n", 1)
    body = parts[1] if len(parts) > 1 else ""
    if source == "body":
        return body or None
    if source == "body_with_the_gap_filled":
        if not answers or GAP_MARKER not in body:
            return None
        return body.replace(GAP_MARKER, answers[0])
    raise ValueError(f"SPOKEN_TEXT_SOURCE names {source!r}, which this function cannot read")


# ---------------------------------------------------------------------------
# The stage
# ---------------------------------------------------------------------------


@register_stage("g8", reads=("exercise",), writes=("baked_clip",), requires_group="tts")
def bake(ctx: StageContext) -> StageResult:
    """Synthesise, level, transcode and verify the whole bank for one language."""
    cast = load_cast(ctx.lang)
    require_tools()
    require_successful(ctx.lang, ["g7"])

    exercises = list(read_records("exercise", lang=ctx.lang))
    utterances = plan_utterances(cast, exercises)
    ctx.entry.read = len(exercises)

    engine_factory = TTS.get(cast.engine)
    if engine_factory is None:  # pragma: no cover - the cast loader checks the name
        return StageResult(ok=False, message=f"no TTS engine registered as {cast.engine!r}")
    engine = engine_factory(ctx.lang)

    directory = bank_dir(ctx.lang)
    records: list[dict[str, Any]] = []
    entries: list[dict[str, Any]] = []
    failures: list[str] = []

    for utterance in utterances:
        role = cast.role(utterance.role_id)
        samples, rate = engine.synthesise(utterance.text, role)
        levelled, limiter_db = master(
            samples,
            rate,
            cast.target_lufs,
            ceiling_dbfs=PEAK_CEILING_DBFS,
            tolerance_lu=cast.tolerance_lu,
            max_passes=MASTER_MAX_PASSES,
        )

        # INV-AUD-08: the measurement that counts is taken on the SHIPPED file, and
        # the loop closes on it. A 20 kbps encode costs a systematic 0.4-0.75 LU
        # (measured), so a bake that encoded once and widened the tolerance to cover
        # the loss would be asserting the target rather than reaching it.
        candidate = levelled
        encode_pass = 0
        while encode_pass < ENCODE_MAX_PASSES:
            encode_pass += 1
            clip = encode(candidate, rate, utterance.clip_id, directory)
            decoded, decoded_rate = decode(clip.path)
            measured = measure_lufs(decoded, decoded_rate)
            error = cast.target_lufs - measured.lufs
            if abs(error) <= cast.tolerance_lu / 2.0:
                break
            candidate = trim_gain(candidate, rate, error, ceiling_dbfs=PEAK_CEILING_DBFS)

        drift = abs(measured.lufs - cast.target_lufs)
        if drift > cast.tolerance_lu:
            failures.append(
                f"{utterance.clip_id} ({utterance.role_id}) measured {measured.lufs:.2f} "
                f"LUFS, {drift:.2f} LU from the declared {cast.target_lufs:.1f} "
                f"(tolerance {cast.tolerance_lu:.2f})"
            )

        duration_ms = int(round(len(decoded) / decoded_rate * 1000))
        records.append(
            {
                "schema_version": ARTIFACT_SCHEMA_VERSION,
                "lang": ctx.lang,
                "clip_id": utterance.clip_id,
                "text": utterance.text,
                "voice_id": role.voice_id,
                "engine": cast.engine,
                "codec": "opus",
                "bitrate_kbps": cast.bitrate_kbps,
                "duration_ms": duration_ms,
                "bytes": clip.bytes,
                "path": f"{BANK_DIRNAME}/{clip.path.name}",
                "licence": cast.engine_licence,
                "pipeline": utterance.pipeline,
            }
        )
        entries.append(
            {
                "clip_id": utterance.clip_id,
                "role": utterance.role_id,
                "voice": role.voice_id,
                "engine": cast.engine,
                "engine_pin": cast.engine_pin,
                "pipeline": utterance.pipeline,
                "role_sample": utterance.role_sample,
                "text": utterance.text,
                "path": f"{BANK_DIRNAME}/{clip.path.name}",
                "sha256": _sha256(clip.path),
                "bytes": clip.bytes,
                "duration_ms": duration_ms,
                "loudness_lufs": round(measured.lufs, 3),
                "loudness_gated": measured.gated,
                "peak_dbfs": round(measured.peak_dbfs, 3),
                "limiter_reduction_db": limiter_db,
                "encode_passes": encode_pass,
            }
        )

    write_records("baked_clip", records, lang=ctx.lang)
    ctx.entry.record_output("baked_clip")
    ctx.entry.written = len(records)

    manifest = build_manifest(cast, entries)
    _write_manifest(ctx.lang, manifest)

    budget = manifest["budget"]
    ctx.entry.note(
        codec="opus",
        bitrate_kbps=cast.bitrate_kbps,
        engine=cast.engine,
        engine_pin=cast.engine_pin,
        target_lufs=cast.target_lufs,
        tolerance_lu=cast.tolerance_lu,
        clips=len(entries),
        bytes=manifest["totals"]["bytes"],
        declared_bytes=budget["declared_bytes"],
        budget_bytes=budget["budget_bytes"],
    )

    if failures:
        return StageResult(
            ok=False,
            message=(
                f"{len(failures)} clip(s) outside the declared loudness tolerance "
                f"(INV-AUD-08): " + "; ".join(failures[:5])
            ),
        )
    if budget["declared_bytes"] > budget["budget_bytes"]:
        return StageResult(
            ok=False,
            message=(
                f"the declared bank is {budget['declared_bytes'] / BYTES_PER_MB:.1f} MB "
                f"against a {AUDIO_BUDGET_MB} MB budget (INV-PACK-15), summed over "
                f"{', '.join(AUDIO_PIPELINES)}"
            ),
        )
    return StageResult(ok=True, message=f"{len(entries)} clip(s)")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# The manifest (INV-PACK-15)
# ---------------------------------------------------------------------------


def build_manifest(cast: Cast, entries: list[dict[str, Any]]) -> dict[str, Any]:
    """The committed record of the bank: hashes, durations, bytes, voice, engine.

    Never audio bytes. The bank itself is gitignored and rebuilt from this file plus
    the cast; what is committed is everything needed to say whether a rebuild produced
    the same bank, and everything S002 and S133 render about it.

    `budget` is the INV-PACK-15 assertion, written out rather than reduced to a
    boolean, so a reader can see which pipeline is using what. Each pipeline occupies
    `max(baked, reserved)`: a pipeline that has baked nothing still holds its
    reservation, and one that has outgrown it is charged what it actually costs.
    """
    by_pipeline: dict[str, dict[str, Any]] = {
        pipeline: {"clips": 0, "bytes": 0, "seconds": 0.0} for pipeline in AUDIO_PIPELINES
    }
    for entry in entries:
        bucket = by_pipeline[entry["pipeline"]]
        bucket["clips"] += 1
        bucket["bytes"] += entry["bytes"]
        bucket["seconds"] += entry["duration_ms"] / 1000.0

    pipelines: dict[str, dict[str, Any]] = {}
    declared = 0
    for pipeline in AUDIO_PIPELINES:
        baked = by_pipeline[pipeline]
        reserved = PIPELINE_RESERVED_BYTES[pipeline]
        charged = max(baked["bytes"], reserved)
        declared += charged
        pipelines[pipeline] = {
            "status": "baked" if baked["clips"] else "reserved",
            "clips": baked["clips"],
            "baked_bytes": baked["bytes"],
            "baked_seconds": round(baked["seconds"], 3),
            "reserved_bytes": reserved,
            "reserved_seconds": PIPELINE_RESERVED_SECONDS[pipeline],
            "charged_bytes": charged,
            "assumption": _ASSUMPTIONS[pipeline],
        }

    total_bytes = sum(entry["bytes"] for entry in entries)
    total_seconds = sum(entry["duration_ms"] for entry in entries) / 1000.0

    return {
        "schema_version": AUDIO_MANIFEST_VERSION,
        "language": cast.language,
        # Ruling B6. This field used to be `locale: es-ES`, read from
        # LOCALE_BY_LANGUAGE — a regional claim that was vendor-backed under Azure and
        # unfalsifiable under Kokoro. The manifest now says the language and how much is
        # known about the accent, and F2 refuses a manifest that still carries a locale.
        "accent_claim": cast.accent_claim,
        "engine": cast.engine,
        "engine_pin": cast.engine_pin,
        "engine_licence": cast.engine_licence,
        "codec": "opus",
        "bitrate_kbps": cast.bitrate_kbps,
        "loudness": {
            "target_lufs": cast.target_lufs,
            "tolerance_lu": cast.tolerance_lu,
            "algorithm": "ITU-R BS.1770-4 K-weighted, gated",
            "measured_on": "the decoded Opus file",
        },
        "cast": [
            {
                "role": role.id,
                "display_name": role.display_name,
                "voice": role.voice_id,
                "stock": role.stock,
                "weights": {voice: weight for voice, weight in role.weights},
                "rate": role.rate,
            }
            for role in cast.roles
        ],
        "totals": {
            "clips": len(entries),
            "bytes": total_bytes,
            "seconds": round(total_seconds, 3),
            "megabytes": round(total_bytes / BYTES_PER_MB, 3),
            # S002 ("sample sentence + speaker" download state) and S133 ("38 MB audio")
            # render ONE number, and this manifest offers two candidates: what the bank
            # costs (`totals.megabytes`) and what the budget reserves for three pipelines
            # two of which do not exist yet (`budget.declared_mb`, 98.0). A download
            # screen that quoted 98 MB for a 0.145 MB file would be lying to the learner
            # in the direction that loses the install, so the field is named here rather
            # than chosen by whoever builds the screen. INV-PACK-55 owns the rendering at
            # P4; this is the contract it renders against.
            "learner_facing_field": "totals.megabytes",
            "learner_facing_note": (
                "S002 and S133 show the size of the bank that will actually be "
                "downloaded (totals.megabytes, decimal MB). budget.declared_mb is the "
                "INV-PACK-15 reservation across all three pipelines and is never shown "
                "to a learner."
            ),
        },
        "budget": {
            "budget_mb": AUDIO_BUDGET_MB,
            "budget_bytes": AUDIO_BUDGET_BYTES,
            "declared_bytes": declared,
            "declared_mb": round(declared / BYTES_PER_MB, 3),
            "headroom_bytes": AUDIO_BUDGET_BYTES - declared,
            "rule": (
                "every pipeline is charged max(baked, reserved); the sum must not "
                "exceed the budget (INV-PACK-15, review R14)"
            ),
            "pipelines": pipelines,
        },
        "clips": entries,
    }


#: Where each reservation's number comes from. Written into the manifest so nobody has
#: to find this file to learn that 27 MB of the budget is an assumption about Stories.
_ASSUMPTIONS: dict[str, str] = {
    "lesson": (
        f"{LESSON_UTTERANCE_TARGET:,} utterances averaging "
        f"{LESSON_SECONDS_PER_UTTERANCE} s at {OPUS_BITRATE_KBPS} kbps (the R13 denominator)"
    ),
    "story": (
        f"{STORY_COUNT_RESERVED} stories of {STORY_MINUTES_EACH} min "
        f"at {OPUS_BITRATE_KBPS} kbps — an ASSUMPTION, not a measurement; P6 replaces it"
    ),
    "radio": (
        f"{RADIO_EPISODE_COUNT_RESERVED} episodes of {RADIO_MINUTES_EACH} min "
        f"at {OPUS_BITRATE_KBPS} kbps — an ASSUMPTION, not a measurement; P6 replaces it"
    ),
}


def _write_manifest(lang: str, manifest: dict[str, Any]) -> None:
    target = manifest_path(lang)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=False) + "\n",
        encoding="utf-8",
    )


def read_manifest(lang: str) -> dict[str, Any]:
    """The committed manifest, or a `FileNotFoundError` naming the bake that writes it."""
    target = manifest_path(lang)
    if not target.exists():
        raise FileNotFoundError(
            f"no audio manifest at {target}; run `coursekit bake {lang}`. "
            f"A validator that cannot find the manifest must not report a pass."
        )
    return json.loads(target.read_text(encoding="utf-8"))
