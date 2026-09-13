"""Reviewed lexical identities and explicit surface bindings for the two word counters."""

from .grading import content_hash, fields, index, require, reviewed, sha, string_list, text
from .itemid import item_id

CATALOG_FIELDS = {
    "lexemeId",
    "lemma",
    "pos",
    "language",
    "wordItemId",
    "semantic",
    "countable",
    "classification",
    "sources",
}
BINDING_FIELDS = {
    "exerciseId",
    "sourceId",
    "sourceSha256",
    "schedulerItemId",
    "surfaceId",
    "lexemeId",
    "wordItemId",
}
RUNTIME_FIELDS = {
    "schedulerItemId",
    "surfaceId",
    "surface",
    "language",
    "lexemeId",
    "lemma",
    "pos",
    "wordItemId",
    "semantic",
    "countable",
    "classification",
    "proof",
}


def lexical_identity(row, lexemes, language):
    """No POS-to-countability inference; semantics are independently declared."""
    lexeme = lexemes.get(text(row["lexemeId"], "lexical identity"))
    require(
        lexeme is not None
        and row["lemma"] == lexeme["lemma"]
        and row["pos"] == lexeme["pos"]
        and row["language"] == language,
        "lexical identity: actual lexeme definition/language mismatch",
    )
    classification = row["classification"]
    require(
        classification in {"word", "particle", "bound-morpheme", "character"}
        and type(row["countable"]) is bool
        and (not row["countable"] or classification == "word"),
        "lexical countability: invalid classification or excluded item",
    )
    semantic = fields(
        row["semantic"],
        {"prompt", "preferredSurface", "register", "lexemes", "grammarConcepts", "graphemes"},
        "lexical semantics",
    )
    for key in ("prompt", "preferredSurface", "register"):
        text(semantic[key], "lexical semantics " + key)
    require(
        string_list(semantic["lexemes"], "lexical semantic tags") == [row["lemma"]]
        and semantic["grammarConcepts"] == []
        and semantic["graphemes"] == [],
        "lexical semantics: exact lexical tags required",
    )
    require(
        row["wordItemId"] == item_id(semantic), "lexical identity: semantic content hash mismatch"
    )
    return {key: row[key] for key in ("semantic", "countable", "classification")}


def consistent_word_identity(row, identities):
    value = {key: row[key] for key in ("semantic", "countable", "classification")}
    previous = identities.setdefault(row["wordItemId"], value)
    require(previous == value, "lexical identity: conflicting content for the same word item ID")


def validate_lexical_catalog(rows, *, language, sources, lexemes):
    catalog = index(rows, "lexemeId", "lexical catalog")
    identities = {}
    for row in catalog.values():
        reviewed(row, CATALOG_FIELDS, "lexical declaration")
        lexical_identity(row, lexemes, language)
        consistent_word_identity(row, identities)
        origins = index(row["sources"], "sourceId", "lexical declaration sources")
        require(bool(origins), "lexical declaration: source evidence missing")
        for origin in origins.values():
            fields(origin, {"sourceId", "sourceSha256"}, "lexical declaration source")
            source = sources.get(origin["sourceId"])
            require(
                source is not None
                and source.get("lang") == language
                and sha(origin["sourceSha256"], "lexical source hash") == content_hash(source),
                "lexical declaration: stale source snapshot",
            )
            tokens = source.get("analysis", {}).get("tokens", [])
            require(
                any(t.get("lemma") == row["lemma"] and t.get("pos") == row["pos"] for t in tokens)
                or (
                    source.get("lexeme_id") == row["lexemeId"]
                    and source.get("lemma") == row["lemma"]
                    and source.get("pos") == row["pos"]
                )
                or any(
                    p.get("leftLexemeId") == row["lexemeId"]
                    for p in source.get("reviewedGlossPairs", [])
                ),
                "lexical declaration: lexeme absent from exact source evidence",
            )
    return catalog


def build_lexical_bindings(catalog, bindings, scheduler, *, exercise_id, source_id, source_sha256):
    require(isinstance(bindings, list), "lexical bindings: explicit mappings missing")
    expected = {
        (row["itemId"], row["surfaceId"]): row for row in scheduler if row["kind"] == "lexeme"
    }
    seen, result = set(), []
    for binding in bindings:
        reviewed(binding, BINDING_FIELDS, "lexical binding")
        key = (binding["schedulerItemId"], binding["surfaceId"])
        target = expected.get(key)
        declaration = catalog.get(binding["lexemeId"])
        require(
            key not in seen
            and target is not None
            and declaration is not None
            and target["itemRef"] == binding["lexemeId"]
            and declaration["wordItemId"] == binding["wordItemId"],
            "lexical binding: missing/duplicate/wrong scheduler target or identity",
        )
        require(
            binding["exerciseId"] == exercise_id
            and binding["sourceId"] == source_id
            and binding["sourceSha256"] == source_sha256
            and {"sourceId": source_id, "sourceSha256": source_sha256} in declaration["sources"],
            "lexical binding: stale source/exercise snapshot",
        )
        seen.add(key)
        result.append(
            {
                "schedulerItemId": target["itemId"],
                "surfaceId": target["surfaceId"],
                "surface": target["surface"],
                **{
                    key: declaration[key]
                    for key in (
                        "lexemeId",
                        "lemma",
                        "pos",
                        "language",
                        "wordItemId",
                        "semantic",
                        "countable",
                        "classification",
                    )
                },
                "proof": {
                    "sourceId": source_id,
                    "sourceSha256": source_sha256,
                    "declarationSha256": content_hash(declaration),
                    "bindingSha256": content_hash(binding),
                },
            }
        )
    require(seen == expected.keys(), "lexical bindings: incomplete scheduler surface population")
    return result


def validate_runtime_lexical_bindings(row, lexemes, language, identities):
    bindings = row.get("lexicalBindings")
    require(isinstance(bindings, list), "lexical bindings: explicit mappings missing")
    expected = {
        (t["itemId"], t["surfaceId"]): t for t in row["schedulerSurfaces"] if t["kind"] == "lexeme"
    }
    seen = set()
    for binding in bindings:
        fields(binding, RUNTIME_FIELDS, "lexical runtime binding")
        lexical_identity(binding, lexemes, language)
        consistent_word_identity(binding, identities)
        key = (binding["schedulerItemId"], binding["surfaceId"])
        target = expected.get(key)
        require(
            key not in seen
            and target is not None
            and target["itemRef"] == binding["lexemeId"]
            and target["surface"] == binding["surface"]
            and target["language"] == binding["language"],
            "lexical runtime binding: actual scheduler surface mismatch",
        )
        proof = fields(
            binding["proof"],
            {"sourceId", "sourceSha256", "declarationSha256", "bindingSha256"},
            "lexical runtime proof",
        )
        for key in ("sourceSha256", "declarationSha256", "bindingSha256"):
            sha(proof[key], "lexical runtime proof")
        require(
            proof["sourceId"] == row["proof"]["sourceId"]
            and proof["sourceSha256"] == row["proof"]["sourceSha256"],
            "lexical runtime binding: source proof mismatch",
        )
        seen.add((binding["schedulerItemId"], binding["surfaceId"]))
    require(
        seen == expected.keys(), "lexical runtime bindings: incomplete scheduler surface population"
    )
