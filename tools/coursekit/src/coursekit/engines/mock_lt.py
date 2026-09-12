"""A local HTTP server that speaks LanguageTool's API, for tests and for CI.

`pack-ci.yml` is a 20-minute ubuntu job with `uv sync --locked` and no JDK, and pytest
must not need a 240 MB jar to exercise G6. So this module serves the two endpoints the
grammar engine uses — `/v2/languages` and `/v2/check` — over a real socket on a real
port.

**A real socket, deliberately.** Stubbing `LanguageToolEngine.check` would leave the
transport, the payload shape, the `software.version` extraction and the public-host
refusal untested, and those are where a client breaks. What runs against this server is
the same class that runs against the jar.

It is also, by design, impossible to mistake for the real thing. Its probe reports
`grammar_engine: "mock_lt/<version>/<code>"`, V8 writes that string into the runlog and
the manifest, and INV-PACK-55 renders the engine fields on the pack card — so a course
validated against this reports a mock on the screen a learner reads. That is the whole
argument for registering it as an engine rather than hiding it in the test tree: a mock
that can be run in a build must be one that announces itself in the artefact.

## What it models, and why those things

Two behaviours, both taken from the measured 6.6 server (2026-09-12):

- **A spell checker that is present for some languages and absent for others.** The
  real asymmetry — `MORFOLOGIK_RULE_ES` for Spanish, nothing at all for `ja-JP` — is
  the fact `deep/10` got backwards and review R1 corrected. A mock without that
  asymmetry would let an INV-PACK-14 bug pass every test in the suite, because every
  language would look equally equipped.
- **Grammar matches carrying `issueType` and `category.id`**, because that is what V8's
  per-language blocking set is keyed on and a match with neither is not a match this
  pipeline can act on.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs

from ..config.g6 import (
    LANGUAGETOOL_LONG_CODE,
    SPELLCHECK_CATEGORY_ID,
    SPELLCHECK_ISSUE_TYPE,
)
from ..engines import register_engine
from .languagetool import LanguageToolEngine

__all__ = ["MockLanguageTool", "build", "mock_languagetool_server"]


@dataclass(slots=True)
class MockLanguageTool:
    """The rules this server applies. Everything it will ever say is in here."""

    #: `longCode`s the server serves. A language outside it 404s the way a jar without
    #: that language pack does.
    served: tuple[str, ...] = tuple(LANGUAGETOOL_LONG_CODE.values())
    #: `longCode`s that have a spell checker. Default reproduces the measured shape:
    #: Spanish, French and German do; Japanese does not.
    spellchecks: tuple[str, ...] = ("es", "fr", "de-DE")
    #: Every word the spell checker knows. A token outside it is a misspelling — which
    #: is why a test that wants clean text declares its vocabulary here.
    known_words: frozenset[str] = frozenset()
    #: `substring -> (rule id, issueType, category id, message)`. A sentence containing
    #: the substring raises that match.
    grammar_triggers: dict[str, tuple[str, str, str, str]] = field(default_factory=dict)
    version: str = "mock-6.6"

    def languages(self) -> list[dict[str, str]]:
        return [
            {"name": code, "code": code.split("-")[0], "longCode": code} for code in self.served
        ]

    def check(self, long_code: str, text: str) -> list[dict[str, Any]]:
        matches: list[dict[str, Any]] = []
        for trigger, (rule_id, issue_type, category_id, message) in self.grammar_triggers.items():
            if trigger in text:
                matches.append(_match(rule_id, issue_type, category_id, message))
        if long_code in self.spellchecks:
            for token in _words(text):
                if token.lower() not in self.known_words:
                    matches.append(
                        _match(
                            "MORFOLOGIK_RULE_MOCK",
                            SPELLCHECK_ISSUE_TYPE,
                            SPELLCHECK_CATEGORY_ID,
                            f"Possible spelling mistake: {token}",
                        )
                    )
        return matches


def _words(text: str) -> list[str]:
    return [token for token in "".join(c if c.isalpha() else " " for c in text).split() if token]


def _match(rule_id: str, issue_type: str, category_id: str, message: str) -> dict[str, Any]:
    return {
        "message": message,
        "rule": {
            "id": rule_id,
            "issueType": issue_type,
            "category": {"id": category_id, "name": category_id.title()},
        },
    }


def _handler(rules: MockLanguageTool) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
            """Silence. A test suite that prints one access log line per sentence is
            a test suite whose real failures scroll off the screen."""

        def _send(self, payload: Any, status: int = 200) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - stdlib signature
            if self.path.startswith("/v2/languages"):
                # A BARE ARRAY, which is what 6.6 returns (measured: 60 entries, no
                # envelope). An envelope here would make every client test pass against
                # a shape the jar never sends.
                self._send(rules.languages())
                return
            self._send({"error": "not found"}, status=404)

        def do_POST(self) -> None:  # noqa: N802 - stdlib signature
            if not self.path.startswith("/v2/check"):
                self._send({"error": "not found"}, status=404)
                return
            length = int(self.headers.get("Content-Length", "0"))
            form = parse_qs(self.rfile.read(length).decode("utf-8"))
            long_code = form.get("language", [""])[0]
            text = form.get("text", [""])[0]
            if long_code not in rules.served:
                self._send({"error": f"unsupported language {long_code}"}, status=400)
                return
            self._send(
                {
                    "software": {"name": "MockLanguageTool", "version": rules.version},
                    "language": {"code": long_code.split("-")[0], "name": long_code},
                    "matches": rules.check(long_code, text),
                }
            )

    return Handler


@contextmanager
def mock_languagetool_server(rules: MockLanguageTool | None = None) -> Iterator[str]:
    """Run the mock on an ephemeral port and yield its base URL.

    Port 0, because a hard-coded port is a test that fails on somebody else's machine
    for a reason that looks like a bug in the code under test.
    """
    active = rules or MockLanguageTool()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(active))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@register_engine("mock_lt")
def build(url: str | None = None) -> LanguageToolEngine | None:
    """The same client class, pointed at a mock URL and labelled as one.

    Requires a URL exactly as the real engine does: an engine that silently started its
    own server would make `coursekit build es --set grammar_engine=mock_lt` succeed on a
    machine where nobody meant to validate against a mock.
    """
    if not url:
        return None
    return LanguageToolEngine(base_url=url, id="mock_lt")
