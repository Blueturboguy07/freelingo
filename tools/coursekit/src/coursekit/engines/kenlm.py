"""KenLM perplexity, and the band it is enforced against.

## Why the training text is the oracle-only corpora

OpenSubtitles and CCMatrix/NLLB may never ship a sentence — `inputs.forbid_unshippable`
refuses it at G4. They are exactly the right text to train a language model on, and the
reason is a distinction the licence table already makes: **a language model is a
statistic, not a redistribution.** An n-gram count file is not a copy of the sentences
it was counted over, and nothing in the model reaches the pack; what reaches the pack is
one float per authored sentence and a two-number band.

That is also why this is not a loophole. `train()` refuses a `forbidden` source outright
— a corpus that must never enter the ledger must not enter a statistic over the ledger
either — and records every source it read, with its licence, in the runlog. The
distinction is "oracle_only text may inform a statistic", not "anything may".

## Why the band is percentiles of the training corpus

An absolute band is meaningless without naming the model that produced it: perplexity is
a property of a model, not of a sentence. `pyproject.toml` pins KenLM to a commit for
that reason (a band computed against one build and enforced against another is a V8 that
drifts with no diff), and this module finishes the job — the band is derived from a
held-out slice of the same text, at `PERPLEXITY_BAND_PERCENTILES`, and written beside
the binary model as `band.json`. A model and the band enforced against it travel
together or neither is meaningful.

## What is absent here, and what that costs

The pip package ships the **query** module only: `kenlm.Model`, and no `lmplz`. Training
needs the binaries built from the source tree (`cmake .. && make`, which wants Boost).
`train()` therefore shells out and fails loudly when they are missing, naming the build
command. It does not fall back to a hand-rolled counter — a home-made ARPA would produce
perplexities that look like perplexities and a band nobody can reproduce, which is the
silent-degradation failure `docs/pipeline.md` makes a rule about.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from statistics import quantiles
from typing import Any

from ..config.g6 import (
    ENGINE_NONE,
    KENLM_BAND_FILENAME,
    KENLM_BUILD_BINARY,
    KENLM_ORDER,
    KENLM_TRAIN_BINARY,
    PERPLEXITY_BAND_PERCENTILES,
)
from ..engines import register_engine

__all__ = ["KenLMEngine", "KenLMUnavailable", "band_from_scores", "build", "train"]


class KenLMUnavailable(RuntimeError):
    """The module, the binaries or a trained model are missing. Never a default band."""


@dataclass(slots=True)
class KenLMEngine:
    """One trained model and the band derived from its own training text."""

    model_path: Path
    band: tuple[float, float]
    id: str = "kenlm"
    _model: Any = None

    def probe(self, lang: str) -> dict[str, Any]:
        """Load the model, or report exactly why perplexity cannot be checked."""
        try:
            import kenlm  # noqa: PLC0415 - optional `lm` group, probed not assumed
        except ImportError:
            return {
                "available": False,
                "perplexity_engine": ENGINE_NONE,
                "reason": (
                    "the 'lm' dependency group is not installed; "
                    "`uv sync --group lm` from tools/coursekit"
                ),
                "detail": {},
            }
        if not self.model_path.exists():
            return {
                "available": False,
                "perplexity_engine": ENGINE_NONE,
                "reason": (
                    f"no trained model at {self.model_path}. There are no pre-built "
                    f"KenLM models; train one per language with "
                    f"`{KENLM_TRAIN_BINARY} -o {KENLM_ORDER}` over the oracle corpora."
                ),
                "detail": {},
            }
        self._model = kenlm.Model(str(self.model_path))
        return {
            "available": True,
            "perplexity_engine": f"{self.id}/{Path(self.model_path).name}",
            "reason": "",
            "detail": {
                "model": str(self.model_path),
                "order": self._model.order,
                "band": list(self.band),
                "band_percentiles": list(PERPLEXITY_BAND_PERCENTILES),
                "lang": lang,
            },
        }

    def perplexity(self, text: str) -> float:
        if self._model is None:
            raise KenLMUnavailable(
                "probe() has not run or reported unavailable; a perplexity read off an "
                "unloaded model would be a number with no model behind it"
            )
        return float(self._model.perplexity(text))

    def in_band(self, text: str) -> tuple[bool, float]:
        score = self.perplexity(text)
        low, high = self.band
        return low <= score <= high, score


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------


def band_from_scores(scores: list[float]) -> tuple[float, float]:
    """The band, as percentiles of the held-out slice's own perplexities.

    Two or fewer scores has no distribution to speak of and raises, rather than
    returning a band that is really just the two numbers it was handed.
    """
    if len(scores) < 3:
        raise KenLMUnavailable(
            f"a band needs a distribution; {len(scores)} held-out score(s) is not one"
        )
    low_pct, high_pct = PERPLEXITY_BAND_PERCENTILES
    cut = quantiles(sorted(scores), n=100, method="inclusive")
    return (cut[int(low_pct) - 1], cut[int(high_pct) - 1])


def train(
    text_path: Path,
    out_dir: Path,
    *,
    holdout: list[str],
    order: int = KENLM_ORDER,
) -> dict[str, Any]:
    """`lmplz` then `build_binary`, then derive the band from `holdout`.

    Minutes to hours on a real corpus, which is why every caller runs it out of band and
    polls a log. Returns the paths and the band; writes `band.json` beside the model.
    """
    binaries = (KENLM_TRAIN_BINARY, KENLM_BUILD_BINARY)
    missing = [binary for binary in binaries if shutil.which(binary) is None]
    if missing:
        raise KenLMUnavailable(
            f"{', '.join(missing)} not on PATH. The pip package ships the query module "
            f"only; the trainers are built from the source tree "
            f"(`cmake .. && make -j4`, needs Boost) and put on PATH. There is no "
            f"fallback: a hand-rolled n-gram count produces a band nobody can reproduce."
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    arpa = out_dir / f"{text_path.stem}.arpa"
    binary = out_dir / f"{text_path.stem}.binary"

    with text_path.open("rb") as source, arpa.open("wb") as sink:
        subprocess.run(  # noqa: S603 - fixed argv, no shell
            [KENLM_TRAIN_BINARY, "-o", str(order)], stdin=source, stdout=sink, check=True
        )
    subprocess.run(  # noqa: S603 - fixed argv, no shell
        [KENLM_BUILD_BINARY, str(arpa), str(binary)], check=True
    )

    engine = KenLMEngine(model_path=binary, band=(0.0, float("inf")))
    probe = engine.probe("")
    if not probe["available"]:
        raise KenLMUnavailable(probe["reason"])
    band = band_from_scores([engine.perplexity(line) for line in holdout])

    (out_dir / KENLM_BAND_FILENAME).write_text(
        json.dumps(
            {
                "model": binary.name,
                "order": order,
                "band": list(band),
                "percentiles": list(PERPLEXITY_BAND_PERCENTILES),
                "holdout_sentences": len(holdout),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return {"arpa": arpa, "model": binary, "band": band}


def load_band(model_path: Path) -> tuple[float, float] | None:
    """The band recorded beside a model, or `None` if the model travelled alone."""
    band_file = model_path.parent / KENLM_BAND_FILENAME
    if not band_file.exists():
        return None
    payload = json.loads(band_file.read_text(encoding="utf-8"))
    low, high = payload["band"]
    return (float(low), float(high))


@register_engine("kenlm")
def build(model: str | None = None, band: str | None = None) -> KenLMEngine | None:
    """The engine for a given model path, or `None` when no model was named.

    `band` is `"<low>,<high>"` from `--set kenlm_band=...` and overrides `band.json`;
    it exists so a build can tighten a band without retraining. A model with neither is
    refused rather than given a default: a band nobody chose is a gate nobody set.
    """
    if not model:
        return None
    model_path = Path(model)
    if band:
        low_text, _, high_text = band.partition(",")
        bounds = (float(low_text), float(high_text))
    else:
        loaded = load_band(model_path)
        if loaded is None:
            raise KenLMUnavailable(
                f"{model_path} has no {KENLM_BAND_FILENAME} beside it and no "
                f"--set kenlm_band=<low>,<high> was given. A perplexity with no band "
                f"is a number nobody can fail."
            )
        bounds = loaded
    return KenLMEngine(model_path=model_path, band=bounds)
