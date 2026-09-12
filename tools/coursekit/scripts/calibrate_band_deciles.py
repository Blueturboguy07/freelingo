#!/usr/bin/env python
"""Calibrate `config/g2.BAND_BY_DECILE` against a real CEFR lexicon, and report the miss.

`scope2/00-FRAMEWORK-ANSWER.md` line 110 specifies the G2 fallback as a "frequency-decile
proxy **calibrated against fr/es/de/en**". A hand-picked decile table is not that, and the
difference is invisible: the proxy is only ever used where the lexicon is absent, so
nothing in a green build ever compares the two. This script is the comparison.

What it does, using the lane's own code so the numbers describe the shipped path:

1. read hermitdave `es_50k.txt` (surface forms — CC BY-SA 4.0 content);
2. push every surface through the G1 adapter (`es_core_news_md` 3.8.0), exactly as
   `stages/g2_band.lemmatise_frequency` does, and sum counts onto `(lemma, UD POS)`;
3. rank, decile with `stages/g2_band.decile_for`;
4. read the real `ELELex.tsv` with `stages/g2_band.read_elelex`;
5. on the lemmas the lexicon covers, score the committed table and fit the best
   monotone (non-decreasing) one by dynamic programming.

**Deviation from the shipped path, stated because it moves the number.** The live stage
takes each lemma's POS from G1's in-context corpus wherever the corpus has it
(`corpus_profile`), and falls back to the context-free tag only for the tail. A
calibration run has no G1 corpus, so every POS here is context-free — which is the worse
tagger (6.1% of the top 3,000 surfaces come back PROPN). The effect is on POS, not on
rank, so the decile distribution is the shipped one and the lexicon *coverage* is a
slight under-count.

The monotone constraint is not decoration: V11 asserts mean sentence difficulty is
non-decreasing across units, and units are built in ledger order, so a proxy that bands a
rarer lemma easier than a commoner one puts V11 in tension with the ordering that produced
it. The unconstrained modal table is printed too, so the cost of the constraint is visible.

Neither input is vendored: ELELex is CC BY-NC-SA (build-machine only, never committed) and
hermitdave is CC BY-SA. Fetch both, then:

    uv run --group nlp python scripts/calibrate_band_deciles.py \
        --frequency /tmp/es_50k.txt --elelex /tmp/ELELex.tsv

Re-run it when the model pin, `ELELEX_MIN_DOCS_FOR_LEVEL` or `DECILE_COUNT` moves, and
paste the report into `BAND_BY_DECILE`'s docstring. It is a founder-visible number, so it
lives next to the constant rather than in a log nobody reads.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:  # pragma: no cover — script entry point
    sys.path.insert(0, str(SRC))

from coursekit.adapters.spacy_es import build as build_es_adapter  # noqa: E402
from coursekit.config.g2 import (  # noqa: E402
    BAND_BY_DECILE,
    DECILE_COUNT,
    ELELEX_LEVELS,
    FREQUENCY_SKIP_POS,
)
from coursekit.stages.g2_band import (  # noqa: E402
    decile_for,
    lemmatise_frequency,
    rank,
    read_elelex,
    read_frequency,
)

#: The bands a proxy may emit, easiest first. Same order as `ELELEX_LEVELS`, upper-cased,
#: because a band on a row is upper-case and a lexicon column name is not.
BANDS: tuple[str, ...] = tuple(level.upper() for level in ELELEX_LEVELS)


def observed(
    frequency: Path, elelex: Path
) -> tuple[list[Counter[str]], int, int]:
    """Per-decile counts of the lexicon's band, plus (ledger lemmas, covered lemmas)."""
    adapter = build_es_adapter()
    adapter.require_self_test()

    surfaces = read_frequency(frequency, lang="es", require_full=True)
    counts, stats = lemmatise_frequency(adapter, surfaces, context_pos={})
    ordered = rank(counts)
    lexicon, _ = read_elelex(elelex)

    print(
        f"  surfaces {len(surfaces)}  ledger lemmas {len(ordered)}  "
        f"skipped {stats['frequency_skipped']}  lexicon entries {len(lexicon)}"
    )

    per_decile: list[Counter[str]] = [Counter() for _ in range(DECILE_COUNT)]
    covered = 0
    total = len(ordered)
    for position, (lemma, pos, _) in enumerate(ordered):
        if pos in FREQUENCY_SKIP_POS:
            continue
        level = lexicon.get((lemma.casefold(), pos))
        if level is None:
            continue
        covered += 1
        per_decile[decile_for(position, total) - 1][level] += 1
    return per_decile, total, covered


