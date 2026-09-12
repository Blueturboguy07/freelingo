"""LanguageTool, as a build-time sidecar. Never linked, never the public API.

LanguageTool is LGPL-2.1-or-later. That is compatible with an AGPL codebase for exactly
one reason: this is an **out-of-process build service**. The jar is started beside the
build, answered over HTTP, and shut down; nothing from it travels into the app or into a
pack. Link it in and the analysis changes completely, so the shape is not a convenience.

The other rule is operational and `deep/10` §S6 states it outright: **the public API is
rate-limited and must not take a batch.** A 6,000-item course pointed at
`api.languagetool.org` gets throttled somewhere in the middle and produces a validator
report that is part real and part timeout — the worst possible shape, because it is
green-ish. `FORBIDDEN_LANGUAGETOOL_HOSTS` refuses those hosts by name, up front.

## Capability is probed, never assumed

`deep/10` claimed Japanese was "spell check only (no grammar checks)". Review R1 showed
that was the table read backwards — the ✓ is the **Spell check** column, the quoted
sentence is about Norwegian, and Japanese is 735 grammar rules with *no* spell checker.
A fact that has already been got wrong once by reading a table is not a fact to encode
as a constant.

So `probe()` asks the server that is about to do the work. It sends one sentence
carrying a nonce token no dictionary can contain and looks at what comes back: a
`misspelling` match means this language has a spell checker, silence means it does not.
Measured against LanguageTool 6.6 on 2026-09-12 the answers were `MORFOLOGIK_RULE_ES`
for Spanish and nothing at all for `ja-JP` — the review's correction, reproduced from
the server rather than from the page.

A language the server does not serve, a server that is not up, a connection that fails:
all three come back as `available: False` with a reason. None of them comes back as
zero errors.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx

from ..config.g6 import (
    ENGINE_NONE,
    FORBIDDEN_LANGUAGETOOL_HOSTS,
    LANGUAGETOOL_LONG_CODE,
    LANGUAGETOOL_TIMEOUT_SECONDS,
    LANGUAGETOOL_XML_RULE_COUNTS,
    SPELLCHECK_CATEGORY_ID,
    SPELLCHECK_ISSUE_TYPE,
    SPELLCHECK_PROBE,
)
from ..engines import register_engine

__all__ = ["GrammarMatch", "LanguageToolEngine", "PublicApiRefused", "build"]


class PublicApiRefused(RuntimeError):
    """A URL on the hosted service was passed to a batch validator."""


@dataclass(frozen=True, slots=True)
class GrammarMatch:
    """One thing LanguageTool objected to, flattened to what V8 needs."""

    rule_id: str
    issue_type: str
    category_id: str
    message: str

    def to_json(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "issue_type": self.issue_type,
            "category_id": self.category_id,
            "message": self.message,
        }


@dataclass(slots=True)
class LanguageToolEngine:
    """A client for one running sidecar.

    `id` is what the runlog records as the engine that ran, so it carries the server's
    own reported version rather than the package's: two builds checked by different
    jars must not read as the same run.
    """

    base_url: str
    id: str = "languagetool"
    _version: str = ""
    _served: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        host = (urlparse(self.base_url).hostname or "").lower()
        if host in FORBIDDEN_LANGUAGETOOL_HOSTS:
            raise PublicApiRefused(
                f"{self.base_url} is the hosted LanguageTool service. It is rate-limited "
                f"and must never take a batch: a throttled run reports part real errors "
                f"and part timeouts, which reads as a pass. Start the sidecar instead "
                f"(`java -cp languagetool-server.jar org.languagetool.server.HTTPServer "
                f"--port 8081`) and point {self.id} at it."
            )

    # -- capability --------------------------------------------------------

    def probe(self, lang: str) -> dict[str, Any]:
        """What this server can actually do for this language, asked rather than assumed."""
        long_code = LANGUAGETOOL_LONG_CODE.get(lang)
        if long_code is None:
            return self._unavailable(f"no LanguageTool language code is declared for {lang!r}")

        try:
            languages = self._get("/v2/languages")
        except httpx.HTTPError as exc:
            return self._unavailable(f"{self.base_url} did not answer /v2/languages: {exc}")

        served = tuple(entry["longCode"] for entry in languages)
        self._served = served
        if long_code not in served:
            return self._unavailable(
                f"this server serves {len(served)} languages and {long_code!r} is not "
                f"among them; the language pack is missing from the jar"
            )

        try:
            matches = self.check(lang, SPELLCHECK_PROBE[lang])
        except httpx.HTTPError as exc:
            return self._unavailable(f"{self.base_url} did not answer /v2/check: {exc}")

        # The whole spell-check question, decided by the server: did a token no
        # dictionary contains come back as a misspelling?
        has_spellcheck = any(
            match.issue_type == SPELLCHECK_ISSUE_TYPE or match.category_id == SPELLCHECK_CATEGORY_ID
            for match in matches
        )
        grammar = f"{self.id}/{self._version or 'unknown'}/{long_code}"
        return {
            "available": True,
            "grammar_engine": grammar,
            "spellcheck_engine": grammar if has_spellcheck else ENGINE_NONE,
            "reason": "",
            "detail": {
                "long_code": long_code,
                "server_version": self._version,
                "xml_rule_count": LANGUAGETOOL_XML_RULE_COUNTS.get(lang),
                "spellcheck_probe": SPELLCHECK_PROBE[lang],
                "spellcheck_probe_matches": [match.to_json() for match in matches],
            },
        }

    def _unavailable(self, reason: str) -> dict[str, Any]:
        return {
            "available": False,
            "grammar_engine": ENGINE_NONE,
            "spellcheck_engine": ENGINE_NONE,
            "reason": reason,
            "detail": {},
        }

    # -- checking ----------------------------------------------------------

    def check(self, lang: str, text: str) -> list[GrammarMatch]:
        """Every match the server raises for one sentence."""
        long_code = LANGUAGETOOL_LONG_CODE[lang]
        payload = self._post("/v2/check", {"language": long_code, "text": text})
        return [
            GrammarMatch(
                rule_id=match["rule"]["id"],
                issue_type=match["rule"].get("issueType", ""),
                category_id=match["rule"].get("category", {}).get("id", ""),
                message=match.get("message", ""),
            )
            for match in payload.get("matches", [])
        ]

    # -- transport ---------------------------------------------------------

    def _get(self, path: str) -> Any:
        response = httpx.get(
            f"{self.base_url.rstrip('/')}{path}", timeout=LANGUAGETOOL_TIMEOUT_SECONDS
        )
        response.raise_for_status()
        return response.json()

    def _post(self, path: str, data: dict[str, str]) -> Any:
        response = httpx.post(
            f"{self.base_url.rstrip('/')}{path}",
            data=data,
            timeout=LANGUAGETOOL_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        payload = response.json()
        version = payload.get("software", {}).get("version")
        if version:
            self._version = version
        return payload


@register_engine("languagetool")
def build(url: str | None = None) -> LanguageToolEngine | None:
    """The sidecar client, or `None` when no URL was given.

    `None` rather than a raise: "nobody started a sidecar" is a legitimate state of a
    build machine, and G6 turns it into `grammar_engine: none` plus the named
    degradation. What is never legitimate is inventing a default URL and reporting the
    connection refusal as zero grammar errors.
    """
    if not url:
        return None
    return LanguageToolEngine(base_url=url)
