"""Constants owned by G1 Analyze — and the pack's ledger declaration.

Two kinds of thing live here.

**The adapter's identity.** Which analyser runs for which language, pinned to a version,
plus a frozen corpus of sentences whose lemmatisation must never change. `spacy download`
resolves against a live manifest, and a lemmatiser change re-partitions the lemma ledger
and can retro-introduce a lemma *before* its introduction unit — a V1 failure that is
invisible to every test downstream of G2, because all of them agree with the new
lemmatiser. The wheel-URL pin in `pyproject.toml` stops the model moving; the self-test
corpus below is what notices if it moves anyway (a different wheel in a contributor's
venv, a patched spaCy, a `pip install spacy-lookups-data`).

**The ledger declaration (INV-PACK-40).** `ledger_unit` is declared here, once, for every
language, and `coursekit.ledger` is the only thing that reads it. Everything a consumer
needs to count tokens the pack's way — the length window, the new-item budget, the
recycling window, the content-word POS set — is declared beside it, for the same reason:
the invariant's failure mode is not a wrong number, it is *two* numbers, one of them
inlined next to a consumer where nobody reviewing the spec will find it.

A note for the lanes downstream, because this file is where the collision would happen:
`config/ingest.py` (G0) must NOT declare its own length window, `config/curriculum.py`
(G3) must NOT declare its own new-item budget, and the validators must not re-derive
either. They read `coursekit.ledger`. That is the whole of INV-PACK-40, and
`tests/test_ledger_unit.py` fails the build over a tree that does it any other way.

Owner: p2-g1-g2-analyze-band.

**Naming note.** `p2-deps-scaffold` scaffolded empty `config/analyze.py` and
`config/band.py` beside these; this lane's constants live in `config/g1.py` and
`config/g2.py`, so the two empty twins were DELETED rather than filled in. Two plausible
homes for a ledger constant is how the second declaration gets written, and INV-PACK-40's
"declared exactly once" test greps for the name `LEDGER_UNIT_BY_LANGUAGE` — it would not
have caught a window or a budget landing in the twin.
"""

from __future__ import annotations

from typing import Final

# ---------------------------------------------------------------------------
# The adapters
# ---------------------------------------------------------------------------

#: Which morphology adapter is registered for which language.
#:
#: The value is two things at once, deliberately: the `adapter.name` written onto every
#: `analysed_sentence` row — so a mixed-adapter run is visible in the artefact and not
#: only in a runlog somewhere — and the `config/base.SOURCES` id G1 resolves to get the
#: adapter's licence row. Keeping them the same string is what stops a stage recording a
#: licence for one analyser while running another.
#:
#: `fr` and `de` name adapters that do not exist yet and sources that are not registered
#: yet; both land with P7, and until then G1 fails for those languages by name rather
#: than by falling through to whatever is installed.
ADAPTER_BY_LANGUAGE: Final[dict[str, str]] = {
    "es": "spacy_es",
    "fr": "spacy_fr",
    "de": "spacy_de",
    "ja": "sudachipy",
}

#: The spaCy model each Latin-script language loads, and the version the wheel URL in
#: `pyproject.toml` pins. `spacy.load` is given the bare name because that is the only
#: API it has; the pin lives in the lockfile and is ASSERTED here at run time, so a venv
#: carrying a different build fails at G1 instead of producing a differently partitioned
#: ledger that every downstream test agrees with.
SPACY_MODEL_BY_LANGUAGE: Final[dict[str, str]] = {
    "es": "es_core_news_md",
    "fr": "fr_core_news_md",
    "de": "de_core_news_md",
}

#: The exact model version G1 requires. 3.8.0 is the whole spaCy 3.8 model line
#: (compatibility.json returns 3.8.0 for every `{es,fr,de,ja}_core_news_{sm,md,lg}`).
SPACY_MODEL_VERSION: Final[str] = "3.8.0"

