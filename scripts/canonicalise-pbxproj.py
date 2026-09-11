#!/usr/bin/env python3
"""Canonicalise Xcode object ids in a `.pbxproj`, so two prebuilds can be compared.

`expo prebuild` is NOT byte-reproducible, and INV-PLAT-02's determinism gate would fail
on every run if it pretended otherwise. Measured on this repo, 2026-09-11: two
consecutive `expo prebuild --clean --no-install` runs on the same commit produced 70
identical files and one difference — expo-dev-client's config plugin mints a fresh
random 24-hex Xcode object id for its "[Expo Dev Launcher] Strip Local Network Keys for
Release" build phase every time.

An Xcode object id is an arbitrary internal name, so the trees are compared *up to a
consistent renaming of ids*: each distinct id becomes `OBJ000000`, `OBJ000001`, ... in
order of first appearance. A build phase that moved, changed, appeared or disappeared
still changes the canonical form -- only the choice of name does not. `--self-test`
asserts exactly that, and the determinism job runs it before it trusts a hash.

Usage:
    canonicalise-pbxproj.py FILE...      rewrite each file in place
    canonicalise-pbxproj.py --self-test  check the contract, write nothing
"""

from __future__ import annotations

import re
import sys

# An Xcode object id: 24 uppercase hex characters. Nothing else in a pbxproj matches it.
OBJECT_ID = re.compile(rb"\b[0-9A-F]{24}\b")


def canonicalise(data: bytes) -> bytes:
    names: dict[bytes, bytes] = {}

    def rename(match: re.Match[bytes]) -> bytes:
        raw = match.group(0)
        if raw not in names:
            names[raw] = b"OBJ%06d" % len(names)
        return names[raw]

    return OBJECT_ID.sub(rename, data)


def self_test() -> None:
    phase_a = b"1E274186A53144469067CCC8"
    phase_b = b"48F0363509EB436FBBFF3EB8"
    other = b"13B07F8E1A680F5B00A75B9A"

    def project(phase: bytes, setting: bytes = b"NO", reorder: bool = False) -> bytes:
        refs = [b"\t\t\t\t%s /* phase */," % phase, b"\t\t\t\t%s /* other */," % other]
        if reorder:
            refs.reverse()
        return b"\n".join(
            [
                b"\t\tbuildPhases = (",
                *refs,
                b"\t\t);",
                b"\t\tENABLE_BITCODE = %s;" % setting,
                b"\t\t%s /* phase */ = { isa = PBXShellScriptBuildPhase; };" % phase,
            ]
        )

    # 1. The same project with a differently-named id is the same project.
    assert canonicalise(project(phase_a)) == canonicalise(project(phase_b)), (
        "a renamed object id must not read as drift"
    )
    # 2. A changed build setting is drift.
    assert canonicalise(project(phase_a)) != canonicalise(project(phase_a, setting=b"YES")), (
        "a changed build setting must read as drift"
    )
    # 3. A reordered build phase is drift.
    assert canonicalise(project(phase_a)) != canonicalise(project(phase_a, reorder=True)), (
        "a reordered build phase must read as drift"
    )
    # 4. Ids are renamed by order of first appearance, so the mapping is stable.
    assert canonicalise(project(phase_a)).count(b"OBJ000000") == 2
    assert b"OBJ000001" in canonicalise(project(phase_a))
    print("canonicalise-pbxproj: self-test passed (4 checks)")


def main(argv: list[str]) -> int:
    if argv == ["--self-test"]:
        self_test()
        return 0
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    for path in argv:
        with open(path, "rb") as handle:
            original = handle.read()
        with open(path, "wb") as handle:
            handle.write(canonicalise(original))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
