import argparse
import importlib.util
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--module", type=Path, required=True)
parser.add_argument("--revision", type=Path, required=True)
args = parser.parse_args()
p = args.module
s = importlib.util.spec_from_file_location("revision_mutation_subject", p)
r = importlib.util.module_from_spec(s)
s.loader.exec_module(r)
root = args.revision
original = r.rows(root.parent / "first-unit-20260913/bundle/candidates.jsonl")
cases = [
    (
        "stale original candidate",
        lambda a: a["revisions"][0].__setitem__("originalCandidateSha256", "0" * 64),
    ),
    (
        "author revision cannot self-approve",
        lambda a: a["revisions"][0].__setitem__("review", {"verdict": "accepted"}),
    ),
    (
        "first session cannot contain production",
        lambda a: a["firstSession"].__setitem__("productionAllowed", True),
    ),
    (
        "correct option mismatch",
        lambda a: a["introductions"][0].__setitem__("correctOptionId", "option-night"),
    ),
]
real = r.require
results = []
for message, change in cases:
    a = r.load(root / "authoring.json")
    change(a)
    try:
        r.validate_authoring(a, original)
    except ValueError as e:
        assert str(e) == message
    else:
        raise AssertionError("baseline did not reject " + message)

    def skip(condition, description, *, target=message):
        if description != target:
            real(condition, description)

    r.require = skip
    try:
        r.validate_authoring(a, original)
    except ValueError:
        raise AssertionError("mutation not isolated " + message)
    else:
        results.append(
            {
                "guard": message,
                "baseline": "rejects falsifier",
                "mutant": "accepts same falsifier",
                "killed": True,
            }
        )
    finally:
        r.require = real
print(
    json.dumps(
        {
            "kind": "four isolated guard-removal mutations; no source-file changes",
            "mutations": results,
        },
        indent=2,
    )
)