#: How many one-word documents `nlp.pipe` batches when a frequency list is lemmatised.
#: hermitdave's Spanish list is 50,000 surface forms, and one `nlp(surface)` call each is
#: several minutes of pure call overhead; `pipe` at this batch size is the same answer in
#: a fraction of the time. It changes throughput and nothing else — the per-surface API
#: stays, because a caller with one word should not have to build a list.
SPACY_BATCH_SIZE: Final[int] = 512

#: spaCy components G1 does not need and will not pay for. The ledger wants segmentation,
#: lemmas, UD POS and morph features; it does not want named entities or a dependency
#: parse, and `es_core_news_md`'s parser is the slowest thing in the pipeline.
SPACY_DISABLED_COMPONENTS: Final[tuple[str, ...]] = ("ner", "parser")

# ---------------------------------------------------------------------------
# The adapter self-test corpus
# ---------------------------------------------------------------------------

#: Twelve original A1 Spanish sentences and the exact `surface/lemma/UPOS` string
#: `es_core_news_md` 3.8.0 produces for each. Written for this repository — not sampled
#: from Tatoeba, OPUS, a lexicon or a course — for the same reason the `es-mini` fixture
#: is (INV-PACK-13 puts the licence allow-list at ingest, and a self-test corpus of
#: unclear provenance sitting inside the suite that enforces it is the exact hazard).
#:
#: They were chosen to sit on the lemmatiser's seams, so a swap cannot pass by getting
#: the easy words right: enclitic and reflexive `me`/`se`, the contractions `al`/`del`,
#: gender and number agreement (`pequeña`, `blanca`, `rojas`, `bonitas`), the ser/estar
#: split, existential `hay`, preterite forms, and `agua` (feminine noun, masculine
#: article).
#:
#: **Four of the frozen answers are wrong Spanish**, and they are frozen anyway:
#: `Nosotros` lemmatises to `yo`, `se` to `él`, `muy` to `mucho`, and `desayuna` and
#: `trabajé` are left unlemmatised. This table records what the pinned model DOES, not
#: what a grammarian would prefer. Freezing the defects is the point: the ledger is
#: partitioned by this function, and a "fix" that silently improves it moves lemmas
#: between units in packs that are already built.
ADAPTER_SELFTEST_ES: Final[tuple[tuple[str, str], ...]] = (
    (
        "Hola, me llamo Ana y soy de Madrid.",
        "Hola/hola/PROPN ,/,/PUNCT me/yo/PRON llamo/llamar/VERB Ana/ana/PROPN y/y/CCONJ "
        "soy/ser/AUX de/de/ADP Madrid/madrid/PROPN ././PUNCT",
    ),
    (
        "Mi hermana pequeña vive en la casa blanca.",
        "Mi/mi/DET hermana/hermana/NOUN pequeña/pequeño/ADJ vive/vivir/VERB en/en/ADP "
        "la/el/DET casa/casa/NOUN blanca/blanco/ADJ ././PUNCT",
    ),
    (
        "Los niños comen pan con aceite por la mañana.",
        "Los/el/DET niños/niño/NOUN comen/comer/VERB pan/pan/NOUN con/con/ADP "
        "aceite/aceite/NOUN por/por/ADP la/el/DET mañana/mañana/NOUN ././PUNCT",
    ),
    (
        "¿Cuántos años tienes?",
        "¿/¿/PUNCT Cuántos/cuántos/DET años/año/NOUN tienes/tener/VERB ?/?/PUNCT",
    ),
    (
        "Voy al mercado del barrio los sábados.",
        "Voy/ir/VERB al/al/ADP mercado/mercado/NOUN del/del/ADP barrio/barrio/NOUN "
        "los/el/DET sábados/sábado/NOUN ././PUNCT",
    ),
    (
        "Ella se levanta temprano y desayuna café.",
        "Ella/él/PRON se/él/PRON levanta/levantar/VERB temprano/temprano/ADV y/y/CCONJ "
        "desayuna/desayuna/VERB café/café/NOUN ././PUNCT",
    ),
    (
        "No hay agua fría en la nevera.",
        "No/no/ADV hay/haber/AUX agua/agua/NOUN fría/frío/ADJ en/en/ADP la/el/DET "
        "nevera/nevera/NOUN ././PUNCT",
    ),
    (
        "Nosotros estamos muy cansados hoy.",
        "Nosotros/yo/PRON estamos/estar/AUX muy/mucho/ADV cansados/cansado/ADJ "
        "hoy/hoy/ADV ././PUNCT",
    ),
    (
        "El profesor es amable, pero está ocupado.",
        "El/el/DET profesor/profesor/NOUN es/ser/AUX amable/amable/ADJ ,/,/PUNCT "
        "pero/pero/CCONJ está/estar/AUX ocupado/ocupado/ADJ ././PUNCT",
    ),
    (
        "Quiero comprar dos billetes para el tren.",
        "Quiero/querer/VERB comprar/comprar/VERB dos/dos/NUM billetes/billete/NOUN "
        "para/para/ADP el/el/DET tren/tren/NOUN ././PUNCT",
    ),
    (
        "Las flores rojas son bonitas.",
        "Las/el/DET flores/flor/NOUN rojas/rojo/ADJ son/ser/AUX bonitas/bonito/ADJ "
        "././PUNCT",
    ),
    (
        "Ayer trabajé ocho horas y dormí poco.",
        "Ayer/ayer/ADV trabajé/trabajé/VERB ocho/ocho/NUM horas/hora/NOUN y/y/CCONJ "
        "dormí/dormir/VERB poco/poco/ADV ././PUNCT",
    ),
)

