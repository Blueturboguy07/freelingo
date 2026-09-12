# Pack provenance — what a pack claims, and who checked it

**Four** surfaces render what is on this page, and they are the reason it exists rather
than living in a code comment:

| Screen   | Renders                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S001** | the course-picker card: `A1 · CEFR-aligned` / `Beginner · frequency-ordered`, `{{n}}% machine-authored`, `measured wrong-item rate {{n}}%`, `DOWNLOAD · {{n}} MB`                           |
| **S002** | pack detail: sample sentence + speaker, item count, size, **validator-report summary**                                                                                                      |
| **S137** | About: licences (AGPL), content provenance, measured defect rate, version — and `Content credits`, the whole-pack entry point into S152                                                     |
| **S152** | Credits: per-sentence source, licence and attribution owner; the derived-list and voice declarations; the pack's own licence. Entered from S137 and from S045's `Credits for this sentence` |

The product map marks S001, S002 and S137 `[DEPART D-HONEST]`. The departure is the
point: a learner can see how the course was made and how well it was checked, which is a
thing the reference product does not show. A number rendered there without its provenance
is worse than no number, because it makes the same claim as a number somebody paid to
verify.

**S152 is a different kind of departure and is newer than the rest of this file.** It is
not an honesty flourish, it is a licence obligation: Freelingo's sentences are
Tatoeba-attributed and its unit ordering is derived from CC BY-SA-4.0 frequency data, so
the credit has to be _reachable_, not merely recorded in a manifest. The reference
product has no such surface because it owns its sentences. The map stopped at S151 while
INV-PACK-17 and validator F3 already enforced the pack half — a screen id in an invariant
with no row anywhere — and founder ruling **B5** closed that on 2026-09-12:

> S152 now has a product-map row (Surface 16 in `deep/00-PRODUCT-MAP.md`): states `list ·
filtered · sentence-detail · empty · pack-missing`, entry points S137 → `Content
credits` and S045 → `Credits for this sentence`. P4 builds it.

So the copy slots exist to build against. All of them, from Surface 16, verbatim — nine
backticked strings plus one unbacketed slot the corpus writes as "per row: sentence text":

| Slot                                                                        | Where                                  |
| --------------------------------------------------------------------------- | -------------------------------------- |
| `Credits`                                                                   | the screen title                       |
| `Content credits`                                                           | the S137 row that opens the whole pack |
| `Credits for this sentence`                                                 | the S045 row that opens one item       |
| the **sentence text** itself                                                | per row, before its three credit lines |
| `Source: {{source}}` · `Licence: {{licence}}` · `By {{owner}}`              | per credited row                       |
| `Frequency ordering derived from FrequencyWords (hermitdave), CC BY-SA 4.0` | the derived-list declaration           |
| `Voices: Kokoro (Apache-2.0)`                                               | the voice declaration                  |
| `This pack is CC BY-NC-SA 4.0`                                              | the pack's own licence                 |

The `sentence text` row is easy to lose because it is the one slot the corpus does not
backtick, and losing it would build the screen wrong in a way nothing would catch: a
credits list of sources and owners with no sentences beside them credits nothing a reader
can identify, and the map also makes the whole-pack state **searchable by sentence text**,
which needs the text rendered to be worth searching.

The `filtered` state filters by source — Tatoeba / NLLB / Freelingo-authored / voices /
lists — and the surface reads only the pack's `sentence`, `audio` and `meta` rows. **No
network**, which is what keeps the credits surface honest when a learner is offline: a
credit that needed a connection would be a credit that disappears.

Note one string that disagrees with itself across the corpus and is not this file's to
fix: the product-map S001 row reads `A1 · CEFR-aligned`, while the plan's CEFR ruling and
the constant the manifest is built from — `CEFR_CLAIM_CHECKED` in
`tools/coursekit/src/coursekit/config/g9.py`, `"A1 · CEFR-checked"` — say **checked**. The
map is the build contract for P3, so the map's spelling is quoted above; whoever builds
S001 should reconcile the two rather than pick one silently. The manifest field wins on
substance either way: G3 either checked the sections against a CEFR lexicon or it did
not, and `cefrChecked` is the boolean that says which.

## The claims, and what backs each one

