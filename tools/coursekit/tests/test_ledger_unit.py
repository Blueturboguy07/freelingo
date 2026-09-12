"""**INV-PACK-40** and **INV-PACK-51** — the ledger declaration and its identity key.

INV-PACK-40 is bigger than one file, which is why this test file is not `test_g1`'s or
`test_g2`'s. The invariant has three halves and each one fails somewhere else:

1. The declaration exists, once, per pack, with the pack's own window and budget.
2. Every token-counting consumer READS it. That one cannot be tested by calling a
   function, because the failure is a consumer that never calls the function at all — so
   it is a grep over the whole `tools/coursekit` tree.
3. The validator reports mean content-words-per-sentence per pack.

INV-PACK-51 is here rather than only in `test_g2_band.py` because the key it constrains
is the ledger's, and a G2 that happens not to produce a collision today would leave the
rule untested for G3 and G9, which are where senses appear.

Falsifying inputs: `tests/falsifiers/INV-PACK-40.json`, `tests/falsifiers/INV-PACK-51.json`.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from coursekit.config import LANGUAGES
from coursekit.config.g1 import (
    CONTENT_POS,
    LEDGER_UNIT_BY_LANGUAGE,
    LEDGER_UNITS,
    LENGTH_WINDOW_BY_LANGUAGE,
    NEW_ITEMS_PER_LESSON_BY_LANGUAGE,
    RECYCLING_WINDOW_BY_LANGUAGE,
)
from coursekit.ledger import (
    DuplicateLedgerKey,
    DuplicateTileLabel,
    LedgerError,
    LedgerItem,
    assert_distinct_tile_labels,
    assert_unique_keys,
    content_units,
    count_units,
    ledger_declaration,
    ledger_key,
    ledger_unit,
    length_ok,
    length_window,
    mean_content_words_per_sentence,
    new_item_budget,
    normalized_form,
    reading_form,
    recycling_window,
    speaking_tokens,
    units,
)

COURSEKIT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = COURSEKIT / "src" / "coursekit"
FALSIFIERS = Path(__file__).parent / "falsifiers"


def falsifier(invariant: str) -> dict:
    return json.loads((FALSIFIERS / f"{invariant}.json").read_text(encoding="utf-8"))


def case(invariant: str, case_id: str) -> dict:
    for entry in falsifier(invariant)["cases"]:
        if entry["id"] == case_id:
            return entry
    raise AssertionError(f"{invariant}.json has no case {case_id!r}")


def analysed(lang: str, tokens: list[tuple[str, str]], *, split_mode: str | None = None) -> dict:
    """A minimal `analysed_sentence`-shaped mapping: `(lemma, UD POS)` pairs."""
    return {
        "lang": lang,
        "adapter": {"name": "fake", "version": "0", "model": None, "split_mode": split_mode},
        "tokens": [{"surface": lemma, "lemma": lemma, "pos": pos} for lemma, pos in tokens],
    }


# ---------------------------------------------------------------------------
# INV-PACK-40 — the declaration
# ---------------------------------------------------------------------------


def test_INV_PACK_40_every_pack_declares_a_ledger_unit_exactly_once() -> None:
    """[INV-PACK-40] every pack declares `ledger_unit` once — Mode-A for ja, lemma otherwise."""
    assert set(LEDGER_UNIT_BY_LANGUAGE) == set(LANGUAGES)
    assert ledger_unit("ja") == "morpheme_mode_a"
    for lang in LANGUAGES:
        if lang == "ja":
            continue
        assert ledger_unit(lang) == "lemma", lang
    assert set(LEDGER_UNIT_BY_LANGUAGE.values()) <= set(LEDGER_UNITS)


def test_INV_PACK_40_a_pack_with_no_declaration_is_refused() -> None:
    """[INV-PACK-40] falsifier case 1: no `ledger_unit` in the manifest.

    A manifest with no declaration leaves every consumer to guess, and each one guesses
    differently. The falsifier's manifest is what `ledger_declaration` must never
    produce, and an undeclared language must raise rather than default to `lemma` —
    defaulting is how Japanese would silently ship a lemma ledger.
    """
    broken = case("INV-PACK-40", "no-ledger-unit-in-the-manifest")
    assert "ledger_unit" not in broken["manifest"]
    assert broken["expect"] == "refused"

    with pytest.raises(LedgerError, match="unknown language"):
        ledger_unit("kl")

    declared = ledger_declaration("es")
    assert declared["ledger_unit"] == "lemma"
    for field in broken["manifest"]:
        if field == "lang":
            continue
        assert field in declared, f"the declaration is missing {field}"


def test_INV_PACK_40_the_declaration_is_the_only_place_the_unit_is_written() -> None:
    """[INV-PACK-40] falsifier case 2: two declarations is worse than none.

    Grep, not introspection: a second declaration is a second CONSTANT somewhere, and
    the only way to show there is not one is to look at every file.
    """
    duplicated = case("INV-PACK-40", "ledger-unit-declared-twice-with-different-values")
    assert duplicated["expect"] == "refused"

    declaring: list[str] = []
    for path in sorted(PACKAGE_ROOT.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            # `AnnAssign` as well as `Assign`: every constant in `config/` is annotated
            # `Final[...]`, and a walker that only knew about bare assignment would
            # report "declared nowhere" and pass.
            if isinstance(node, ast.Assign):
                targets = node.targets
            elif isinstance(node, ast.AnnAssign):
                targets = [node.target]
            else:
                continue
            for target in targets:
                if isinstance(target, ast.Name) and "LEDGER_UNIT_BY_LANGUAGE" in target.id:
                    declaring.append(str(path.relative_to(PACKAGE_ROOT)))
    assert declaring == ["config/g1.py"], (
        f"the ledger unit is declared in {declaring}; INV-PACK-40 says exactly once"
    )


def test_INV_PACK_40_each_pack_declares_its_own_window_and_budget() -> None:
    """[INV-PACK-40] falsifier case 5: one shared window starves a Japanese lesson.

    The invariant's own falsifier, arithmetic and all: seven Mode-A morphemes of ordinary
    Japanese are three content words and four bound morphemes, so a single global budget
    tuned on Spanish lemmas teaches three things and calls the lesson full.
    """
    starved = case("INV-PACK-40", "one-shared-window-starves-a-japanese-lesson")
    shared = starved["shared_budget_new_items_per_lesson"]
    assert len(starved["ja_lesson_units"]) == shared
    assert len(starved["ja_content_units"]) == 3

    assert new_item_budget("es") == shared, "the shared budget in the falsifier is Spanish's"
    assert new_item_budget("ja") < shared, (
        "Japanese must declare its own budget, in the unit it actually counts"
    )
    assert length_window("ja") != length_window("es")
    assert recycling_window("ja") != recycling_window("es")

    for lang in LANGUAGES:
        assert lang in LENGTH_WINDOW_BY_LANGUAGE
        assert lang in NEW_ITEMS_PER_LESSON_BY_LANGUAGE
        assert lang in RECYCLING_WINDOW_BY_LANGUAGE
        minimum, maximum = length_window(lang)
        assert 0 < minimum < maximum
        assert new_item_budget(lang) > 0
        window = recycling_window(lang)
        assert window.lessons > 0 and window.min_occurrences > 0


def test_INV_PACK_40_the_declaration_block_carries_every_number_a_consumer_needs() -> None:
    """[INV-PACK-40] the manifest block G9 copies: unit, window, budget, recycling, mean."""
    declared = ledger_declaration("es", mean_content_words_per_sentence=3.25)
    assert declared["ledger_unit"] == "lemma"
    assert declared["length_window_units"] == list(length_window("es"))
    assert declared["new_items_per_lesson"] == new_item_budget("es")
    assert declared["recycling_window_lessons"] == recycling_window("es").lessons
    assert declared["recycling_min_occurrences"] == recycling_window("es").min_occurrences
    assert declared["content_pos"] == list(CONTENT_POS)
    assert declared["mean_content_words_per_sentence"] == 3.25
    assert declared["ledger_unit_prose"]


def test_INV_PACK_40_the_mean_is_none_until_something_measures_it() -> None:
    """[INV-PACK-40] a plausible default is indistinguishable from a measurement."""
    assert ledger_declaration("es")["mean_content_words_per_sentence"] is None


# ---------------------------------------------------------------------------
# INV-PACK-40 — the counter, and the reported mean
# ---------------------------------------------------------------------------


def test_INV_PACK_40_the_counter_counts_lexical_units_not_characters_or_punctuation() -> None:
    """[INV-PACK-40] `units` is the single counter; punctuation rides along uncounted."""
    record = analysed(
        "es",
        [("el", "DET"), ("gato", "NOUN"), ("dormir", "VERB"), (".", "PUNCT")],
    )
    assert units(record) == ("el", "gato", "dormir")
    assert count_units(record) == 3
    assert content_units(record) == ("gato", "dormir")
    assert speaking_tokens(record) == units(record)


def test_INV_PACK_40_the_speaking_tokens_are_the_ledger_units() -> None:
    """[INV-PACK-40] INV-MOD-13 stores speaking tokens 'in the unit `ledger_unit` declares'.

    The app bundle links no tokenizer, so these are stored, not re-derived on the device.
    If they were ever computed some other way, a speaking item would be graded against a
    different partition of the sentence than V1 and V2 checked.
    """
    record = analysed("es", [("querer", "VERB"), ("agua", "NOUN"), ("?", "PUNCT")])
    assert speaking_tokens(record) == ("querer", "agua")


def test_INV_PACK_40_the_validator_reports_mean_content_words_per_sentence() -> None:
    """[INV-PACK-40] '...and the validator reports mean content-words-per-sentence per pack'."""
    corpus = [
        analysed("es", [("el", "DET"), ("gato", "NOUN"), ("dormir", "VERB")]),
        analysed("es", [("yo", "PRON"), ("comer", "VERB"), ("pan", "NOUN"), ("hoy", "ADV")]),
    ]
    assert mean_content_words_per_sentence(corpus) == pytest.approx(2.5)
    assert mean_content_words_per_sentence([]) == 0.0


def test_INV_PACK_40_the_length_filter_measures_in_the_declared_unit() -> None:
    """[INV-PACK-40] the length filter is a consumer; it reads the window, per pack."""
    short = analysed("es", [("hola", "INTJ"), ("!", "PUNCT")])
    ok = analysed("es", [("el", "DET"), ("gato", "NOUN"), ("dormir", "VERB")])
    assert not length_ok(short)
    assert length_ok(ok)


def test_INV_PACK_40_a_row_whose_adapter_disagrees_with_the_declaration_is_refused() -> None:
    """[INV-PACK-40] a `ja` pack handed Mode-C tokens counts compounds as single items.

    That is the V1 hole Mode A exists to close, and it is invisible in the row — the
    lemmas all look like words. So the declaration is checked against the adapter's own
    `split_mode` every time the units are counted.
    """
    mode_c = analysed("ja", [("国家公務員", "NOUN")], split_mode="C")
    with pytest.raises(LedgerError, match="split_mode"):
        units(mode_c)

    mode_a = analysed(
        "ja", [("国家", "NOUN"), ("公務", "NOUN"), ("員", "NOUN")], split_mode="A"
    )
    assert count_units(mode_a) == 3

    spanish_with_a_split_mode = analysed("es", [("gato", "NOUN")], split_mode="A")
    with pytest.raises(LedgerError, match="no split"):
        units(spanish_with_a_split_mode)

    # The reported mean is the ONE figure from this invariant that reaches the manifest,
    # so it must refuse the same row the counter refuses. It did not: `content_units` read
    # `analysed["tokens"]` directly and averaged a Mode-C row that `count_units` had
    # already rejected, which is a manifest number computed over a segmentation the pack
    # does not declare.
    with pytest.raises(LedgerError, match="split_mode"):
        content_units(mode_c)
    with pytest.raises(LedgerError, match="split_mode"):
        mean_content_words_per_sentence([mode_c])
    with pytest.raises(LedgerError, match="split_mode"):
        mean_content_words_per_sentence([mode_a, mode_c])
    with pytest.raises(LedgerError, match="no split"):
        mean_content_words_per_sentence([spanish_with_a_split_mode])
    assert mean_content_words_per_sentence([mode_a]) == 3.0


# ---------------------------------------------------------------------------
# INV-PACK-40 — the grep gate over the whole tree
# ---------------------------------------------------------------------------

#: Whitespace-splitting and word-class regexes, spelled the way they get written.
#:
#: A bounded split (`rsplit(" ", 1)`) is a FIELD parse — a two-column frequency file, a
#: `surface/lemma/POS` fingerprint — and is allowed. An unbounded one is tokenisation
#: and is not. `split("\t")` and `splitlines()` are parsing and never appear here.
_INLINED_TOKENISER_PATTERNS: tuple[tuple[str, str], ...] = (
    (".split()", "whitespace tokenisation"),
    ('.split(" ")', "whitespace tokenisation"),
    (".split(' ')", "whitespace tokenisation"),
    ("\\w+", "a word-class regex"),
    ("[^\\W\\d_]", "a word-class regex"),
    ("[a-zA-Z]+", "a word-class regex"),
    ("[[:alpha:]]", "a word-class regex"),
)

#: The only files in the tree allowed to carry one, and why. Two rules keep this list
#: from becoming a way around the gate:
#:
#: - Nothing under `src/coursekit/` may be added to it except the ledger itself and the
#:   adapters, and `test_the_exception_list_cannot_grow_into_src` asserts that.
#: - A `tests/` entry is a test that deliberately RE-DERIVES a fixture in plain Python so
#:   the fixture is not self-certifying. That is the opposite of a consumer trusting its
#:   own tokeniser, and it is the reason `p2-deps-scaffold` restated the tokeniser in
#:   `conftest.py` instead of importing one.
_ALLOWED_TO_TOKENISE: dict[str, str] = {
    "src/coursekit/ledger.py": (
        "the ledger IS the definition; it is what every other module must call"
    ),
    "src/coursekit/adapters/spacy_es.py": (
        "the adapter IS the tokeniser — segmentation is its whole job, and its "
        "self-test fingerprint is a `surface/lemma/POS` string it has to take apart"
    ),
    "tests/conftest.py": (
        "the es-mini fixture's tokeniser, restated rather than imported so the suite "
        "recomputes frequency.tsv instead of agreeing with whatever produced it"
    ),
    "tests/test_artifacts.py": (
        "the same independent re-derivation, loading the pinned spaCy model to check "
        "the committed lemma map is what it really produces"
    ),
    "tests/test_ledger_unit.py": (
        "this file: the patterns above are the gate's own detector, and the planted "
        "violations it runs against are written to a tmp_path, never to the tree"
    ),
}


def _tokenising_files(root: Path) -> dict[str, list[str]]:
    """Every `.py` under `root` carrying an inlined notion of a token, and which."""
    found: dict[str, list[str]] = {}
    for path in sorted(root.rglob("*.py")):
        if ".venv" in path.parts or "__pycache__" in path.parts:
            continue
        source = path.read_text(encoding="utf-8")
        hits = [why for pattern, why in _INLINED_TOKENISER_PATTERNS if pattern in source]
        if hits:
            found[str(path.relative_to(root))] = sorted(set(hits))
    return found


def test_INV_PACK_40_no_consumer_carries_its_own_inlined_notion_of_a_token() -> None:
    """[INV-PACK-40] the grep gate: `length_filter`, the budget, V1/V2 and speaking tokens.

    Falsifier cases 3 and 4. This is the half of the invariant that cannot be tested by
    calling anything: the failure is a consumer that never calls the ledger at all, and
    it is invisible in a green suite because the consumer's own tokeniser agrees with the
    ledger on Spanish function words — and disagrees on every clitic, every contraction
    and every Japanese compound.
    """
    offenders = {
        path: why
        for path, why in _tokenising_files(COURSEKIT).items()
        if path not in _ALLOWED_TO_TOKENISE
    }
    assert offenders == {}, (
        "these files carry their own notion of a token instead of calling "
        "coursekit.ledger: "
        + "; ".join(f"{path} ({', '.join(why)})" for path, why in offenders.items())
        + ". INV-PACK-40 requires every token-counting consumer — the length filter, the "
        "new-item budget, V1/V2 and the stored speaking tokens — to read the pack's "
        "declared ledger_unit. Call coursekit.ledger.units / count_units / "
        "length_window / new_item_budget instead."
    )


def test_INV_PACK_40_the_grep_gate_catches_a_planted_consumer(tmp_path: Path) -> None:
    """[INV-PACK-40] the gate's falsifier: it must fail on the planted sources.

    Without this the gate above passes over an empty rglob, over a pattern list that no
    longer matches how anyone writes it, and over an exception list that swallowed
    everything.
    """
    data = falsifier("INV-PACK-40")
    planted = [c for c in data["cases"] if "planted_source" in c]
    assert len(planted) == 2, "both shapes of the bug must be in the falsifier"

    for entry in planted:
        target = tmp_path / entry["planted_at"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(entry["planted_source"], encoding="utf-8")

    caught = _tokenising_files(tmp_path)
    assert set(caught) == {entry["planted_at"] for entry in planted}, caught

    # And the near-misses the gate must NOT flag, or it would refuse every TSV parse in
    # the tree and be turned off within the week.
    innocent = tmp_path / "src/coursekit/innocent.py"
    innocent.write_text(
        'row = line.split("\\t")\n'
        'surface, count = line.rsplit(" ", 1)\n'
        "lines = text.splitlines()\n",
        encoding="utf-8",
    )
    assert "src/coursekit/innocent.py" not in _tokenising_files(tmp_path)


def test_the_exception_list_cannot_grow_into_src() -> None:
    """The gate's own guard rail: an exception under `src/` would be a way around it."""
    for path in _ALLOWED_TO_TOKENISE:
        assert (COURSEKIT / path).exists(), f"{path} is exempted and does not exist"
        if not path.startswith("src/"):
            continue
        assert path == "src/coursekit/ledger.py" or path.startswith("src/coursekit/adapters/"), (
            f"{path} is exempt from the tokeniser gate and is neither the ledger nor an "
            f"adapter. A consumer cannot be exempted — that is the invariant."
        )


