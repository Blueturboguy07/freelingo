"""G9's streamed learning extension. Called inside the pack write transaction.

The producer proves the current reviewed population; this boundary rechecks its frozen
hashes and joins against the rows actually inserted, and fully consumes the dictionary
stream before commit. It never modifies an installed or previously published pack.
"""

from __future__ import annotations

import hashlib
import sqlite3
from collections.abc import Mapping, Sequence
from typing import Any

from ..config.g9 import PACK_SCHEMA_TS_RELPATH
from .grading import GradingPayload, content_hash, require, text
from .itemid import canonical_json


def write_learning_extension(
    connection: sqlite3.Connection,
    payload: GradingPayload,
    credits: Sequence[Mapping[str, Any]],
) -> None:
    from .sqlite import read_ts_string_array, repo_root

    require(isinstance(payload, GradingPayload), "grading payload must come from its producer")
    meta = dict(connection.execute("SELECT key,value FROM meta"))
    required = {"packId": "pack_id", "courseId": "course_id", "packVersion": "version"}
    for field, key in required.items():
        require(
            payload.metadata.get(field) == meta.get(key) is not None,
            "grading pack identity mismatch",
        )
    require(payload.metadata.get("schemaVersion") == 1, "grading revision is unsupported")
    require(
        payload.provenance.get("metadataSha256") == content_hash(payload.metadata),
        "grading metadata changed after assembly",
    )
    require(
        payload.provenance.get("runtimeSha256") == content_hash(payload.runtime_items),
        "grading runtime changed after assembly",
    )
    source_cursor = connection.execute("SELECT * FROM exercise ORDER BY exercise_id")
    columns = [column[0] for column in source_cursor.description]
    actual_rows = [dict(zip(columns, row, strict=True)) for row in source_cursor]
    require(
        payload.provenance.get("exerciseRowsSha256") == content_hash(actual_rows),
        "grading exercise content changed after assembly",
    )
    cursor = connection.execute("SELECT exercise_id,item_id,unit_id,lesson_index FROM exercise")
    exercises = {row[0]: row[1:] for row in cursor}
    seen = set()
    for row in payload.runtime_items:
        identifier = row.get("exerciseId")
        require(
            identifier not in seen and identifier in exercises,
            "grading runtime population differs from actual exercises",
        )
        require(
            (row.get("itemId"), row.get("unitId"), row.get("lessonIndex")) == exercises[identifier],
            "grading runtime item/placement differs from actual exercise",
        )
        seen.add(identifier)
    require(seen == exercises.keys() and bool(seen), "grading runtime population is incomplete")

    profiles = {}
    for profile in payload.metadata["profiles"]:
        identifier = profile["profileId"]
        words = profile["configuration"]["targetLanguageWords"]
        require(
            identifier not in profiles
            and words["kind"] == "table"
            and words["table"] == "grading_word"
            and words["profileId"] == identifier,
            "grading dictionary profile binding",
        )
        profiles[identifier] = words

    def check_dictionary_bindings():
        seen_profiles = set()
        actual_proofs = []
        for dictionary in payload._dictionaries:
            profile = dictionary.profile_id
            require(
                profile in profiles and profile not in seen_profiles,
                "grading streamed dictionary profile differs",
            )
            seen_profiles.add(profile)
            words = profiles[profile]
            require(
                dictionary.count == words["count"]
                and dictionary.sha256 == words["sha256"]
                and dictionary.provenance == words["provenance"],
                "grading streamed dictionary proof differs from frozen metadata",
            )
            actual_proofs.append(dictionary.provenance)
        require(seen_profiles == profiles.keys(), "grading streamed dictionary is missing")
        require(
            actual_proofs == payload.provenance["dictionaryProofs"],
            "grading dictionary proof order/content differs",
        )

    check_dictionary_bindings()
    # Credits are independently supplied, not guessed from a filename or a notice.
    credit_by_source = {}
    for credit in credits:
        source = text(credit.get("source_id"), "dictionary credit source")
        require(source not in credit_by_source, "dictionary credit is duplicated")
        require(
            set(credit) == {"source_id", "owner", "licence", "url", "notice"},
            "dictionary credit fields",
        )
        text(credit["owner"], "dictionary credit owner")
        credit_by_source[source] = dict(credit)
    expected_sources = {words["provenance"]["sourceId"] for words in profiles.values()}
    require(credit_by_source.keys() == expected_sources, "dictionary credit population differs")
    counts = {source: 0 for source in expected_sources}
    for words in profiles.values():
        proof = words["provenance"]
        credit = credit_by_source[proof["sourceId"]]
        for left, right in (("licence", "license"), ("url", "sourceUrl"), ("notice", "notice")):
            require(credit[left] == proof[right], "dictionary credit disagrees with actual source")
        counts[proof["sourceId"]] += words["count"]

    for ddl in read_ts_string_array(repo_root() / PACK_SCHEMA_TS_RELPATH, "PACK_LEARNING_DDL"):
        connection.execute(ddl)
    connection.execute(
        "INSERT INTO meta VALUES (?,?)", ("grading:v1", canonical_json(payload.metadata))
    )
    connection.execute(
        "INSERT INTO meta VALUES (?,?)",
        ("grading-provenance:v1", canonical_json(payload.provenance)),
    )
    for source, credit in credit_by_source.items():
        connection.execute(
            "INSERT INTO meta VALUES (?,?)",
            (
                "attribution:" + source,
                canonical_json({**credit, "kind": "derived-list", "items": counts[source]}),
            ),
        )
    for row in payload.runtime_items:
        encoded = canonical_json(row)
        connection.execute(
            "INSERT INTO exercise_runtime VALUES (?,?,?)",
            (row["exerciseId"], encoded, hashlib.sha256(encoded.encode("utf-8")).hexdigest()),
        )
    # executemany consumes through StopIteration, including the producer's final hash
    # checks. A changed source cannot leave a successfully committed prefix behind.
    counts_by_profile = {profile: 0 for profile in profiles}
    hashes = {profile: hashlib.sha256() for profile in profiles}

    def rows():
        for profile, word in payload.word_rows():
            require(profile in profiles, "grading dictionary has an unknown profile")
            counts_by_profile[profile] += 1
            hashes[profile].update(word.encode("utf-8") + b"\n")
            yield profile, word

    connection.executemany("INSERT INTO grading_word VALUES (?,?)", rows())
    check_dictionary_bindings()
    for profile, words in profiles.items():
        require(
            counts_by_profile[profile] == words["count"]
            and hashes[profile].hexdigest() == words["sha256"],
            "grading dictionary metadata/count/content mismatch",
        )