| Claim on the card         | Produced by                                               | Backed by                                                          |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| CEFR level                | G3 section assignment, checked against CEFRLex (es/fr)    | `config.CEFR_LANGUAGES`; de/ja read `Beginner · frequency-ordered` |
| `{{n}}% machine-authored` | the `selected_item` / `candidate` split at G4-G5          | counted over the shipped-item join                                 |
| validator-report summary  | `coursekit validate`                                      | `build/<lang>/validator-report.json`                               |
| measured wrong-item rate  | `coursekit sample` + `content/<lang>/review/scores.jsonl` | the rubric in `content/<lang>/review/RUBRIC.md`                    |
| licences and attribution  | V10, over every shipped sentence                          | the credits surface S152 (INV-PACK-17)                             |
| signature                 | `coursekit sign`                                          | `packages/schema/keys/pack-signing.pub`                            |
| `accent_claim`            | G8's cast, `content/es/cast.yaml`                         | **nothing in the toolchain** — see below                           |

## The accent claim is the one row nothing can contradict

Every other row above is backed by something that can contradict it. This one is not, and
the table says so rather than letting the reader assume it is the same kind of number.

### What changed, and the ruling that recorded it

The approved plan names **Azure Neural** as the voice vendor (§Approval: "Approving this
plan accepts … **Azure as the voice vendor**"), and Azure publishes a locale sub-tag per
voice, so `es-ES` used to be a vendor-backed, machine-checkable fact. No cloud credential
of any kind exists in this environment — no Azure, no AWS — and the build rule is that
anything needing a hosted model must have a local path. So Spanish is baked on
**Kokoro**, whose three Spanish style vectors are tagged `e` (Spanish) and nothing finer
and whose Spanish G2P path is generic espeak-ng: **no regional accent is declared
anywhere**.

That is a founder-visible override of an approved plan line, not an implementation
detail, and it was overridden rather than worked around. Founder ruling **B6**,
2026-09-12:

> Kokoro is the voice engine for es/fr/ja (Piper build-time only for de). Manifests
> replace `locale: es-ES` with `language: es` + `accent_claim: unverified`; the reviewer
> rubric checks accent consistency; the two blended cast roles stay, declared in
> `cast.yaml`.

So the manifest no longer asserts a locale it cannot back. It declares `language: es` —
which is a fact — and `accent_claim: unverified`, which is the absence of a claim rather
than a weaker one. The G8 lane recorded the vendor change as `OVERRIDE-VOICE-VENDOR` in
`docs/owned/p2-g8.json` and as `D-CAST-ES-00` in `content/es/cast.yaml`; both files
carry the reasoning, and `cast.yaml` is the one the bake actually reads.

Two consequences ride on it.

**1. The reviewer sample is the only remaining falsifier.** V1–V12 and F1–F5 read text,
licences, bands, difficulty and bytes. None of them listens. So the 300-item sample is
the last place a Latin-American-sounding peninsular course can be caught, and
`content/es/review/RUBRIC.md` now carries `accent_consistency` as a scored dimension
with the three questions it is asked through — one accent / the taught variety / the same
cast row to row. Two things about it are worth knowing here rather than in the rubric:

- the dimension's key must be in `REVIEW_DIMENSIONS` (`config/sample.py`) before it can
  appear in a scored row. `read_scores` raises on an unknown key, so a mismatched
  spelling does not lower the rate, it destroys it;
- the drawn sheet carries **no clip reference and no voice role** today, so the dimension
  is defined and not yet scoreable. That is **B18** in `docs/P2-BLOCKERS.md`.

**2. Two of the four cast roles are blends.** Kokoro ships three Spanish voices where the
cast wants four, and the shortfall is a _female_ voice: of `ef_dora`, `em_alex` and
`em_santa`, one is female, and the cast has two female roles. So `adult_female` (Rosa,
`ef_dora` 0.70 + `em_santa` 0.30 at rate 0.98) and `young` (Nico, `em_alex` 0.55 +
`ef_dora` 0.45 at rate 1.08) are deterministic weighted blends, declared as
`D-CAST-ES-02`. Deterministic and pinned by the re-bake key — INV-AUD-08 puts the
synthesis **engine** in that key, so a blend on a different engine is a different clip —
but a blended voice is what a learner hears for half the cast, which makes it a product
choice rather than an implementation detail. It is reversible in one field (`engine` on
`cast.yaml`) and what it costs is a cloud key and a re-bake, never a silent swap.

### The voices' licence chain, and why it is not the pack's licence

The thing a reader of a pack most easily gets wrong: **a voice engine's code licence is
not its voices' licence, and neither is the pack's.** Three separate licences are in play
and the credits surface names all three.

| Artefact                                  | Licence             | Consequence                                                               |
| ----------------------------------------- | ------------------- | ------------------------------------------------------------------------- |
| `kokoro-onnx`, the synthesiser code       | **Apache-2.0**      | build-time only; never links into the app                                 |
| Kokoro v1.0 model weights + style vectors | **Apache-2.0**      | the reason this cast can bake a CC BY-NC-SA pack with no licence question |
| the baked Opus clips inside the pack      | **CC BY-NC-SA 4.0** | they are pack content and take the pack's licence, not the engine's       |

Apache-2.0 on **both** halves is the whole reason Kokoro is usable here — a
permissively-licensed engine with non-commercial weights would have been unusable for
exactly the reason Piper's only Japanese voice is: it is CC BY-NC-SA, which is fine for a
pack and wrong for a tool, and `tts/piper.py` refuses it in code rather than in a comment.
Piper itself (GPL-3.0-only) stays a **build-time tool** held for German at P7 and never
ships inside the app.

Kokoro's allow-list entry records `attribution_required: false`, so the
`Voices: Kokoro (Apache-2.0)` line on S152 is a **declaration, not an obligation**: no
licence compels it and the surface carries it anyway, because a learner asking "who is
speaking to me" deserves an answer and because the accent claim above is unfalsifiable
without it. The rows S152 _must_ carry to pass F3 and INV-PACK-17 are the
attribution-required ones — the per-sentence Tatoeba owners, and the hermitdave
CC BY-SA-4.0 frequency ordering whose share-alike clause the pack inherits and declares.

## The honesty string

The Spanish pack's wrong-item rate for this run is **not** measured by a paid native
speaker. `scope2/00` §2.4 H1 describes a native-speaker pass; the plan budgets $300-800
per language for one; this run has none. What it has instead is a second pass by the
phase's Opus reviewer agent against a written rubric.

Founder ruling **B3**, 2026-09-12, decided what that is allowed to unblock:

> P3 proceeds. The 300-item sample is scored by an Opus reviewer as
> `REVIEWER_KIND_AGENT`; the manifest and S001 card carry
> `PROVISIONAL (unreviewed by a paid native speaker)` verbatim; `gate_passed()`
> accepts an agent-scored rate ≤ 2 % for
> the automated run; the paid native review is a **release prerequisite** listed in
> `docs/RELEASE.md`.

Read the two halves together. The automated gate accepts an agent-scored rate, so P3 can
build on the pack — and the **release** gate does not, so the paid pass is item 1 of
[`RELEASE.md`](./RELEASE.md), ahead of signing, the manual checklist and EAS, because
plan §Risks 7 is that a Spanish defect rate above 2% discovered late invalidates P3–P6.
An agent-scored rate is the phase's own model marking its own homework; that is why
`REVIEWER_KIND_AGENT` and `REVIEWER_KIND_PAID_NATIVE` are two constants and not a
boolean, and why only the second one clears the note.

So every rate this pipeline publishes carries, verbatim:

```
PROVISIONAL (unreviewed by a paid native speaker)
```

It is a constant — `PROVISIONAL_DEFECT_RATE_NOTE` in
`tools/coursekit/src/coursekit/config/sample.py` — so that it cannot be paraphrased in
one carrier and not another. There are **two places that exist today** and two that are
future work:

| Carrier                                       | State                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| this document                                 | carries it now                                                          |
| `tools/coursekit/README.md`                   | carries it now                                                          |
| the S001 pack card, beside the rate           | **does not exist yet** — S001 is P3, and no app screen renders anything |
| the pack manifest's `review` block (and S137) | **does not exist yet** — see the paragraph below                        |

The manifest row is worth being exact about, because a reader could reasonably assume it
had landed. G9 builds a manifest and it does carry a rate — `"defectRate":
inputs.defect_rate` in `tools/coursekit/src/coursekit/packbuild/manifest.py` — as a
**bare value with no note beside it**, and `review` is not one of
`MANIFEST_EXTRA_FIELDS` in `config/g9.py`. The note travels today only in the validator
report, whose `summarise()` cannot emit a rate without it. Until the manifest carries the
note too, the rule "every rate carries its provenance" holds in the report and in these
two documents, and the manifest is the gap.

**`accent_claim` is a separate gap in the same file, and it closes first.** Measured on
this branch: `MANIFEST_EXTRA_FIELDS` in `config/g9.py` contains neither `accent_claim`
nor `locale`, so a manifest built here makes no accent claim at all — accidentally
compliant rather than compliant, since B6 wants the absence _declared_. That is already
fixed on the sibling branch `p2r3/expand-bake-package`, where
`packbuild/manifest.py` writes `accentClaim` into the manifest's `audio` block and F2
refuses a manifest still carrying `locale`. So at the integrate pass this paragraph splits
in two: the accent half becomes built, and the **note** half — the `PROVISIONAL` string
beside `defectRate` — stays future, because nothing on any branch has landed it. Keep the
two apart; they are one sentence today only because they share a constant's neighbourhood.

`tools/coursekit/tests/test_sample.py::test_the_honesty_string_is_exactly_what_the_docs_promise`
opens the two committed carriers and asserts the constant appears verbatim in both — a
test that only compared the literal to itself would stay green through a doc edit that
softened the wording, which is the whole failure this constant exists to prevent. A
second test, `test_the_docs_do_not_claim_the_note_already_appears_where_it_cannot`,
fails if this section starts describing the two unbuilt carriers in the present tense.
Meanwhile
`test_validate_runner.py::test_the_summary_never_reports_a_rate_without_its_provenance`
pins the rule that `summarise()` cannot emit a rate without it. Only
`reviewer_kind == "paid-native-speaker"` clears the note, and clearing it is a one-field
change — nothing else in the pipeline moves when a real reviewer is hired.

## What "unscored" renders as

An unscored or partly scored sample has **no rate**. `wrong_item_rate` is `null`, not 0,
and `gate_passed()` is false. `None` is not 0%: a sample with no numerator is not a clean
pack, and a screen that rendered `0%` there would be the single most misleading number in
the app.

Both `sample_size` (rows drawn) and `scored` (rows a reviewer actually judged) are
published, so a partly-scored sheet cannot be mistaken for a complete one.

`awkward` verdicts — "a speaker would phrase it differently" — are counted and published
**separately**. Folding them into the wrong-item rate would make the 2% gate meaningless
in both directions.

## The validator report

`build/<lang>/validator-report.json`, written by every `coursekit validate` run and
copied into the pack manifest at G9. Schema: `tools/coursekit/src/coursekit/validators/report.py`.

The property that makes it worth rendering: **a validator that did not run is in the
report, with an outcome that says so.** `unregistered` and `skipped` are blocking
outcomes. A report that listed only the validators that executed would say "16 of 16
green" for a suite with a hole in it, and that sentence would be printed on a card
somebody reads before downloading 120 MB.

`summarise()` is the only thing a screen reads:

```json
{
  "status": "green",
  "line": "17/17 validators green",
  "declared": 17,
  "green": 17,
  "not_run": 0,
  "blocking_findings": 0,
  "warning_findings": 1,
  "hard_gate_passed": true,
  "wrong_item_rate": null,
  "wrong_item_rate_note": "PROVISIONAL (unreviewed by a paid native speaker)",
  "reviewer_kind": null,
  "reviewer_sample_size": 0
}
```

`hard_gate_passed` is V1-V4 specifically, which is the plan's P2 gate row ("V1-V4 100%").
The other thirteen must be green for the pack to ship at all; those four are called out
because they are the i+1 promise itself.

## Reproducing any of it

```sh
cd tools/coursekit
uv sync --locked
uv run coursekit build es                 # G0-G9
uv run coursekit validate es              # writes build/es/validator-report.json
uv run coursekit sample es                # writes build/es/sample-300.jsonl, seed 20260911
PACK_SIGNING_KEY=… uv run coursekit sign es
```

The sample is deterministic under its recorded seed, so a reviewer's 300 rows and a
maintainer's 300 rows six weeks later are the same 300. That is what makes an audit of
the published rate possible at all.
