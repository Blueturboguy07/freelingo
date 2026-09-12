"""The `sample` stage — `coursekit sample <lang>`.

A thin adapter. Everything it does lives in `coursekit.sample`, which is pure and
testable; this module exists so the verb reaches the registry like every other, and so
the draw's seed and allocation land in the provenance log beside the stages that
produced what it sampled.

Options (via `--set key=value`, the scaffold's option channel — `cli.py` deliberately
carries no per-stage flags so that eight lanes never edit one dispatch table):

    coursekit sample es --set n=300 --set seed=20260911

`n` defaults to `config.REVIEWER_SAMPLE_ITEMS` (300) and `seed` to
`config.sample.SAMPLE_SEED`, so a bare `coursekit sample es` is the 300-item draw the
plan's P2 row calls for.

Owner: p2-validate-sample-ci
"""

from __future__ import annotations

from ..config import REVIEWER_SAMPLE_ITEMS
from ..config.sample import SAMPLE_SEED
from ..sample import draw_sample, write_sample
from ..validators.pack import SuiteInputMissing
from . import StageContext, StageResult, register_stage


@register_stage("sample", reads=("exercise", "selected_item", "ingested_sentence"))
def sample(ctx: StageContext) -> StageResult:
    """Draw the stratified reviewer sheet and record how it was drawn."""
    try:
        n = int(ctx.options.get("n", REVIEWER_SAMPLE_ITEMS))
        seed = int(ctx.options.get("seed", SAMPLE_SEED))
    except ValueError as exc:
        return StageResult(ok=False, message=f"--set n/seed must be integers: {exc}")

    try:
        sheet = draw_sample(ctx.lang, n=n, seed=seed)
    except SuiteInputMissing as exc:
        return StageResult(ok=False, message=str(exc))

    sheet_path, summary_path = write_sample(sheet)
    ctx.entry.read = sheet.population
    ctx.entry.written = sheet.drawn
    ctx.entry.note(
        seed=sheet.seed,
        strata=list(sheet.strata),
        distinct_strata=len(sheet.allocation),
        requested=sheet.requested,
        drawn=sheet.drawn,
        population=sheet.population,
        sheet=str(sheet_path),
        summary=str(summary_path),
    )
    if sheet.drawn < sheet.requested:
        return StageResult(
            ok=False,
            message=(
                f"asked for {sheet.requested} items and the build only has "
                f"{sheet.population}. A short sheet measures a smaller population than "
                f"the published rate claims."
            ),
        )
    return StageResult(ok=True, detail=sheet.summary())
