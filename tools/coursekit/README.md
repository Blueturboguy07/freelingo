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

**A fourth refusal lives in V8, and it is the one CI trips over today.** V8 blocks a run
in which `grammar_engine` and `perplexity_engine` are both `none` — "zero errors from
nothing", the exact reading INV-PACK-14 exists to fail. `pack-ci.yml`'s `build-es` runs
`coursekit build es --set max_pairs=…` and names neither a LanguageTool URL nor a KenLM
model, so that is the state every CI build is in, for any content whatsoever. It is a gap
in the workflow, not in the pipeline, and it is written up with its measured remedy in
`docs/P2-BLOCKERS.md` §B8. Locally:

```bash
java -cp LanguageTool-6.6/languagetool-server.jar \
     org.languagetool.server.HTTPServer --port 8081 &
uv run coursekit build es --set languagetool_url=http://localhost:8081
```

The URL is the server **base** — the engine appends `/v2/languages` and `/v2/check`
itself, so `…/v2/check` 404s. With a sidecar and no KenLM, V8 warns `grammar_only`
instead of blocking; measured 2026-09-12 against LanguageTool 6.6 by the two
`COURSEKIT_LANGUAGETOOL_URL`-gated tests in `tests/test_g6_validate_language.py`.

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
uv run coursekit sample es                              # 300 items, seed 20260913
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
pins it.

`coursekit sample es --n 300` appeared in the P2 task briefs and in
`docs/P2-REPORT.md` §B4. **It is not a spelling this CLI has, and it never was.** The
sanctioned spellings are the two in the block above; nothing is missing and nothing needs
adding. Measured on this tree, 2026-09-12:

```
$ uv run coursekit sample es --n 300
Error: No such option: --n            (exit 2)
$ uv run coursekit sample es
sample failed: no exercise artefact at build/es/g7/exercises.jsonl … run `coursekit build es` first   (exit 4)
```

Note the **2**, and note that it is not this CLI's 2. `config/base.py` defines exit 2 as
"the verb exists, the stage behind it is not registered"; Click writes 2 for any usage
error, so a mistyped flag and an unwritten stage are the same number to a caller. Nothing
in `coursekit` can change that — Click owns the code it exits with before any command
body runs — so the guard is a test rather than a fix:
`tests/test_sample.py::test_the_phantom_n_flag_is_rejected_and_collides_with_exit_2`
pins **both** exit codes and the collision, so if `--n` is ever added to `cli.py` that
test fails and tells whoever adds it that this paragraph is now wrong. The one thing that
must never happen is the flag being accepted and ignored, which would draw some other
number of items under a command line that says 300.

Stratified over `(unit_index, exercise_type, provenance)` and deterministic under the
recorded seed. A sheet that cannot be redrawn belongs to no measurable population, so the
seed and the per-stratum allocation are written into `build/<lang>/sample-summary.json`.

Scoring happens against `content/<lang>/review/RUBRIC.md`, into
`content/<lang>/review/scores.jsonl`. Copy each sheet row's `content_fingerprint` into
its score. The fingerprint covers the reviewable content; the sheet summary also
records the full population fingerprint. An unchanged exercise id does not validate an
old score after answers, source text, distractors or clip metadata change. The H1 gate
requires at least 300 rows, all scored and joined to the current population; duplicate
scores and partial intersections cannot pass. Clip paths are relative to
`build/<lang>/`, so the candidate CI artifact preserves `g8/bank/` alongside the sheet.

**This run has no paid native reviewer.** The Spanish sample is scored by the phase's
reviewer agent (Codex for the current takeover round), so every rate derived from it
is published with, verbatim:

> PROVISIONAL (unreviewed by a paid native speaker)

here and in `docs/pack-provenance.md` today, and — once they exist — on the S001 pack card
(P3) and in the pack manifest's `review` block (G9). The string is a constant
(`config/sample.py::PROVISIONAL_DEFECT_RATE_NOTE`) precisely because it has to be the same
string in every carrier; `tests/test_sample.py` opens the two that exist and asserts it
verbatim in both, rather than comparing the literal to itself. `awkward` verdicts are
reported separately and never folded into the wrong-item rate. An **unscored** sample has a rate of `None`, and
`None` does not pass the 2% gate.

Founder ruling **B3** (2026-09-12) settled what an agent-scored rate unblocks:
`gate_passed()` accepts `REVIEWER_KIND_AGENT` at ≤ 2% **for the automated run**, so P3
may build on the pack, and the **paid** native review is a release prerequisite — item 1
of `docs/RELEASE.md`, ahead of signing and the manual checklist, because a defect rate
above 2% discovered after P3 invalidates P3–P6. Two reviewer classes exist as two
constants (`REVIEWER_KIND_AGENT`, `REVIEWER_KIND_PAID_NATIVE`) rather than a boolean for
exactly that reason, and only the paid one clears the note.

