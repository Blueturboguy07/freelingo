# Release prerequisites

What has to be true before Freelingo ships, and — for each item — whether anything in
this build environment can make it true. The plan's **P8** row names the gate ("Full
suite + e2e green; D checklist signed; ≤2% for every shipped language"); this file is the
list of things that gate expands into, written down at P2 rather than at P8 because four
of them cost money or need a human and therefore have a lead time.

Nothing on this page is a task an agent can complete. That is the point of collecting
them: a release blocker discovered at P8 with a six-week lead time is a release blocker
discovered too late.

| #     | Prerequisite                             | Blocks               | Can this environment do it? |
| ----- | ---------------------------------------- | -------------------- | --------------------------- |
| **1** | Paid native-speaker review, per language | the pack, and P3–P6  | **No** — costs $300–800 ×4  |
| **2** | Signing key custody, exercised           | pack install         | Partly — see below          |
| **3** | The D-kind manual checklist, signed      | P5 and the release   | **No** — needs a person     |
| **4** | EAS Starter ($19/month)                  | the iOS build        | **No** — needs a card       |
| **5** | App-store signing identities             | TestFlight, Play     | **No** — needs an account   |
| **6** | The full suite and the e2e flows green   | everything           | Yes, and it is not green    |
| **7** | The README honesty block                 | publishing at all    | Yes, at P8                  |
| **8** | A measured mutation score                | nothing — non-gating | Yes, as a P3 chore          |

---

## 1. The paid native-speaker review of every shipped language

**This is the first prerequisite because it is the only one with a two-way door
underneath it.** The plan's §Risks item 7: "Spanish defect rate > 2% discovered late
would invalidate P3–P6; hence the sample is sent at the end of P2." Every other item on
this page delays a release. This one can invalidate work already done.

| Per language           | Figure                                                                    |
| ---------------------- | ------------------------------------------------------------------------- |
| Items reviewed         | **300**, the stratified sheet `coursekit sample <lang>` draws             |
| Gate                   | **wrong-item rate ≤ 2%**, `wrong` verdicts only                           |
| Cost                   | **$300–800** (plan §Effort, "native reviewers $300–800 per language ×4")  |
| Languages at release   | es, fr, de, ja — so **$1,200–3,200** total                                |
| Reviewer must be       | a native speaker paid for the pass — `reviewer_kind: paid-native-speaker` |
| Where the rubric lives | `content/<lang>/review/RUBRIC.md`                                         |
| Where the scores go    | `content/<lang>/review/scores.jsonl`                                      |

