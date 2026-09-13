import json

import pytest
from test_answer_evidence import check, proofs, reviewed_fixture
from test_selected_sources import source_fixture

from coursekit.answer_evidence import (
    AnswerEvidenceError,
    answer_content_hash,
    build_answer_approval,
    load_answer_evidence,
    load_validated_answer_evidence,
    write_answer_approval,
)
from coursekit.artifacts import dedup_hash, sentence_id
from coursekit.config.g5 import MAX_TOKENS
from coursekit.ledger import count_units, surface_tokens
from coursekit.selected_sources import resolve_selected_sources


@pytest.fixture(autouse=True)
def isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("COURSEKIT_BUILD_ROOT", str(tmp_path / "build"))
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path / "content"))


def test_INV_PACK_08_explicit_old_g6_cannot_bypass_later_failed_run(tmp_path, monkeypatch):
    import coursekit.answer_evidence as module

    sources, row, path = reviewed_fixture(tmp_path)
    evidence = load_answer_evidence("es", sources, path=path)
    approval = build_answer_approval(
        "es", sources, evidence, proofs(sources, evidence), run_id="r1"
    )
    notes = write_answer_approval("es", approval)
    old = {"lang": "es", "stage": "g6", "status": "ok", "run_id": "r1", "notes": notes}
    entries = [{"stage": f"g{i}", "status": "ok"} for i in range(6)] + [
        old,
        {**old, "run_id": "r2", "status": "failed"},
    ]
    monkeypatch.setattr(module, "read_entries", lambda lang: iter(entries))
    with pytest.raises(AnswerEvidenceError):
        load_validated_answer_evidence("es", sources, evidence=evidence, g6_entry=old)


def analysis(text, sid):
    tokens = []
    offset = 0
    for surface in surface_tokens(text):
        start = text.index(surface, offset)
        end = start + len(surface)
        offset = end
        word = surface.lower().strip(".")
        lemma = {"quiero": "querer"}.get(word, word)
        pos = {
            "quiero": "VERB",
            "ir": "VERB",
            "yo": "PRON",
            "hoy": "ADV",
            "a": "ADP",
            "con": "ADP",
            "un": "DET",
            "mi": "DET",
            "y": "CCONJ",
        }.get(word, "NOUN")
        tokens.append(
            {
                "surface": surface,
                "lemma": lemma,
                "pos": pos,
                "morph": "Mood=Ind|Number=Sing|Person=1|Tense=Pres|VerbForm=Fin"
                if word == "quiero"
                else "",
                "start": start,
                "end": end,
            }
        )
    return {
        "schema_version": 1,
        "lang": "es",
        "sentence_id": sid,
        "adapter": {"name": "fixture", "version": "1", "model": "fixture", "split_mode": None},
        "tokens": tokens,
        "display_tokens": list(surface_tokens(text)),
        "lemmas": list(dict.fromkeys(t["lemma"] for t in tokens)),
    }


def test_INV_PACK_08_approval_cannot_accept_overlength_spanish_surface(tmp_path):
    canonical = "Hoy quiero ir a un restaurante con mi madre y hermana"
    alternate = "Yo hoy quiero ir a un restaurante con mi madre y mi hermana"
    english = "Today I want to go to a restaurant with my mother and sister"
    assert len(surface_tokens(canonical)) == 11 and len(surface_tokens(alternate)) == 13
    data = source_fixture()
    sid = sentence_id("es", canonical)
    a = analysis(canonical, sid)
    b = analysis(alternate, sid)
    data["ingested"][0].update(
        sentence_id=sid,
        text=canonical,
        translation=english,
        token_count=11,
        dedup_hash=dedup_hash(canonical),
    )
    data["analysed"] = [a]
    data["selected"][0].update(
        sentence_id=sid,
        known_lemmas=sorted(set(b["lemmas"]) - {"restaurante"}),
        new_lemmas=["restaurante"],
    )
    sources = resolve_selected_sources("es", **data)
    row = {
        "schema_version": 1,
        "source": sources[0].snapshot(),
        "author": "A",
        "licence": "CC-BY-NC-SA-4.0",
        "authored_on": "2026-09-13",
        "rationale": "Ordinary explicit subject and repeated possessive.",
        "canonical_pair": {"score": 4, "register": "neutral", "judgement": "Equivalent."},
        "spanish": [
            {
                "text": alternate,
                "pair": {
                    "score": 4,
                    "register": "neutral",
                    "judgement": "Same meaning with explicit first-person subject.",
                },
            }
        ],
        "english_reverse_only": [],
        "review": None,
    }
    row["review"] = {
        "reviewer": "B",
        "verdict": "accepted",
        "note": "Independent whole-pair check.",
        "content_hash": answer_content_hash(row),
    }
    path = tmp_path / "answers.jsonl"
    path.write_text(json.dumps(row) + "\n")
    evidence = load_answer_evidence("es", sources, path=path)
    proof = []
    for use, text, an, lang in [
        ("forward", canonical, a, "es"),
        ("forward", alternate, b, "es"),
        ("reverse_only", english, None, "en"),
    ]:
        checks = {
            name: check(lang)
            for name in (
                ["ledger", "register", "length", "duplicate", "pair", "grammar", "perplexity"]
                if use == "forward"
                else ["pair", "grammar"]
            )
        }
        if use == "forward":
            checks["length"]["detail"] = {
                "minimum": sources[0].minimum_tokens,
                "maximum": MAX_TOKENS,
                "count": count_units(an),
                "window_pos_digest": sources[0].window_pos_digest,
            }
        checks["pair"]["detail"] = {"score": 4, "review_hash": row["review"]["content_hash"]}
        proof.append({"use": use, "text": text, "analysis": an, "checks": checks})
    with pytest.raises(AnswerEvidenceError, match="length window"):
        build_answer_approval("es", sources, evidence, {sources[0].slot: proof}, run_id="r1")
