"""Constants owned by package (G9).

Manifest fields, the attribution table shape, the item-id rule and the budget assertion.
INV-PACK-15 covers all three pipelines (lesson, story, radio), not lessons alone (R14).

The one rule worth reading before changing anything here: **the pack's column shapes are
not in this file and never will be.** They live in `packages/schema/src/pack-schema.ts`,
which the app also reads, and `packbuild/sqlite.py` parses that file at build time. What
is here is where to find it and what to call it.

Owner: p2-g9-package
"""

from __future__ import annotations

from typing import Final

# ---------------------------------------------------------------------------
# Where the one copy of the schema lives
# ---------------------------------------------------------------------------

#: The single source of the pack DDL, relative to the repository root. Parsed by
#: `packbuild.sqlite.pack_schema_ddl()`; a second copy in Python would drift, and it
#: would drift into a pack that builds green and returns no rows on a device.
PACK_SCHEMA_TS_RELPATH: Final[str] = "packages/schema/src/pack-schema.ts"

#: The exported array names this build reads out of that file.
DDL_ARRAY_NAME: Final[str] = "PACK_SCHEMA_DDL"
SEMANTIC_FIELDS_ARRAY_NAME: Final[str] = "SEMANTIC_ITEM_FIELDS"
PRESENTATION_FIELDS_ARRAY_NAME: Final[str] = "PRESENTATION_ITEM_FIELDS"

#: `PRAGMA user_version` a pack declares. Mirrors `PACK_SCHEMA_VERSION` in the TS file
#: and is asserted against the built database, not against the constant.
PACK_SCHEMA_VERSION: Final[int] = 1

#: Insertion order, which is NOT `PACK_TABLES` order: foreign keys are ON during the
#: build (a dangling reference must fail here, not become an empty screen on a device),
#: so a referenced table is written before the table that references it. Mirrors
#: `PACK_TABLE_NAMES` in `pack-schema.ts`, and `tests/test_g9_package.py` asserts the two
#: are the same set.
PACK_INSERT_ORDER: Final[tuple[str, ...]] = (
    "meta",
    "audio",
    "lexeme",
    "grammar_concept",
    "sentence",
    "unit",
    "unit_item",
    "exercise",
    "exercise_item_tag",
    "story",
    "radio_episode",
    "character_lesson",
)

#: The column(s) that identify a row of each pack table, joined by `/` to form the
#: `pack_row` artefact's `row_id`. Two tables are pure joins and have no single id, which
#: is why this is a tuple per table rather than a string.
PACK_ROW_ID_COLUMNS: Final[dict[str, tuple[str, ...]]] = {
    "meta": ("key",),
    "audio": ("audio_id",),
    "lexeme": ("lexeme_id",),
    "grammar_concept": ("concept_id",),
    "sentence": ("sentence_id",),
    "unit": ("unit_id",),
    "unit_item": ("unit_id", "item_kind", "item_ref"),
    "exercise": ("exercise_id",),
    "exercise_item_tag": ("exercise_id", "item_kind", "item_ref"),
    "story": ("story_id",),
    "radio_episode": ("episode_id",),
    "character_lesson": ("character_lesson_id",),
}

#: Tables the schema creates and a v0 pack leaves empty: Stories and Radio are P6, the
#: Japanese characters stage is P7. Present now so a later pack version is not a schema
#: migration on a file the app may not write to.
PACK_TABLES_EMPTY_AT_V0: Final[tuple[str, ...]] = ("story", "radio_episode", "character_lesson")

# ---------------------------------------------------------------------------
# Pack layout on disk
# ---------------------------------------------------------------------------

PACK_DB_FILENAME: Final[str] = "pack.sqlite"
MANIFEST_FILENAME: Final[str] = "manifest.json"
SIGNATURE_FILENAME: Final[str] = "manifest.sig"
AUDIO_DIRNAME: Final[str] = "audio"

#: The committed loader fixture, built by this stage so the thing `packages/core` tests
#: against is real G9 output rather than a hand-written database that agrees with the
#: loader by construction.
FIXTURE_PACK_RELPATH: Final[str] = "packages/core/src/packs/__fixtures__/es-mini"
FIXTURE_SEED_FILENAME: Final[str] = "seed.json"

# ---------------------------------------------------------------------------
# The manifest
# ---------------------------------------------------------------------------

#: The fields `packages/core/src/packs/install.ts` REQUIRES, exactly as it names them.
#: The signature is over the manifest bytes, so the app parses what was signed and never
#: re-serialises it; a field renamed here is a pack that will not install.
MANIFEST_REQUIRED_FIELDS: Final[tuple[str, ...]] = (
    "packId",
    "courseId",
    "major",
    "version",
    "payloadSha256",
    "payloadBytes",
    "audioBytes",
    "itemIds",
)

#: Everything else G9 declares. The app tolerates unknown fields by design (its parser
#: checks the required ones and ignores the rest), which is what lets S001, S002, S137
#: and S151 read provenance, the validator report and the licence table off the manifest
#: without a schema bump every time one of them grows a line.
MANIFEST_EXTRA_FIELDS: Final[tuple[str, ...]] = (
    "lang",
    "schemaVersion",
    "ledgerUnit",
    "provenance",
    "defectRate",
    "reviewerSampleItems",
    "cefrClaim",
    "audio",
    "validatorReport",
    "licences",
    "attribution",
    "shareAlike",
    "builtAt",
)