The gate is the plan's **non-negotiable 5**: "Content ships only through `coursekit
validate` and a paid native-speaker sample with a ≤2% wrong-item gate; the measured rate
is shown to the learner." Both halves are load-bearing — the gate, and the rendering. A
pack that passed the gate and did not publish the rate would fail the honesty departure
`[DEPART D-HONEST]` the product map marks on S001, S002 and S137.

### The rate this project publishes today is not that rate, and is marked as not being it

Founder ruling **B3** (2026-09-12, `docs/P2-BLOCKERS.md`) lets P3 proceed on an
**agent-scored** rate. The ruling is explicit about what it is buying and what it is not:

> P3 proceeds. The 300-item sample is scored by an Opus reviewer as `REVIEWER_KIND_AGENT`;
> the manifest and S001 card carry `PROVISIONAL (unreviewed by a paid native speaker)`
> verbatim; `gate_passed()` accepts an agent-scored rate ≤ 2 % for the automated run; the
> paid native review is a **release prerequisite** listed in `docs/RELEASE.md`.

So there are two reviewer classes in the code, and they are separate constants on
purpose (`tools/coursekit/src/coursekit/config/sample.py`):

| Constant                    | Value                 | What it means                                          |
| --------------------------- | --------------------- | ------------------------------------------------------ |
| `REVIEWER_KIND_AGENT`       | `opus-agent-reviewer` | the phase's own model scored the phase's own output    |
| `REVIEWER_KIND_PAID_NATIVE` | `paid-native-speaker` | the thing `scope2/00` §2.4 H1 describes, and this gate |

An agent-scored rate is a real second pass against a written rubric and it is **not an
independent measurement**: it is the same model marking its own homework. That is why
only `reviewer_kind == "paid-native-speaker"` clears the provisional note
(`sample.py`, `note = "" if reviewer_kind == REVIEWER_KIND_PAID_NATIVE else …`), and why
no amount of agent scoring can satisfy this prerequisite.

**Hiring the reviewer is a one-field change.** `reviewer_kind` becomes
`paid-native-speaker`, the note becomes empty, and nothing else in the pipeline moves.
The sheet is deterministic under `SAMPLE_SEED = 20260911`, so the 300 rows a reviewer
scores in six weeks are the same 300 rows that are drawable today: the brief can be sent
before the pack is final.

### What the reviewer must be briefed on, beyond correctness

Founder ruling **B6** made one more thing the reviewer's job, and it is not optional
padding. Kokoro replaced Azure as the voice engine; Kokoro's Spanish voices declare no
regional accent; so the `accent_claim` a manifest carries has **nothing in the toolchain
that can falsify it**, and the 300-item sample is the last place a
Latin-American-sounding "peninsular" course can be caught. `content/es/review/RUBRIC.md`
carries that dimension. A reviewer brief that omits it buys a correctness number and
leaves the accent claim unchecked.

## 2. Signing key custody, exercised on a real manifest

Two different keys, and only one of them exists.

**The pack-signing key exists and has never signed anything.** P0 generated the ed25519
pair, committed the public half to `packages/schema/keys/pack-signing.pub`, and put the
private half in the `PACK_SIGNING_KEY` Actions secret (`docs/P0-REPORT.md`, "Signing key
custody: done"). What has not happened is a signature: `coursekit sign es` has never
signed a manifest that exists, because no pack has ever been built
(`docs/owned/p2-validate-ci.json` → `knownHazards`). So the custody is real and the
**path** is unexercised, and INV-PACK-18 — a device refusing an unverified pack — has no
owning test and never has. Before release:

- one real pack signed in CI by the secret, not by a local key (there is no `--key` flag
  and that is deliberate);
- the app-side verify-before-install path exercised against that pack, and against a
  pack signed by a different key, on a device;
- a written answer to "who can recover this key if the repository's secrets are lost",
  which does not exist anywhere today. A lost pack-signing key is not a lost signature,
  it is every future pack update becoming uninstallable for every existing install.

**The app-store signing identities do not exist at all** — see item 5.

## 3. The D-kind manual checklist, signed

`D` in the invariant registry means "a human with a device, and no automation". The plan
lists the checklist twice (§Verification, and P5's gate row) and nothing in CI can
substitute for it. The registry carries **ten** D-kind ids:

| Id              | The thing a person has to observe                                              |
| --------------- | ------------------------------------------------------------------------------ |
| **INV-PACK-11** | packs are outside the backed-up directory, per a real backup manifest          |
| **INV-PER-10**  | the on-device backup manifest lists only the checkpointed DB, inside the quota |
| **INV-WID-04**  | widget reloads stay ≤1 per 15 min and under the daily budget, over a real day  |
| **INV-NOT-06**  | pending notifications never exceed the platform ceiling                        |
| **INV-PLAT-04** | the speech-recognition permission ladder, and the Android no-beep option       |
| **INV-PLAT-05** | the audio session mode is set per surface and restored                         |
| **INV-PLAT-09** | an audio interruption mid-recording returns the item to idle                   |
| **INV-AUD-07**  | highlight lag never exceeds one keypoint interval                              |
| **INV-SND-05**  | one answer-class cue per 120 ms burst, at the right pitch                      |
| **INV-SND-07**  | one trace item emits exactly one success notification and one chime            |

The plan's prose checklist also names **haptics**, the **silent switch**, **Low Power
Mode**, and **"the reminder fires the next day"**. Those have no id of their own: they
are the manual half of ids that are otherwise automated, and a checklist that only walked
the ten rows above would skip them.

One discrepancy worth fixing rather than inheriting: the plan's P5 row calls reboot
survival a D-kind item ("reboot survival PLAT-07"), and the registry records
**INV-PLAT-07 as kind `E`** — an emulator reboot with an assertion that the next reminder
still fires. `E` is automatable and `D` is not, so whoever signs the checklist should
confirm which one PLAT-07 is before signing for it. It is one line in the registry, and
the registry is generated from the corpus, so the fix is upstream.

"Signed" means a named person recorded the date, the device, the OS version and the
outcome per row. An unsigned checklist is the same shape of claim as an unscored sample:
no numerator, and not a pass.

## 4. EAS Starter ($19/month)

The plan, §Stack: EAS **Starter** "for release candidates because Free's 45-minute
timeout will kill a Skia+Rive+widget iOS build and burn one of 15 monthly builds". The
release-candidate builds therefore need a paid plan for the month of the release, which
is the cheapest item on this page and still not something this environment can buy.

`eas build --local` covers the daily loop and does not cover the release: a local build
is unsigned by the release identity and is not what goes to TestFlight.

## 5. App-store signing identities and accounts

Distinct from item 2, and entirely absent:

- an **Apple Developer Program** membership, a distribution certificate and a
  provisioning profile that covers the app **and every target** — the WidgetKit
  extension is a separate bundle id, and the plan's §Stack trap is that "build numbers
  must match across targets";
- a **Play Console** account and an upload key for the signed APK/AAB;
- a decision the plan defers rather than answers (§Risks 6, trade dress): "App Store is a
  later decision." Freelingo keeps Duolingo's green and a parrot mascot. The README
  honesty block states that mechanics are re-implemented and every asset is original;
  whether that survives review is not a thing this repository can determine, and a
  release plan that assumed it would is a release plan with an unpriced risk in it.

## 6. The full suite and the e2e flows green

Not a purchase, and not green today. The honest state at the end of P2:

- **`coursekit build es` has never completed.** B9 and B16 are open phase blockers
  (`docs/P2-BLOCKERS.md`), so G7 onwards — G8, G9, `coursekit validate`, `coursekit
