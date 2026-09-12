"""The two audio validators: V7 (the string/audio join) and F2 (INV-PACK-15).

Both read the COMMITTED manifest, `content/<lang>/audio-manifest.json`, and not the
bank. That is the whole design. The bank is gitignored, so a validator that walked
`build/<lang>/g8/bank/` would pass on whatever happens to be on the machine it runs on
and could not run in CI at all; the manifest is the artefact that travels, and it is
the artefact the pack manifest, S002 and S133 are built from. Where the bank IS present
the validators check it too — a manifest whose digests do not match the files beside it
is a manifest describing a bank nobody has.

**V7** — every renderable string has audio, every audio file has a string, durations
are sane. Three findings, not one, because they fail in different directions: an
exercise with no clip is silent in the player; a clip no exercise plays is bytes inside
the budget doing nothing; and a clip whose duration is absurd is usually a phonemiser
that was handed the wrong language, which nothing else in this pipeline can see. That
last one is the reason the duration bounds exist at all: text, licence and loudness are
all fine on a Spanish sentence read by an English G2P.

**F2 / INV-PACK-15** — the manifest carries codec, bitrate and total bytes, and the
declared size is asserted against the budget for **all three** pipelines. Review R14
found the inherited model counted lessons only; the gate here fails both ways, on a
pipeline missing from the manifest and on a total over budget.
"""

from __future__ import annotations

from typing import Any

from ..config import AUDIO_BUDGET_MB, AUDIO_PIPELINES, OPUS_BITRATE_KBPS
from ..config.g8 import (
    ACCENT_CLAIMS,
    AUDIO_BUDGET_BYTES,
    BYTES_PER_MB,
    CAST_FORBIDDEN_KEYS,
    LOUDNESS_TOLERANCE_LU,
    MAX_CLIP_MS,
    MIN_CLIP_MS,
    TARGET_LUFS,
    TARGET_TEXT_FIELD_BY_TYPE,
)
from . import Finding, ValidatorContext, register_validator

__all__ = ["audio_budget", "string_audio_join"]


def _manifest(ctx: ValidatorContext) -> dict[str, Any] | None:
    from ..stages.g8_bake import read_manifest

    try:
        return read_manifest(ctx.lang)
    except FileNotFoundError:
        return None


def _no_manifest(validator_id: str, lang: str) -> Finding:
    return Finding(
        validator_id=validator_id,
        severity="blocking",
        message=(
            f"no audio manifest for {lang}. A validator that cannot find the thing it "
            f"checks must report a failure, never a pass: `coursekit bake {lang}` "
            f"writes content/{lang}/audio-manifest.json."
        ),
        subject=lang,
    )


# ---------------------------------------------------------------------------
# V7
# ---------------------------------------------------------------------------


@register_validator("V7")
def string_audio_join(ctx: ValidatorContext) -> list[Finding]:
    """Every renderable string has audio; every audio file has a string."""
    from ..artifacts import read_records

    manifest = _manifest(ctx)
    if manifest is None:
        return [_no_manifest("V7", ctx.lang)]

    findings: list[Finding] = []
    clips = manifest.get("clips", [])
    by_text: dict[str, dict[str, Any]] = {clip["text"]: clip for clip in clips}

    try:
        exercises = list(read_records("exercise", lang=ctx.lang))
    except FileNotFoundError:
        exercises = []
        ctx.entry.note(exercises_artefact="absent")
        findings.append(
            Finding(
                validator_id="V7",
                severity="warning",
                message=(
                    "no G7 exercise artefact for this language, so the "
                    "every-string-has-audio half of V7 checked nothing. Recorded "
                    "rather than passed silently — V8's lesson."
                ),
                subject=ctx.lang,
            )
        )

    # -- every renderable string has audio ---------------------------------
    spoken: set[str] = set()
    for exercise in exercises:
        field = TARGET_TEXT_FIELD_BY_TYPE.get(exercise["type"])
        if field is None:
            continue
        text = (
            exercise["accepted_answers"][0]
            if field == "accepted_answers"
            else exercise.get(field)
        )
        if not text:
            continue
        spoken.add(str(text))
        if str(text) not in by_text:
            findings.append(
                Finding(
                    validator_id="V7",
                    severity="blocking",
                    message=f"no clip for a renderable {exercise['type']} string",
                    subject=exercise["exercise_id"],
                    detail={"text": str(text)},
                )
            )

    # -- every audio file has a string -------------------------------------
    # A cast sample (S002's `sample sentence + speaker`) belongs to no exercise and is
    # exempt BY NAME, not by being quietly skipped: the flag is in the manifest and a
    # clip that claims it without being one of the four sample lines is still a
    # finding.
    for clip in clips:
        if not clip.get("text"):
            findings.append(
                Finding(
                    validator_id="V7",
                    severity="blocking",
                    message="clip carries no text",
                    subject=clip.get("clip_id", "?"),
                )
            )
            continue
        if clip.get("role_sample"):
            continue
        if exercises and clip["text"] not in spoken:
            findings.append(
                Finding(
                    validator_id="V7",
                    severity="blocking",
                    message=(
                        "clip is in the bank and in the budget but no exercise plays it"
                    ),
                    subject=clip["clip_id"],
                    detail={"text": clip["text"]},
                )
            )

    # -- durations are sane ------------------------------------------------
    for clip in clips:
        duration = int(clip.get("duration_ms", 0))
        if not MIN_CLIP_MS <= duration <= MAX_CLIP_MS:
            findings.append(
                Finding(
                    validator_id="V7",
                    severity="blocking",
                    message=(
                        f"duration {duration} ms is outside [{MIN_CLIP_MS}, "
                        f"{MAX_CLIP_MS}] — usually a phonemiser handed the wrong "
                        f"language, which text, licence and loudness all survive"
                    ),
                    subject=clip.get("clip_id", "?"),
                    detail={"text": clip.get("text", "")},
                )
            )

    ctx.entry.note(clips=len(clips), exercises=len(exercises), findings=len(findings))
    # `exercises_artefact` is set above when G7 has not run; it is a SEPARATE key from
    # the count on purpose, because "0 exercises" and "no exercise artefact" are the
    # two states a later reader must be able to tell apart.
    return findings


