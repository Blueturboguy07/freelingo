"""Source-backed scheduler objectives; a sentence hash is not a lexeme declaration."""

from .grading import fields, number, require, reviewed, text


def scheduler_objectives(draft, exercise, source, unit, lexemes, tags, targets):
    """Resolve explicit reviewed objectives, never the first or all sentence tags.

    The current 17-shape producer has no script/grapheme teaching carrier. Those
    source objectives remain unsupported until actual script evidence is supplied.
    """
    if draft["gradable"]["family"] == "match":
        require(
            "schedulerObjective" not in draft,
            "scheduler objective: a match uses exact semantic left targets",
        )
        objectives = {target: {"kind": "lexeme", "itemRef": target} for target in targets}
    else:
        declaration = draft.get("schedulerObjective")
        reviewed(
            declaration,
            {"exerciseId", "sourceId", "sourceSha256", "kind", "itemRef"},
            "scheduler objective",
        )
        require(
            declaration["exerciseId"] == exercise["exercise_id"]
            and declaration["sourceId"] == draft["sourceId"]
            and declaration["sourceSha256"] == draft["sourceSha256"],
            "scheduler objective: stale source/exercise binding",
        )
        objectives = {exercise["item_id"]: {key: declaration[key] for key in ("kind", "itemRef")}}
    actual = {
        (row["item_kind"], row["item_ref"])
        for row in tags
        if row["exercise_id"] == exercise["exercise_id"]
    }
    for value in objectives.values():
        kind, ref = value["kind"], value["itemRef"]
        if kind == "lexeme":
            lexeme = lexemes.get(ref)
            require(
                lexeme is not None and ("lexeme", lexeme["lemma"]) in actual,
                "scheduler objective: missing actual lexeme/tag declaration",
            )
            if draft["gradable"]["family"] != "match":
                tokens = source.get("analysis", {}).get("tokens", [])
                require(
                    any(
                        token.get("lemma") == lexeme["lemma"] and token.get("pos") == lexeme["pos"]
                        for token in tokens
                    )
                    or (
                        source.get("lexeme_id") == ref
                        and source.get("lemma") == lexeme["lemma"]
                        and source.get("pos") == lexeme["pos"]
                    ),
                    "scheduler objective: lexeme absent from exact source evidence",
                )
        elif kind == "grammarConcept":
            require(
                ("grammar_concept", ref) in actual and unit.get("grammar_concept") == ref,
                "scheduler objective: missing exact grammar/unit declaration",
            )
        else:
            require(False, "scheduler objective: unsupported source kind")
    return objectives


def validate_objective_tags(tags, exercises):
    require(isinstance(tags, (list, tuple)), "scheduler objective: actual tags missing")
    keys = set()
    for row in tags:
        fields(row, {"exercise_id", "item_kind", "item_ref", "is_new"}, "scheduler objective tag")
        key = (row["exercise_id"], row["item_kind"], row["item_ref"])
        require(
            key not in keys
            and row["exercise_id"] in exercises
            and isinstance(row["item_ref"], str)
            and bool(row["item_ref"].strip())
            and row["item_kind"] in {"lexeme", "grammar_concept", "grapheme"}
            and type(row["is_new"]) is int
            and row["is_new"] in {0, 1},
            "scheduler objective: invalid/duplicate actual tag",
        )
        keys.add(key)


def objective_definitions(units, lexemes):
    """Only the source-defining columns; unrelated presentation fields do not drift IDs."""
    unit_rows = []
    for row in units:
        unit_rows.append(
            {
                "unit_id": text(row.get("unit_id"), "objective definitions unit"),
                "unit_index": number(row.get("unit_index"), "objective definitions unit index"),
                "grammar_concept": text(
                    row.get("grammar_concept"), "objective definitions concept"
                ),
            }
        )
    lexical_rows = [
        {
            key: text(row.get(key), "objective definitions lexeme " + key)
            for key in ("lexeme_id", "lemma", "pos")
        }
        for row in lexemes
    ]
    return {
        "units": sorted(unit_rows, key=lambda row: row["unit_id"]),
        "lexemes": sorted(lexical_rows, key=lambda row: row["lexeme_id"]),
    }
