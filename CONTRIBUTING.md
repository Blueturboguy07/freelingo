# Contributing to Freelingo

Freelingo is an open-source, **local-only** language learning app: no accounts, no server,
no social graph, no paywall. SQLite on the device is the source of truth. The network is
touched for exactly two things: downloading a content pack, and a BYOK model call the user
opted into.

Before your first pull request, read [`CLA.md`](./CLA.md) — a bot will ask you to accept it
— and [`NOTICE`](./NOTICE), which explains why the code is AGPL-3.0-only and the content
packs are CC BY-NC-SA 4.0.

## Getting set up

```bash
# Node 24+, pnpm 11+, uv, gitleaks
pnpm install                     # node-linker=hoisted; Expo needs a flat tree
pnpm test                        # vitest + fast-check, all packages
pnpm test:coverage-map           # every owned invariant id has an owning test
pnpm lint && pnpm typecheck

cd tools/coursekit && uv sync && uv run pytest
```

To run the app you need a dev client, not Expo Go (Skia, SQLite and the widget targets are
native):

```bash
cd apps/mobile
pnpm expo prebuild --clean       # regenerates ios/ and android/; never commit them
pnpm expo run:ios                # or run:android
```

## The rules that are not negotiable

1. **`npx expo install`, never `npm install` or `pnpm add`, for anything Expo or React
   Native.** The SDK pins the Reanimated/worklets pair; a hand-picked version breaks the
   build in a way that looks like something else. CI gate: `INV-PLAT-01`.
2. **Never hand-edit `apps/mobile/ios/` or `apps/mobile/android/`.** They are generated and
   git-ignored; `expo prebuild --clean` wipes them. Native changes go in a config plugin.
   CI gate: `INV-PLAT-02`.
3. **`packages/core` imports no React, no React Native and no Expo.** It is a pure headless
   engine; the app renders its output and forwards taps, and never computes a rule.
   Enforced twice: an eslint rule and `packages/core/src/purity.test.ts`.
4. **Every constant lives in a named config.** No magic number, colour, duration, price or
   path literal anywhere else.
5. **Every test that covers an invariant carries its id in the test name**, in brackets:

   ```ts
   it('[INV-DAY-01] streak is the maximal contiguous run of distinct days ...', () => {});
   ```

   `pnpm test:coverage-map` reads `docs/invariants.md` and fails when an id listed in
   `docs/invariants-owned.json` has no owning test — and when a test claims an id that does
   not exist. An invariant with no owning test is worse than a failing one.

6. **No secrets in the tree.** gitleaks runs in CI and in the pre-commit hook.
7. **Artefacts come from CI.** Screenshots and native snapshots are produced by the
   workflow and uploaded as `e2e/artifacts/<sha>/<test-id>.png`. An agent or a contributor
   never writes to `e2e/artifacts/`; a screenshot without a CI URL does not count.

## Writing a change

Start from the invariant, not the code. Find the id in `docs/invariants.md`, write the
failing test with the id in its name (a committed falsifier input, where the invariant has
one), then make it pass. If you changed the schema, add a golden-DB fixture for the
migration.

A change is done when:

- the invariant ids it claims are green,
- `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:coverage-map` are green,
- the reference frames still match, if you touched a rendered surface,
- and the commit message says what invariant or screen id it moves.

## Content

Course content never lands by hand. It goes through `tools/coursekit`
(`build → validate → bake → pack → sample → sign`) and a paid native-speaker sample with a
≤2% wrong-item gate; the measured rate is shown to the learner in the app. See
[`packs/README.md`](./packs/README.md).

## Reporting a bug

Say which screen id or invariant id it is about, what you expected, what happened, and the
device/OS. "Every product-map state has a defined render — an undefined state is a build
bug" is a rule, so a screenshot of a state with no defined render is always a valid report.