def test_INV_PACK_40_the_named_consumers_read_the_ledger_when_they_land() -> None:
    """[INV-PACK-40] the positive half, armed for the lanes that have not landed yet.

    The invariant names four consumers: the length filter (G0), the new-item budget (G3),
    V1/V2, and the stored speaking tokens (G7). None of those modules exist today, so
    this asserts the shape it can — every module that already mentions one of the ledger's
    subjects imports the ledger — and it turns into a real check the day one lands,
    because a new `stages/g0_*.py` that counts tokens will either import the ledger or
    trip the grep gate above.
    """
    subjects = ("length_window", "new_item_budget", "recycling_window", "speaking_tokens")
    for path in sorted((PACKAGE_ROOT).rglob("*.py")):
        if path.name == "ledger.py" or path.parent.name == "config":
            continue
        source = path.read_text(encoding="utf-8")
        if not any(subject in source for subject in subjects):
            continue
        assert "ledger" in source, (
            f"{path.relative_to(PACKAGE_ROOT)} talks about a ledger subject without "
            f"importing coursekit.ledger"
        )


# ---------------------------------------------------------------------------
# INV-PACK-51 — the identity key
# ---------------------------------------------------------------------------


def test_INV_PACK_51_no_two_distinct_items_share_the_key() -> None:
    """[INV-PACK-51] the Spanish homograph pair collapsing to one Words row.

    `capital` (money, masculine) and `capital` (city, feminine): two lexemes, identical
    spelling, identical UD POS. Two rows in the learner's Words list and two FSRS items.
    Merging them teaches one and schedules the other's reviews against it.
    """
    collapsing = case("INV-PACK-51", "es-homograph-pair-collapsing-to-one-words-row")
    items = [
        LedgerItem(lang="es", lemma=row["lemma"], pos=row["pos"], sense=row["sense"])
        for row in collapsing["items"]
    ]
    assert [list(item.key) for item in items] == [collapsing["collapsed_key"]] * 2

    with pytest.raises(DuplicateLedgerKey, match="capital"):
        assert_unique_keys(items)