#: sha256 over the self-test corpus as `"<sentence>\\t<expected>"` lines joined by "\\n".
#: A one-line signal for a run report and a manifest; the table above is what tells a
#: reader WHICH token moved. Both are needed: a digest alone is unreadable in a diff, and
#: a table alone gets skimmed.
ADAPTER_SELFTEST_ES_DIGEST: Final[str] = (
    "2b3ba30abe40ba5f4e6b41faad303f882bace7f2e12731baa9ad97a22976b21f"
)

#: The self-test corpora, keyed the way the adapters are. fr/de/ja land with P7 and each
#: one needs its own frozen table — a corpus is not portable between lemmatisers.
ADAPTER_SELFTEST: Final[dict[str, tuple[tuple[str, str], ...]]] = {
    "es": ADAPTER_SELFTEST_ES,
}

# ---------------------------------------------------------------------------
# The ledger declaration (INV-PACK-40)
# ---------------------------------------------------------------------------

#: **The declaration.** One entry per pack, and the only place it is written.
#:
#: `lemma` everywhere except Japanese, which is the Mode-A morpheme: SudachiPy Mode A is
#: the most granular split (国家公務員 -> 国家/公務/員) and the ledger runs on it so a
#: compound cannot smuggle unseen morphemes past V1. Mode C is the display string and the
#: audio unit, and is stored beside it, never counted.
#:
#: Q2 (`scope2/00`) picked option C — lemma plus grammar-concept-as-item, the policy
#: declared per language in the adapter and printed in the pack manifest — and recorded
#: why it is the most expensive question in the framework to get wrong: it is baked into
#: D1's tag schema, it changes the content budget for the inflected languages by 3-6x,
#: and **it cannot be changed after the first pack ships without orphaning every
#: learner's FSRS state**. Hence "exactly once", and hence a whole module
#: (`coursekit.ledger`) whose only job is to be the single reader of this dict.
LEDGER_UNIT_BY_LANGUAGE: Final[dict[str, str]] = {
    "es": "lemma",
    "fr": "lemma",
    "de": "lemma",
    "ja": "morpheme_mode_a",
}

#: Every ledger unit that exists. A value outside this set is a typo that would otherwise
#: read as a third policy nobody designed.
LEDGER_UNITS: Final[tuple[str, ...]] = ("lemma", "morpheme_mode_a")