The rubric grew a sixth dimension in the same round, `accent_consistency`, because ruling
**B6** made it the only check there is on how the bank sounds — see "Voices" below.
`REVIEW_DIMENSIONS` in `config/sample.py` is the authority on the spelling: `read_scores`
raises `ScoreError` on a `dimensions` key outside that tuple, so a rubric and a constant
that disagree do not produce a wrong rate, they produce **no rate**.

## Where these numbers are rendered

`coursekit` produces provenance for four surfaces, and the reason each figure exists is
that something renders it. `docs/pack-provenance.md` is the full account; this is the map.

| Screen   | Reads                                                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S001** | course-picker card: `A1 · CEFR-aligned` / `Beginner · frequency-ordered`, `{{n}}% machine-authored`, `measured wrong-item rate {{n}}%`, size                            |
| **S002** | pack detail: sample sentence + speaker, item count, size, the **validator-report summary** (`validators/report.py::summarise()`)                                        |
| **S137** | About: licences, content provenance, measured defect rate, version, and `Content credits` into S152                                                                     |
| **S152** | Credits: per row the **sentence text** then `Source: {{source}}` · `Licence: {{licence}}` · `By {{owner}}`; the derived-list and voice declarations; the pack's licence |

S152 is the surface INV-PACK-17 and validator **F3** enforce: every sentence, voice and
derived list whose licence requires attribution must be **reachable** from it, and the
build fails otherwise. It was a screen id in an invariant with no product-map row until
founder ruling **B5** gave it one (Surface 16: states `list · filtered · sentence-detail ·
empty · pack-missing`, entered from S137 `Content credits` and S045 `Credits for this
sentence`). P4 builds it; the pack half is already gated here.

`docs/pack-provenance.md` carries the full slot list. The one to not lose is the **per-row
sentence text**, which Surface 16 writes without backticks among nine backticked strings:
a credited row renders the sentence, then its source, licence and owner, and the whole-pack
state is searchable by that text.

## Voices — Kokoro, and the three licences a reader must not conflate

The approved plan named **Azure Neural** as the voice vendor. No cloud credential exists
in this environment, so founder ruling **B6** replaced it: **Kokoro** bakes es/fr/ja, and
Piper stays a build-time-only tool held for German at P7. The override is recorded in
`content/es/cast.yaml` as `D-CAST-ES-00` — the file the bake actually reads — and in
`docs/owned/p2-g8.json` as `OVERRIDE-VOICE-VENDOR`.

Two things follow, and both are founder-visible rather than internal:

- **the accent claim lost its backing.** Azure publishes a locale sub-tag per voice;
  Kokoro's three Spanish vectors are tagged `e` and nothing finer. So the manifest says
  `language: es` + `accent_claim: unverified` instead of `locale: es-ES`, and the reviewer
  sample's `accent_consistency` dimension is the only thing that can contradict it;
- **two of four cast roles are blends.** Three Spanish voices, four roles, one female
  vector against two female roles: `adult_female` and `young` are deterministic weighted
  blends of stock vectors at declared weights (`D-CAST-ES-02`). Pinned by the re-bake key,
  which includes the **engine** (INV-AUD-08), so an engine swap re-bakes rather than
  silently reusing the bank.

| Artefact                              | Licence             | Where it goes                                             |
| ------------------------------------- | ------------------- | --------------------------------------------------------- |
| `kokoro-onnx`, the synthesiser code   | **Apache-2.0**      | build time only; never links into the app                 |
| Kokoro v1.0 weights and style vectors | **Apache-2.0**      | build time only                                           |
| the baked Opus clips in the pack      | **CC BY-NC-SA 4.0** | pack content, so the **pack's** licence, not the engine's |
| `piper`                               | GPL-3.0-only        | build-time tool, de only, P7; never shipped               |

Apache-2.0 on **both** the code and the weights is why Kokoro can bake a CC BY-NC-SA pack
with no licence question at all. The rule underneath the table — **a voice engine's code
licence is not its voices' licence, and neither is the pack's** — is enforced rather than
advised: Piper's single Japanese voice is CC BY-NC-SA and `tts/piper.py` refuses it in
code. Kokoro's allow-list entry sets `attribution_required: false`, so the
`Voices: Kokoro (Apache-2.0)` line on S152 is a declaration the project chose to make,
not an obligation it owes.

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
