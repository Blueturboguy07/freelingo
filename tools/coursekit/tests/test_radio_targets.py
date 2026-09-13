"""Original SQL target fixtures, independent of Spanish production content."""

import hashlib
import sqlite3

import pytest

from coursekit.narratives.compiler import NarrativeError
from coursekit.packbuild.itemid import canonical_json, item_id


def digest(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def fixture(tmp_path, mutate=None):
    semantic = {
        "prompt": "coffee",
        "preferredSurface": "café",
        "register": "neutral",
        "lexemes": ["café"],
        "grammarConcepts": [],
        "graphemes": [],
    }
    target = {
        "itemId": "i_original",
        "kind": "lexeme",
        "itemRef": "lx:café:NOUN",
        "surfaceId": "sf_" + digest(["es", "café"])[:32],
        "surface": "café",
        "language": "es",
        "canonical": True,
    }
    lexical = {
        "schedulerItemId": target["itemId"],
        "surfaceId": target["surfaceId"],
        "surface": "café",
        "language": "es",
        "lexemeId": "lx:café:NOUN",
        "lemma": "café",
        "pos": "NOUN",
        "wordItemId": item_id(semantic),
        "semantic": semantic,
        "countable": True,
        "classification": "word",
        "proof": {
            "sourceId": "s1",
            "sourceSha256": "1" * 64,
            "declarationSha256": "2" * 64,
            "bindingSha256": "3" * 64,
        },
    }
    runtime = {
        "schemaVersion": 1,
        "exerciseId": "ex1",
        "itemId": "i_original",
        "unitId": "u1",
        "lessonIndex": 1,
        "profileId": "spanish",
        "responseLanguage": "es",
        "schedulerSurfaces": [target],
        "lexicalBindings": [lexical],
        "proof": {
            "sourceId": "s1",
            "sourceSha256": "1" * 64,
            "approvalId": "approval1",
            "approvalSha256": "4" * 64,
            "draftSha256": "5" * 64,
        },
    }
    dbpath = tmp_path / "original.sqlite"
    db = sqlite3.connect(dbpath)
    db.executescript(
        "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);"
        "CREATE TABLE unit(unit_id TEXT PRIMARY KEY,unit_index INTEGER);"
        "CREATE TABLE exercise(exercise_id TEXT PRIMARY KEY,item_id TEXT,"
        "unit_id TEXT,lesson_index INTEGER,"
        "source_sentence_id TEXT);"
        "CREATE TABLE exercise_runtime(exercise_id TEXT PRIMARY KEY,"
        "payload_json TEXT,payload_sha256 TEXT);"
        "CREATE TABLE lexeme(lexeme_id TEXT PRIMARY KEY,lemma TEXT,pos TEXT);"
        "CREATE TABLE exercise_item_tag(exercise_id TEXT,item_kind TEXT,item_ref TEXT);"
    )
    db.executemany("INSERT INTO meta VALUES (?,?)", [("lang", "es"), ("pack_id", "original-pack")])
    db.execute("INSERT INTO unit VALUES ('u1',1)")
    db.execute("INSERT INTO exercise VALUES ('ex1','i_original','u1',1,'s1')")
    db.execute("INSERT INTO lexeme VALUES ('lx:café:NOUN','café','NOUN')")
    db.execute("INSERT INTO exercise_item_tag VALUES ('ex1','lexeme','café')")
    if mutate:
        mutate(runtime, db)
    raw = canonical_json(runtime)
    db.execute(
        "INSERT INTO exercise_runtime VALUES (?,?,?)",
        ("ex1", raw, hashlib.sha256(raw.encode()).hexdigest()),
    )
    db.commit()
    db.close()
    return dbpath, hashlib.sha256(dbpath.read_bytes()).hexdigest(), runtime, target


def test_INV_STO_10_radio_target_uses_exact_declared_surface_and_semantic_identity(tmp_path):
    from coursekit.narratives.targets import load_radio_targets

    path, sha, runtime, target = fixture(tmp_path)
    result = load_radio_targets(
        path,
        expected_sha256=sha,
        references=[
            {"exerciseId": "ex1", "schedulerItemId": "i_original", "surfaceId": target["surfaceId"]}
        ],
    )
    value = result.resolve("ex1", "i_original", target["surfaceId"])
    assert result.pack_sha256 == sha and result.language == "es"
    assert value["lexical"] == runtime["lexicalBindings"][0]
    assert value["scheduler"] == target and value["unitIndex"] == 1
    assert value["runtimeSha256"] == hashlib.sha256(canonical_json(runtime).encode()).hexdigest()
    value["lexical"]["lemma"] = "changed"
    assert result.resolve("ex1", "i_original", target["surfaceId"])["lexical"]["lemma"] == "café"


@pytest.mark.parametrize(
    "fault",
    [
        "pack-hash",
        "payload-hash",
        "no-runtime",
        "missing-target",
        "duplicate-target",
        "surface-drift",
        "language-drift",
        "definition-drift",
        "tag-drift",
        "identity-drift",
        "excluded-countable",
        "source-drift",
        "placement-drift",
        "duplicate-binding",
        "unknown-binding",
        "future-unit",
    ],
)
def test_INV_PACK_41_radio_target_refuses_stale_or_unbacked_pack_evidence(tmp_path, fault):
    from coursekit.narratives.targets import load_radio_targets

    def change(row, db):
        if fault == "duplicate-target":
            row["schedulerSurfaces"] *= 2
        if fault == "surface-drift":
            row["lexicalBindings"][0]["surface"] = "otro"
        if fault == "language-drift":
            row["lexicalBindings"][0]["language"] = "fr"
        if fault == "definition-drift":
            db.execute("UPDATE lexeme SET pos='VERB'")
        if fault == "tag-drift":
            db.execute("DELETE FROM exercise_item_tag")
        if fault == "identity-drift":
            row["lexicalBindings"][0]["semantic"]["prompt"] = "a different meaning"
        if fault == "excluded-countable":
            row["lexicalBindings"][0]["classification"] = "particle"
        if fault == "source-drift":
            row["lexicalBindings"][0]["proof"]["sourceSha256"] = "f" * 64
        if fault == "placement-drift":
            row["lessonIndex"] = 2
        if fault == "duplicate-binding":
            row["lexicalBindings"] *= 2
        if fault == "unknown-binding":
            row["lexicalBindings"][0]["guess"] = True
        if fault == "future-unit":
            db.execute("UPDATE unit SET unit_index=3")

    path, sha, row, target = fixture(tmp_path, change)
    if fault in {"payload-hash", "no-runtime"}:
        with sqlite3.connect(path) as db:
            db.execute(
                "UPDATE exercise_runtime SET payload_sha256=?", ("0" * 64,)
            ) if fault == "payload-hash" else db.execute("DELETE FROM exercise_runtime")
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
    if fault == "pack-hash":
        sha = "0" * 64
    ref = {"exerciseId": "ex1", "schedulerItemId": "i_original", "surfaceId": target["surfaceId"]}
    if fault == "missing-target":
        ref["surfaceId"] = "unknown"
    with pytest.raises(NarrativeError, match="Radio target"):
        load_radio_targets(path, expected_sha256=sha, references=[ref], maximum_unit_index=2)
