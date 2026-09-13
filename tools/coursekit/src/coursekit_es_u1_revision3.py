"""Second independent-review correction over a frozen, still-unapproved author bundle.

All additions are explicit author data. Local source and shape checks are not G6,
independent review, SQL insertion or an installed-pack capability.
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "es_u1_frozen_revision2", Path(__file__).with_name("coursekit_es_u1_revision.py")
)
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)
load, rows, digest, file_hash, require, write_new = (
    base.load,
    base.rows,
    base.digest,
    base.file_hash,
    base.require,
    base.write_new,
)
PENDING = base.PENDING
KEEP = ["8180f214fcc79b40", "05fb73a8c2f6c12d", "04e7339237305ab0"]
CHANGED = {"b03de7ed176e07a1", "16f59b19698b62a0"}


def validate_authoring(a, original):
    base.no_authored_approval(a)
    by = {c["draft"]["record"]["exercise_id"]: c for c in original}
    require(a["schemaVersion"] == 1 and a["author"].strip(), "author contract")
    require(
        {c["exerciseId"] for c in a["englishRevisions"]} == CHANGED
        and len(a["englishRevisions"]) == 2,
        "exact review corrections required",
    )
    for c in a["englishRevisions"]:
        old = by[c["exerciseId"]]
        require(c["candidateSha256"] == digest(old), "stale original candidate")
        require(
            old["draft"]["responseLanguage"] == "en"
            and old["draft"]["shapeId"] == "typed_translate_reverse",
            "English reverse-only correction",
        )
        base.ranked(c["answers"])
        require(
            c["answers"][: len(old["proposedAnswers"])] == old["proposedAnswers"],
            "existing canonical and accepted ranks must remain",
        )
        require(
            len(c["answers"]) > len(old["proposedAnswers"]),
            "review omission needs actual additions",
        )
    session = a["firstSession"]
    require(
        session["keepExerciseIds"] == KEEP, "three independently accepted introductions must remain"
    )
    require(session["productionAllowed"] is False, "production cannot pad first session")
    additions = a["recognitionAdditions"]
    require(
        len(additions) == 3 and session["additionalSourceOrder"] == [r["text"] for r in additions],
        "exact authored first-session additions required",
    )
    require(len({r["text"] for r in additions}) == 3, "duplicate source text")
    require(len({r["exerciseSlotIndex"] for r in additions}) == 3, "duplicate placement")
    for c in additions:
        require(
            c["sourceKind"] in {"lexical-authoring-proposal", "existing-source-shape-variant"},
            "source kind",
        )
        require(
            c["introduction"]
            == ("word" if c["sourceKind"] == "lexical-authoring-proposal" else "phrase"),
            "source display cue",
        )
        require(c["lexemeId"] == f"lx:{c['lemma']}:{c['pos']}", "exact lexeme declaration")
        require(
            c["classification"] == "word" and c["countable"] is True,
            "declared lexical countability",
        )
        if c["sourceKind"] == "existing-source-shape-variant":
            require(
                any(
                    row["draft"]["sourceId"] == c["existingSourceId"]
                    and row["draft"]["sourceSha256"] == c["existingSourceSha256"]
                    for row in original
                ),
                "reused source must match frozen source hash",
            )
        base.ranked(c["answers"])
        require(c["answers"][0]["surface"] == c["translation"], "canonical meaning")
        require(
            len(c["options"]) >= 3 and len({x["id"] for x in c["options"]}) == len(c["options"]),
            "distinct offered options",
        )
        offered = [x["text"] for x in c["options"]]
        require(
            len(set(offered)) == len(offered)
            and sum(x in [r["surface"] for r in c["answers"]] for x in offered) == 1
            and c["translation"] in offered,
            "exact one correct offered meaning",
        )
    return by


def inputs(revision):
    revision = Path(revision)
    prior = revision.parent / "first-unit-20260913-revision-2"
    a = load(revision / "authoring.json")
    m = load(prior / "bundle/manifest.json")
    require(
        file_hash(prior / "bundle/manifest.json") == a["baseManifestSha256"],
        "frozen parent manifest drift",
    )
    require(
        file_hash(prior / "bundle/candidates.jsonl") == a["baseCandidatesSha256"],
        "frozen parent candidates drift",
    )
    for name, sha in m["files"].items():
        require(file_hash(prior / "bundle" / name) == sha, "frozen parent bundle drift")
    original = rows(prior / "bundle/candidates.jsonl")
    validate_authoring(a, original)
    _, _, _, selected, banded, _, unit = base.source_inputs(prior)
    require(
        file_hash(revision / "inputs/glosses.jsonl")
        == load(revision / "inputs/provenance.json")["snapshotSha256"],
        "glossary snapshot drift",
    )
    return a, original, selected, banded, unit, rows(revision / "inputs/glosses.jsonl"), prior


def source_id(row):
    if row["sourceKind"] == "existing-source-shape-variant":
        return row["existingSourceId"]
    return digest(
        [
            "es-u1-author-revision-3",
            {k: row[k] for k in ["text", "translation", "sourceKind", "g4SlotIndex"]},
        ]
    )[:16]


def analyse(revision, out):
    from coursekit.lexeme_glosses import _VALIDATOR, gloss_content_hash

    import coursekit.adapters.spacy_es as adapter_module
    import coursekit.stages.g5_gapfill as axis_module
    from coursekit.adapters.spacy_es import build
    from coursekit.config.g5 import min_tokens_for_slot
    from coursekit.stages.g5_gapfill import _axis, ledger_digest

    a, _, selected, banded, unit, glosses, _ = inputs(revision)
    analyser = build()
    for g in glosses:
        require(
            not list(_VALIDATOR.iter_errors(g))
            and g["review"]["verdict"] == "accepted"
            and g["review"]["content_hash"] == gloss_content_hash(g),
            "existing independent glossary proof",
        )
    slots = {r["slot_index"]: r for r in selected if r["lesson_index"] == 1}
    pos = {r["lemma"]: r["pos"] for r in banded}
    checks = []
    for c in a["recognitionAdditions"]:
        g = slots[c["g4SlotIndex"]]
        sid = source_id(c)
        minimum = min_tokens_for_slot(g["known_lemmas"], g["new_lemmas"], pos)
        raw = {
            "lang": "es",
            "text": c["text"],
            "translation": c["translation"],
            "new_lemmas": g["new_lemmas"],
            "ledger_digest": ledger_digest(g["known_lemmas"], g["new_lemmas"]),
            "accepted_alternates": [],
        }
        reject, _ = _axis(raw, g, analyser, set(), sid, minimum, required_unit=unit)
        actual = analyser.analyse(sentence_id=sid, text=c["text"])
        checks.append(
            {
                "sourceId": sid,
                "text": c["text"],
                "selectedSlotSha256": digest(g),
                "minimumTokens": minimum,
                "axisReject": reject,
                "analysis": actual,
                "analysisSha256": digest(actual),
            }
        )
    write_new(
        out,
        {
            "schemaVersion": 1,
            "authoringSha256": file_hash(Path(revision) / "authoring.json"),
            "driverSha256": file_hash(__file__),
            "adapter": analyser.fingerprint(),
            "adapterSourceSha256": file_hash(adapter_module.__file__),
            "axisSourceSha256": file_hash(axis_module.__file__),
            "checks": checks,
            "G6Approval": None,
        },
    )
    return {
        "newLocalAxisChecks": len(checks),
        "rejected": sum(c["axisReject"] is not None for c in checks),
        "G6Approval": False,
    }


def validate_analysis(a, proof, selected, revision):
    from coursekit.artifacts import validate_record

    require(
        proof["authoringSha256"] == file_hash(Path(revision) / "authoring.json")
        and proof["driverSha256"] == file_hash(__file__),
        "stale analysis/driver",
    )
    require(proof["G6Approval"] is None, "local analysis cannot claim G6")
    expected = {source_id(r): r for r in a["recognitionAdditions"]}
    require(
        len(proof["checks"]) == len(expected)
        and {r["sourceId"] for r in proof["checks"]} == set(expected),
        "current source check population",
    )
    slots = {r["slot_index"]: r for r in selected if r["lesson_index"] == 1}
    for c in proof["checks"]:
        r = expected[c["sourceId"]]
        analysis = c["analysis"]
        validate_record("analysed_sentence", analysis)
        require(
            c["text"] == r["text"] and c["selectedSlotSha256"] == digest(slots[r["g4SlotIndex"]]),
            "source/slot drift",
        )
        require(c["axisReject"] is None, "actual local source rejection")
        require(
            c["analysisSha256"] == digest(analysis) and analysis["sentence_id"] == c["sourceId"],
            "exact current source analysis",
        )
        require(
            all(r["text"][t["start"] : t["end"]] == t["surface"] for t in analysis["tokens"]),
            "source spans differ",
        )


def export(revision, out):
    from coursekit.packbuild.grading import surface_id, validate_shape

    from coursekit.artifacts import validate_record
    from coursekit.packbuild.itemid import item_id

    revision = Path(revision)
    out = Path(out)
    require(not out.exists(), "new output directory required")
    a, original, selected, banded, unit, glosses, prior = inputs(revision)
    base.check(prior, prior / "bundle")
    proof = load(revision / "inputs/local-analysis.json")
    validate_analysis(a, proof, selected, revision)
    candidates = copy.deepcopy(original)
    by = {r["draft"]["record"]["exercise_id"]: r for r in candidates}
    sources = load(prior / "bundle/sources.json")
    catalog = {r["lexemeId"]: r for r in rows(prior / "bundle/lexical-catalog.jsonl")}
    surfaces = {r["surfaceId"]: r for r in rows(prior / "bundle/surface-catalog.jsonl")}
    slots = {r["slot_index"]: r for r in selected if r["lesson_index"] == 1}
    g2 = {r["lemma"]: r for r in banded}
    gloss = {(r["lemma"], r["pos"]): r for r in glosses}
    analyses = {r["sourceId"]: r["analysis"] for r in proof["checks"]}
    new_ids = []

    def add_surface(language, surface, rank, sid, introduction=None):
        sf = surface_id(language, surface)
        old = surfaces.get(sf)
        if old:
            require(
                old["rank"] == rank
                and (introduction is None or old["introduction"] in (None, introduction)),
                "conflicting surface rank/display",
            )
            # A previously undeclared surface gains its first explicit visible
            # introduction. Never replace another declared display event.
            if introduction is not None:
                old["introduction"] = introduction
            if sid not in old["sourceIds"]:
                old["sourceIds"].append(sid)
        else:
            surfaces[sf] = {
                "surfaceId": sf,
                "language": language,
                "surface": surface,
                "rank": rank,
                "introduction": introduction,
                "sourceIds": [sid],
                "author": a["author"],
            }
        return sf

    for amendment in a["englishRevisions"]:
        c = by[amendment["exerciseId"]]
        d = c["draft"]
        forms = [r["surface"] for r in amendment["answers"]]
        d["record"]["accepted_answers"] = forms
        d["presentation"]["acceptedAnswers"] = forms
        d["surfaceIds"] = [
            add_surface("en", r["surface"], r["rank"], d["sourceId"]) for r in amendment["answers"]
        ]
        c["proposedAnswers"] = amendment["answers"]
        c["proposedExercise"]["accepted_answers_json"] = base.canonical(forms)
        c["authorRevision"] = {
            "author": a["author"],
            "fromCandidateSha256": amendment["candidateSha256"],
            "rationale": amendment["rationale"],
        }
    for entry in a["recognitionAdditions"]:
        sid = source_id(entry)
        analysis = analyses[sid]
        g = slots[entry["g4SlotIndex"]]
        lemma = entry["lemma"]
        part = entry["pos"]
        ref = entry["lexemeId"]
        require(g2[lemma]["pos"] == part, "unchanged G2 POS differs")
        s = {
            "lang": "es",
            "unit_index": 1,
            "lesson_index": 1,
            "text": entry["text"],
            "translation": entry["translation"],
            "sourceKind": entry["sourceKind"],
            "analysis": analysis,
            "selectedSlot": g,
            "license": a["licence"],
            "author": a["author"],
        }
        if entry["sourceKind"] == "lexical-authoring-proposal":
            reviewed = gloss[(lemma, part)]
            require(
                reviewed["citation_gloss"] == entry["translation"],
                "source meaning differs from reviewed glossary",
            )
            s.update(lexeme_id=ref, lemma=lemma, pos=part, reviewedGlossary=reviewed, g2=g2[lemma])
        else:
            require(
                any(t["lemma"] == lemma and t["pos"] == part for t in analysis["tokens"]),
                "phrase lexical target lacks actual G1 evidence",
            )
            s = sources[sid]
            require(
                digest(s) == entry["existingSourceSha256"]
                and s["text"] == entry["text"]
                and s["translation"] == entry["translation"]
                and s["analysis"] == analysis
                and s["selectedSlot"] == g,
                "reused source text/analysis/slot must remain exact",
            )
        sha = digest(s)
        sources[sid] = s
        lemmas = analysis["lemmas"]
        forms = [r["surface"] for r in entry["answers"]]
        prompt = entry["instruction"] + "\n" + entry["text"]
        semantic = {
            "prompt": prompt,
            "preferredSurface": forms[0],
            "register": "tu",
            "lexemes": sorted(lemmas),
            "grammarConcepts": [],
            "graphemes": [],
        }
        item = item_id(semantic)
        eid = digest([sid, "meaning_select", entry["exerciseSlotIndex"], semantic])[:16]
        new_ids.append(eid)
        p = {
            "itemId": item,
            "type": "meaningSelect",
            "instruction": entry["instruction"],
            "prompt": entry["text"],
            "promptLanguage": "es",
            "language": "en",
            "acceptedAnswers": forms,
            "introduction": entry["introduction"],
            "options": entry["options"],
        }
        distractors = [r["text"] for r in p["options"] if r["text"] not in forms]
        record = {
            "schema_version": 1,
            "lang": "es",
            "exercise_id": eid,
            "unit_index": 1,
            "lesson_index": 1,
            "type": "match",
            "prompt": prompt,
            "accepted_answers": forms,
            "distractors": distractors,
            "item_tags": {"lemmas": sorted(lemmas), "grammar_concepts": []},
            "source_sentence_id": sid,
            "audio_ref": None,
            "alignment": [],
            "register": "tu",
        }
        accepted = [add_surface("en", r["surface"], r["rank"], sid) for r in entry["answers"]]
        target = add_surface(
            "es",
            entry["text"],
            0,
            sid,
            {"exerciseId": eid, "unitId": "u001", "lessonIndex": 1, "when": "prompt"},
        )
        if ref not in catalog:
            semantic_word = {
                "prompt": gloss[(lemma, part)]["citation_gloss"],
                "preferredSurface": lemma,
                "register": "neutral",
                "lexemes": [lemma],
                "grammarConcepts": [],
                "graphemes": [],
            }
            catalog[ref] = {
                "lexemeId": ref,
                "lemma": lemma,
                "pos": part,
                "language": "es",
                "wordItemId": item_id(semantic_word),
                "semantic": semantic_word,
                "countable": entry["countable"],
                "classification": entry["classification"],
                "sources": [],
                "author": a["author"],
            }
        lexical = catalog[ref]
        binding = {"sourceId": sid, "sourceSha256": sha}
        if binding not in lexical["sources"]:
            lexical["sources"].append(binding)
        d = {
            "record": record,
            "shapeId": "meaning_select",
            "shapeEvidence": {"kind": "simple"},
            "sourceId": sid,
            "sourceSha256": sha,
            "profileId": "en-recognition-v1",
            "responseLanguage": "en",
            "surfaceIds": accepted,
            "schedulerSurfaces": [{"itemId": item, "surfaceId": target, "canonical": True}],
            "gradable": {"family": "select", "schedulerFacet": "meaning"},
            "presentation": p,
            "schedulerObjective": {
                "exerciseId": eid,
                **binding,
                "kind": "lexeme",
                "itemRef": ref,
                "author": a["author"],
            },
            "explanation": {
                "exerciseId": eid,
                "sourceId": sid,
                "text": entry["explanation"],
                "author": a["author"],
            },
            "lexicalBindings": [
                {
                    "exerciseId": eid,
                    **binding,
                    "schedulerItemId": item,
                    "surfaceId": target,
                    "lexemeId": ref,
                    "wordItemId": lexical["wordItemId"],
                    "author": a["author"],
                }
            ],
        }
        sql = {
            "exercise_id": eid,
            "item_id": item,
            "unit_id": "u001",
            "lesson_index": 1,
            "slot_index": entry["exerciseSlotIndex"],
            "type": "match",
            "prompt": prompt,
            "preferred_surface": forms[0],
            "accepted_answers_json": base.canonical(forms),
            "distractors_json": base.canonical(distractors),
            "source_sentence_id": sid,
            "audio_id": None,
            "illustration_ref": None,
            "register": "tu",
            "alignment_json": "[]",
            "ruby_json": None,
        }
        candidates.append(
            {
                "schemaVersion": 1,
                "status": "unreviewed-proposed-source-and-G7-row",
                "originalExerciseId": None,
                "draft": d,
                "proposedExercise": sql,
                "proposedTags": [
                    {
                        "exercise_id": eid,
                        "item_kind": "lexeme",
                        "item_ref": lx,
                        "is_new": int(lx in g["new_lemmas"]),
                    }
                    for lx in sorted(lemmas)
                ],
                "proposedAnswers": entry["answers"],
                "assemblyReady": False,
                "pending": PENDING,
            }
        )
    for c in candidates:
        d = c["draft"]
        validate_record("exercise", d["record"])
        validate_shape(
            d["gradable"],
            d["presentation"],
            [surfaces[s] for s in d["surfaceIds"]],
            {},
            d,
            {},
            [],
            sources[d["sourceId"]],
            [],
        )
    require(
        len({r["draft"]["record"]["exercise_id"] for r in candidates}) == len(candidates),
        "duplicate exercise identity",
    )
    require(
        len({r["draft"]["presentation"]["itemId"] for r in candidates}) == len(candidates),
        "duplicate semantic exercise identity",
    )
    require(
        len(
            {
                (r["proposedExercise"]["lesson_index"], r["proposedExercise"]["slot_index"])
                for r in candidates
            }
        )
        == len(candidates),
        "duplicate SQL placement",
    )
    first = load(prior / "bundle/first-session.json")
    first_ids = KEEP + new_ids
    first.update(
        exerciseIds=first_ids,
        candidateCount=len(first_ids),
        orderedLexemeIds=[
            c["draft"]["schedulerObjective"]["itemRef"]
            for eid in first_ids
            for c in candidates
            if c["draft"]["record"]["exercise_id"] == eid
        ],
        rationale=a["firstSession"]["rationale"],
        sourceFactsSha256=digest(sources),
    )
    first["distinctLexicalIdentities"] = len(set(first["orderedLexemeIds"]))
    first["displayedSpanishSurfaceCount"] = len(first_ids)
    out.mkdir(parents=True)
    write_new(out / "candidates.jsonl", candidates, lines=True)
    write_new(out / "sources.json", sources)
    write_new(out / "lexical-catalog.jsonl", list(catalog.values()), lines=True)
    write_new(out / "surface-catalog.jsonl", list(surfaces.values()), lines=True)
    write_new(out / "first-session.json", first)
    write_new(
        out / "changes.json",
        {
            "englishExerciseIds": sorted(CHANGED),
            "newRecognitionExerciseIds": new_ids,
            "preservedCandidateHashes": {
                c["draft"]["record"]["exercise_id"]: digest(c)
                for c in original
                if c["draft"]["record"]["exercise_id"] not in CHANGED
            },
        },
    )
    write_new(
        out / "checks.json",
        {
            "candidateCount": len(candidates),
            "realProductionShapeChecks": len(candidates),
            "firstSessionRecognition": len(first_ids),
            "productionInFirstSession": 0,
            "distinctLexicalIdentities": first["distinctLexicalIdentities"],
            "displayedSpanishSurfaceCount": len(first_ids),
            "newLocalAxisChecks": len(proof["checks"]),
            "axisRejects": 0,
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
            "compiler": base.compiler_proofs(),
            "files": {p.name: file_hash(p) for p in out.iterdir()},
            "assemblyReady": False,
            "pending": PENDING,
        },
    )
    return load(out / "checks.json")


def check(revision, out):
    revision = Path(revision)
    out = Path(out)
    m = load(out / "manifest.json")
    inputs(revision)
    require(
        m["authoringSha256"] == file_hash(revision / "authoring.json")
        and m["analysisSha256"] == file_hash(revision / "inputs/local-analysis.json")
        and m["exporterSha256"] == file_hash(__file__),
        "author/checker drift",
    )
    require(m["compiler"] == base.compiler_proofs(), "compiler drift")
    for name, sha in m["files"].items():
        require(file_hash(out / name) == sha, "bundle drift")
    return load(out / "checks.json")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["analyse", "export", "check"])
    parser.add_argument("--revision", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    print(
        json.dumps(
            {"analyse": analyse, "export": export, "check": check}[args.command](
                args.revision, args.out
            ),
            indent=2,
        )
    )
