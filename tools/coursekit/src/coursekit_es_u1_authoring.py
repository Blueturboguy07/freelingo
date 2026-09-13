"""Review-free Spanish unit-one candidate export and deterministic source preflight.

Run by file path with PYTHONPATH pointing at the explicitly selected production
compiler tree. No shared CLI edits, downloads, build stages, approvals or SQLite
writes. A successful preflight certifies source/shape joins only, never language.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sqlite3
from pathlib import Path

INPUTS = (
    "g0/ingested.jsonl",
    "g1/analysed.jsonl",
    "g2/banded.jsonl",
    "g3/units.jsonl",
    "g4/selected.jsonl",
    "g5/candidates.jsonl",
    "g7/exercises.jsonl",
    "g9/pack.sqlite",
    "runlog.jsonl",
)
PENDING = [
    "independent-reviews-missing",
    "current-complete-source-G6-approval-missing",
    "production-profile-and-dictionary-policy-missing",
]


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def file_proof(path):
    sha = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
    return {"sha256": sha.hexdigest(), "bytes": Path(path).stat().st_size}


def verify_file(path, proof):
    if file_proof(path) != proof:
        raise ValueError("source file hash mismatch: " + str(path))


def rows(path):
    with Path(path).open() as stream:
        for line in stream:
            yield json.loads(line)


def unique(values, key):
    result = {}
    for row in values:
        identity = key(row)
        if identity in result:
            raise ValueError("duplicate source identity: " + str(identity))
        result[identity] = row
    return result


def has_review_or_approval(value):
    if isinstance(value, dict):
        return any(
            "review" in key.lower() or "approval" in key.lower() or has_review_or_approval(child)
            for key, child in value.items()
        )
    return isinstance(value, list) and any(map(has_review_or_approval, value))


def source_facts(root, ids):
    """Read exact chosen sources; preserve the raw rows and all SQL definition columns."""
    root = Path(root)
    proofs = {name: file_proof(root / name) for name in INPUTS}
    wanted = set(ids)
    records = unique(
        (r for r in rows(root / "g7/exercises.jsonl") if r["exercise_id"] in wanted),
        lambda r: r["exercise_id"],
    )
    if records.keys() != wanted:
        raise ValueError("requested G7 exercise missing")
    if any(r["unit_index"] != 1 for r in records.values()):
        raise ValueError("bounded authoring requires first-unit sources")
    source_ids = {r["source_sentence_id"] for r in records.values()}
    g0 = unique(
        (r for r in rows(root / INPUTS[0]) if r["sentence_id"] in source_ids),
        lambda r: r["sentence_id"],
    )
    g1 = unique(
        (r for r in rows(root / INPUTS[1]) if r["sentence_id"] in source_ids),
        lambda r: r["sentence_id"],
    )
    g3 = unique(
        (r for r in rows(root / INPUTS[3]) if r["unit_index"] == 1), lambda r: r["unit_index"]
    )
    selected = [r for r in rows(root / INPUTS[4]) if r["unit_index"] == 1]
    first = {}
    for row in rows(root / INPUTS[5]):
        if row["accepted"] and row["unit_index"] == 1:
            first.setdefault((row["unit_index"], row["lesson_index"], row["slot_index"]), row)
    selected_by_source = {}
    for row in selected:
        slot = (row["unit_index"], row["lesson_index"], row["slot_index"])
        candidate = first.get(slot) if row["gap"] else None
        sid = candidate["candidate_id"] if candidate else row["sentence_id"]
        selected_by_source.setdefault((row["lesson_index"], sid), []).append((row, candidate))
    db = sqlite3.connect(
        (root / "g9/pack.sqlite").resolve().as_uri() + "?mode=ro&immutable=1", uri=True
    )
    db.row_factory = sqlite3.Row
    unit = dict(db.execute("SELECT * FROM unit WHERE unit_index=1").fetchone())
    result = {}
    for eid in ids:
        record = records[eid]
        sql = db.execute("SELECT * FROM exercise WHERE exercise_id=?", (eid,)).fetchone()
        if sql is None:
            raise ValueError("actual SQL exercise missing: " + eid)
        sql = dict(sql)
        sid = record["source_sentence_id"]
        choices = selected_by_source.get((record["lesson_index"], sid), [])
        if len(choices) != 1:
            raise ValueError("missing/ambiguous first-selected source join: " + eid)
        selection, candidate = choices[0]
        if candidate:
            text, translation, analysis = (
                candidate["text"],
                candidate["translation"],
                candidate["analysis"],
            )
            upstream = {"g4": selection, "g5": candidate}
        else:
            text, translation, analysis = g0[sid]["text"], g0[sid]["translation"], g1[sid]
            upstream = {"g4": selection, "g0": g0[sid], "g1": g1[sid]}
        sentence = dict(db.execute("SELECT * FROM sentence WHERE sentence_id=?", (sid,)).fetchone())
        if (sentence["text"], sentence["translation"]) != (text, translation):
            raise ValueError("SQL sentence differs from selected source: " + eid)
        source = {
            "lang": "es",
            "unit_index": 1,
            "lesson_index": record["lesson_index"],
            "text": text,
            "translation": translation,
            "analysis": analysis,
            "selected": selection,
            "sqlSentence": sentence,
        }
        tags = [
            dict(r)
            for r in db.execute(
                "SELECT * FROM exercise_item_tag WHERE exercise_id=? ORDER BY item_kind,item_ref",
                (eid,),
            )
        ]
        lemmas = {r["item_ref"] for r in tags if r["item_kind"] == "lexeme"}
        lexemes = [
            dict(r)
            for r in db.execute("SELECT * FROM lexeme ORDER BY lexeme_id")
            if r["lemma"] in lemmas
        ]
        result[eid] = {
            "sourceId": sid,
            "source": source,
            "record": record,
            "exercise": sql,
            "unit": unit,
            "g3": g3[1],
            "upstream": upstream,
            "tags": tags,
            "lexemes": lexemes,
        }
    db.close()
    relevant = {r["lemma"] for fact in result.values() for r in fact["lexemes"]}
    banded = [r for r in rows(root / INPUTS[2]) if r["lemma"] in relevant]
    # Hash both before and after all joins to reject concurrent source edits.
    for name, proof in proofs.items():
        verify_file(root / name, proof)
    return {"schemaVersion": 1, "inputFiles": proofs, "g2": banded, "exercises": result}


def make_candidate(authored, facts, *, author):
    from coursekit.packbuild.grading import surface_id

    source, sql, record = facts["source"], facts["exercise"], facts["record"]
    sid = facts.get("sourceId", record["source_sentence_id"])
    source_sha = digest(source)
    language = "es" if authored["shapeId"] == "typed_translate_forward" else "en"
    forms = [r["surface"] for r in authored["answers"]]
    objective = {
        "exerciseId": record["exercise_id"],
        "sourceId": sid,
        "sourceSha256": source_sha,
        **authored["objective"],
        "author": author,
    }
    canonical_es = source["text"]
    targets = forms if language == "es" else [canonical_es]
    draft = {
        "record": copy.deepcopy(record),
        "shapeId": authored["shapeId"],
        "shapeEvidence": {"kind": "simple"},
        "sourceId": sid,
        "sourceSha256": source_sha,
        "profileId": "es-typed-v1" if language == "es" else "en-reverse-v1",
        "responseLanguage": language,
        "surfaceIds": [surface_id(language, s) for s in forms],
        "schedulerSurfaces": [
            {
                "itemId": sql["item_id"],
                "surfaceId": surface_id("es", s),
                "canonical": s == canonical_es,
            }
            for s in targets
        ],
        "gradable": {"family": "typed-translate", "schedulerFacet": "meaning"},
        "presentation": {
            "itemId": sql["item_id"],
            "type": "typedTranslate",
            "instruction": authored["instruction"],
            "prompt": authored["prompt"],
            "language": language,
            "promptLanguage": authored["promptLanguage"],
            "acceptedAnswers": forms,
        },
        "schedulerObjective": objective,
        "explanation": {
            "exerciseId": record["exercise_id"],
            "sourceId": sid,
            "text": authored["explanation"],
            "author": author,
        },
        "lexicalBindings": [],
    }
    return {
        "schemaVersion": 1,
        "draft": draft,
        "proposedAnswers": copy.deepcopy(authored["answers"]),
        "introduction": authored["introduction"],
        "notes": authored["notes"],
    }


def check_candidate(candidate, facts):
    """Run actual compiler shape predicates; absent language proof is never substituted."""
    from coursekit.packbuild.grading import SHAPES, SOURCE_SHAPES, surface_id, validate_shape

    errors, amendments = [], []
    try:
        if has_review_or_approval(candidate):
            raise ValueError("candidate must not contain review or approval metadata")
        d = candidate["draft"]
        source = facts["source"]
        sql = facts["exercise"]
        record = facts["record"]
        p = d["presentation"]
        objective = d["schedulerObjective"]
        if d["record"] != record or digest(source) != d["sourceSha256"]:
            raise ValueError("stale exact G7/source snapshot")
        if (sql["unit_id"], sql["lesson_index"]) != (
            facts["unit"]["unit_id"],
            source["lesson_index"],
        ) or record["unit_index"] != source["unit_index"]:
            raise ValueError("actual source/unit/lesson join mismatch")
        if record["prompt"] != sql["prompt"] or record["accepted_answers"] != json.loads(
            sql["accepted_answers_json"]
        ):
            raise ValueError("actual SQL/G7 content mismatch")
        if (
            d["sourceId"] != record["source_sentence_id"]
            or d["sourceId"] != sql["source_sentence_id"]
        ):
            raise ValueError("actual source identity mismatch")
        shape = d["shapeId"]
        if shape not in ("typed_translate_forward", "typed_translate_reverse"):
            raise ValueError("bounded candidate shape unsupported")
        language = "es" if shape == "typed_translate_forward" else "en"
        if (
            d["responseLanguage"] != language
            or p["language"] != language
            or p["promptLanguage"] != ("en" if language == "es" else "es")
        ):
            raise ValueError("response/prompt language mismatch")
        if (
            record["type"] != sql["type"]
            or record["type"] != SOURCE_SHAPES[shape].type
            or (d["gradable"]["family"], p["type"]) != SHAPES[shape]
        ):
            raise ValueError("exact compiler shape/type mismatch")
        if p["instruction"] + "\n" + p["prompt"] != sql["prompt"] or p["itemId"] != sql["item_id"]:
            raise ValueError("actual presentation join mismatch")
        answers = candidate["proposedAnswers"]
        if not answers or any(
            set(r) != {"surface", "rank"}
            or not isinstance(r["surface"], str)
            or not r["surface"].strip()
            or type(r["rank"]) is not int
            or r["rank"] < 0
            for r in answers
        ):
            raise ValueError("explicit answer/rank declaration malformed")
        if len({r["surface"] for r in answers}) != len(answers) or len(
            {r["rank"] for r in answers}
        ) != len(answers):
            raise ValueError("duplicate explicit answer/rank")
        proposed = [r["surface"] for r in answers]
        if proposed != record["accepted_answers"]:
            amendments.append("accepted-answer-set-differs-from-frozen-G7")
        if p["acceptedAnswers"] != proposed or d["surfaceIds"] != [
            surface_id(language, value) for value in proposed
        ]:
            raise ValueError("proposed answer/presentation/surface identity mismatch")
        if (
            sql.get("preferred_surface", record["accepted_answers"][0])
            != record["accepted_answers"][0]
        ):
            raise ValueError("actual preferred answer differs from frozen G7")
        if p["prompt"] != source["translation" if language == "es" else "text"]:
            raise ValueError("presentation differs from exact bilingual source")
        expected_targets = proposed if language == "es" else [source["text"]]
        if (
            d["schedulerSurfaces"]
            != [
                {
                    "itemId": sql["item_id"],
                    "surfaceId": surface_id("es", value),
                    "canonical": value == source["text"],
                }
                for value in expected_targets
            ]
            or sum(t["canonical"] for t in d["schedulerSurfaces"]) != 1
        ):
            raise ValueError("scheduler targets differ from exact authored target surfaces")
        when = candidate["introduction"]
        if (
            when not in ("prompt", "wrong-feedback")
            or source["text"] != (p["prompt"] if when == "prompt" else p["acceptedAnswers"][0])
            or (p["promptLanguage"] if when == "prompt" else language) != "es"
        ):
            raise ValueError("introduction lacks exact visible target-language source")
        # No approved surfaces are supplied. Typed-shape checks do not need one;
        # language completeness remains a separately reported missing prerequisite.
        validate_shape(
            d["gradable"],
            p,
            [],
            {r["lexeme_id"]: r for r in facts["lexemes"]},
            d,
            {},
            [],
            source,
            [],
        )
        if (
            objective["exerciseId"] != record["exercise_id"]
            or objective["sourceId"] != d["sourceId"]
            or objective["sourceSha256"] != d["sourceSha256"]
        ):
            raise ValueError("objective source binding mismatch")
        tags = {(t["item_kind"], t["item_ref"]) for t in facts["tags"]}
        if objective["kind"] == "lexeme":
            lexeme = next(
                (r for r in facts["lexemes"] if r["lexeme_id"] == objective["itemRef"]), None
            )
            if (
                lexeme is None
                or ("lexeme", lexeme["lemma"]) not in tags
                or not any(
                    t["lemma"] == lexeme["lemma"] and t["pos"] == lexeme["pos"]
                    for t in source["analysis"]["tokens"]
                )
            ):
                raise ValueError("objective lacks exact contextual SQL lexeme/POS/tag")
        elif (
            objective["kind"] != "grammarConcept"
            or objective["itemRef"] != facts["unit"]["grammar_concept"]
            or ("grammar_concept", objective["itemRef"]) not in tags
        ):
            raise ValueError("objective lacks actual unit grammar/tag")
    except (ValueError, KeyError, TypeError, StopIteration) as exc:
        errors.append(str(exc))
    return {
        "exerciseId": facts["record"]["exercise_id"],
        "structuralErrors": errors,
        "sourceAmendments": amendments,
        "pending": PENDING,
        "assemblyReady": False,
    }


def compiler_proofs():
    from coursekit.packbuild import grading, lexical, objectives, path

    return {
        module.__name__: file_proof(module.__file__)
        for module in (grading, lexical, objectives, path)
    }


def assemble_candidates(authoring, facts):
    from coursekit.packbuild.grading import surface_id
    from coursekit.packbuild.lexical import consistent_word_identity, lexical_identity
    from coursekit.packbuild.path import build_path_metadata

    from coursekit.packbuild.itemid import item_id

    author = authoring["author"]
    candidates, catalog, surfaces, identities = [], {}, {}, {}
    for authored in authoring["exercises"]:
        f = facts["exercises"][authored["exerciseId"]]
        c = make_candidate(authored, f, author=author)
        d = c["draft"]
        candidates.append(c)
        es_surfaces = (
            [f["source"]["text"]]
            if d["responseLanguage"] == "en"
            else [a["surface"] for a in authored["answers"]]
        )
        declared = [(d["responseLanguage"], a["surface"], a["rank"]) for a in authored["answers"]]
        declared += [("es", s, 0) for s in es_surfaces if d["responseLanguage"] == "en"]
        for language, surface, rank in declared:
            sfid = surface_id(language, surface)
            row = surfaces.setdefault(
                sfid,
                {
                    "surfaceId": sfid,
                    "language": language,
                    "surface": surface,
                    "rank": rank,
                    "introduction": None,
                    "sourceIds": [],
                    "author": author,
                },
            )
            if row["rank"] != rank:
                raise ValueError("conflicting explicitly authored rank")
            if d["sourceId"] not in row["sourceIds"]:
                row["sourceIds"].append(d["sourceId"])
            if language == "es" and surface == f["source"]["text"] and row["introduction"] is None:
                row["introduction"] = {
                    "exerciseId": authored["exerciseId"],
                    "unitId": f["exercise"]["unit_id"],
                    "lessonIndex": f["exercise"]["lesson_index"],
                    "when": authored["introduction"],
                }
        objective = authored["objective"]
        if objective["kind"] == "lexeme":
            ref = objective["itemRef"]
            declaration = authoring["lexicalDeclarations"][ref]
            lexeme = next(r for r in f["lexemes"] if r["lexeme_id"] == ref)
            semantic = declaration["semantic"]
            row = catalog.setdefault(
                ref,
                {
                    "lexemeId": ref,
                    "lemma": lexeme["lemma"],
                    "pos": lexeme["pos"],
                    "language": "es",
                    "wordItemId": item_id(semantic),
                    "semantic": semantic,
                    "countable": declaration["countable"],
                    "classification": declaration["classification"],
                    "sources": [],
                    "author": author,
                },
            )
            origin = {"sourceId": d["sourceId"], "sourceSha256": d["sourceSha256"]}
            if origin not in row["sources"]:
                row["sources"].append(origin)
            lexical_identity(row, {ref: lexeme}, "es")
            consistent_word_identity(row, identities)
            for surface in es_surfaces:
                d["lexicalBindings"].append(
                    {
                        "exerciseId": authored["exerciseId"],
                        **origin,
                        "schedulerItemId": f["exercise"]["item_id"],
                        "surfaceId": surface_id("es", surface),
                        "lexemeId": ref,
                        "wordItemId": row["wordItemId"],
                        "author": author,
                    }
                )
    path = copy.deepcopy(authoring["pathDeclaration"])
    by_lesson = {}
    for f in facts["exercises"].values():
        by_lesson.setdefault(f["exercise"]["lesson_index"], []).append(f["exercise"])
    for section in path["sections"]:
        for unit in section["units"]:
            for node in unit["nodes"]:
                for session in node["sessions"]:
                    session["exerciseIds"] = [
                        r["exercise_id"]
                        for r in sorted(
                            by_lesson[session["lessonIndex"]],
                            key=lambda r: (r["slot_index"], r["exercise_id"]),
                        )
                    ]
    unit = next(iter(facts["exercises"].values()))["unit"]
    compiled_path = build_path_metadata(
        path, [unit], [f["exercise"] for f in facts["exercises"].values()]
    )
    checks = [
        check_candidate(c, facts["exercises"][c["draft"]["record"]["exercise_id"]])
        for c in candidates
    ]
    return {
        "candidates.jsonl": candidates,
        "lexical-catalog.jsonl": list(catalog.values()),
        "surface-catalog.jsonl": list(surfaces.values()),
        "path-candidate.json": path,
        "path-preflight.json": compiled_path,
        "candidate-checks.json": checks,
    }


def production_refusal(candidates, facts, lexical_catalog):
    """Exercise the real fail-closed builder with its genuinely absent trust input."""
    from coursekit.packbuild.grading import (
        GradingBuildError,
        GradingBuildInputs,
        build_grading_payload,
    )

    values = list(facts["exercises"].values())
    inputs = GradingBuildInputs(
        identity={"packId": "freelingo-es", "courseId": "en-es", "version": "0.1.0", "lang": "es"},
        units=[values[0]["unit"]],
        lexemes=list({r["lexeme_id"]: r for f in values for r in f["lexemes"]}.values()),
        exercises=[f["exercise"] for f in values],
        exercise_tags=[r for f in values for r in f["tags"]],
        profiles=[],
        lessons=[],
        drafts=[c["draft"] for c in candidates],
        sources={
            c["draft"]["sourceId"]: facts["exercises"][c["draft"]["record"]["exercise_id"]][
                "source"
            ]
            for c in candidates
        },
        approvals={},
        surface_catalog=[],
        teaching=[],
        dictionaries=[],
        approval_check=None,
        lexical_catalog=lexical_catalog,
    )
    try:
        build_grading_payload(inputs)
    except GradingBuildError as exc:
        if str(exc) != "approval validator is required":
            raise ValueError("unexpected production refusal: " + str(exc)) from exc
        return {"assemblyReady": False, "error": str(exc), "stage": "build_grading_payload"}
    raise ValueError("production builder accepted missing approval validator")


def write_bundle(root, authoring_path, output):
    output = Path(output)
    if output.exists():
        raise ValueError("output must be a new directory; preserve previous evidence")
    authoring = json.loads(Path(authoring_path).read_text())
    if has_review_or_approval(authoring):
        raise ValueError("authoring must contain no review/approval metadata")
    facts = source_facts(root, [r["exerciseId"] for r in authoring["exercises"]])
    artifacts = assemble_candidates(authoring, facts)
    artifacts["production-refusal.json"] = production_refusal(
        artifacts["candidates.jsonl"], facts, artifacts["lexical-catalog.jsonl"]
    )
    artifacts["source-facts.json"] = facts
    output.mkdir(parents=True)
    for name, value in artifacts.items():
        body = (
            "".join(canonical(r) + "\n" for r in value)
            if name.endswith(".jsonl")
            else canonical(value) + "\n"
        )
        (output / name).write_text(body)
    manifest = {
        "schemaVersion": 1,
        "status": "unreviewed-authoring-candidates",
        "authoring": file_proof(authoring_path),
        "compiler": compiler_proofs(),
        "authoringTool": file_proof(__file__),
        "files": {name: file_proof(output / name) for name in artifacts},
        "pending": PENDING,
        "assemblyReady": False,
    }
    (output / "manifest.json").write_text(canonical(manifest) + "\n")
    return manifest


def replay(root, authoring_path, bundle):
    bundle = Path(bundle)
    manifest = json.loads((bundle / "manifest.json").read_text())
    verify_file(authoring_path, manifest["authoring"])
    verify_file(__file__, manifest["authoringTool"])
    if compiler_proofs() != manifest["compiler"]:
        raise ValueError("production compiler changed; new explicit preflight required")
    for name, proof in manifest["files"].items():
        verify_file(bundle / name, proof)
    authoring = json.loads(Path(authoring_path).read_text())
    current = source_facts(root, [r["exerciseId"] for r in authoring["exercises"]])
    if current != json.loads((bundle / "source-facts.json").read_text()):
        raise ValueError("source replay differs from frozen export")
    rebuilt = assemble_candidates(authoring, current)
    for name, value in rebuilt.items():
        saved = (
            list(rows(bundle / name))
            if name.endswith(".jsonl")
            else json.loads((bundle / name).read_text())
        )
        if value != saved:
            raise ValueError("deterministic candidate replay mismatch: " + name)
    refusal = production_refusal(
        rebuilt["candidates.jsonl"], current, rebuilt["lexical-catalog.jsonl"]
    )
    if refusal != json.loads((bundle / "production-refusal.json").read_text()):
        raise ValueError("production refusal changed")
    checks = rebuilt["candidate-checks.json"]
    return {
        "candidates": len(checks),
        "structuralErrors": sum(bool(r["structuralErrors"]) for r in checks),
        "sourceAmendments": sum(bool(r["sourceAmendments"]) for r in checks),
        "pathSourceJoin": "passed",
        "assemblyReady": False,
        "pending": PENDING,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["export", "check"])
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--authoring", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    result = (write_bundle if args.action == "export" else replay)(
        args.source_root, args.authoring, args.bundle
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
