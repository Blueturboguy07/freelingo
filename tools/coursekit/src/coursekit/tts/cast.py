"""The cast contract: who speaks, with which voice, and what a re-bake key is.

`content/<lang>/cast.yaml` is the file. This module loads it, refuses every shape that
would make a bank unreproducible, and computes the one value the whole stage turns on:

    clip_id = rebake_key(cast, role, text)

INV-AUD-08's second clause lives in that function. A clip's id hashes the ENGINE and
the engine's version pin alongside the voice, the rate, the codec, the bitrate and the
target loudness — so two clips identical in every way except the synthesiser that made
them are different clips with different ids. The failure that clause is written against
(EC-PACK-52) is a bank re-baked on a new engine reusing the old content hashes: every
file on disk keeps its name, the manifest keeps its digests, nothing looks stale, and
one character's voice has silently changed mid-course.

The other half of the file is the cast's own arithmetic. `weights` maps Kokoro voice
ids to their share of a blended style vector; a single entry at 1.0 is a stock voice.
Kokoro v1.0 publishes exactly three Spanish style vectors against a four-role cast, so
a blend is not a flourish — it is the only way to cast four speakers from this roster
without a cloud key, and `cast.yaml` records that as a decision rather than a table
cell.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from ..config import LOCALE_BY_LANGUAGE, OPUS_BITRATE_KBPS
from ..config.g8 import (
    AUDIO_MANIFEST_VERSION,
    BAKE_ENGINE_BY_LANGUAGE,
    CAST_FILENAME,
    CAST_ROLES,
    CONTENT_DIRNAME,
    CONTENT_ROOT_ENV_VAR,
    LOUDNESS_TOLERANCE_LU,
    TARGET_LUFS,
)

__all__ = [
    "Cast",
    "CastError",
    "CastRole",
    "cast_path",
    "content_root",
    "load_cast",
    "rebake_key",
]


class CastError(ValueError):
    """A cast file that cannot be trusted to produce the same bank twice."""


@dataclass(frozen=True, slots=True)
class CastRole:
    """One speaker. `weights` is a blend over engine voice ids; `rate` is its pace."""

    id: str
    display_name: str
    weights: tuple[tuple[str, float], ...]
    rate: float
    stock: bool

    @property
    def voice_id(self) -> str:
        """The canonical voice spec, and the thing the re-bake key hashes.

        Sorted by voice id and rendered at fixed precision so a YAML reorder, a
        `0.55` written as `0.550`, or a dict iteration order can never change a clip
        id. It reads as `em_alex:0.550+ef_dora:0.450@1.080` — deliberately legible,
        because it is also what the manifest and the pack detail screen show.
        """
        blend = "+".join(f"{voice}:{weight:.3f}" for voice, weight in self.weights)
        return f"{blend}@{self.rate:.3f}"


@dataclass(frozen=True, slots=True)
class Cast:
    """One language's cast, as loaded and checked."""

    language: str
    locale: str
    engine: str
    engine_pin: str
    engine_licence: str
    roles: tuple[CastRole, ...]
    target_lufs: float
    tolerance_lu: float
    bitrate_kbps: int

    def role(self, role_id: str) -> CastRole:
        for role in self.roles:
            if role.id == role_id:
                return role
        raise CastError(
            f"{self.language}: no cast role {role_id!r}; the cast declares "
            f"{', '.join(role.id for role in self.roles)}"
        )


# ---------------------------------------------------------------------------
# Where the file lives
# ---------------------------------------------------------------------------


def content_root() -> Path:
    """`<repo>/content`, or `$COURSEKIT_CONTENT_ROOT`.

    The walk is by path shape rather than a `.git` probe, for the reason
    `artifacts._repo_root` gives: `.git` is a FILE inside a worktree, and this package
    is run from worktrees all day.
    """
    override = os.environ.get(CONTENT_ROOT_ENV_VAR)
    if override:
        return Path(override)
    # tools/coursekit/src/coursekit/tts/cast.py -> five parents is tools/, six is root.
    return Path(__file__).resolve().parents[5] / CONTENT_DIRNAME


