"""The three G6 engines, each tested through the path a build actually takes.

The LanguageTool client is exercised over a **real socket** against `engines/mock_lt.py`
— the same class that talks to the jar, the same HTTP payloads, the same
`software.version` extraction — because stubbing the method would leave every part that
actually breaks untested and would let a shape the jar never sends pass forever.

The KenLM engine is exercised against a **real KenLM model**: `kenlm.Model` loading an
ARPA built in `arpa_over()` below. That helper is test scaffolding standing in for
`lmplz`, which the pip package does not ship (it is built from the source tree with
cmake). It is not a fallback trainer — `engines/kenlm.train()` refuses to run without the
real binaries, and this file asserts that it does.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from collections.abc import Iterator
from pathlib import Path

import pytest

from coursekit.config.g6 import (
    ENGINE_NONE,
    PERPLEXITY_BAND_PERCENTILES,
    SPELLCHECK_CATEGORY_ID,
    SPELLCHECK_ISSUE_TYPE,
    SPELLCHECK_PROBE,
)
from coursekit.engines import ENGINES
from coursekit.engines.backtranslation import AgentRubricEngine
from coursekit.engines.kenlm import (
    KenLMEngine,
    KenLMUnavailable,
    band_from_scores,
)
from coursekit.engines.kenlm import build as build_kenlm
from coursekit.engines.languagetool import PublicApiRefused
from coursekit.engines.languagetool import build as build_languagetool
from coursekit.engines.mock_lt import MockLanguageTool, mock_languagetool_server

REPO_ROOT = Path(__file__).resolve().parents[3]
REAL_CANDIDATES = REPO_ROOT / "content" / "es" / "candidates.jsonl"

TOKEN = re.compile(r"[^\W\d_]+", re.UNICODE)


def words(text: str) -> list[str]:
    return [match.group(0).lower() for match in TOKEN.finditer(text)]


def arpa_over(sentences: list[str], target: Path) -> Path:
    """A real bigram ARPA over `sentences`, add-one smoothed. Test scaffolding.

    `lmplz` is not on PATH in this repository (the pip package ships the query module
    only), and `engines.kenlm.train` refuses to invent one. This builds the smallest
    thing `kenlm.Model` will load — KenLM refuses a unigram-only ARPA outright, measured:
    "This ngram implementation assumes at least a bigram model" — so the engine's query
    path is tested against the real library rather than against a stub.
    """
    unigram: Counter[str] = Counter()
    bigram: Counter[tuple[str, str]] = Counter()
    for sentence in sentences:
        tokens = ["<s>", *words(sentence), "</s>"]
        unigram.update(tokens)
        bigram.update(zip(tokens, tokens[1:], strict=False))

    total, vocabulary = sum(unigram.values()), len(unigram)
    lines = ["\\data\\"]
    unigrams = [(math.log10(1.0 / (total + vocabulary)), "<unk>", "-0.5")]
    for word, count in sorted(unigram.items()):
        probability = -99.0 if word == "<s>" else math.log10((count + 1) / (total + vocabulary))
        unigrams.append((probability, word, None if word == "</s>" else "-0.5"))
    bigrams = [
        (math.log10((count + 1) / (unigram[left] + vocabulary)), f"{left} {right}")
        for (left, right), count in sorted(bigram.items())
    ]
    lines += [f"ngram 1={len(unigrams)}", f"ngram 2={len(bigrams)}", "", "\\1-grams:"]
    for probability, word, backoff in unigrams:
        lines.append(f"{probability:.6f}\t{word}" + (f"\t{backoff}" if backoff else ""))
    lines += ["", "\\2-grams:"]
    for probability, pair in bigrams:
        lines.append(f"{probability:.6f}\t{pair}")
    lines += ["", "\\end\\", ""]

    target.write_text("\n".join(lines), encoding="utf-8")
    return target


def spanish_sentences() -> list[str]:
    return [
        json.loads(line)["text"]
        for line in REAL_CANDIDATES.read_text(encoding="utf-8").splitlines()
        if line
    ]


# ---------------------------------------------------------------------------
# LanguageTool
# ---------------------------------------------------------------------------


@pytest.fixture
def spanish_server() -> Iterator[str]:
    """A mock sidecar whose vocabulary is the authored Spanish course."""
    vocabulary = frozenset(word for text in spanish_sentences() for word in words(text))
    rules = MockLanguageTool(known_words=vocabulary)
    with mock_languagetool_server(rules) as url:
        yield url


def test_the_client_probes_capability_rather_than_assuming_it(spanish_server: str) -> None:
    """Both engines named, derived from what the server answered.

    `deep/10` §S6 encoded this as a table and got Japanese exactly backwards (R1). The
    engine asks instead, so a jar without a language pack, a version bump or a different
    server all show up as a changed answer rather than a constant that is still true on
    paper.
    """
    engine = build_languagetool(spanish_server)
    assert engine is not None
    report = engine.probe("es")
    assert report["available"]
    assert report["grammar_engine"].startswith("languagetool/mock-6.6/es")
    assert report["spellcheck_engine"] == report["grammar_engine"]
    assert report["detail"]["xml_rule_count"] == 1644
    assert report["detail"]["spellcheck_probe"] == SPELLCHECK_PROBE["es"]


def test_a_language_with_no_spell_checker_degrades_on_that_axis_only() -> None:
    """R1's correction, as behaviour: Japanese gets grammar rules and no spell check.

    The probe raises nothing for a nonce token in Japanese — measured against a real
    LanguageTool 6.6 server on 2026-09-12, and reproduced here — so `spellcheck_engine`
    is `none` while `grammar_engine` is not. `deep/10` had these the other way round and
    built V8's fallback on it.
    """
    with mock_languagetool_server(MockLanguageTool(spellchecks=("es",))) as url:
        report = build_languagetool(url).probe("ja")
    assert report["available"]
    assert report["grammar_engine"].endswith("/ja-JP")
    assert report["spellcheck_engine"] == ENGINE_NONE
    assert report["detail"]["xml_rule_count"] == 735


def test_the_spellcheck_probe_sentences_are_the_measured_ones() -> None:
    """Where the nonce token sits decides the answer, and only the jar says where.

    Measured against the real LanguageTool 6.6 server (build `f3e8d91`, Java 22.0.1,
    port 8081) on 2026-09-12:

    * `fr` `Je xqzptv dans la maison.` -> `JE_VERBE` / `uncategorized` / `CAT_GRAMMAIRE`
      and **no misspelling**. A nonce straight after `Je` is claimed by a grammar rule,
      the speller never fires, and the probe concludes French has no spell checker.
    * `fr` `La maison xqzptv est grande.` -> `FR_SPELLING_RULE` / `misspelling` / `TYPOS`.

    French is P7 and the wrong probe would have degraded its pack on an axis that works,
    silently, with `spellcheck_engine: none` in the manifest. The probe sentence is
    therefore a measured constant, not a phrase that reads naturally, and this test is
    what stops it drifting back. The mock cannot catch this — it flags any unknown token
    wherever it sits — so a real run is the only evidence, and the numbers above are it.
    """
    assert SPELLCHECK_PROBE["fr"] == "La maison xqzptv est grande."
    assert "Je xqzptv" not in SPELLCHECK_PROBE["fr"]
    assert all("xqzptv" in probe for probe in SPELLCHECK_PROBE.values())
    assert set(SPELLCHECK_PROBE) == {"es", "fr", "de", "ja"}


def test_a_misspelling_comes_back_labelled_the_way_v8_keys_on(spanish_server: str) -> None:
    matches = build_languagetool(spanish_server).check("es", "Yo xqzptv en la casa.")
    assert matches
    assert matches[0].issue_type == SPELLCHECK_ISSUE_TYPE
    assert matches[0].category_id == SPELLCHECK_CATEGORY_ID


def test_a_grammar_match_carries_its_issue_type_and_category() -> None:
    rules = MockLanguageTool(
        spellchecks=(),
        grammar_triggers={
            "es blanco": (
                "CONCORDANCIAS_ATRIBUTO",
                "inconsistency",
                "AGREEMENT_VERBS",
                "Posible error de concordancia.",
            )
        },
    )
    with mock_languagetool_server(rules) as url:
        matches = build_languagetool(url).check("es", "La casa es blanco.")
    assert [match.rule_id for match in matches] == ["CONCORDANCIAS_ATRIBUTO"]
    assert matches[0].issue_type == "inconsistency"


def test_the_public_api_is_refused_by_name() -> None:
    """A 6,000-item batch against the hosted service returns part errors, part timeouts.

    That shape reads as a pass. `deep/10` §S6 says the sidecar is the supported route and
    the public endpoint is rate-limited; refusing it at construction is cheaper than
    discovering it in a validator report.
    """
    for host in ("https://api.languagetool.org", "https://languagetool.org/api"):
        with pytest.raises(PublicApiRefused, match="rate-limited"):
            build_languagetool(host)


def test_a_server_that_does_not_serve_the_language_is_unavailable_not_clean() -> None:
    with mock_languagetool_server(MockLanguageTool(served=("es",))) as url:
        report = build_languagetool(url).probe("ja")
    assert not report["available"]
    assert report["grammar_engine"] == ENGINE_NONE
    assert "ja-JP" in report["reason"]


def test_a_server_that_is_not_up_is_unavailable_not_clean() -> None:
    """The failure mode the whole design turns on: nothing answered, nothing was wrong."""
    report = build_languagetool("http://127.0.0.1:9").probe("es")
    assert not report["available"]
    assert report["grammar_engine"] == ENGINE_NONE
    assert report["spellcheck_engine"] == ENGINE_NONE


def test_no_url_builds_no_engine() -> None:
    """ "Nobody started a sidecar" is a legitimate state; a default URL is not."""
    assert build_languagetool(None) is None
    assert build_languagetool("") is None


# ---------------------------------------------------------------------------
# KenLM
# ---------------------------------------------------------------------------


def test_the_engine_scores_against_a_real_kenlm_model(tmp_path: Path) -> None:
    """In-domain Spanish scores inside the band; a nonce string does not.

    Not a stub: `kenlm.Model` loads the ARPA and computes the perplexity.
    """
    pytest.importorskip("kenlm", reason="the 'lm' dependency group is not installed")
    sentences = spanish_sentences()
    model = arpa_over(sentences, tmp_path / "es.arpa")
    engine = KenLMEngine(model_path=model, band=(0.0, math.inf))
    assert engine.probe("es")["available"]

    in_domain = engine.perplexity("yo como pan")
    nonsense = engine.perplexity("xqzptv xqzptv xqzptv")
    assert nonsense > in_domain * 5, (in_domain, nonsense)


def test_the_band_is_percentiles_of_the_training_corpus(tmp_path: Path) -> None:
    """A band is a property of a model, not of a language.

    `pyproject.toml` pins KenLM to a commit because a band computed against one build and
    enforced against another drifts with no diff; deriving the band from the model's own
    held-out slice is the other half of that.
    """
    pytest.importorskip("kenlm", reason="the 'lm' dependency group is not installed")
    sentences = spanish_sentences()
    model = arpa_over(sentences, tmp_path / "es.arpa")
    engine = KenLMEngine(model_path=model, band=(0.0, math.inf))
    engine.probe("es")

    scores = [engine.perplexity(sentence) for sentence in sentences]
    low, high = band_from_scores(scores)
    assert low < high
    inside = sum(1 for score in scores if low <= score <= high)
    expected = (PERPLEXITY_BAND_PERCENTILES[1] - PERPLEXITY_BAND_PERCENTILES[0]) / 100
    assert inside / len(scores) == pytest.approx(expected, abs=0.06)


def test_a_band_needs_a_distribution() -> None:
    with pytest.raises(KenLMUnavailable, match="not one"):
        band_from_scores([12.0, 40.0])


def test_a_model_with_no_band_beside_it_is_refused(tmp_path: Path) -> None:
    """A perplexity with no band is a number nobody can fail."""
    model = tmp_path / "es.binary"
    model.write_bytes(b"")
    with pytest.raises(KenLMUnavailable, match="band"):
        build_kenlm(str(model))


def test_an_explicit_band_overrides_the_file(tmp_path: Path) -> None:
    model = tmp_path / "es.binary"
    model.write_bytes(b"")
    engine = build_kenlm(str(model), "10,500")
    assert engine is not None
    assert engine.band == (10.0, 500.0)


def test_a_missing_model_is_unavailable_with_the_remedy(tmp_path: Path) -> None:
    """There are no pre-built KenLM models; the message says train one."""
    report = KenLMEngine(model_path=tmp_path / "absent.binary", band=(1.0, 2.0)).probe("es")
    assert not report["available"]
    assert report["perplexity_engine"] == ENGINE_NONE
    assert "lmplz" in report["reason"]


def test_training_refuses_to_improvise_when_lmplz_is_absent(tmp_path: Path, monkeypatch) -> None:
    """No hand-rolled n-gram counter. A band nobody can reproduce is worse than no band."""
    monkeypatch.setenv("PATH", str(tmp_path))
    text = tmp_path / "oracle.txt"
    text.write_text("hola\n", encoding="utf-8")
    with pytest.raises(KenLMUnavailable, match="lmplz"):
        from coursekit.engines.kenlm import train

        train(text, tmp_path / "out", holdout=["hola"])


def test_an_unloaded_model_never_yields_a_perplexity(tmp_path: Path) -> None:
    with pytest.raises(KenLMUnavailable, match="unloaded model"):
        KenLMEngine(model_path=tmp_path / "x", band=(1.0, 2.0)).perplexity("hola")


# ---------------------------------------------------------------------------
# Back-translation
# ---------------------------------------------------------------------------


def test_the_rubric_engine_names_itself_as_agent_authored() -> None:
    """The disclaimer rides on the engine id, so it reaches the manifest and the pack card.

    There is no hosted model here, so this axis is an agent's judgement against a
    published rubric. Whatever else changes, a reader must never be able to mistake it
    for a translation round trip.
    """
    report = AgentRubricEngine(path=REAL_CANDIDATES).probe("es")
    assert report["available"]
    assert "not a model round-trip" in report["backtranslation_engine"]
    # Keyed by text, so the six deliberate exact repeats (the `duplicate` axis's
    # over-generation) collapse. 160 authored rows, 154 distinct sentences.
    assert report["detail"]["scored"] == len(set(spanish_sentences()))
    assert report["detail"]["rubric_version"] == "1"


def test_an_unscored_candidate_makes_the_axis_absent_not_passed(tmp_path: Path) -> None:
    """A sentence nobody judged is not a sentence that survived judgement."""
    rows = [json.loads(line) for line in REAL_CANDIDATES.read_text(encoding="utf-8").splitlines()]
    rows[3]["backtranslation"] = {"rubric_version": "1", "judged_by": "agent"}
    target = tmp_path / "candidates.jsonl"
    target.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8"
    )
    report = AgentRubricEngine(path=target).probe("es")
    assert not report["available"]
    assert report["backtranslation_engine"] == ENGINE_NONE
    assert "no rubric score" in report["reason"]


def test_an_absent_file_is_absent_not_clean(tmp_path: Path) -> None:
    report = AgentRubricEngine(path=tmp_path / "nothing.jsonl").probe("es")
    assert not report["available"]
    assert report["backtranslation_engine"] == ENGINE_NONE


def test_a_text_nobody_scored_returns_none_rather_than_a_default() -> None:
    engine = AgentRubricEngine(path=REAL_CANDIDATES)
    engine.probe("es")
    assert engine.score("Una frase que nadie escribió.") is None


# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------


def test_every_engine_this_lane_owns_is_registered() -> None:
    """Adding a module is the whole of the wiring; assert the wiring worked."""
    assert {"kenlm", "languagetool", "mock_lt", "agent_rubric"} <= set(ENGINES.ids())
