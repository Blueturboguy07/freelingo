# coursekit

The Freelingo content pipeline. Stages **G0-G9** and validators **V1-V12** (plus the
Freelingo-specific validators **F1-F5**) turn open corpora into a signed content pack.

```bash
uv sync
uv run pytest
uv run coursekit --help
uv run coursekit doctor        # what is registered, what is installed, what resolves
```

## Commands

| Command                     | Does                                                                     | State                   |
| --------------------------- | ------------------------------------------------------------------------ | ----------------------- |
| `coursekit build <lang>`    | G0-G9: corpus ledger -> selected items -> exercises -> units             | stages land per lane    |
| `coursekit validate <lang>` | V1-V12 + F1-F5, then writes `validator-report.json`                      | runner + V10-V12 landed |
| `coursekit bake <lang>`     | synthesize the voice cast and transcode to Opus, within the audio budget | G8 lane                 |
| `coursekit pack <lang>`     | assemble the read-only SQLite pack + manifest                            | G9 lane                 |
| `coursekit sample <lang>`   | draw the stratified reviewer sample (H1)                                 | **landed**              |
| `coursekit sign <lang>`     | sign the manifest with the ed25519 release key (INV-PACK-18)             | **landed**              |

`coursekit doctor` always exits 0 and prints the truth about all of the above; a
diagnostic that can fail is a diagnostic people stop running.

## Exit codes

The contract other lanes and `pack-ci.yml` depend on, named in `config/base.py`:

| Code | Means                                                                 |
| ---- | --------------------------------------------------------------------- |
| 0    | ok                                                                    |
| 1    | usage — unknown language, unknown stage or validator id               |
| 2    | the verb exists, a stage or validator behind it is **not registered** |
| 3    | a required input or dependency group is **absent**                    |
| 4    | a registered stage or validator ran and **failed**                    |

**2 is the one that matters.** A command whose stages are unwritten must never exit 0,
and `tests/test_cli.py::test_exit_two_is_not_vacuous` proves the rule both ways: empty
registry exits 2, full registry exits 0, remove one stage and it is 2 again. Not every
command exits 2 any more — `sample`, `sign` and the V10-V12 half of `validate` are
implemented — so the code you get tells you which half of the pipeline you are standing
in.

## `coursekit validate`

The suite is a **hard CI gate that runs before any human review** (`scope2/00` §2.4). It
stands in for Duolingo's human select-and-edit step, so it has to be impossible for it to
report a pass it did not earn. Three refusals, in
`src/coursekit/validators/runner.py`:

- an **unregistered** validator is exit 2 and a `unregistered` row in the report, with
  the id named. The denominator is `config.VALIDATOR_IDS`, never the registry — a report
  that omitted the unwritten validator would print "16/16 green" on the S002 pack card;
- a **skipped** validator (its dependency group is absent) is exit 3 and a blocking row.
  A validator that could not run reports zero findings, and zero findings is what a green
  validator looks like;
- a validator that **raises** is exit 4, not a pass, for the same reason.

Every validator runs even after one produces a blocking finding: the suite runs before
human review, and a reviewer handed "V1 failed" and nothing else waits a whole build to
learn V6 failed too.

The run writes `build/<lang>/validator-report.json`, validated on write and on read.
`validators/report.py::summarise()` is what S002's "validator-report summary" and S137's
provenance block render; it never emits a defect rate without the note that says who
measured it.

### The three validators that live here

The other nine live with the stages that produce what they check.

| Id  | Property                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------- |
| V10 | every shipped sentence carries a resolved licence, on the allow-list, with an attribution owner where one is required |
| V11 | mean sentence difficulty is non-decreasing across units — the batch-level drift check                                 |
| V12 | the pack declares the right direction, and every character in it is inside the shipped font's declared ranges         |

All three **fail on an empty or absent input**. A validator that reads nothing reports
zero findings; `docs/ci.md` describes the same shape for `maestro test` over an empty
directory, and the invariant registry calls it INV-PACK-14.

