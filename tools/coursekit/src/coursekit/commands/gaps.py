"""`coursekit gaps <lang>` — the authoring brief, one JSON line per gap slot.

G4 emits 490 gap slots for Spanish (measured 2026-09-12 at the frozen ingest cap) and
every one of them needs twenty authored candidates. The author needs, per slot: which
slot it is in G4's OWN key space, which lemmas the learner already has, which lemma the
slot is reserved to teach, the unit's grammar concept, and the unit's title and function
so the sentence is about something.
All of that exists inside `build/<lang>/`, spread over two artefacts, in the shape a
stage reads rather than the shape a person reads. This verb joins them.

## It is a report, and G5 never reads it

The committed output (`content/<lang>/authoring/gap-brief.jsonl`) carries
`"kind": "derived-snapshot"` on its header line and names the build it was derived
from. That label is load-bearing, not decoration.

G5's enforcement is the `stale_ledger` axis, and it runs against the ledger **G4
emitted in the build being run** — never against this file. If G5 read the brief, then a
brief regenerated at a different ingest cap, or committed from a laptop, would
*redefine* what the candidates are checked against, and a candidates file and a brief
that agreed with each other would pass while both disagreed with the course. That is
exactly the second inlined notion of the ledger INV-PACK-40 forbids. So the brief is
written by this command, read by people, and imported by nothing:
`tests/test_gaps_command.py` fails if any stage imports this module or opens that path.

## The token window is per slot, and it says why

`token_window` used to be the course-wide `[MIN_TOKENS, MAX_TOKENS]` on every row, which
was a fact about the config and not about the slot. It is now
`[min_tokens_for_slot(...), MAX_TOKENS]` — the same function G5's length axis calls, with
the same G2 lexicon behind it — so a slot whose permitted window cannot hold a verb prints
`[1, 12]` and carries `verbless_window: true` beside it (founder ruling B9(b)).

That is not cosmetic. `u1/l1/s0 … s8` went unauthored through two rounds because the brief
said those slots needed three tokens, three tokens of `{bueno, día, hola, noche, tarde}`
is a word list, and two independent authoring lanes refused to write one. The number an
author reads has to be the number the stage enforces.

## The digest is the join

Each row carries `ledger_digest`, computed by `stages.g5_gapfill.ledger_digest` — the
same function G5 checks with, imported, not re-implemented. An author copies it onto
every candidate they write for that slot. If the course is rebuilt at a different cap
and the slot's vocabulary moves, the digest moves with it and every candidate written
against the old one fails `stale_ledger` by name. That is the freeze this brief is a
snapshot of, and `digest` on the header line is the same function over every slot's
digest in emission order, so one string says whether a whole brief is still current.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from pathlib import Path
from typing import Any

import typer

from ..artifacts import read_records
from ..config import EXIT_MISSING_INPUT, EXIT_OK
from ..config.g5 import (
    GAP_BRIEF_FILENAME,
    GAP_BRIEF_KIND,
    GAP_BRIEF_SCHEMA,
    MIN_CANDIDATES_PER_SLOT,
    MIN_TOKENS,
    MIN_TOKENS_VERBLESS_LESSON,
    min_tokens_for_slot,
)
from ..config.g5 import MAX_TOKENS as GAP_MAX_TOKENS
from ..inputs import MissingInput
from ..runlog import read_entries
from ..stages.g5_gapfill import Slot, ledger_digest, pos_by_lemma
from ._run import check_language, fail

__all__ = ["brief_path", "gap_brief", "gaps"]


def brief_path(lang: str) -> Path:
    """`content/<lang>/authoring/gap-brief.jsonl`."""
    # Imported here rather than at module scope so the "no stage imports this module"
    # test can be about imports and not about a cycle.
    from ..config.g5 import GAP_BRIEF_DIRNAME
    from ..stages.g5_gapfill import content_root

    return content_root() / lang / GAP_BRIEF_DIRNAME / GAP_BRIEF_FILENAME


def _units(lang: str) -> dict[int, dict[str, Any]]:
    """G3's unit rows by `unit_index`.

    The unit title and function come from here rather than from a second read of
    `curriculum.yaml`. They are the same strings — G3 copies them off the curriculum —
    but they arrive through the build, so a brief can never describe a unit the build
    does not have. Two readers of one YAML file is how a brief and a course drift.
    """
    try:
        rows = list(read_records("unit_assignment", lang=lang))
    except FileNotFoundError:
        return {}
    return {int(row["unit_index"]): row for row in rows}


def gap_brief(lang: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Every gap slot as one row, plus the header that says which build they came from.

    Raises `MissingInput` when G4 or G3 has not run: a brief with no gaps in it and a
    brief that could not be built are different facts, and only one of them means
    "nothing left to author".
    """
    units = _units(lang)
    if not units:
        raise MissingInput(
            f"no G3 unit assignments for {lang!r}. Run `coursekit build {lang} --only g3` "
            f"first; a gap brief with no units has no titles, no functions and no "
            f"grammar concepts, which is a brief nobody can author against."
        )

    try:
        items = list(read_records("selected_item", lang=lang))
    except FileNotFoundError as exc:
        # `read_records` raises rather than yielding nothing, and it is right to: an
        # absent artefact is not an empty one. What this command owes on top is the
        # SHAPE of the message — INV-PACK-12 wants the missing input named together with
        # the command that produces it, so the reader does not have to know the build
        # layout to act.
        raise MissingInput(
            f"no G4 selection for {lang!r} ({exc}). Run `coursekit build {lang}` first; "
            f"a gap brief is a view of G4's output and there is nothing to view."
        ) from exc

    # The same lookup G5 uses, imported rather than re-derived. `{}` when G2 has not run,
    # which keeps every slot's window at the strict floor — see `pos_by_lemma`.
    lexicon_pos = pos_by_lemma(lang)

    rows: list[dict[str, Any]] = []
    for item in items:
        if not item["gap"]:
            continue
        unit = units.get(int(item["unit_index"]))
        if unit is None:
            raise MissingInput(
                f"G4 emitted a gap in unit {item['unit_index']} and G3 assigned no such "
                f"unit. The two artefacts are from different builds; rebuild both."
            )
        slot = Slot.of(item)
        slot_min_tokens = min_tokens_for_slot(item["known_lemmas"], item["new_lemmas"], lexicon_pos)
        rows.append(
            {
                "slot": str(slot),
                "unit_index": slot.unit_index,
                "lesson_index": slot.lesson_index,
                "slot_index": slot.slot_index,
                "unit_title": unit["unit_title"],
                "function": unit["function"],
                "grammar_concept": item["grammar_concept"],
                "section_index": unit["section_index"],
                "section_cefr": unit["section_cefr"],
                "register_slot": unit["register_slot"],
                "new_lemmas": list(item["new_lemmas"]),
                "known_lemmas": list(item["known_lemmas"]),
                "ledger_digest": ledger_digest(item["known_lemmas"], item["new_lemmas"]),
                "candidates_required": MIN_CANDIDATES_PER_SLOT,
                # PER SLOT, not per course. The lower bound is `MIN_TOKENS` everywhere
                # except a slot whose permitted window holds no verb, which takes
                # `MIN_TOKENS_VERBLESS_LESSON` (founder ruling B9(b)). The brief printed
                # one course-wide `[3, 12]` before, and an author reading it had no way
                # to know that the nine slots of `u1/l1` admit a one-word fixed phrase —
                # which is the whole reason those nine went unauthored for two rounds.
                # `verbless_window` says WHY the number is what it is, because a bare `1`
                # reads as a typo.
                "token_window": [slot_min_tokens, GAP_MAX_TOKENS],
                "verbless_window": slot_min_tokens != MIN_TOKENS,
            }
        )

    if not rows:
        raise MissingInput(
            f"no gap slots for {lang!r}: either G4 has not run (no `selected_item` "
            f"artefact) or it filled every slot from the corpus. Check "
            f"`build/{lang}/runlog.jsonl` — an empty brief and an absent build read the "
            f"same on the page and are not the same thing."
        )

    return rows, _header(lang, rows)


