"""[INV-PACK-13] The ingest licence allow-list, and the transport nobody may reach past it.

The property is not "no forbidden sentence appears in the output". A pipeline that
downloads TED2020, parses it, and drops the rows at G9 satisfies that and has already
written CC BY-NC-ND text into every intermediate artefact. The property is **zero network
calls**, and it is only assertable against a transport that records every request — which
is what `RecordingTransport` is for, and why every other test module in this lane imports
it from here.

The falsifier corpus is `tests/falsifiers/INV-PACK-13.json`: eleven cases, each naming the
source, the verdict it must get and the reason, sourced to EC-PACK-09..13 and to the
adversarial review of `deep/10`. It carries `permitted` cases as well as `refused` ones,
because a gate that refuses everything passes every refusal test there is.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from coursekit.config import INGEST_LICENCE_ALLOW_LIST, SOURCES
from coursekit.config.g0 import (
    INGEST_CORPORA_BY_LANGUAGE,
    LICENCE_PAGE_BY_SOURCE,
    MAX_REDIRECT_HOPS,
    UNRESOLVED_LICENCE,
)
from coursekit.inputs import ForbiddenSource, MissingInput
from coursekit.sources import opus, tatoeba
from coursekit.sources.licences import (
    GatedTransport,
    IngestPermit,
    LicenceGateBypassed,
    NotFound,
    Redirected,
    Response,
    UnresolvedLicence,
    allow_list_refusal,
    open_transport,
    permit,
    require,
    resolve_licence,
)

FALSIFIERS = Path(__file__).parent / "falsifiers"


# ---------------------------------------------------------------------------
# The recording transport every test in this lane asserts against
# ---------------------------------------------------------------------------


class RecordingTransport:
    """A `Transport` that serves a dict of URL -> bytes and remembers every request.

    Remembering is the whole point. "The output had no forbidden rows" is satisfied by a
    late filter; "the transport was never called" is not satisfiable by anything except a
    gate that ran first.
    """

    def __init__(
        self,
        files: dict[str, bytes] | None = None,
        headers: dict[str, dict[str, str]] | None = None,
    ) -> None:
        self.files = dict(files or {})
        self.headers = dict(headers or {})
        self.requests: list[str] = []

    # -- Transport ---------------------------------------------------------

    def get(self, url: str, *, byte_range: tuple[int, int | None] | None = None) -> Response:
        self.requests.append(url)
        blob = self.files.get(url)
        if blob is None:
            raise NotFound(f"404 for {url}")
        headers = dict(self.headers.get(url, {}))
        status = 200
        if byte_range is not None:
            first, last = byte_range
            total = len(blob)
            if first < 0:
                start, end = max(0, total + first), total
            else:
                start, end = first, total if last is None else min(total, last + 1)
            headers["content-range"] = f"bytes {start}-{max(end - 1, start)}/{total}"
            blob = blob[start:end]
            status = 206
        return Response(status_code=status, url=url, content=blob, headers=headers)

    def stream(self, url: str) -> Iterator[bytes]:
        self.requests.append(url)
        blob = self.files.get(url)
        if blob is None:
            raise NotFound(f"404 for {url}")
        for at in range(0, len(blob), 4096):
            yield blob[at : at + 4096]

    # -- assertions --------------------------------------------------------

    def asked_for(self, needle: str) -> bool:
        return any(needle in url for url in self.requests)


def _cases(invariant: str) -> list[dict[str, object]]:
    payload = json.loads((FALSIFIERS / f"{invariant}.json").read_text(encoding="utf-8"))
    assert payload["invariant"] == invariant
    return list(payload["cases"])


PACK13 = _cases("INV-PACK-13")


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


def test_the_falsifier_corpus_was_actually_read() -> None:
    """Every scan in this file is vacuous if the corpus comes back empty."""
    assert len(PACK13) >= 10
    assert {case["expect"] for case in PACK13} == {"refused", "permitted"}


@pytest.mark.parametrize("case", PACK13, ids=lambda case: str(case["id"]))
def test_INV_PACK_13_the_ingest_allow_list_decides_every_case(case: dict[str, object]) -> None:
    """[INV-PACK-13] every falsifier case gets the verdict the corpus states."""
    source_id, lang = str(case["source_id"]), str(case["lang"])
    if case["expect"] == "permitted":
        granted = permit(source_id, lang)
        assert granted.licence == case["licence"]
        assert granted.verdict == case["verdict"]
        assert granted.attribution_required == case["attribution_required"]
        assert granted.licence in INGEST_LICENCE_ALLOW_LIST
        # A permitted source must say WHERE its licence was read from, or the row it
        # produces is an assertion nobody can re-check (edge case 4).
        assert granted.licence_page.startswith("http")
        return

    with pytest.raises((ForbiddenSource, MissingInput)) as raised:
        permit(source_id, lang)
    assert source_id in str(raised.value)


@pytest.mark.parametrize(
    "case",
    [case for case in PACK13 if case["expect"] == "refused"],
    ids=lambda case: str(case["id"]),
)
def test_INV_PACK_13_a_refused_corpus_makes_zero_network_calls(case: dict[str, object]) -> None:
    """[INV-PACK-13] the gate runs before a socket exists, not after the rows are in.

    A transport that recorded even one request would mean the refusal happened after the
    download — which is "filtered at package time" wearing an ingest-shaped coat, and
    leaves the text on the build machine either way.
    """
    transport = RecordingTransport()
    with pytest.raises((ForbiddenSource, MissingInput)):
        granted = permit(str(case["source_id"]), str(case["lang"]))
        # Unreachable for a refused case; present so the test would catch a `permit` that
        # started returning None instead of raising.
        opus.describe(granted, transport)
    assert transport.requests == [], (
        f"{case['id']}: a refused corpus reached the network: {transport.requests}"
    )


def test_INV_PACK_13_every_configured_corpus_is_on_the_allow_list() -> None:
    """[INV-PACK-13] the corpora G0 is told to read all clear the gate.

    Config and gate are two files, and the failure mode of two files is that one of them
    moves. A corpus in `INGEST_CORPORA_BY_LANGUAGE` that the gate refuses would turn every
    build of that language into a hard stop, which is safe — but a build that never runs
    is not a licence posture anybody reviewed.
    """
    for lang, corpora in INGEST_CORPORA_BY_LANGUAGE.items():
        for source_id in corpora:
            granted = permit(source_id, lang)
            assert granted.licence in INGEST_LICENCE_ALLOW_LIST


def test_INV_PACK_13_the_allow_list_carries_no_nc_and_no_nd_licence() -> None:
    """[INV-PACK-13] NC and ND are excluded by the LIST, not by a per-source decision."""
    for licence in INGEST_LICENCE_ALLOW_LIST:
        assert "NC" not in licence.upper().split("-")
        assert "ND" not in licence.upper().split("-")


#: The verdict each corpus in `config.SOURCES` must get, written out INDEPENDENTLY of the
#: code that decides it. The previous version of the test below asserted
#: `(refusal is None) == (resolve_licence(s) in ALLOW_LIST and s.verdict != "forbidden")`,
#: which is `allow_list_refusal`'s own branching restated — it survives any change made
#: consistently in both places, which is every change somebody makes on purpose. This is a
#: table a reviewer can check against `deep/10`'s licence rows without reading the gate.
EXPECTED_INGEST_VERDICT: dict[str, bool] = {
    # id -> may it be ingested at all?
    "tatoeba": True,  # CC BY 2.0 FR, attribution-only
    "tatoeba_cc0": True,  # CC0-1.0
    "nllb": True,  # ODC-By-1.0 (R2), oracle_only but ingestable
    "opensubtitles": False,  # NOASSERTION -> unclassified -> fails (EC-PACK-10)
    "ccmatrix": False,  # NOASSERTION -> unclassified -> fails (EC-PACK-10)
    "ted2020": False,  # CC BY-NC-ND-4.0: NC and ND (EC-PACK-09)
    "jparacrawl": False,  # non-commercial by default (R8, EC-PACK-11)
}

#: `cefrlex` is kind `lexicon`, not `corpus`, so it is outside the table above — and it
#: must still be refused (CC BY-NC-SA-4.0 is NC; EC-PACK-12). It is a G2 lexicon whose
#: *derived banding* ships inside an NC pack, never its text, and the moment somebody
#: adds a `cefrlex` sentence fetcher this assertion is the one that stops it.
CEFRLEX_MUST_BE_REFUSED = "cefrlex"


def test_INV_PACK_13_an_unclassified_licence_fails_rather_than_defaults() -> None:
    """[INV-PACK-13] 'anything unclassified fails' — the allow-list's defining property.

    Asserted against a hand-written expectation, and over the WHOLE corpus half of the
    source table, so a source added later cannot pass by being new: an id with no row in
    `EXPECTED_INGEST_VERDICT` fails here before it can be silently permitted.
    """
    corpora = {source.id for source in SOURCES.values() if source.kind == "corpus"}
    assert corpora == set(EXPECTED_INGEST_VERDICT), (
        "config.SOURCES gained or lost a corpus. Add its row to EXPECTED_INGEST_VERDICT "
        "with the licence page it was read from, or this gate is deciding nothing."
    )
    for source_id, may_ingest in EXPECTED_INGEST_VERDICT.items():
        refusal = allow_list_refusal(SOURCES[source_id])
        assert (refusal is None) is may_ingest, (
            f"{source_id}: expected may_ingest={may_ingest}, got refusal={refusal!r}"
        )
        if not may_ingest:
            # Refusal is not enough; it has to say which of the three doors closed, or the
            # operator reading it cannot tell "add a licence page" from "this is NC".
            assert source_id in refusal
            assert (
                "forbidden at ingest" in refusal
                or "not on the INV-PACK-13 ingest allow-list" in refusal
                or UNRESOLVED_LICENCE in refusal
            )
        else:
            assert resolve_licence(SOURCES[source_id]) in INGEST_LICENCE_ALLOW_LIST

    cefrlex_refusal = allow_list_refusal(SOURCES[CEFRLEX_MUST_BE_REFUSED])
    assert cefrlex_refusal is not None
    assert "CC-BY-NC-SA-4.0" in cefrlex_refusal


def test_INV_PACK_13_a_corpus_with_no_licence_page_resolves_to_unresolved() -> None:
    """[INV-PACK-13] edge case 4: OPUS grants no blanket licence and its API has no field.

    The licence string has to come from `/legacy/{CORPUS}-{VERSION}.php`. A corpus with no
    page resolves to UNRESOLVED and is refused at ingest — it never reaches G9, where the
    spec's version of this check lived.
    """
    from dataclasses import replace

    licensed = SOURCES["nllb"]
    assert resolve_licence(licensed) == "ODC-By-1.0"
    orphan = replace(licensed, id="nllb_unpaged")
    assert orphan.id not in LICENCE_PAGE_BY_SOURCE
    assert resolve_licence(orphan) == UNRESOLVED_LICENCE
    assert UNRESOLVED_LICENCE in (allow_list_refusal(orphan) or "")


# ---------------------------------------------------------------------------
# The gate cannot be walked around
# ---------------------------------------------------------------------------


def test_INV_PACK_13_a_permit_cannot_be_constructed_outside_the_gate() -> None:
    """[INV-PACK-13] the gate is a capability, not a convention.

    `is_allowed(source) -> bool` would be satisfied by a fetcher that never calls it. The
    only object a fetcher can fetch with is minted by `permit()`, so "forgot to check" is
    not a state this pipeline has.
    """
    with pytest.raises(LicenceGateBypassed):
        IngestPermit(
            source_id="ted2020",
            lang="es",
            url=None,
            corpus="TED2020",
            corpus_version="v1",
            licence="CC-BY-NC-ND-4.0",
            licence_page="",
            verdict="shippable",
            attribution_required=True,
            attribution_owner="TED Conferences LLC",
        )


def test_INV_PACK_13_a_fetcher_handed_something_that_is_not_a_permit_refuses() -> None:
    """[INV-PACK-13] and it refuses before it opens anything."""
    transport = RecordingTransport()
    with pytest.raises(LicenceGateBypassed):
        require("tatoeba")  # type: ignore[arg-type]
    with pytest.raises(LicenceGateBypassed):
        tatoeba.fetch_pairs("tatoeba", transport)  # type: ignore[arg-type]
    assert transport.requests == []


def test_INV_PACK_13_a_permit_is_re_gated_on_every_request(monkeypatch) -> None:
    """[INV-PACK-13] a permit minted once is re-checked per request, not per run.

    A fetcher is a loop: `permit()` runs once and `get()` runs per file. If the table's
    verdict changed under a long run, every remaining request would ride on a decision
    that is no longer true.
    """
    from dataclasses import replace

    granted = permit("tatoeba", "es")
    gated = open_transport(
        granted,
        RecordingTransport({"https://downloads.tatoeba.org/x": b"1"}),
        hosts=("downloads.tatoeba.org",),
    )
    assert gated.get("https://downloads.tatoeba.org/x").ok

    monkeypatch.setitem(SOURCES, "tatoeba", replace(SOURCES["tatoeba"], verdict="forbidden"))
    with pytest.raises(ForbiddenSource):
        gated.get("https://downloads.tatoeba.org/x")


def test_INV_PACK_13_a_permit_may_not_reach_another_host() -> None:
    """[INV-PACK-13] a permit covers one source, and hosts are not interchangeable.

    A redirect nobody checked, or a mis-templated URL, would otherwise fetch from a host
    whose terms were never read under a permit granted for one whose terms were.
    """
    granted = permit("tatoeba", "es")
    transport = RecordingTransport({"https://example.invalid/spa.tsv.bz2": b""})
    gated = open_transport(granted, transport, hosts=("downloads.tatoeba.org",))
    with pytest.raises(ForbiddenSource):
        gated.get("https://example.invalid/spa.tsv.bz2")
    assert transport.requests == []


class RedirectingTransport(RecordingTransport):
    """A `RecordingTransport` that answers some URLs with a hop instead of bytes.

    Models the one thing `GatedTransport`'s host check could not see before: an HTTP
    client that follows a `Location` itself. `HttpTransport` no longer does
    (`follow_redirects=False`), so a hop surfaces as `Redirected` and the gate decides.
    """

    def __init__(
        self,
        hops: dict[str, str],
        files: dict[str, bytes] | None = None,
        headers: dict[str, dict[str, str]] | None = None,
    ) -> None:
        super().__init__(files, headers)
        self.hops = dict(hops)
        #: Called as the hop is issued. Exists so a test can change the world BETWEEN two
        #: hops, which is the only way to prove the second one is gated on its own.
        self.on_redirect: Callable[[str], None] | None = None

    def _hop(self, url: str) -> Redirected:
        self.requests.append(url)
        if self.on_redirect is not None:
            self.on_redirect(url)
        return Redirected(self.hops[url], 302)

    def get(self, url: str, *, byte_range: tuple[int, int | None] | None = None) -> Response:
        if url in self.hops:
            raise self._hop(url)
        return super().get(url, byte_range=byte_range)

    def stream(self, url: str) -> Iterator[bytes]:
        if url in self.hops:
            raise self._hop(url)
        yield from super().stream(url)


def test_INV_PACK_13_a_redirect_to_an_unclassified_host_is_refused() -> None:
    """[INV-PACK-13] a hop off the allow-list is refused, and its target is never fetched.

    This is the hole the review found: with `follow_redirects=True` inside the HTTP
    client, a 302 from a permitted host to an unclassified one was followed under a permit
    granted for the first, and the gate — which only ever saw the URL the FETCHER asked
    for — could not tell. The assertion that matters is the last one: the redirect target
    appears in no request list, so no byte came off an unclassified host.
    """
    granted = permit("tatoeba", "es")
    start = "https://downloads.tatoeba.org/exports/per_language/spa/spa_sentences.tsv.bz2"
    elsewhere = "https://mirror.invalid/spa_sentences.tsv.bz2"
    transport = RedirectingTransport({start: elsewhere}, files={elsewhere: b"id\tlang\ttext\n"})
    gated = open_transport(granted, transport, hosts=("downloads.tatoeba.org",))

    with pytest.raises(ForbiddenSource) as raised:
        gated.get(start)
    assert "mirror.invalid" in str(raised.value)
    assert elsewhere not in transport.requests


def test_INV_PACK_13_a_redirect_inside_the_allow_list_is_re_gated_then_followed(
    monkeypatch,
) -> None:
    """[INV-PACK-13] a permitted hop IS followed — and the licence is re-checked on it.

    A gate that refused every redirect would pass the test above and break the OPUS API,
    which issues one. So the hop is made, and it is made through `_check`, which means the
    verdict is re-derived from `config.SOURCES` for the hop as well as for the first
    request. The second half proves that: with the table flipped to `forbidden` between
    hops, the hop is refused and its bytes are never fetched.
    """
    from dataclasses import replace

    granted = permit("nllb", "es")
    api = "https://opus.nlpl.eu/opusapi/?corpus=NLLB"
    archive = "https://object.pouta.csc.fi/OPUS-NLLB/v1/moses/en-es.txt.zip"
    transport = RedirectingTransport({api: archive}, files={archive: b"PK\x03\x04"})
    gated = open_transport(granted, transport, hosts=("opus.nlpl.eu", "object.pouta.csc.fi"))

    assert gated.get(api).content == b"PK\x03\x04"
    assert transport.requests == [api, archive]
    assert gated.requests == [api, archive]

    # Now the part that only a hop can prove: flip the table AS the redirect is issued, so
    # the first request was legitimate and the second is not. A gate that checked once per
    # `get()` would sail straight on to the archive.
    flipped = RedirectingTransport({api: archive}, files={archive: b"PK\x03\x04"})
    regated = GatedTransport(granted, flipped, ("opus.nlpl.eu", "object.pouta.csc.fi"))
    flipped.on_redirect = lambda _url: monkeypatch.setitem(
        SOURCES, "nllb", replace(SOURCES["nllb"], verdict="forbidden")
    )
    with pytest.raises(ForbiddenSource):
        regated.get(api)
    assert flipped.requests == [api], "the hop target was fetched after the verdict changed"


def test_INV_PACK_13_a_streamed_redirect_is_gated_the_same_way() -> None:
    """[INV-PACK-13] `stream()` is the door the bulk bytes come through, so it gates too.

    `get()` fetches directories and headers; `stream()` fetches the corpus. A gate that
    covered only the first would leave every sentence unchecked.
    """
    granted = permit("tatoeba", "es")
    start = "https://downloads.tatoeba.org/exports/per_language/spa/spa-eng_links.tsv.bz2"
    elsewhere = "https://mirror.invalid/links.tsv.bz2"
    transport = RedirectingTransport({start: elsewhere}, files={elsewhere: b"1\t2\n"})
    gated = open_transport(granted, transport, hosts=("downloads.tatoeba.org",))

    with pytest.raises(ForbiddenSource):
        list(gated.stream(start))
    assert elsewhere not in transport.requests

    # And a relative Location stays on the host that issued it, rather than being refused
    # for looking like a bare path: relative hops are real and a build must not die on one.
    same_host = "https://downloads.tatoeba.org/exports/mirror/links.tsv.bz2"
    relative = RedirectingTransport(
        {start: "/exports/mirror/links.tsv.bz2"}, files={same_host: b"1\t2\n"}
    )
    ok = open_transport(granted, relative, hosts=("downloads.tatoeba.org",))
    assert b"".join(ok.stream(start)) == b"1\t2\n"
    assert relative.requests == [start, same_host]


def test_INV_PACK_13_a_redirect_loop_stops_rather_than_spinning() -> None:
    """[INV-PACK-13] hops are bounded, and the bound is a named constant.

    Two permitted hosts pointing at each other is a live-lock, not a fetch. It ends as a
    refusal naming the source, because `--max-pairs` bounds bytes and nothing else bounded
    requests.
    """
    granted = permit("nllb", "es")
    one = "https://opus.nlpl.eu/a"
    two = "https://object.pouta.csc.fi/b"
    transport = RedirectingTransport({one: two, two: one})
    gated = open_transport(granted, transport, hosts=("opus.nlpl.eu", "object.pouta.csc.fi"))

    with pytest.raises(ForbiddenSource) as raised:
        gated.get(one)
    assert "redirect hops" in str(raised.value)
    assert len(transport.requests) == MAX_REDIRECT_HOPS + 1


def test_INV_PACK_13_an_unresolved_licence_raises_its_own_error_type() -> None:
    """[INV-PACK-13] 'no page backs this string' and 'this licence is forbidden' are both
    refusals at ingest, and the CLI exits 4 on either — but they need different fixes, so
    they are different types."""
    assert issubclass(UnresolvedLicence, ForbiddenSource)