def cast_path(lang: str) -> Path:
    return content_root() / lang / CAST_FILENAME


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def load_cast(lang: str, *, path: Path | None = None) -> Cast:
    """Load and check one language's cast, or raise `CastError`.

    Every check here is a way a bank stops being reproducible, not a style rule:

    - a missing or extra role means a generated dialogue has a speaker with no voice,
      or a voice nothing will ever use;
    - weights that do not sum to 1 produce a style vector whose magnitude, and
      therefore whose timbre, depends on how many voices somebody listed;
    - a locale that disagrees with the EC-PACK-17 ruling means two files claim
      different things about the same course;
    - an engine that disagrees with `BAKE_ENGINE_BY_LANGUAGE` is how a German cast
      ends up pointed at a voice tree that has no German, or a Japanese one at the
      CC BY-NC-SA Piper voice review R7 ruled out.
    """
    target = path or cast_path(lang)
    if not target.exists():
        raise CastError(
            f"no cast at {target}. A bake cannot pick voices for itself: "
            f"a cast chosen per-run is a bank that changes between runs."
        )
    raw = yaml.safe_load(target.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise CastError(f"{target}: expected a mapping at the top level")

    _require_version(raw, target)
    if raw.get("language") != lang:
        raise CastError(f"{target}: declares language {raw.get('language')!r}, loaded as {lang!r}")

    locale = raw.get("locale")
    expected_locale = LOCALE_BY_LANGUAGE[lang]
    if locale != expected_locale:
        raise CastError(
            f"{target}: locale {locale!r} contradicts the EC-PACK-17 ruling of one "
            f"locale per course ({expected_locale}). The ruling is a plan line, so "
            f"changing it is a founder decision, not a YAML edit."
        )

    engine = raw.get("engine")
    expected_engine = BAKE_ENGINE_BY_LANGUAGE[lang]
    if engine != expected_engine:
        raise CastError(
            f"{target}: engine {engine!r}, but {lang} bakes on {expected_engine!r}. "
            f"Kokoro has no German and Piper's only Japanese voice is CC BY-NC-SA "
            f"(review R7), so this mapping is a licence decision, not a preference."
        )

    roles = _load_roles(raw, target)
    loudness = _mapping(raw, "loudness", target)
    codec = _mapping(raw, "codec", target)
    _require_loudness(loudness, target)
    _require_codec(codec, target)

    return Cast(
        language=lang,
        locale=str(locale),
        engine=str(engine),
        engine_pin=_nonempty(raw, "engine_version_pin", target),
        engine_licence=_nonempty(raw, "engine_licence", target),
        roles=roles,
        target_lufs=float(loudness["target_lufs"]),
        tolerance_lu=float(loudness["tolerance_lu"]),
        bitrate_kbps=int(codec["bitrate_kbps"]),
    )


def _require_version(raw: dict[str, Any], target: Path) -> None:
    version = raw.get("schema_version")
    if version != AUDIO_MANIFEST_VERSION:
        raise CastError(
            f"{target}: schema_version {version!r}, expected {AUDIO_MANIFEST_VERSION}. "
            f"A bump re-bakes the bank, so it is never silent."
        )


def _nonempty(raw: dict[str, Any], key: str, target: Path) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise CastError(f"{target}: {key} must be a non-empty string, got {value!r}")
    return value


def _mapping(raw: dict[str, Any], key: str, target: Path) -> dict[str, Any]:
    value = raw.get(key)
    if not isinstance(value, dict):
        raise CastError(f"{target}: {key} must be a mapping, got {type(value).__name__}")
    return value


def _require_loudness(loudness: dict[str, Any], target: Path) -> None:
    """The cast may not declare a loudness contract the tool does not enforce."""
    if float(loudness.get("target_lufs", 0.0)) != TARGET_LUFS:
        raise CastError(
            f"{target}: target_lufs {loudness.get('target_lufs')!r} contradicts "
            f"config/g8.py's {TARGET_LUFS} — the sound bank's target (deep/08 §12). "
            f"Two banks at two targets is EC-PACK-52."
        )
    if float(loudness.get("tolerance_lu", 0.0)) != LOUDNESS_TOLERANCE_LU:
        raise CastError(
            f"{target}: tolerance_lu {loudness.get('tolerance_lu')!r} contradicts "
            f"config/g8.py's {LOUDNESS_TOLERANCE_LU}. INV-AUD-08 measures against a "
            f"DECLARED tolerance; two declarations is none."
        )


def _require_codec(codec: dict[str, Any], target: Path) -> None:
    if codec.get("name") != "opus":
        raise CastError(f"{target}: codec.name {codec.get('name')!r}, expected 'opus'")
    if int(codec.get("bitrate_kbps", 0)) != OPUS_BITRATE_KBPS:
        raise CastError(
            f"{target}: codec.bitrate_kbps {codec.get('bitrate_kbps')!r} contradicts "
            f"config's {OPUS_BITRATE_KBPS}. The budget is written in this number."
        )


def _load_roles(raw: dict[str, Any], target: Path) -> tuple[CastRole, ...]:
    entries = raw.get("roles")
    if not isinstance(entries, list) or not entries:
        raise CastError(f"{target}: roles must be a non-empty list")

    roles: list[CastRole] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise CastError(f"{target}: every role must be a mapping, got {entry!r}")
        role_id = entry.get("id")
        weights = entry.get("weights")
        if not isinstance(weights, dict) or not weights:
            raise CastError(f"{target}: role {role_id!r} has no weights")
        total = 0.0
        pairs: list[tuple[str, float]] = []
        for voice, weight in weights.items():
            if not isinstance(voice, str) or not voice:
                raise CastError(f"{target}: role {role_id!r} has a non-string voice id")
            if not isinstance(weight, int | float) or isinstance(weight, bool):
                raise CastError(f"{target}: role {role_id!r} weight for {voice!r} is not a number")
            if not 0.0 < float(weight) <= 1.0:
                raise CastError(
                    f"{target}: role {role_id!r} weight for {voice!r} is {weight!r}; "
                    f"weights are shares of one style vector, in (0, 1]"
                )
            total += float(weight)
            pairs.append((voice, float(weight)))
        if abs(total - 1.0) > 1e-6:
            raise CastError(
                f"{target}: role {role_id!r} weights sum to {total:.6f}, not 1.0. A "
                f"blend that does not sum to one scales the style vector, which "
                f"changes the timbre by however many voices somebody happened to list."
            )
        rate = entry.get("rate")
        if not isinstance(rate, int | float) or isinstance(rate, bool) or not 0.5 <= rate <= 2.0:
            raise CastError(f"{target}: role {role_id!r} rate {rate!r} is outside [0.5, 2.0]")
        roles.append(
            CastRole(
                id=str(role_id),
                display_name=_nonempty(entry, "display_name", target),
                # Sorted here, once, so `voice_id` is order-independent by construction.
                weights=tuple(sorted(pairs)),
                rate=float(rate),
                stock=bool(entry.get("stock", len(pairs) == 1)),
            )
        )

    seen = [role.id for role in roles]
    if seen != list(CAST_ROLES):
        raise CastError(
            f"{target}: roles are {seen}, expected exactly {list(CAST_ROLES)} in that "
            f"order. A missing role is a generated dialogue with a speaker that has no "
            f"voice; an extra one is a voice nothing will ever play."
        )
    return tuple(roles)


# ---------------------------------------------------------------------------
# The re-bake key (INV-AUD-08)
# ---------------------------------------------------------------------------


def rebake_key(cast: Cast, role_id: str, text: str) -> str:
    """The content-addressed clip id: 16 hex over everything that changes the audio.

    Everything, and nothing else. Adding a field re-bakes the bank, so the list is
    deliberate:

    - `engine` and `engine_pin` — INV-AUD-08's clause. Same voice, same text, new
      synthesiser, new file. EC-PACK-52's failure is exactly the absence of these two.
    - `voice` — the canonical blend-and-rate spec, sorted and fixed-precision.
    - `codec`, `bitrate_kbps`, `target_lufs` — the shipped file differs when any of
      these does, and the manifest asserts sizes against the bitrate.
    - `text` — so one edited line re-renders one file and leaves 7,999 alone.

    `locale` is deliberately NOT in the key: it is a claim about the course, not an
    input to synthesis (see D-CAST-ES-01), and hashing it would re-bake a whole bank
    for a label change.
    """
    role = cast.role(role_id)
    payload = json.dumps(
        {
            "schema": AUDIO_MANIFEST_VERSION,
            "lang": cast.language,
            "engine": cast.engine,
            "engine_pin": cast.engine_pin,
            "voice": role.voice_id,
            "codec": "opus",
            "bitrate_kbps": cast.bitrate_kbps,
            "target_lufs": cast.target_lufs,
            "text": text,
        },
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