V12 is the **pack half** of INV-PACK-54. The other half — that the `.ttf` actually
shipped in `apps/mobile` still carries those ranges after subsetting — belongs to P3,
because the subset lives with the app. V12 records `bundled_font_subset_checked: false`
in its runlog entry rather than leaving that unsaid.

## `coursekit sample` and the published defect rate

```bash
uv run coursekit sample es                              # 300 items, seed 20260911
uv run coursekit sample es --set n=300 --set seed=12345  # per-stage options ride on --set
```

**There is no `--n` flag, and that is the scaffold's decision, not an omission.**
`cli.py` says so in its own docstring: "a lane lands a stage by adding a module to
`coursekit/stages/` and this file does not change… P2 runs as two waves over eight lanes;
a hand-maintained dispatch table here would be eight conflicting edits to one function."
So every per-stage option rides on `--set`, for all seven verbs, and the sample stage
reads `n` and `seed` out of `ctx.options`. A bare `coursekit sample es` is already the
300-item draw the plan's P2 row asks for — `REVIEWER_SAMPLE_ITEMS` is 300 — and
`tests/test_sample.py::test_the_default_sheet_is_the_three_hundred_the_plan_asks_for`
pins it. If the `--n 300` spelling is wanted, it is a one-line change to `cli.py` owned
by whoever owns the dispatch table, not by this lane.

Stratified over `(unit_index, exercise_type, provenance)` and deterministic under the
recorded seed. A sheet that cannot be redrawn belongs to no measurable population, so the
seed and the per-stratum allocation are written into `build/<lang>/sample-summary.json`.

Scoring happens against `content/<lang>/review/RUBRIC.md`, into
`content/<lang>/review/scores.jsonl`.

**This run has no paid native reviewer.** The Spanish sample is scored by the phase's
Opus reviewer agent, so every rate derived from it is published with, verbatim:

> PROVISIONAL (unreviewed by a paid native speaker)

here and in `docs/pack-provenance.md` today, and — once they exist — on the S001 pack card
(P3) and in the pack manifest's `review` block (G9). The string is a constant
(`config/sample.py::PROVISIONAL_DEFECT_RATE_NOTE`) precisely because it has to be the same
string in every carrier; `tests/test_sample.py` opens the two that exist and asserts it
verbatim in both, rather than comparing the literal to itself. `awkward` verdicts are
reported separately and never folded into the wrong-item rate. An **unscored** sample has a rate of `None`, and
`None` does not pass the 2% gate.

## `coursekit sign`

ed25519 over the canonicalised manifest, against the contract in
`packages/schema/src/signing.ts`. The private key exists only as the `PACK_SIGNING_KEY`
GitHub Actions secret: there is no `--key` flag and no local key file. The loader refuses
a PEM block outright (`-----BEGIN` cannot occur in base64) and **names a path only after
the base64 decode has already failed** — `/` is a member of the base64 alphabet, so a
`os.sep in value` heuristic refuses roughly half of all valid ed25519 keys, which is a
coin flip on the first real signing run. `tests/test_signing.py` pins both halves: a
hard-coded key whose base64 contains `/` must load, and 200 freshly generated ones must
too. After signing, the stage **verifies what it just wrote against the committed public
key** — the one shipped inside the app — because
signing with the wrong key otherwise surfaces as a device refusing to install.

An invalid signature maps to the `unverified` pack state, never `corrupt`.

## Rules

- Every constant is in `coursekit/config/`. No literal elsewhere —
  `tests/test_cli.py::test_no_constant_lives_outside_config` walks the package with `ast`
  and fails the build on a violation.
- `INV-PACK-13`: the licence allow-list is checked **at ingest**, before G0 reads a byte.
  NonCommercial data is allowed into packs and forbidden in code; NoDerivatives is
  forbidden everywhere.
- A stage that needs an absent dependency group **fails loudly** (exit 3) and never
  degrades to a worse aligner or a system voice. CI syncs `dev`, `nlp` and `lm` only;
  `align` and `tts` are gigabytes and are installed on demand.
- Corpora are streamed and capped, never fully downloaded and never committed.
- Packs are CC BY-NC-SA 4.0; this tool is AGPL-3.0-only. See `../../NOTICE`.
