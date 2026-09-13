"""English answer checks use the configured, separately probed LT language."""


def test_INV_PACK_14_english_probe_and_check_use_actual_en_us_transport(monkeypatch):
    import httpx

    from coursekit.engines.languagetool import LanguageToolEngine

    calls = []

    def get(url, **kwargs):
        return httpx.Response(200, request=httpx.Request("GET", url), json=[{"longCode": "en-US"}])

    def post(url, *, data, **kwargs):
        calls.append(dict(data))
        rule = "MORFOLOGIK_RULE_EN_US" if "misspelledd" in data["text"] else "HE_VERB_AGR"
        issue = "misspelling" if rule.startswith("MORFO") else "grammar"
        return httpx.Response(
            200,
            request=httpx.Request("POST", url),
            json={
                "software": {"version": "6.6"},
                "matches": [
                    {
                        "rule": {
                            "id": rule,
                            "issueType": issue,
                            "category": {"id": "TYPOS" if issue == "misspelling" else "GRAMMAR"},
                        },
                        "message": "controlled diagnostic",
                    }
                ],
            },
        )

    monkeypatch.setattr(httpx, "get", get)
    monkeypatch.setattr(httpx, "post", post)
    engine = LanguageToolEngine("http://127.0.0.1:8081")
    result = engine.probe("en")
    assert result["available"] is True
    assert result["grammar_engine"] == "languagetool/6.6/en-US"
    assert result["spellcheck_engine"] != "none"
    assert engine.check("en", "He go to school every day.")[0].rule_id == "HE_VERB_AGR"
    assert calls == [
        {"language": "en-US", "text": "This is a misspelledd word."},
        {"language": "en-US", "text": "He go to school every day."},
    ]