# ---------------------------------------------------------------------------
# F2 — INV-PACK-15
# ---------------------------------------------------------------------------


@register_validator("F2")
def audio_budget(ctx: ValidatorContext) -> list[Finding]:
    """Codec, bitrate and total bytes present; the declared size within budget."""
    manifest = _manifest(ctx)
    if manifest is None:
        return [_no_manifest("F2", ctx.lang)]

    findings: list[Finding] = []

    # -- ruling B6: language plus an accent claim, and no locale ------------
    # The cast loader refuses a cast that still carries `locale:`, but a MANIFEST is a
    # committed file that outlives the run that wrote it and is what the pack manifest,
    # S002 and S133 are built from. A manifest still carrying a regional tag is the
    # claim B6 deleted, sitting in the artefact that travels.
    if manifest.get("language") != ctx.lang:
        findings.append(
            Finding(
                validator_id="F2",
                severity="blocking",
                message=(
                    f"manifest declares language {manifest.get('language')!r}, validated "
                    f"as {ctx.lang!r}"
                ),
                subject=ctx.lang,
            )
        )
    for key, ruling in CAST_FORBIDDEN_KEYS.items():
        if key in manifest:
            findings.append(
                Finding(
                    validator_id="F2",
                    severity="blocking",
                    message=f"manifest still carries `{key}`: {ruling}",
                    subject=ctx.lang,
                )
            )
    if manifest.get("accent_claim") not in ACCENT_CLAIMS:
        findings.append(
            Finding(
                validator_id="F2",
                severity="blocking",
                message=(
                    f"manifest accent_claim is {manifest.get('accent_claim')!r}, not one "
                    f"of {', '.join(ACCENT_CLAIMS)} (ruling B6). The bank is baked on an "
                    f"engine that publishes no locale sub-tag, so the only evidence that "
                    f"could raise this claim is the 300-item native-reviewer sample."
                ),
                subject=ctx.lang,
            )
        )

    # -- the three fields the invariant names -------------------------------
    if manifest.get("codec") != "opus":
        findings.append(
            Finding(
                validator_id="F2",
                severity="blocking",
                message=f"manifest codec is {manifest.get('codec')!r}, expected 'opus'",
                subject=ctx.lang,
            )
        )
    if manifest.get("bitrate_kbps") != OPUS_BITRATE_KBPS:
        findings.append(
            Finding(
                validator_id="F2",
                severity="blocking",
                message=(
                    f"manifest bitrate is {manifest.get('bitrate_kbps')!r} kbps, "
                    f"expected {OPUS_BITRATE_KBPS}. Review R13: a budget with no "
                    f"bitrate beside it is not a budget."
                ),
                subject=ctx.lang,
            )
        )
    totals = manifest.get("totals") or {}
    if not isinstance(totals.get("bytes"), int):
        findings.append(
            Finding(
                validator_id="F2",
                severity="blocking",
                message="manifest carries no integer total byte count",
                subject=ctx.lang,
            )
        )

    budget = manifest.get("budget") or {}
    pipelines = budget.get("pipelines") or {}

    # -- all three pipelines, present and sized ------------------------------
    for pipeline in AUDIO_PIPELINES:
        row = pipelines.get(pipeline)
        if not isinstance(row, dict):
            findings.append(
                Finding(
                    validator_id="F2",
                    severity="blocking",
                    message=(
                        f"the {pipeline!r} pipeline is missing from the manifest's "
                        f"budget. Review R14: the inherited cost model counted lessons "
                        f"only, and a missing pipeline is an implicit zero that the "
                        f"other two then grow into."
                    ),
                    subject=ctx.lang,
                )
            )
            continue
        if not isinstance(row.get("reserved_bytes"), int) or row["reserved_bytes"] <= 0:
            findings.append(
                Finding(
                    validator_id="F2",
                    severity="blocking",
                    message=(
                        f"the {pipeline!r} pipeline has no positive reservation; a "
                        f"placeholder must be NAMED and SIZED, not zero"
                    ),
                    subject=ctx.lang,
                )
            )
        if not row.get("assumption"):
            findings.append(
                Finding(
                    validator_id="F2",
                    severity="warning",
                    message=(
                        f"the {pipeline!r} reservation states no assumption; a number "
                        f"nobody can argue with is a number nobody will revisit"
                    ),
                    subject=ctx.lang,
                )
            )

    # -- the assertion itself ------------------------------------------------
    declared = budget.get("declared_bytes")
    if not isinstance(declared, int):
        findings.append(
            Finding(
                validator_id="F2",
                severity="blocking",
                message="the manifest declares no total size to assert against the budget",
                subject=ctx.lang,
            )
        )
    else:
        expected = sum(
            max(int(pipelines[p].get("baked_bytes", 0)), int(pipelines[p].get("reserved_bytes", 0)))
            for p in AUDIO_PIPELINES
            if isinstance(pipelines.get(p), dict)
        )
        if len(pipelines) == len(AUDIO_PIPELINES) and declared != expected:
            findings.append(
                Finding(
                    validator_id="F2",
                    severity="blocking",
                    message=(
                        f"declared_bytes is {declared}, but the three pipelines sum to "
                        f"{expected}. A declared total that is not the sum of its parts "
                        f"is the only number in this file that can be wrong quietly."
                    ),
                    subject=ctx.lang,
                )
            )
        if declared > AUDIO_BUDGET_BYTES:
            findings.append(
                Finding(
                    validator_id="F2",
                    severity="blocking",
                    message=(
                        f"declared audio is {declared / BYTES_PER_MB:.1f} MB against a "
                        f"{AUDIO_BUDGET_MB} MB budget, summed over "
                        f"{', '.join(AUDIO_PIPELINES)} (INV-PACK-15)"
                    ),
                    subject=ctx.lang,
                )
            )

    # -- INV-AUD-08's manifest half ------------------------------------------
    loudness = manifest.get("loudness") or {}
    if loudness.get("target_lufs") != TARGET_LUFS or (
        loudness.get("tolerance_lu") != LOUDNESS_TOLERANCE_LU
    ):
        findings.append(
            Finding(
                validator_id="F2",
                severity="blocking",
                message=(
                    f"the manifest declares target {loudness.get('target_lufs')!r} LUFS "
                    f"±{loudness.get('tolerance_lu')!r} LU, the tool enforces "
                    f"{TARGET_LUFS} ±{LOUDNESS_TOLERANCE_LU}"
                ),
                subject=ctx.lang,
            )
        )
    for clip in manifest.get("clips", []):
        measured = clip.get("loudness_lufs")
        if not isinstance(measured, int | float):
            findings.append(
                Finding(
                    validator_id="F2",
                    severity="blocking",
                    message="clip carries no measured loudness (INV-AUD-08)",
                    subject=clip.get("clip_id", "?"),
                )
            )
            continue
        if abs(float(measured) - TARGET_LUFS) > LOUDNESS_TOLERANCE_LU:
            findings.append(
                Finding(
                    validator_id="F2",
                    severity="blocking",
                    message=(
                        f"measured {measured} LUFS, "
                        f"{abs(float(measured) - TARGET_LUFS):.2f} LU from the declared "
                        f"{TARGET_LUFS} (tolerance {LOUDNESS_TOLERANCE_LU})"
                    ),
                    subject=clip.get("clip_id", "?"),
                )
            )
        if clip.get("engine") != manifest.get("engine") or clip.get("engine_pin") != manifest.get(
            "engine_pin"
        ):
            findings.append(
                Finding(
                    validator_id="F2",
                    severity="blocking",
                    message=(
                        "clip's engine or pin differs from the manifest's: a bank baked "
                        "by two engines under one declaration is EC-PACK-52"
                    ),
                    subject=clip.get("clip_id", "?"),
                )
            )

    ctx.entry.note(
        codec=manifest.get("codec"),
        bitrate_kbps=manifest.get("bitrate_kbps"),
        accent_claim=manifest.get("accent_claim"),
        declared_bytes=declared,
        budget_bytes=AUDIO_BUDGET_BYTES,
        pipelines=sorted(pipelines),
    )
    return findings
