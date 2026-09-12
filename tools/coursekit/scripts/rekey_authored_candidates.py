#!/usr/bin/env python3
"""Re-key the authored candidate shards onto the gap list G4 has just emitted.

    uv run python scripts/rekey_authored_candidates.py es [--apply]

**Founder ruling B9, 2026-09-12**, last clause: *"Re-key only rows whose `ledger_digest`
changes."* This is that step, and it exists because B9's other three clauses move the
ledger:

* B9(a) put a lemma-normalisation table in the G1 adapter, so surfaces that used to
  lemmatise to nothing in the lexicon now reach a real lemma;
* B9(c) made G3 fail the build on a target lexeme no form of which the pinned lemmatiser
  can reach, which forced `content/es/curriculum.yaml` to declare the lemmas the model
  actually produces and to drop the ones it merges.

Measured at the P2 round-3 integration: G3 now assigns **945 of 952** authored lexemes
with **7 deferred**, where the frozen build assigned **928 of 990** with **63 deferred**.
A different ledger admits different corpus sentences, so G4's gap list moves — 494 gaps
against the frozen brief's 490 — and **9,269 of 9,812 authored rows** name a window whose
digest has changed. G5's `stale_ledger` axis rejects every one of them, which is correct:
the axis asks "were you written against THIS window?" and the answer was no.

## Why re-keying is not laundering a stale row

`stale_ledger` is a fingerprint, not a content check. Everything substantive happens
AFTER it in `_axis`: `out_of_vocabulary` re-lemmatises the text and refuses any lemma
outside `known | new`, `new_lemma_budget` counts the introductions against the slot's own
reserved set, `length` applies the slot's token window, `duplicate` applies the unit's.
So a row that is re-keyed and then still accepted has been measured against the new
window on every axis that reads the text. A row whose text no longer fits comes back as
`out_of_vocabulary` — by name, in the reject census, where it can be counted.

What re-keying MUST NOT do is invent a slot. A row whose slot is not in the new gap list
is not re-keyed onto a neighbouring slot: it is written to `--orphan-dir` with the reason,
outside the `*.jsonl` glob G5 reads, so the work survives for a future re-key without
being smuggled into a window nobody wrote it for. INV-PACK-10 is the rule this obeys: a
candidate that fails its window is discarded, never patched.

## What it writes

For every authored row whose slot is still a gap:

* `ledger_digest` <- `ledger_digest(gap.known_lemmas, gap.new_lemmas)`
* `new_lemmas`    <- `gap.new_lemmas`
* `rekeyed` <- `{"from_digest": …, "from_new_lemmas": [...], "g4_run_id": …, "at": …}`,
  once, and never overwritten if the row already carries one from an earlier re-key —
  the FIRST digest a row was authored against is the audit trail, and losing it is losing
  the only evidence of which window the sentence was actually written for.

Rows whose digest and reserved set are already right are left byte-identical.

Dry-run by default: it prints the census and writes nothing without `--apply`.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "coursekit" / "src"))

from coursekit.stages.g5_gapfill import ledger_digest  # noqa: E402

Slot = tuple[int, int, int]


def slot_name(slot: Slot) -> str:
    unit, lesson, index = slot
    return f"u{unit}/l{lesson}/s{index}"


def gap_rows(build_root: Path, lang: str) -> dict[Slot, dict[str, Any]]:
    """G4's gap rows, keyed by slot. The build being re-keyed against, not a brief.

    `content/<lang>/authoring/gap-brief.jsonl` is a DERIVED SNAPSHOT (`config/g5.py`
    `GAP_BRIEF_KIND`) and G5 never reads it, so neither does this: the authority is the
    `selected_item` artefact of the build that is about to run.
    """
    path = build_root / lang / "g4" / "selected.jsonl"
    if not path.is_file():
        raise SystemExit(f"{path} does not exist: run `coursekit build {lang}` through G4 first")
    out: dict[Slot, dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("gap"):
            out[(row["unit_index"], row["lesson_index"], row["slot_index"])] = row
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lang")
    parser.add_argument("--apply", action="store_true", help="write the files")
    parser.add_argument("--build-root", default=str(REPO_ROOT / "build"))
    parser.add_argument("--content-root", default=str(REPO_ROOT / "content"))
    parser.add_argument(
        "--orphan-dir",
        default=None,
        help="where rows whose slot is gone are written (default: "
        "content/<lang>/candidates-orphaned/)",
    )
    args = parser.parse_args()

    lang = args.lang
    content = Path(args.content_root) / lang
    shards = sorted((content / "candidates").glob("*.jsonl"))
    legacy = content / "candidates.jsonl"
    if legacy.is_file():
        shards.append(legacy)
    if not shards:
        raise SystemExit(f"no authored candidate shards under {content}")

    gaps = gap_rows(Path(args.build_root), lang)
    orphan_dir = Path(args.orphan_dir) if args.orphan_dir else content / "candidates-orphaned"
    stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    run_id = next(iter(gaps.values()), {}).get("run_id")

    census: Counter[str] = Counter()
    orphan_slots: set[Slot] = set()
    per_file_rekeyed: Counter[str] = Counter()

    for shard in shards:
        rows = [
            json.loads(line)
            for line in shard.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        keep: list[dict[str, Any]] = []
        orphans: list[dict[str, Any]] = []
        for row in rows:
            slot: Slot = (
                row["slot"]["unit_index"],
                row["slot"]["lesson_index"],
                row["slot"]["slot_index"],
            )
            gap = gaps.get(slot)
            if gap is None:
                census["orphaned"] += 1
                orphan_slots.add(slot)
                orphans.append({**row, "orphaned_because": "the slot is not in G4's gap list"})
                continue
            wanted_digest = ledger_digest(gap["known_lemmas"], gap["new_lemmas"])
            wanted_new = list(gap["new_lemmas"])
            if row["ledger_digest"] == wanted_digest and sorted(row["new_lemmas"]) == sorted(
                wanted_new
            ):
                census["unchanged"] += 1
                keep.append(row)
                continue
            census["rekeyed"] += 1
            per_file_rekeyed[shard.name] += 1
            updated = dict(row)
            if "rekeyed" not in updated:
                updated["rekeyed"] = {
                    "from_digest": row["ledger_digest"],
                    "from_new_lemmas": list(row["new_lemmas"]),
                    "g4_run_id": run_id,
                    "at": stamp,
                    "why": "founder ruling B9: re-key only rows whose ledger_digest changes",
                }
            updated["ledger_digest"] = wanted_digest
            updated["new_lemmas"] = wanted_new
            keep.append(updated)

        if args.apply:
            shard.write_text(
                "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in keep),
                encoding="utf-8",
            )
            if orphans:
                orphan_dir.mkdir(parents=True, exist_ok=True)
                target = orphan_dir / f"{shard.stem}.orphaned.jsonl"
                target.write_text(
                    "".join(
                        json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n"
                        for row in orphans
                    ),
                    encoding="utf-8",
                )

    unauthored = sorted(
        slot for slot in gaps if slot not in _authored_slots(shards) and slot not in orphan_slots
    )

    print(f"gap slots in this build: {len(gaps)}")
    print(f"rows rekeyed:            {census['rekeyed']}")
    print(f"rows already correct:    {census['unchanged']}")
    print(f"rows orphaned:           {census['orphaned']} across {len(orphan_slots)} slot(s)")
    if orphan_slots:
        print("  " + ", ".join(slot_name(slot) for slot in sorted(orphan_slots)))
    print(f"gap slots with no authored row at all: {len(unauthored)}")
    if unauthored:
        print("  " + ", ".join(slot_name(slot) for slot in unauthored))
    for name, count in sorted(per_file_rekeyed.items()):
        print(f"  {name}: {count} rekeyed")
    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
    return 0


def _authored_slots(shards: list[Path]) -> set[Slot]:
    out: set[Slot] = set()
    for shard in shards:
        for line in shard.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            out.add(
                (
                    row["slot"]["unit_index"],
                    row["slot"]["lesson_index"],
                    row["slot"]["slot_index"],
                )
            )
    return out


if __name__ == "__main__":
    raise SystemExit(main())
