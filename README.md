# Freelingo

**An open-source, local-only language learning app.** No accounts, no server, no social
graph, no paywall, no ads. Your progress is a SQLite file on your phone and nowhere else.
The one non-negotiable: people actually learn.

> **Status: P0 — foundation.** The repository is scaffolded, the engine is not built yet.
> Nothing here is installable. Do not treat any number in the honesty block below as
> measured until it stops saying `TBD`.

---

## The honesty block

This section is a release gate, not marketing. Every placeholder is filled with a measured
number before v1 ships, and any that cannot be measured says so.

### What "parity" means here

Freelingo aims at the **paid (Super) Duolingo experience**, re-implemented. Concretely that
means **no ads, unlimited mistakes (the hearts meter renders `∞`), and Legendary levels
entered for free**. Two features people often call "Super" are free-tier on Duolingo as of
2026 and are shipped here as such, not as a bonus: **Explain My Answer** (free since
2026-01-01) and the **Practice Hub** (free since 2026-04-28).

**Where Freelingo exceeds Super:** **Roleplay**, which is Duolingo Max-only. Video Call is
not in v1.

**Both streak mechanics ship:** the 2026 recovery challenge _and_ a monthly Streak Repair
(one per calendar month).

**What is deliberately absent, and always will be:** leaderboards, leagues, friends,
follower counts, streak-sharing, hearts-as-a-paywall, gem-gated learning, ads, and any
screen that asks you to make an account.

Freelingo copies no code and ships no asset it did not make. The mechanics are
re-implemented from observed behaviour; the mascot, cast, node art and sound bank are
original work. The green stayed green.

### Provenance — where the course content comes from

| Language      | Sentences with declared provenance | Source mix | Attribution-required sentences |
| ------------- | ---------------------------------- | ---------- | ------------------------------ |
| Spanish (es)  | TBD %                              | TBD        | TBD                            |
| French (fr)   | TBD %                              | TBD        | TBD                            |
| German (de)   | TBD %                              | TBD        | TBD                            |
| Japanese (ja) | TBD %                              | TBD        | TBD                            |

Every attribution-required sentence is reachable from inside the app (report sheet and the
About/credits screen), not only from a file.

### Defect rate — how wrong the content is, measured

Every language ships only after a **paid native-speaker review of a 300-item sample**, and
only if the wrong-item rate is **≤ 2%**. The measured rate is shown to the learner in the
app and repeated here.

| Language      | Sample size | Measured wrong-item rate | Gate |
| ------------- | ----------- | ------------------------ | ---- |
| Spanish (es)  | TBD         | TBD %                    | ≤ 2% |
| French (fr)   | TBD         | TBD %                    | ≤ 2% |
| German (de)   | TBD         | TBD %                    | ≤ 2% |
| Japanese (ja) | TBD         | TBD %                    | ≤ 2% |

### Surfaces with no visual reference

Pixel parity is claimed only where a reference frame exists. The reference corpus is 236
guest, free-tier frames at a 614×811 CSS px viewport. These surfaces were designed, not
matched, and no parity claim is made for them:

- Practice Hub
- Stories
- Radio
- The home-screen widget (iOS and Android)
- The streak recovery challenge and the monthly Streak Repair
- Data export/import and the About/credits screens
- All ten session flavours' test variants

Everywhere else, parity is checked three ways: token conformance against the measured
token table, ~15 curated frames diffed at 614 CSS px, and self-baseline native snapshots on
every PR across three font scales × three widths × light/dark.

### CEFR policy — what a level label is allowed to claim

A CEFR label is shown only where a CEFRLex resource exists to check it against.

| Language      | Card reads                                        | Why                       |
| ------------- | ------------------------------------------------- | ------------------------- |
| Spanish (es)  | `A1 · CEFR-checked`                               | graded against ELELex     |
| French (fr)   | `A1 · CEFR-checked`                               | graded against FLELex     |
| German (de)   | `Beginner · frequency-ordered · no CEFR resource` | DAFlex publishes no files |
| Japanese (ja) | `Beginner · frequency-ordered · no CEFR resource` | no resource exists        |

The CEFR chips and prose on the course screens render for `es` and `fr` only. This is
possible at all because the packs are NonCommercial — see the licence split below.

### Licence split

| Artefact                                                                      | Licence                              |
| ----------------------------------------------------------------------------- | ------------------------------------ |
| **The code** — `apps/`, `packages/`, `tools/`, `targets/`, `e2e/`, `scripts/` | [AGPL-3.0-only](./LICENSE)           |
| **The content packs** — `content/` and the published course packs             | [CC BY-NC-SA 4.0](./content/LICENSE) |

A commercial fork may take the code. It may not take the packs. The reason, and the
per-artefact licence allow-list that enforces it at ingest, are in [`NOTICE`](./NOTICE) and
[`packs/README.md`](./packs/README.md). Contributions are accepted under the individual
[CLA](./CLA.md).

---

## How it is built

```
apps/mobile/       Expo SDK 57 app (iOS, Android; the web target exists only for token tests)
packages/core/     pure TypeScript engine — no React Native, headless, every rule lives here
packages/schema/   pack + progress SQLite schema, migration registry, golden DB fixtures
packages/ui/       design tokens, the 3D button atom, cards, chips, bars, mascot poses
packages/testkit/  virtual clock, IANA zone matrix, fixtures, fast-check arbitraries
tools/coursekit/   Python: G0-G9 content pipeline, V1-V12 validators, build/validate/bake/pack/sample/sign
content/<lang>/    curriculum.yaml, characters.yaml (ja) — never corpora
art/               parrot + cast sources, pose sheets, node/chest/trophy art, sound bank
targets/           WidgetKit target + Android Glance module
e2e/               Maestro flows, native snapshot baselines, a11y-tree walks, curated parity frames
```

The engine is a pure package on purpose: the app renders engine output and forwards taps;
it never computes a rule. Node tests run the same SQL through Node 24's built-in
`node:sqlite`, so CI needs no native build.

## Developing

```bash
pnpm install
pnpm test                 # vitest + fast-check
pnpm test:coverage-map    # every owned invariant id has an owning test
pnpm invariants:check     # docs/invariants.md is the unmodified corpus copy
pnpm lint && pnpm typecheck
cd tools/coursekit && uv sync && uv run pytest
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the rules that are not negotiable — chiefly
`npx expo install` (never `npm install`), no hand-edited native trees, no React Native in
`packages/core`, every constant in a named config, and every invariant test carrying its id.

## Not affiliated with Duolingo

Freelingo is an independent project. It is not affiliated with, endorsed by, or sponsored
by Duolingo, Inc. "Duolingo" is their trademark, used here only to describe what this
project re-implements.