def test_INV_PACK_51_the_same_item_twice_is_a_merge_not_a_collision() -> None:
    """[INV-PACK-51] the near-miss: G2 folds many surface forms onto one lemma.

    A gate that refused this would refuse every real run and would be turned off, which
    is the most common way an invariant stops being enforced.
    """
    merging = case("INV-PACK-51", "same-item-seen-twice-is-not-a-collision")
    assert merging["expect"] == "accepted"
    assert_unique_keys(
        [
            LedgerItem(lang="es", lemma=row["lemma"], pos=row["pos"], sense=row["sense"])
            for row in merging["items"]
        ]
    )


def test_INV_PACK_51_for_spanish_the_reading_form_is_the_orthographic_form() -> None:
    """[INV-PACK-51] Spanish spelling determines pronunciation, so the key degenerates.

    Both elements are case-folded, and that is the load-bearing half. When only
    `normalized_form` folded case, `ledger_key("es", "Casa", ...)` and
    `ledger_key("es", "casa", ...)` were two keys — two rows in the learner's Words list
    for one word — and nothing in the ledger prevented it: the "one item" guarantee rested
    on the spaCy adapter remembering to lower-case every lemma, which is a second
    definition of the ledger's identity living in an adapter (INV-PACK-40).
    """
    key = ledger_key("es", "Capital", "NOUN")
    assert key == ("capital", "capital", "NOUN")
    assert normalized_form("es", "Capital") == "capital"
    assert reading_form("es", "Capital") == "capital"
    assert ledger_key("es", "Casa", "NOUN") == ledger_key("es", "casa", "NOUN")

    # Passing a reading for Spanish is a bug upstream, not a value to drop quietly.
    with pytest.raises(LedgerError, match="no separate reading"):
        reading_form("es", "capital", reading="カピタル")