sample`, `coursekit sign` — is unproven on real content. No pack exists, so no rate of
  any kind exists, agent-scored or otherwise.
- `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage-map` and
  `pnpm invariants:check` are the per-push gate (`docs/ci.md`) and are the part that is
  green.
- The Maestro flows and the native snapshot matrix are P3 and later.

## 7. The README honesty block

The plan's P8 deliverable: the README states the **parity definition** (no ads,
unlimited mistakes rendering `∞`, free Legendary entry — and Roleplay as the one place
Freelingo exceeds Super), the **provenance percentages**, the **measured defect rates**
per language with their reviewer class, the **surfaces that have no reference frame at
all** (Practice Hub, Stories, Radio, widget, recovery, Data/About, every test flavour),
and the **CEFR policy** (es/fr `A1 · CEFR-checked`; de/ja `Beginner · frequency-ordered ·
no CEFR resource`).

This is writing, not money, and it is listed here because it is the one release item that
is easy to leave for last and is the whole reason the licence split and the provenance
plumbing exist. `docs/pack-provenance.md` is its source material.

## 8. A measured mutation score — explicitly not a gate

Recorded so no release report has to quote a number that has never printed. **No
mutation score exists for any sha in this repository**: Stryker dies in the dry run on a
`packages/core/src/data/` fast-check property at Vitest's 300,000 ms per-test timeout,
and `mutation.yml` reports success only because `continue-on-error: true` holds it.
Founder ruling **B7** keeps it non-gating and schedules the fix — `coverageAnalysis: off`
plus tighter `INV-DAT` generators — as a **P3 chore**. The measurement and the three
facts that rule out the obvious wrong fix are in `docs/P2-BLOCKERS.md` §B7.

The commit that records a real whole-engine score in `docs/P1-REPORT.md` is also the one
that takes `continue-on-error: true` off the workflow. Until then, a release report says
"no mutation score" rather than a number.

---

## Who owns this page

No invariant id, no test, no automation: every row is a purchase, a person or a signature.
It is kept next to the phase reports because the P8 gate is the only place it is read in
anger, and by then the lead times have already been spent.
