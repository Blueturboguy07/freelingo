"""INV-PACK-13, as a capability rather than a check.

> `corpora_shippable` is an allow-list; anything unclassified fails; NC and ND sources
> are excluded **at ingest**, not at package time.

The invariant registry calls this "the only invariant whose failure cannot be fixed after
release", and the plan makes it a P2 *entry* criterion: the allow-list exists before G0
reads a byte. A module that exported `is_allowed(source) -> bool` would satisfy the
letter of that and none of it, because the next lane to add a fetcher simply would not
call it, and nothing would say so.

So the gate is not a check a fetcher performs — it is the only way to obtain the object a
fetcher needs. `IngestPermit` cannot be constructed outside this module (its `__init__`
demands a module-private token), every fetcher's signature takes one, and `require()`
re-derives the verdict from `config.SOURCES` at call time so even a permit that somehow
escaped is re-gated before a transport is touched. A forbidden corpus therefore produces
**zero network calls**, which is the property `tests/test_licences.py` asserts against a
transport that records every request and must have recorded none.

Three ways in, all closed:

- `verdict == "forbidden"` — TED2020 (CC BY-NC-ND: NC *and* ND, and every exercise shape
  is a derivative) and JParaCrawl (R8: "for commercial use, please contact NTT", which is
  non-commercial-by-default against an AGPL app a fork can commercialise).
- a licence that is not on `INGEST_LICENCE_ALLOW_LIST` — OpenSubtitles and CCMatrix are
  `NOASSERTION`, which is *unclassified*, which fails. They stay reachable as oracles
  only through data somebody else already ingested, never through this door.
- a source with no licence page in `LICENCE_PAGE_BY_SOURCE` — it resolves to
  `UNRESOLVED`, and edge case 4 ("OPUS licence assumed from the front page") is exactly
  the bug that produces. OPUS grants no blanket licence and its API returns no licence
  field; the string has to come from `/legacy/{CORPUS}-{VERSION}.php` and the row records
  which page it came from.

`oracle_only` is NOT refused here. NLLB is ODC-By and the plan ingests it, capped, as the
selection and validation oracle; what it may never do is fill a lesson slot, and
`inputs.forbid_unshippable` is where G4 enforces that. Conflating "may not be ingested"
with "may not be shipped" would either lose the oracle or ship the crawl text, and those
are different mistakes.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from dataclasses import fields as dataclass_fields
from typing import Any, Protocol, runtime_checkable

from ..config import INGEST_LICENCE_ALLOW_LIST, LANGUAGES, SOURCES, Source
from ..config.g0 import LICENCE_PAGE_BY_SOURCE, UNRESOLVED_LICENCE
from ..inputs import ForbiddenSource, MissingInput, ResolvedSource, resolve
from ..runlog import LicenceRow

__all__ = [
    "GatedTransport",
    "HttpTransport",
    "IngestPermit",
    "LicenceGateBypassed",
    "NotFound",
    "Response",
    "Transport",
    "UnresolvedLicence",
    "allow_list_refusal",
    "licence_page_for",
    "open_transport",
    "permit",
    "require",
    "resolve_licence",
    "with_corpus_version",
]


class LicenceGateBypassed(RuntimeError):
    """Somebody built an `IngestPermit` without going through `permit()`.

    Raised rather than tolerated because the alternative is a fetcher that works, a test
    that passes, and a pack carrying text nobody classified.
    """


class UnresolvedLicence(ForbiddenSource):
    """A source whose licence string never resolved to a real page.

    A subclass of `ForbiddenSource` so the CLI's existing `except` arm already exits 4
    and prints it: an unresolved licence and a forbidden licence are the same decision
    at ingest, and only the message differs.
    """


#: The token `IngestPermit.__init__` demands. A module-private object identity, so it
#: cannot be forged from outside without reaching into this module's globals — at which
#: point somebody is deliberately defeating a licence gate rather than making a mistake,
#: and no design stops that.
_GATE = object()


@dataclass(frozen=True, slots=True, init=False)
class IngestPermit:
    """Proof that one source, for one language, cleared the ingest licence gate.

    Carries everything a row needs to be self-describing: the corpus and its version, the
    licence string, the page it was resolved from, the verdict, and the attribution
    owner. `G0` copies these onto every `ingested_sentence`, which is what makes V10's
    "every sentence carries a resolved licence and attribution owner" checkable from the
    artefact alone rather than from a corpus-level footnote.
    """

    source_id: str
    lang: str
    url: str | None
    corpus: str
    corpus_version: str
    licence: str
    licence_page: str
    verdict: str
    attribution_required: bool
    attribution_owner: str | None

    def __init__(self, *, gate: object = None, **fields: Any) -> None:
        if gate is not _GATE:
            raise LicenceGateBypassed(
                "an IngestPermit may only be created by coursekit.sources.licences.permit(); "
                "constructing one directly would let a corpus be fetched without clearing "
                "the INV-PACK-13 allow-list, which is the one failure that cannot be fixed "
                "after release."
            )
        expected = {field.name for field in dataclass_fields(self)}
        if set(fields) != expected:
            raise LicenceGateBypassed(
                f"an IngestPermit needs exactly {sorted(expected)}; got {sorted(fields)}. "
                f"A partly-filled permit would produce a row with a missing licence or a "
                f"missing attribution owner, which is what V10 exists to catch."
            )
        for name, value in fields.items():
            object.__setattr__(self, name, value)

    @property
    def shippable(self) -> bool:
        """May a sentence from this source appear verbatim in a pack?"""
        return self.verdict == "shippable"

    @property
    def oracle_only(self) -> bool:
        """May it inform frequency, perplexity and alignment, but never be shipped?"""
        return self.verdict == "oracle_only"

    def licence_row(self) -> LicenceRow:
        """The runlog row. V10 and INV-PACK-13 read these."""
        return LicenceRow(
            source_id=self.source_id,
            licence=self.licence,
            verdict=self.verdict,
            attribution_required=self.attribution_required,
            attribution_owner=self.attribution_owner,
        )


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


def licence_page_for(source_id: str) -> str | None:
    """The page a source's licence string was read from, or None if there is none.

    None is the interesting answer. OPUS states no blanket licence and its API carries no
    licence field, so a corpus with no legacy page is a corpus whose terms nobody has
    read — and `resolve_licence` turns that into `UNRESOLVED` rather than into the
    source table's optimistic string.
    """
    return LICENCE_PAGE_BY_SOURCE.get(source_id)


def resolve_licence(source: Source) -> str:
    """The licence string, or `UNRESOLVED` when no page backs it.

    Sources that are not corpora (a morphology model, an aligner, a voice engine) carry
    their licence in their own distribution and need no OPUS page; the page requirement
    applies to the `corpus` kind, which is the kind whose TEXT travels into a pack.
    """
    if source.kind != "corpus":
        return source.licence
    if licence_page_for(source.id) is None:
        return UNRESOLVED_LICENCE
    return source.licence


def allow_list_refusal(source: Source) -> str | None:
    """Why this source may not be ingested, or None if it may.

    Pure and total: every refusal the gate can make is a string here, so the reasons can
    be enumerated in a test and in the falsifier corpus rather than discovered one
    `raise` at a time.
    """
    if source.verdict == "forbidden":
        return (
            f"{source.id} is forbidden at ingest: licence {source.licence}. {source.note} "
            f"Remedy: {source.remedy}"
        )
    licence = resolve_licence(source)
    if licence == UNRESOLVED_LICENCE:
        return (
            f"{source.id} has no licence page in config/g0.py LICENCE_PAGE_BY_SOURCE, so its "
            f"licence resolves to {UNRESOLVED_LICENCE}. OPUS grants no blanket licence and its "
            f"API returns no licence field: the string must come from "
            f"opus.nlpl.eu/legacy/{{CORPUS}}-{{VERSION}}.php and be recorded per sentence. "
            f"An unresolved licence is refused at ingest, never filtered at package time."
        )
    if licence not in INGEST_LICENCE_ALLOW_LIST:
        return (
            f"{source.id} carries licence {licence!r}, which is not on the INV-PACK-13 ingest "
            f"allow-list ({', '.join(INGEST_LICENCE_ALLOW_LIST)}). The list is an ALLOW-list: "
            f"anything unclassified fails, and NC and ND are excluded at ingest rather than "
            f"filtered at package time, because filtering later leaves the text in every "
            f"intermediate artefact. {source.note}"
        )
    return None


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


def permit(source_id: str, lang: str) -> IngestPermit:
    """Clear one source for ingest, or raise. The only way to get an `IngestPermit`.

    Order matters: the language and the source are resolved first (so an unknown source
    or a language the source does not cover is a `MissingInput` naming it — INV-PACK-12),
    then the licence gate runs, and only then does a permit exist. Nothing in this
    function opens a socket, and nothing downstream can open one without what it returns.
    """
    if lang not in LANGUAGES:
        raise MissingInput(f"unknown language {lang!r}; expected one of {', '.join(LANGUAGES)}")
    source = SOURCES.get(source_id)
    if source is None:
        raise MissingInput(
            f"no source registered as {source_id!r}. Registered: {', '.join(sorted(SOURCES))}. "
            f"An unregistered source has no licence verdict, and a source with no verdict "
            f"must never be read (INV-PACK-13)."
        )
    refusal = allow_list_refusal(source)
    if refusal is not None:
        raise (UnresolvedLicence if UNRESOLVED_LICENCE in refusal else ForbiddenSource)(refusal)

    # Re-uses the scaffold's resolver for the URL template and the "does this source
    # cover this language" check, with `allow_forbidden=False` — belt to the braces
    # above, and the single place a per-language URL is built.
    resolved: ResolvedSource = resolve(source_id, lang)
    return IngestPermit(
        gate=_GATE,
        source_id=source.id,
        lang=lang,
        url=resolved.url,
        corpus=source.id,
        corpus_version="",
        licence=resolve_licence(source),
        licence_page=licence_page_for(source.id) or "",
        verdict=source.verdict,
        attribution_required=source.attribution_required,
        attribution_owner=source.attribution_owner,
    )


def with_corpus_version(granted: IngestPermit, corpus: str, version: str) -> IngestPermit:
    """A copy of a permit with the corpus name and version the fetcher actually resolved.

    `version=latest` is resolved by the OPUS API, not by the config, so the version a run
    read is a fact about the run. It rides on the permit rather than being passed
    alongside it so a row can never carry a licence from one version and text from
    another.
    """
    require(granted)
    return IngestPermit(
        gate=_GATE,
        source_id=granted.source_id,
        lang=granted.lang,
        url=granted.url,
        corpus=corpus,
        corpus_version=version,
        licence=granted.licence,
        licence_page=granted.licence_page,
        verdict=granted.verdict,
        attribution_required=granted.attribution_required,
        attribution_owner=granted.attribution_owner,
    )


def require(granted: IngestPermit) -> IngestPermit:
    """Re-gate a permit at the moment a fetcher is about to use it. Returns it.

    Every fetcher calls this on its first line, before it constructs a request, so the
    licence decision is re-derived from `config.SOURCES` rather than trusted from an
    object that has been passed around. It costs a dict lookup and it closes the gap
    between "was allowed when the permit was minted" and "is allowed now".
    """
    if not isinstance(granted, IngestPermit):
        raise LicenceGateBypassed(
            f"a fetcher was handed {type(granted).__name__}, not an IngestPermit. "
            f"Every ingest path goes through coursekit.sources.licences.permit()."
        )
    source = SOURCES.get(granted.source_id)
    if source is None:
        raise ForbiddenSource(
            f"{granted.source_id} is no longer a registered source; a permit cannot outlive "
            f"the table that justified it."
        )
    refusal = allow_list_refusal(source)
    if refusal is not None:
        raise (UnresolvedLicence if UNRESOLVED_LICENCE in refusal else ForbiddenSource)(refusal)
    return granted


# ---------------------------------------------------------------------------
# The only door to the network
# ---------------------------------------------------------------------------


class NotFound(MissingInput):
    """A 404. Always a hard build failure, never a fallback to another file or corpus.

    A `MissingInput` subclass so it already exits 3 with a remedy through the CLI's
    existing arm: edge case 1 (wrong OPUS pair direction) and edge case 6 (`ja_50k.txt`)
    are both 404s whose only correct handling is to stop and name the file.
    """


@dataclass(frozen=True, slots=True)
class Response:
    """What a transport returns: a status, the final URL, headers and bytes.

    `headers` is here for exactly one reason and it is load-bearing: a ranged request's
    `content-range` is how the OPUS reader learns the total size of a 40 GB archive
    without downloading it.
    """

    status_code: int
    url: str
    content: bytes
    headers: dict[str, str]

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", "replace")

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300

    def header(self, name: str) -> str | None:
        return self.headers.get(name.lower())


@runtime_checkable
class Transport(Protocol):
    """The two operations a fetcher needs, and no others.

    Narrow on purpose. A test double for this is a dozen lines, and a double that records
    its calls is what lets `tests/test_licences.py` assert the property INV-PACK-13
    actually names — *zero network calls* for a forbidden corpus — rather than the much
    weaker "zero output rows", which a filter at the wrong end of the pipeline would also
    satisfy.

    `byte_range` is `(first, last)` inclusive, HTTP's own convention, or `(-n, None)` for
    "the last n bytes". It exists because the only way to take 2,000,000 pairs out of a
    40,327,884,789-byte archive is to read its directory from the tail and then read the
    front of each member — see `sources/opus.py`.
    """

    def get(self, url: str, *, byte_range: tuple[int, int | None] | None = None) -> Response: ...

    def stream(self, url: str) -> Iterator[bytes]: ...


class GatedTransport:
    """A transport that re-checks the licence gate before every single request.

    Wrapping rather than trusting matters because a fetcher is a loop: `permit()` runs
    once and `get()` runs per file. This re-derives the verdict from `config.SOURCES` on
    each call, and additionally refuses a URL whose host is not one this source is
    expected to live on — so a redirect, a templated URL with the wrong substitution, or
    a future fetcher pointed at the wrong corpus cannot quietly reach another host under
    a permit that was granted for this one.
    """

    __slots__ = ("_hosts", "_inner", "_permit", "requests")

    def __init__(self, granted: IngestPermit, inner: Transport, hosts: tuple[str, ...]) -> None:
        self._permit = require(granted)
        self._inner = inner
        self._hosts = hosts
        #: Every URL this transport was asked for, in order. Read by the runlog and by
        #: the tests; it is the audit trail for "what did this run actually fetch".
        self.requests: list[str] = []

    def _check(self, url: str) -> None:
        require(self._permit)
        host = url.split("://", 1)[-1].split("/", 1)[0]
        if host not in self._hosts:
            raise ForbiddenSource(
                f"{self._permit.source_id} is permitted to fetch from {', '.join(self._hosts)}, "
                f"not from {host!r} ({url}). A permit covers one source, and a request to "
                f"another host under it is either a redirect nobody checked or the wrong "
                f"corpus."
            )
        self.requests.append(url)

    def get(self, url: str, *, byte_range: tuple[int, int | None] | None = None) -> Response:
        self._check(url)
        return self._inner.get(url, byte_range=byte_range)

    def stream(self, url: str) -> Iterator[bytes]:
        self._check(url)
        return self._inner.stream(url)


def open_transport(
    granted: IngestPermit,
    inner: Transport,
    *,
    hosts: tuple[str, ...],
) -> GatedTransport:
    """The only supported way for a fetcher to obtain something it can call `get` on.

    It takes an `IngestPermit`, which only `permit()` mints, which only mints one for a
    source that cleared the allow-list. That chain is the whole of INV-PACK-13's
    enforcement: no permit, no transport; no transport, no bytes.
    """
    return GatedTransport(granted, inner, hosts)


class HttpTransport:
    """The real transport: httpx, streamed, with no retry and no redirect to a new host.

    No retry because a 404 here is a build failure by design and retrying it only delays
    the message. Redirects are followed (the OPUS API issues one), but `GatedTransport`
    re-checks the host of every URL a fetcher asks for, and httpx is configured to refuse
    a redirect chain longer than a couple of hops.
    """

    __slots__ = ("_timeout",)

    def __init__(self, timeout: float = 60.0) -> None:
        self._timeout = timeout

    def get(self, url: str, *, byte_range: tuple[int, int | None] | None = None) -> Response:
        import httpx

        headers: dict[str, str] = {}
        if byte_range is not None:
            first, last = byte_range
            headers["Range"] = f"bytes={first}" if first < 0 else f"bytes={first}-{last or ''}"
        with httpx.Client(timeout=self._timeout, follow_redirects=True, max_redirects=3) as client:
            reply = client.get(url, headers=headers)
        if reply.status_code == 404:
            raise NotFound(f"404 for {url}")
        return Response(
            status_code=reply.status_code,
            url=str(reply.url),
            content=reply.content,
            headers={key.lower(): value for key, value in reply.headers.items()},
        )

    def stream(self, url: str) -> Iterator[bytes]:
        import httpx

        with (
            httpx.Client(timeout=self._timeout, follow_redirects=True, max_redirects=3) as client,
            client.stream("GET", url) as reply,
        ):
            if reply.status_code == 404:
                raise NotFound(f"404 for {url}")
            reply.raise_for_status()
            yield from reply.iter_bytes()