#: What the manifest says in prose, so the declaration is legible to a reviewer who is
#: reading a pack rather than this file.
LEDGER_UNIT_PROSE: Final[dict[str, str]] = {
    "lemma": (
        "one ledger item per lemma; inflected forms of a taught lemma are not new items, "
        "and a grammar concept is scheduled as an item of its own (Q2 option C)"
    ),
    "morpheme_mode_a": (
        "one ledger item per SudachiPy Mode-A morpheme, so a compound cannot introduce "
        "unseen morphemes; Mode C is stored for display and audio and is never counted"
    ),
}

#: **Per pack, never shared.** `(min, max)` ledger units a sentence may carry to be
#: eligible for an A1 lesson. G0's length filter reads this through
#: `coursekit.ledger.length_window`; `config/ingest.py` must not restate it.
#:
#: 3-12 is `scope2/00` §2.3's A1 window for the Latin-script languages. Japanese is 4-18
#: because a Mode-A morpheme is a smaller unit than a lemma: the same sentence measures
#: longer, and reusing 3-12 would filter out ordinary A1 Japanese. That asymmetry is
#: exactly what "each pack declares its own window" means.
LENGTH_WINDOW_BY_LANGUAGE: Final[dict[str, tuple[int, int]]] = {
    "es": (3, 12),
    "fr": (3, 12),
    "de": (3, 12),
    "ja": (4, 18),
}

#: **Per pack, never shared.** The most new ledger items one lesson may introduce (V2's
#: K). Read through `coursekit.ledger.new_item_budget`; `config/curriculum.py` must not
#: restate it.
#:
#: INV-PACK-40's own falsifier is "one shared window yielding a `ja` lesson that teaches
#: three content words inside its budget", and that is what a single global 7 does: seven
#: Mode-A morphemes of ordinary Japanese are three content words and four bound
#: morphemes. So Japanese gets a budget counted in the unit it actually uses.
#:
#: DECLARED, NOT MEASURED. These are v1 starting values consistent with Duolingo's stated
#: "one new word or inflection" per exercise and a 5-8 item lesson; the numbers move when
#: the reviewer sample says they should, and moving them is a founder-visible change
#: because it re-solves G3 for every unit.
NEW_ITEMS_PER_LESSON_BY_LANGUAGE: Final[dict[str, int]] = {
    "es": 7,
    "fr": 7,
    "de": 6,
    "ja": 4,
}

#: **Per pack, never shared.** V3's recycling window: an introduced item must re-appear at
#: least `min_occurrences` times within `lessons` lessons of its introduction. Read
#: through `coursekit.ledger.recycling_window`.
#:
#: `(lessons, min_occurrences)`. Japanese recycles harder over a shorter window because a
#: Mode-A morpheme carries less of the sentence than a lemma does, so a single sighting
#: teaches less. Same status as the budget above: declared, not measured.
RECYCLING_WINDOW_BY_LANGUAGE: Final[dict[str, tuple[int, int]]] = {
    "es": (6, 3),
    "fr": (6, 3),
    "de": (6, 3),
    "ja": (4, 4),
}

#: UD POS tags that count as CONTENT words. The validator reports mean
#: content-words-per-sentence per pack (INV-PACK-40), and the figure is only meaningful
#: against a stated set: a Spanish sentence is mostly determiners, prepositions and
#: clitics, so counting every token would report the same ~8 for a lesson that teaches
#: three things and one that teaches seven.
#:
#: PROPN is deliberately IN: for an A1 course a proper noun is a taught item (a city, a
#: name on a card). NUM is IN for the same reason. AUX is OUT — `ser`, `estar` and `haber`
#: are taught as grammar concepts, which Q2 option C schedules as items of their own
#: rather than as lemmas.
CONTENT_POS: Final[tuple[str, ...]] = ("NOUN", "PROPN", "VERB", "ADJ", "ADV", "NUM")

#: UD POS tags whose tokens are not ledger items at all: punctuation, whitespace, symbols
#: and the un-analysable. They still ride in `tokens[]` with their offsets, because the
#: grader and the word bank need the character spans, and they are never counted.
NON_LEXICAL_POS: Final[tuple[str, ...]] = ("PUNCT", "SPACE", "SYM", "X")