def agreement(table: dict[int, str], per_decile: list[Counter[str]]) -> int:
    """How many lexicon-covered lemmas this decile table bands the way ELELex does."""
    return sum(counts[table[index + 1]] for index, counts in enumerate(per_decile))


def best_monotone(per_decile: list[Counter[str]]) -> dict[int, str]:
    """The non-decreasing decile -> band table with the highest agreement.

    Dynamic programming over (decile, band index): `best[d][b]` is the most agreements
    achievable for deciles 1..d with decile d banded `BANDS[b]` and every earlier decile
    banded no harder. Ten deciles by five bands, so exhaustive search would also do — DP
    is here because it stays right if `DECILE_COUNT` or the band set grows.
    """
    width = len(BANDS)
    best = [[0] * width for _ in per_decile]
    back = [[0] * width for _ in per_decile]
    for band_index in range(width):
        best[0][band_index] = per_decile[0][BANDS[band_index]]
    for decile_index in range(1, len(per_decile)):
        for band_index in range(width):
            gain = per_decile[decile_index][BANDS[band_index]]
            previous = max(range(band_index + 1), key=lambda b: best[decile_index - 1][b])
            best[decile_index][band_index] = best[decile_index - 1][previous] + gain
            back[decile_index][band_index] = previous
    last = max(range(width), key=lambda b: best[-1][b])
    chosen = [0] * len(per_decile)
    chosen[-1] = last
    for decile_index in range(len(per_decile) - 1, 0, -1):
        chosen[decile_index - 1] = back[decile_index][chosen[decile_index]]
    return {index + 1: BANDS[band] for index, band in enumerate(chosen)}


def report(per_decile: list[Counter[str]], total: int, covered: int) -> None:
    """Print the distribution, the three tables, and the number that goes in the docstring."""
    print(f"\n  ledger lemmas {total}  lexicon-covered {covered}\n")
    header = "  decile  " + "".join(f"{band:>7}" for band in BANDS) + "     n   modal"
    print(header)
    for index, counts in enumerate(per_decile, start=1):
        n = sum(counts.values())
        modal = max(BANDS, key=lambda band: counts[band]) if n else "-"
        row = "".join(f"{counts[band]:>7}" for band in BANDS)
        print(f"  {index:>6}  {row}{n:>6}   {modal}")

    modal_table = {
        index + 1: (
            max(BANDS, key=lambda band: counts[band]) if sum(counts.values()) else "A1"
        )
        for index, counts in enumerate(per_decile)
    }
    fitted = best_monotone(per_decile)

    print()
    for name, table in (
        ("committed", BAND_BY_DECILE),
        ("modal (unconstrained)", modal_table),
        ("fitted (monotone)", fitted),
    ):
        hits = agreement(table, per_decile)
        share = hits / covered if covered else 0.0
        line = " ".join(f"{decile}:{table[decile]}" for decile in sorted(table))
        print(f"  {name:<22} {share:>6.1%}  {line}")

    wrong = [
        decile
        for decile in sorted(BAND_BY_DECILE)
        if sum(per_decile[decile - 1].values())
        and BAND_BY_DECILE[decile] != modal_table[decile]
    ]
    print(f"\n  committed table's modal band is wrong in {len(wrong)} of {DECILE_COUNT} "
          f"deciles: {wrong}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frequency", type=Path, required=True, help="hermitdave es_50k.txt")
    parser.add_argument("--elelex", type=Path, required=True, help="ELELex.tsv")
    args = parser.parse_args()
    print("calibrate_band_deciles: es, context-free POS (see the module docstring)")
    per_decile, total, covered = observed(args.frequency, args.elelex)
    report(per_decile, total, covered)
    return 0


if __name__ == "__main__":  # pragma: no cover — script entry point
    raise SystemExit(main())
