"""Explicit, review-free source revisions and text-first recognition session.

`analyse` runs the installed G1 adapter and current G5 axes only, through an explicitly
selected upstream PYTHONPATH. `export` uses the real production shape checker through
its separately selected compiler tree. Neither command runs a stage, inserts SQLite,
creates a G6 approval, or promotes an authored judgment to independent review.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

PENDING = [
    "independent-revision-and-runtime-component-reviews",
    "current-complete-selected-source-answer-and-G6-proof",
    "current-lexical-source-approval-adapter",
    "reviewed-profile-dictionary-and-teaching-policy",
    "G7-G9-proposed-row-and-source-approval-integration",
    "complete-path-source-population-and-policy-approval",
]
OPTION_IDS = {"hola": "option-hello", "día": "option-day", "noche": "option-night"}
ASSET_NAMES = {"hola": "hello", "día": "day", "noche": "night"}
ASSET_DESCRIPTIONS = {
    "hola": "A smiling person raising a hand to greet someone.",
    "día": "A bright daytime landscape with a sun, house and tree.",
    "noche": "The same landscape at night, with a crescent moon, stars and a lit window.",
}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_identity(source):
    return digest(
        [
            "es-u1-author-revision-2",
            {
                k: source[k]
                for k in ["lang", "unit_index", "lesson_index", "text", "translation", "sourceKind"]
            },
        ]
    )[:16]


def load(path):
    return json.loads(Path(path).read_text())


def rows(path):
    return [json.loads(x) for x in Path(path).read_text().splitlines()]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def write_new(path, value, *, lines=False):
    path = Path(path)
    with path.open("x") as stream:
        stream.write(
            "".join(canonical(row) + "\n" for row in value) if lines else canonical(value) + "\n"
        )


def no_authored_approval(value):
    if isinstance(value, dict):
        require(
            not any(
                k in {"review", "approval", "approvalId", "approvalSha256", "runId"} for k in value
            ),
            "author revision cannot self-approve",
        )
        for child in value.values():
            no_authored_approval(child)
    elif isinstance(value, list):
        for child in value:
            no_authored_approval(child)


def ranked(answers):
    require(isinstance(answers, list) and answers, "answers required")
    require(
        all(
            set(x) == {"surface", "rank"}
            and isinstance(x["surface"], str)
            and x["surface"].strip()
            and type(x["rank"]) is int
            for x in answers
        ),
        "answer shape",
    )
    require(
        [x["rank"] for x in answers] == list(range(len(answers))), "explicit canonical-first ranks"
    )
    require(len({x["surface"] for x in answers}) == len(answers), "duplicate answers")


def validate_authoring(authored, original):
    no_authored_approval(authored)
    old = {r["draft"]["record"]["exercise_id"]: r for r in original}
    require(
        authored["schemaVersion"] == 1
        and isinstance(authored["author"], str)
        and authored["author"].strip(),
        "author contract",
    )
    result = {}
    for row in authored["revisions"]:
        eid = row["originalExerciseId"]
        require(eid in old and eid not in result, "unknown/duplicate original exercise")
        require(row["originalCandidateSha256"] == digest(old[eid]), "stale original candidate")
        require(
            row["shapeId"] in {"typed_translate_forward", "typed_translate_reverse"},
            "revision shape",
        )
        require(
            all(
                isinstance(row[k], str) and row[k].strip()
                for k in ["text", "translation", "explanation", "rationale"]
            ),
            "empty source",
        )
        ranked(row["answers"])
        require(
            row["answers"][0]["surface"]
            == row["text" if row["shapeId"] == "typed_translate_forward" else "translation"],
            "canonical source answer",
        )
        old_objective = {k: old[eid]["draft"]["schedulerObjective"][k] for k in ["kind", "itemRef"]}
        if row["objective"] != old_objective:
            change = row.get("objectiveChange", {})
            require(
                set(change) == {"from", "reason"}
                and change["from"] == old_objective
                and isinstance(change["reason"], str)
                and change["reason"].strip(),
                "objective change needs exact original and author rationale",
            )
        else:
            require("objectiveChange" not in row, "unchanged objective has misleading change claim")
        result[eid] = row
    require(len(result) == 8, "exact eight adjudicated revisions required")
    session = authored["firstSession"]
    require(session["productionAllowed"] is False, "first session cannot contain production")
    require(
        session["unitId"] == "u001" and session["unitIndex"] == 1 and session["lessonIndex"] == 1,
        "first-session placement",
    )
    intros = authored["introductions"]
    require(len(intros) == 3, "three explicit first recognition targets")
    require(
        session["orderedLexemeIds"] == [r["lexemeId"] for r in intros]
        and len(set(session["orderedLexemeIds"])) == 3,
        "first-session exact target order",
    )
    for row in intros:
        require(row["shapeId"] == "meaning_select", "first session recognition only")
        require(
            row["lemma"] in OPTION_IDS and row["accepted"] == row["meaning"],
            "lexical canonical answer",
        )
        require(row["lexemeId"] == f"lx:{row['lemma']}:{row['pos']}", "lexeme ID/POS mismatch")
        require(
            row["optionOrder"] == ["hello", "day", "night"],
            "distinct explicit supported option population",
        )
        require(row["prompt"] == row["lemma"], "actual Spanish prompt missing")
        ranked(row["answers"])
        require(row["answers"][0]["surface"] == row["meaning"], "canonical lexical response")
        require(row["correctOptionId"] == OPTION_IDS[row["lemma"]], "correct option mismatch")
        require(
            row["classification"] == "word" and row["countable"] is True,
            "explicit introductory word classification",
        )
    return result


def meaning_presentation(intro, item_id):
    from coursekit.packbuild.grading import surface_id, validate_shape

    options = [{"id": "option-" + word, "text": word} for word in intro["optionOrder"]]
    forms = [x["surface"] for x in intro["answers"]]
    p = {
        "itemId": item_id,
        "type": "meaningSelect",
        "instruction": intro["instruction"],
        "prompt": intro["prompt"],
        "promptLanguage": "es",
        "language": "en",
        "acceptedAnswers": forms,
        "introduction": "word",
        "options": options,
    }
    d = {
        "shapeId": "meaning_select",
        "shapeEvidence": {"kind": "simple"},
        "responseLanguage": "en",
        "record": {"distractors": [x for x in intro["optionOrder"] if x != forms[0]]},
    }
    validate_shape(
        {"family": "select"},
        p,
        [{"surface": form, "surfaceId": surface_id("en", form)} for form in forms],
        {},
        d,
        {},
        [],
        {"text": intro["lemma"]},
        [],
    )
    return p


def picture_presentation(intro, item_id, assets):
    from coursekit.packbuild.grading import surface_id, validate_shape

    options = []
    for word in intro["optionOrder"]:
        asset = assets.get(word)
        require(
            asset and asset.get("uri") and asset.get("description"),
            "actual image declaration missing",
        )
        options.append(
            {
                "id": OPTION_IDS[word],
                "text": word,
                "imageUri": asset["uri"],
                "imageDescription": asset["description"],
            }
        )
    p = {
        "itemId": item_id,
        "type": "pictureSelect",
        "instruction": intro["instruction"],
        "prompt": intro["prompt"],
        "promptLanguage": "en",
        "language": "es",
        "acceptedAnswers": [intro["accepted"]],
        "introduction": "word",
        "options": options,
    }
    d = {
        "shapeId": "picture_select",
        "shapeEvidence": {"kind": "simple"},
        "responseLanguage": "es",
        "record": {"distractors": [x for x in intro["optionOrder"] if x != intro["accepted"]]},
    }
    # This is a shape check over unapproved author surfaces, not approval_check or
    # build_grading_payload. No fake independent reviews are passed to the compiler.
    validate_shape(
        {"family": "select"},
        p,
        [{"surface": intro["accepted"], "surfaceId": surface_id("es", intro["accepted"])}],
        {},
        d,
        {},
        [],
        {"text": intro["accepted"]},
        [],
    )
    return p


def source_inputs(revision):
    revision = Path(revision)
    base = revision.parent / "first-unit-20260913"
    a = load(revision / "authoring.json")
    original = rows(base / "bundle/candidates.jsonl")
    require(
        file_hash(base / "bundle/candidates.jsonl") == a["baseCandidatesSha256"],
        "frozen original file changed",
    )
    validate_authoring(a, original)
    require(
        file_hash(base / "bundle/lexical-catalog.jsonl") == a["baseLexicalCatalogSha256"],
        "frozen lexical catalog changed",
    )
    provenance = load(revision / "inputs/provenance.json")
    parent_proofs = [
        sha
        for name, sha in provenance["originalFiles"].items()
        if Path(name).name == "source-facts.json"
    ]
    require(
        len(parent_proofs) == 1
        and file_hash(base / "bundle/source-facts.json") == parent_proofs[0],
        "original source facts drift",
    )
    for name, sha in provenance["snapshotFiles"].items():
        require(file_hash(revision / "inputs" / name) == sha, "source snapshot changed: " + name)
    return (
        a,
        original,
        load(base / "bundle/source-facts.json"),
        rows(revision / "inputs/selected-u1.jsonl"),
        rows(revision / "inputs/banded-u1.jsonl"),
        rows(revision / "inputs/glosses.jsonl"),
        rows(revision / "inputs/units-u1.jsonl")[0],
    )


def expected_sources(a, facts, selected):
    slots = {(r["lesson_index"], r["slot_index"]): r for r in selected}
    work = []
    for r in a["revisions"]:
        old = facts["exercises"][r["originalExerciseId"]]["source"]["selected"]
        gap = slots[(old["lesson_index"], old["slot_index"])]
        forms = [r["text"]] + (
            [x["surface"] for x in r["answers"][1:]]
            if r["shapeId"] == "typed_translate_forward"
            else []
        )
        work.append((r["originalExerciseId"], r["text"], r["translation"], forms, gap))
    for r in a["introductions"]:
        gap = slots[(1, r["g4SlotIndex"])]
        require(
            gap["new_lemmas"] == [r["lemma"]], "lexical source does not occupy reserved target slot"
        )
        work.append((r["lexemeId"], r["lemma"], r["meaning"], [r["lemma"]], gap))
    return work


def validate_local_analysis(a, proof, facts, selected, revision):
    from coursekit.artifacts import validate_record

    require(
        proof["authoringSha256"] == file_hash(Path(revision) / "authoring.json"),
        "stale current author analysis",
    )
    require(proof["driverSha256"] == file_hash(__file__), "stale analysis driver")
    require(proof["G6Approval"] is None, "local checks cannot claim G6 approval")
    expected = {}
    for identity, _text, translation, forms, gap in expected_sources(a, facts, selected):
        for index, surface in enumerate(forms):
            expected[(identity, surface, index == 0)] = (translation, gap)
    checks = proof["checks"]
    require(
        len(checks) == len(expected)
        and {(x["identity"], x["text"], x["canonical"]) for x in checks} == set(expected),
        "local check population incomplete or duplicated",
    )
    require(
        set(proof["analyses"]) == {key[1] for key in expected}, "analysis population incomplete"
    )
    for check in checks:
        identity, surface, canonical_form = check["identity"], check["text"], check["canonical"]
        translation, gap = expected[(identity, surface, canonical_form)]
        require(
            check["slot"] == {k: gap[k] for k in ["unit_index", "lesson_index", "slot_index"]},
            "local check slot drift",
        )
        require(check["axisReject"] is None, "current source fails actual G5 axes")
        actual = proof["analyses"][surface]
        require(
            actual["text"] == surface and digest(actual["analysis"]) == check["analysisSha256"],
            "analysis content drift",
        )
        analysis = actual["analysis"]
        validate_record("analysed_sentence", analysis)
        expected_id = source_identity(
            {
                "lang": "es",
                "unit_index": 1,
                "lesson_index": gap["lesson_index"],
                "text": surface,
                "translation": translation,
                "sourceKind": "lexical-authoring-proposal"
                if identity.startswith("lx:")
                else "whole-sentence-authoring-revision",
            }
        )
        require(analysis["sentence_id"] == expected_id, "actual analysis/source identity differs")
        require(
            all(surface[t["start"] : t["end"]] == t["surface"] for t in analysis["tokens"]),
            "actual source token span drift",
        )


def analyse(revision, out):
    from coursekit.lexeme_glosses import _VALIDATOR, gloss_content_hash

    from coursekit.adapters.spacy_es import build
    from coursekit.config.g5 import min_tokens_for_slot
    from coursekit.stages.g5_gapfill import _axis, ledger_digest

    a, original, facts, selected, banded, glosses, unit = source_inputs(revision)
    analyser = build()
    pos = {r["lemma"]: r["pos"] for r in banded}
    analyses = {}
    checks = []
    for row in glosses:
        require(not list(_VALIDATOR.iter_errors(row)), "invalid shared glossary row")
        require(
            row["review"]
            and row["review"]["verdict"] == "accepted"
            and row["review"]["content_hash"] == gloss_content_hash(row),
            "unaccepted/stale shared glossary",
        )
    work = expected_sources(a, facts, selected)
    for identity, _text, translation, forms, gap in work:
        minimum = min_tokens_for_slot(gap["known_lemmas"], gap["new_lemmas"], pos)
        for index, surface in enumerate(forms):
            sid = source_identity(
                {
                    "lang": "es",
                    "unit_index": 1,
                    "lesson_index": gap["lesson_index"],
                    "text": surface,
                    "translation": translation,
                    "sourceKind": "lexical-authoring-proposal"
                    if identity.startswith("lx:")
                    else "whole-sentence-authoring-revision",
                }
            )
            raw = {
                "lang": "es",
                "text": surface,
                "translation": translation,
                "new_lemmas": gap["new_lemmas"],
                "ledger_digest": ledger_digest(gap["known_lemmas"], gap["new_lemmas"]),
                "accepted_alternates": [],
            }
            reason, carried = _axis(
                raw, gap, analyser, set(), sid, minimum, required_unit=unit, noncanonical=index > 0
            )
            actual = analyser.analyse(sentence_id=sid, text=surface)
            analyses[surface] = {"text": surface, "analysis": actual}
            checks.append(
                {
                    "identity": identity,
                    "text": surface,
                    "canonical": index == 0,
                    "slot": {k: gap[k] for k in ["unit_index", "lesson_index", "slot_index"]},
                    "minimumTokens": minimum,
                    "axisReject": reason,
                    "analysisSha256": digest(actual),
                    "note": (
                        "Local G5 axis evaluation only; no G5 stage, candidate acceptance record, "
                        "complete population or G6 approval."
                    ),
                }
            )
    module = Path(__file__)
    import coursekit.adapters.spacy_es as adapter_module
    import coursekit.stages.g5_gapfill as axis_module

    report = {
        "schemaVersion": 1,
        "authoringSha256": file_hash(Path(revision) / "authoring.json"),
        "adapter": analyser.fingerprint(),
        "adapterSourceSha256": file_hash(adapter_module.__file__),
        "axisSourceSha256": file_hash(axis_module.__file__),
        "driverSha256": file_hash(module),
        "glossaryRowsChecked": len(glosses),
        "analyses": analyses,
        "checks": checks,
        "G6Approval": None,
    }
    write_new(out, report)
    return {
        "checks": len(checks),
        "rejected": sum(c["axisReject"] is not None for c in checks),
        "G6Approval": False,
    }


def export(revision, out):
    from coursekit.packbuild.grading import surface_id, validate_shape

    from coursekit.packbuild.itemid import item_id

    revision = Path(revision)
    out = Path(out)
    require(not out.exists(), "new output directory required")
    a, original, facts, selected, banded, glosses, unit = source_inputs(revision)
    proof = load(revision / "inputs/local-analysis.json")
    validate_local_analysis(a, proof, facts, selected, revision)
    slots = {(r["lesson_index"], r["slot_index"]): r for r in selected}
    pos = {r["lemma"]: r for r in banded}
    gloss = {(r["lemma"], r["pos"]): r for r in glosses}
    assets = {}
    asset_rows = []
    for lemma, name in ASSET_NAMES.items():
        svg = revision / "assets" / f"{name}.svg"
        png = revision / "assets" / f"{name}.png"
        require(
            svg.is_file() and png.is_file() and png.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n",
            "actual image bytes missing",
        )
        assets[lemma] = {
            "uri": f"images/es-u1-{name}.png",
            "description": ASSET_DESCRIPTIONS[lemma],
        }
        asset_rows.append(
            {
                "lemma": lemma,
                "packPath": assets[lemma]["uri"],
                "sourcePath": str(svg.relative_to(revision)),
                "sourceSha256": file_hash(svg),
                "rasterPath": str(png.relative_to(revision)),
                "sha256": file_hash(png),
                "bytes": png.stat().st_size,
                "mimeType": "image/png",
                "description": ASSET_DESCRIPTIONS[lemma],
                "author": a["author"],
                "license": a["licence"],
                "notice": (
                    "Original Freelingo illustration, Codex Spanish revision author, "
                    "2026-09-13. CC BY-NC-SA 4.0."
                ),
                "review": None,
            }
        )
    candidates = []
    sources = {}
    catalog = {}
    surfaces = {}
    changes = []
    intro_ids = []

    def add_surface(language, text, rank, source_id, introduction=None):
        sid = surface_id(language, text)
        existing = surfaces.get(sid)
        if existing:
            require(
                existing["rank"] == rank and existing["introduction"] == introduction,
                "conflicting rank/display source",
            )
            if source_id not in existing["sourceIds"]:
                existing["sourceIds"].append(source_id)
        else:
            surfaces[sid] = {
                "surfaceId": sid,
                "language": language,
                "surface": text,
                "rank": rank,
                "introduction": introduction,
                "sourceIds": [source_id],
                "author": a["author"],
            }
        return sid

    def build_entry(
        entry, source, shape, lemma_tags, placement, *, origin=None, intro=None, proposed_slot=None
    ):
        source_id = source_identity(source)
        source_sha = digest(source)
        sources[source_id] = source
        require(
            source["analysis"]["sentence_id"] == source_id,
            "actual analysis/source identity differs",
        )
        language = "es" if shape in {"typed_translate_forward", "picture_select"} else "en"
        answers = entry["answers"] if intro is None else intro["answers"]
        forms = [x["surface"] for x in answers]
        instruction = "Translate this sentence" if intro is None else intro["instruction"]
        prompt = source["translation"] if language == "es" else source["text"]
        semantic = {
            "prompt": instruction + "\n" + prompt,
            "preferredSurface": forms[0],
            "register": "tu",
            "lexemes": sorted(lemma_tags),
            "grammarConcepts": [],
            "graphemes": [],
        }
        item = item_id(semantic)
        eid = digest([source_id, shape, placement, semantic])[:16]
        if intro:
            presentation = meaning_presentation(intro, item)
            intro_ids.append(eid)
        else:
            presentation = {
                "itemId": item,
                "type": "typedTranslate",
                "instruction": instruction,
                "prompt": prompt,
                "language": language,
                "promptLanguage": "en" if language == "es" else "es",
                "acceptedAnswers": forms,
            }
        target_forms = forms if language == "es" else [source["text"]]
        introduction = (
            {
                "exerciseId": eid,
                "unitId": "u001",
                "lessonIndex": placement["lesson_index"],
                "when": "prompt",
            }
            if intro
            else None
        )
        accepted_ids = [add_surface(language, x["surface"], x["rank"], source_id) for x in answers]
        target_ids = (
            accepted_ids
            if language == "es"
            else [add_surface("es", source["text"], 0, source_id, introduction)]
        )
        objective = {
            "exerciseId": eid,
            "sourceId": source_id,
            "sourceSha256": source_sha,
            **entry["objective"],
            "author": a["author"],
        }
        distractors = [r["text"] for r in presentation.get("options", []) if r["text"] != forms[0]]
        record = {
            "schema_version": 1,
            "lang": "es",
            "exercise_id": eid,
            "unit_index": 1,
            "lesson_index": placement["lesson_index"],
            "type": "match"
            if intro
            else ("translate" if language == "es" else "reverse_translate"),
            "prompt": instruction + "\n" + prompt,
            "accepted_answers": forms,
            "distractors": distractors,
            "item_tags": {
                "lemmas": sorted(lemma_tags),
                "grammar_concepts": [],
            },
            "source_sentence_id": source_id,
            "audio_ref": None,
            "alignment": [],
            "register": "tu",
        }
        from coursekit.artifacts import validate_record

        validate_record("exercise", record)
        draft = {
            "record": record,
            "shapeId": shape,
            "shapeEvidence": {"kind": "simple"},
            "sourceId": source_id,
            "sourceSha256": source_sha,
            "profileId": "en-recognition-v1"
            if intro
            else ("es-typed-v1" if language == "es" else "en-reverse-v1"),
            "responseLanguage": language,
            "surfaceIds": accepted_ids,
            "schedulerSurfaces": [
                {"itemId": item, "surfaceId": sid, "canonical": surface == source["text"]}
                for sid, surface in zip(target_ids, target_forms, strict=True)
            ],
            "gradable": {
                "family": "select" if intro else "typed-translate",
                "schedulerFacet": "meaning",
            },
            "presentation": presentation,
            "schedulerObjective": objective,
            "explanation": {
                "exerciseId": eid,
                "sourceId": source_id,
                "text": entry["explanation"],
                "author": a["author"],
            },
            "lexicalBindings": [],
        }
        if objective["kind"] == "lexeme":
            ref = objective["itemRef"]
            lemma, part = ref.removeprefix("lx:").rsplit(":", 1)
            require(
                lemma in pos and pos[lemma]["pos"] == part,
                "objective differs from actual reviewed G2 POS",
            )
            require(
                any(t["lemma"] == lemma and t["pos"] == part for t in source["analysis"]["tokens"])
                or (intro and source["lemma"] == lemma and source["pos"] == part),
                "objective absent from exact source",
            )
            semantic_word = (
                {
                    "prompt": intro["meaning"],
                    "preferredSurface": lemma,
                    "register": "neutral",
                    "lexemes": [lemma],
                    "grammarConcepts": [],
                    "graphemes": [],
                }
                if intro
                else next(
                    r
                    for r in rows(
                        revision.parent / "first-unit-20260913/bundle/lexical-catalog.jsonl"
                    )
                    if r["lexemeId"] == ref
                )["semantic"]
            )
            word = item_id(semantic_word)
            lex = catalog.setdefault(
                ref,
                {
                    "lexemeId": ref,
                    "lemma": lemma,
                    "pos": part,
                    "language": "es",
                    "wordItemId": word,
                    "semantic": semantic_word,
                    "countable": True,
                    "classification": "word",
                    "sources": [],
                    "author": a["author"],
                },
            )
            require(lex["semantic"] == semantic_word, "conflicting word semantics")
            origin_row = {"sourceId": source_id, "sourceSha256": source_sha}
            if origin_row not in lex["sources"]:
                lex["sources"].append(origin_row)
            if lemma == "sí":
                lex.update(countable=False, classification="particle")
            draft["lexicalBindings"] = [
                {
                    "exerciseId": eid,
                    **origin_row,
                    "schedulerItemId": item,
                    "surfaceId": sid,
                    "lexemeId": ref,
                    "wordItemId": word,
                    "author": a["author"],
                }
                for sid in target_ids
            ]
        # Exact new proposed row; it is not an assertion that G7/SQLite was written.
        sql = {
            "exercise_id": eid,
            "item_id": item,
            "unit_id": "u001",
            "lesson_index": placement["lesson_index"],
            "slot_index": placement["slot_index"] if proposed_slot is None else proposed_slot,
            "type": record["type"],
            "prompt": record["prompt"],
            "preferred_surface": forms[0],
            "accepted_answers_json": canonical(forms),
            "distractors_json": canonical(distractors),
            "source_sentence_id": source_id,
            "audio_id": None,
            "illustration_ref": None,
            "register": record["register"],
            "alignment_json": "[]",
            "ruby_json": None,
        }
        tags = [
            {
                "exercise_id": eid,
                "item_kind": "lexeme",
                "item_ref": lemma,
                "is_new": int(lemma in placement["new_lemmas"]),
            }
            for lemma in sorted(lemma_tags)
        ]
        validate_shape(
            draft["gradable"],
            presentation,
            [surfaces[s] for s in accepted_ids],
            {},
            draft,
            {},
            [],
            source,
            [],
        )
        candidate = {
            "schemaVersion": 1,
            "status": "unreviewed-proposed-source-and-G7-row",
            "originalExerciseId": origin,
            "draft": draft,
            "proposedExercise": sql,
            "proposedTags": tags,
            "proposedAnswers": answers,
            "assemblyReady": False,
            "pending": PENDING,
        }
        candidates.append(candidate)
        return candidate

    for intro_index, r in enumerate(a["introductions"]):
        declared = gloss.get((r["lemma"], r["pos"]))
        require(
            declared and declared["citation_gloss"] == r["meaning"],
            "lexical meaning lacks exact existing reviewed glossary source",
        )
        g = slots[(1, r["g4SlotIndex"])]
        source = {
            "lang": "es",
            "unit_index": 1,
            "lesson_index": 1,
            "text": r["lemma"],
            "translation": r["meaning"],
            "lexeme_id": r["lexemeId"],
            "lemma": r["lemma"],
            "pos": r["pos"],
            "analysis": proof["analyses"][r["lemma"]]["analysis"],
            "sourceKind": "lexical-authoring-proposal",
            "reviewedGlossary": declared,
            "g2": pos[r["lemma"]],
            "selectedSlot": g,
            "license": a["licence"],
            "author": a["author"],
        }
        build_entry(
            {
                "objective": {"kind": "lexeme", "itemRef": r["lexemeId"]},
                "explanation": r["explanation"],
            },
            source,
            "meaning_select",
            [r["lemma"]],
            g,
            intro=r,
            proposed_slot=intro_index,
        )
    for r in a["revisions"]:
        previous = facts["exercises"][r["originalExerciseId"]]
        old = previous["source"]["selected"]
        g = slots[(old["lesson_index"], old["slot_index"])]
        analysis = proof["analyses"][r["text"]]["analysis"]
        source = {
            "lang": "es",
            "unit_index": 1,
            "lesson_index": g["lesson_index"],
            "text": r["text"],
            "translation": r["translation"],
            "analysis": analysis,
            "selectedSlot": g,
            "sourceKind": "whole-sentence-authoring-revision",
            "originalSourceId": previous["sourceId"],
            "originalSourceSha256": digest(previous["source"]),
            "license": a["licence"],
            "author": a["author"],
        }
        candidate = build_entry(
            r,
            source,
            r["shapeId"],
            analysis["lemmas"],
            g,
            origin=r["originalExerciseId"],
            proposed_slot=previous["exercise"]["slot_index"],
        )
        changes.append(
            {
                "originalExerciseId": r["originalExerciseId"],
                "originalCandidateSha256": r["originalCandidateSha256"],
                "proposedExerciseId": candidate["draft"]["record"]["exercise_id"],
                "proposedItemId": candidate["proposedExercise"]["item_id"],
                "proposedSourceId": candidate["draft"]["sourceId"],
                "rationale": r["rationale"],
                "objectiveChange": r.get("objectiveChange"),
            }
        )
    require(
        len(
            {
                (r["proposedExercise"]["lesson_index"], r["proposedExercise"]["slot_index"])
                for r in candidates
            }
        )
        == len(candidates),
        "proposed exercise placement collision",
    )
    out.mkdir(parents=True)
    write_new(out / "candidates.jsonl", candidates, lines=True)
    write_new(out / "sources.json", sources)
    write_new(out / "lexical-catalog.jsonl", list(catalog.values()), lines=True)
    write_new(out / "surface-catalog.jsonl", list(surfaces.values()), lines=True)
    write_new(out / "assets.json", asset_rows)
    write_new(out / "source-changes.json", changes)
    write_new(
        out / "deferred-picture-previews.json",
        [
            {
                "status": "blocked-verified-native-image-resolver-and-independent-source-review",
                "lexemeId": r["lexemeId"],
                "presentation": picture_presentation(
                    r, "unassembled-picture-" + r["lemma"], assets
                ),
            }
            for r in a["pictureAlternatives"]
        ],
    )
    write_new(
        out / "first-session.json",
        {
            **a["firstSession"],
            "exerciseIds": intro_ids,
            "candidateCount": len(intro_ids),
            "role": "recognition",
            "productionDelayPolicy": "unchanged core scheduler policy",
            "status": "pending-independent-review-and-source-integration",
            "sourceFactsSha256": digest(sources),
            "scope": (
                "Only the proposed first introduction session. Full three-level/six-session "
                "G3 path is not redefined; old source rows are preserved outside this proposal."
            ),
        },
    )
    write_new(
        out / "checks.json",
        {
            "candidateCount": len(candidates),
            "firstSessionRecognition": 3,
            "productionInFirstSession": 0,
            "actualLocalAxisChecks": len(proof["checks"]),
            "axisRejects": 0,
            "realProductionShapeChecks": len(candidates),
            "G6Approval": False,
            "assemblyReady": False,
            "pending": PENDING,
        },
    )
    write_new(
        out / "manifest.json",
        {
            "schemaVersion": 1,
            "authoringSha256": file_hash(revision / "authoring.json"),
            "analysisSha256": file_hash(revision / "inputs/local-analysis.json"),
            "exporterSha256": file_hash(__file__),
            "compiler": compiler_proofs(),
            "files": {p.name: file_hash(p) for p in out.iterdir()},
            "assemblyReady": False,
            "pending": PENDING,
        },
    )
    return load(out / "checks.json")


def compiler_proofs():
    from coursekit import artifacts
    from coursekit.packbuild import grading, itemid

    return {module.__name__: file_hash(module.__file__) for module in (artifacts, grading, itemid)}


def check(revision, bundle):
    revision = Path(revision)
    bundle = Path(bundle)
    m = load(bundle / "manifest.json")
    require(m["authoringSha256"] == file_hash(revision / "authoring.json"), "authoring drift")
    require(
        m["analysisSha256"] == file_hash(revision / "inputs/local-analysis.json"), "analysis drift"
    )
    require(m["exporterSha256"] == file_hash(__file__), "exporter drift")
    require(m["compiler"] == compiler_proofs(), "production compiler drift")
    for name, sha in m["files"].items():
        require(file_hash(bundle / name) == sha, "bundle drift: " + name)
    source_inputs(revision)
    for row in load(bundle / "assets.json"):
        require(
            file_hash(revision / row["sourcePath"]) == row["sourceSha256"]
            and file_hash(revision / row["rasterPath"]) == row["sha256"],
            "image bytes drift",
        )
    return load(bundle / "checks.json")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["analyse", "export", "check"])
    p.add_argument("--revision", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()
    print(
        json.dumps(
            {"analyse": analyse, "export": export, "check": check}[args.command](
                args.revision, args.out
            ),
            indent=2,
        )
    )