def _header(lang: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """The first line of the file: what this is, and which build it is a snapshot OF."""
    g4_entries = [entry for entry in read_entries(lang, stage="g4")]
    latest = g4_entries[-1] if g4_entries else {}
    notes = latest.get("notes", {})
    g0 = [entry for entry in read_entries(lang, stage="g0")]
    g0_notes = (g0[-1] if g0 else {}).get("notes", {})

    over_all = hashlib.sha256()
    for row in rows:
        over_all.update(row["ledger_digest"].encode("utf-8"))
        over_all.update(b"\x1f")

    return {
        "schema": GAP_BRIEF_SCHEMA,
        "kind": GAP_BRIEF_KIND,
        "lang": lang,
        "what": (
            "A DERIVED SNAPSHOT of one build's gap list. Authoring input only. G5 never "
            "reads this file: it checks every candidate against the ledger G4 emits in "
            "the build being run, so a brief regenerated at a different ingest cap "
            "invalidates candidates written against this one and says so by name "
            "(reject axis `stale_ledger`). Regenerate with `coursekit gaps <lang>`."
        ),
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "gap_slots": len(rows),
        "candidates_required_total": len(rows) * MIN_CANDIDATES_PER_SLOT,
        # How many of those slots got the relaxed lower bound, and what it is. A reader
        # comparing two briefs needs to see the count move, not hunt for a row whose
        # `token_window` starts with a 1.
        "verbless_slots": sum(1 for row in rows if row["verbless_window"]),
        "digest": over_all.hexdigest(),
        "g4_run_id": latest.get("run_id"),
        "g4_status": latest.get("status"),
        "slots": notes.get("slots"),
        "gap_fraction": notes.get("gap_fraction"),
        "max_pairs": g0_notes.get("max_pairs"),
        "ingested": (g0[-1] if g0 else {}).get("counts", {}).get("written"),
    }


def gaps(language: str, write: bool = True) -> None:
    """Print the brief, and write it beside the content unless `--no-write`."""
    check_language(language)
    try:
        rows, header = gap_brief(language)
    except MissingInput as exc:
        raise fail(f"gaps: {exc}", EXIT_MISSING_INPUT) from exc

    lines = [json.dumps(header, ensure_ascii=False)]
    lines.extend(json.dumps(row, ensure_ascii=False) for row in rows)
    document = "\n".join(lines) + "\n"

    if write:
        target = brief_path(language)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(document, encoding="utf-8")
        typer.secho(f"gap brief: {target}", fg=typer.colors.BLUE)
    else:
        typer.echo(document, nl=False)

    # stderr, always. `--no-write` puts the brief on stdout and a status line mixed into
    # it makes `coursekit gaps es --no-write > brief.jsonl` produce a file whose last
    # line is not JSON — which is the shape of bug that gets found by the consumer.
    typer.secho(
        f"{language}: {header['gap_slots']} gap slot(s), "
        f"{header['candidates_required_total']} candidates required "
        f"({MIN_CANDIDATES_PER_SLOT} per slot), "
        f"{header['verbless_slots']} verbless slot(s) at {MIN_TOKENS_VERBLESS_LESSON}-"
        f"{GAP_MAX_TOKENS} tokens, ledger digest {header['digest'][:16]}",
        fg=typer.colors.GREEN,
        err=True,
    )
    raise typer.Exit(code=EXIT_OK)