def test_INV_PACK_51_the_key_is_unicode_normalised() -> None:
    """[INV-PACK-51] a combining acute and a precomposed one are one item, not two."""
    precomposed = "canción"
    decomposed = "canci\u006f\u0301n"
    assert precomposed != decomposed
    assert ledger_key("es", precomposed, "NOUN") == ledger_key("es", decomposed, "NOUN")


def test_INV_PACK_51_japanese_needs_its_reading_or_the_pair_collides() -> None:
    """[INV-PACK-51] the registry's own falsifier: 辛い karai vs 辛い tsurai.

    The reading form is in the key precisely so this pair survives it, and a Japanese
    item with no reading is refused rather than falling back to the orthographic form —
    that fallback IS the collision.
    """
    entry = case("INV-PACK-51", "ja-karai-tsurai-collapsing-to-one-words-row")
    karai, tsurai = entry["items"]

    with pytest.raises(LedgerError, match="reading_form"):
        ledger_key("ja", karai["lemma"], karai["pos"])

    items = [
        LedgerItem(
            lang="ja",
            lemma=row["lemma"],
            pos=row["pos"],
            sense=row["sense"],
            reading=row["reading_form"],
        )
        for row in (karai, tsurai)
    ]
    assert items[0].key != items[1].key
    assert_unique_keys(items)


def test_INV_PACK_51_no_two_tiles_in_one_item_share_a_rendered_label() -> None:
    """[INV-PACK-51] the second half: a two-本 bank with no disambiguating ruby.

    A word bank whose two tiles read alike is unanswerable — a learner who taps the right
    one is indistinguishable from one who did not — so it is refused at build time.
    """
    entry = case("INV-PACK-51", "two-tiles-in-one-item-share-a-rendered-label")
    with pytest.raises(DuplicateTileLabel, match="本"):
        assert_distinct_tile_labels(entry["tiles"], where=entry["item"])

    assert_distinct_tile_labels(["本(ほん)", "本(ぼん)", "を", "読む"], where=entry["item"])