#: INV-PACK-40 / EC-PACK-37: "token" means the language adapter's unit, declared exactly
#: once per pack. A Mode-A morpheme for Japanese, a lemma everywhere else.
LEDGER_UNIT_BY_LANGUAGE: Final[dict[str, str]] = {
    "es": "lemma",
    "fr": "lemma",
    "de": "lemma",
    "ja": "morpheme",
}

#: A sentence G5 authored has no corpus behind it: its licence is the pack's own
#: (CC BY-NC-SA 4.0), whose BY clause still requires a credit, and the credits surface
#: names the project rather than a corpus. Written down because "we wrote it, so nobody
#: needs crediting" is the shortcut that makes a share-alike pack uncreditable downstream.
AUTHORED_SOURCE_ID: Final[str] = "freelingo_authored"
AUTHORED_ATTRIBUTION_OWNER: Final[str] = "Freelingo contributors (machine-authored)"

#: The artefact contract calls an authored sentence `llm`; the pack and the credits
#: surface call it `machine_authored`, which is the string S001 and S137 render.
PROVENANCE_BY_ARTEFACT: Final[dict[str, str]] = {
    "corpus": "corpus",
    "llm": "machine_authored",
}

#: The two shipped CEFR claims (Q8 ruling). es/fr have a lexicon to check against;
#: de/ja do not, and a card that claimed otherwise would be the dishonest kind of parity.
CEFR_CLAIM_CHECKED: Final[str] = "A1 · CEFR-checked"
CEFR_CLAIM_FREQUENCY: Final[str] = "Beginner · frequency-ordered"

# ---------------------------------------------------------------------------
# Licences and attribution (INV-PACK-17)
# ---------------------------------------------------------------------------

#: OPUS grants no blanket licence and its API returns no licence field: the manifest row
#: comes from the per-corpus legacy page, and an unresolved one fails the build rather
#: than shipping as "OPUS" (deep/10 edge case 4).
OPUS_LEGACY_LICENCE_URL: Final[str] = "https://opus.nlpl.eu/legacy/{corpus}-{version}.php"

#: What an unresolved licence row says. G9 refuses to package one.
UNRESOLVED_LICENCE: Final[str] = "UNRESOLVED"

#: Licences whose share-alike clause the manifest and the credits surface must state.
#: The hermitdave frequency data is CC BY-SA-4.0 and the ordering derived from it ships
#: inside the pack, so the derived list is share-alike too — that declaration is the
#: reason this tuple exists rather than a `"SA" in licence` test at three call sites.
SHARE_ALIKE_LICENCES: Final[tuple[str, ...]] = (
    "CC-BY-SA-3.0",
    "CC-BY-SA-4.0",
    "CC-BY-NC-SA-4.0",
    "GPL-3.0-only",
)

#: Credits rows live in the pack's `meta` table under this prefix. Mirrors
#: `CREDITS_META_PREFIX` in `pack-schema.ts` and in the loader.
CREDITS_META_PREFIX: Final[str] = "attribution:"

#: The kinds of thing a credit can cover. A derived list is neither a sentence nor a
#: voice and has no row of its own anywhere else, which is exactly why INV-PACK-17 names
#: all three.
CREDIT_KINDS: Final[tuple[str, ...]] = ("sentence", "voice", "derived-list")

#: The screen the credits render on. **Not in `deep/00-PRODUCT-MAP.md`**, which stops at
#: S151: S152 exists only in the plan's §Data model and in INV-PACK-17's own text. The
#: map owes a row — states, copy slots, and the two routes in (report sheet S045, About
#: S137) — before P4 renders it.
CREDITS_SURFACE_SCREEN: Final[str] = "S152"

# ---------------------------------------------------------------------------
# Item identity (INV-PACK-41)
# ---------------------------------------------------------------------------

#: `packages/core/src/packs/items.ts`: `i_` + 16 hex of sha256 over canonical JSON.
ITEM_ID_PREFIX: Final[str] = "i_"
ITEM_ID_HEX_LENGTH: Final[int] = 16

#: EC-PACK-38's ruling, mirrored from `pack-schema.ts` and asserted against it by
#: `tests/test_itemid.py`. Hash over prompt, preferred surface, the lexeme/concept/
#: grapheme tags and register — and NOTHING else, because everything in the next tuple
#: is re-solved by a monthly data release or corrected by a reviewer, and an id that
#: moved would orphan twelve weeks of FSRS history and re-show `NEW WORD`.
SEMANTIC_ITEM_FIELDS: Final[tuple[str, ...]] = (
    "prompt",
    "preferredSurface",
    "register",
    "lexemes",
    "grammarConcepts",
    "graphemes",
)

PRESENTATION_ITEM_FIELDS: Final[tuple[str, ...]] = (
    "ruby",
    "audioHash",
    "strokePaths",
    "illustration",
    "acceptedAlternates",
    "distractors",
)

#: The golden vector both languages hash, so the Python and TypeScript implementations
#: are pinned to each other by a value rather than by a shared reading of a paragraph.
#: `tests/test_itemid.py` and `packages/schema/src/pack-schema.test.ts` both assert it.
ITEM_ID_GOLDEN_INPUT: Final[dict[str, object]] = {
    "prompt": "¿Cómo estás?",
    "preferredSurface": "¿Cómo estás?",
    "register": "informal",
    "lexemes": ["estar", "cómo"],
    "grammarConcepts": ["present-tense-questions"],
    "graphemes": [],
}
ITEM_ID_GOLDEN_OUTPUT: Final[str] = "i_14df0f2e14669171"
