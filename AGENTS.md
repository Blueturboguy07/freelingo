# AGENTS.md — how to work on Freelingo

Freelingo is an open-source, **local-only** (no accounts, no server, no social), pixel-parity clone of Duolingo's paid (Super) experience with a parrot mascot. Code is AGPL-3.0; content packs are CC BY-NC-SA 4.0. Public repo: `Blueturboguy07/freelingo`. Start with **`docs/HANDOFF.md`**, which says where the build stands and what to do next.

## Where the truth lives (read before changing anything)

| What | Path |
|---|---|
| The approved build plan: rulings, architecture, phase table, the build loop | `~/.claude/plans/vectorized-coalescing-sun.md` (copy: `docs/handoff/plan.md`) |
| Locked scope and every founder decision with grounding | `~/duolingo-research/SCOPE.md`, `~/duolingo-research/DECISIONS-LOG.md` |
| Product map: 152 screens/state groups (`S001`–`S152`), copy slots, departures | `~/duolingo-research/deep/00-PRODUCT-MAP.md` |
| Invariants: 424 executable properties, the "zero faults" contract | `docs/invariants.md` (mirror of `~/duolingo-research/deep/00-INVARIANTS.md`) |
| Edge cases: 552 catalogued, each covered by an invariant or a ruling | `~/duolingo-research/deep/00-EDGE-CASES.md` |
| Specs per surface (lesson machine, ceremony, path, economy, Super, stories/radio, hub/widget/notifications, design, tooling, content pipeline) | `~/duolingo-research/deep/01…10-*.md` |
| Design tokens measured from the live app | `~/duolingo-research/scope/10-design-tokens-web.md`, `deep/08` |
| Reference screenshots (guest, 614×811 CSS px, one A/B arm) | `~/duolingo-research/screens/` |
| Content pipeline G0–G9 + validators V1–V12 | `~/duolingo-research/scope2/00-FRAMEWORK-ANSWER.md`, `deep/10`, `tools/coursekit/docs/` |
| Phase briefs P1–P8 | `docs/phases/P1.md … P8.md` |
| Phase reports and blockers | `docs/P0-REPORT.md`, `docs/P1-REPORT.md`, `docs/P2-REPORT.md`, `docs/P2-BLOCKERS.md` |
| CI: what each workflow proves | `docs/ci.md` |

## Non-negotiables

1. Local-only. SQLite is the source of truth. Network only for pack download and BYOK calls the user opts into.
2. Super parity means no ads, unlimited mistakes (`∞` hearts), free Legendary entry. Explain My Answer and Practice Hub are free-tier features also shipped. Roleplay exceeds Super. Video Call is v2. Both the recovery challenge and a monthly Streak Repair ship.
3. Every product-map state has a defined render. An undefined state is a build bug.
4. A failing invariant blocks a release. An invariant with no owning test is worse than a failing one: `pnpm test:coverage-map` must stay green for every id in `docs/invariants-owned.json`, and each phase adds its ids there.
5. Content ships only through `coursekit validate` (V1–V12 + the Freelingo validators) and a scored 300-item sample. Without a paid native reviewer the rate is labelled `PROVISIONAL (unreviewed by a paid native speaker)` verbatim; the paid review is a release prerequisite (`docs/RELEASE.md`).
6. Pixel parity is measured, not asserted: token conformance against `scope/10`, curated masked parity frames at 614 CSS px, self-baseline native snapshots. The README names the surfaces with no reference.

## The build loop (one phase at a time, `docs/phases/P<n>.md` is the brief)

1. **Plan**: read the brief, the product-map screens and invariant sections it names; write 4–10 tasks with **disjoint file lanes**, each keyed by screen ids and invariant ids. Exactly one task is the **deps task**; it runs first and alone.
2. **Implement** each task in its **own git worktree** (`git worktree add ~/freelingo-wt/<name> -b <branch> origin/main`), **test first** from the invariant's text and falsifier, then code, then commit on the branch.
3. **Verify**: `pnpm lint && pnpm typecheck && pnpm test` (and `pnpm test:coverage-map`); for device tasks, build and run the Maestro flow on the iOS simulator and the Android emulator and keep the screenshots under `e2e/artifacts/local-<sha>/`.
4. **Adversarial review**: a separate pass that tries to refute the branch against the spec and the edge-case rows: every claimed invariant has a test whose assertion fails if the guard is removed, property tests use `PROPERTY_RUNS`, no react-native import in `packages/core`, no dependency added outside the deps task, evidence files exist. Refuted → fix, once.
5. **Integrate**: merge branches into `main` one at a time with rebase-and-retest, add the phase's ids to `docs/invariants-owned.json`, push, watch CI (ci.yml, pack-ci.yml, native-e2e.yml, mutation.yml where relevant), download the e2e artefacts, and write `docs/P<n>-REPORT.md` whose first line is `GATE: GREEN` or `GATE: RED` with CI run URLs and real numbers.
6. **Stop condition**: a phase whose gate is red twice after fixes is a scope or founder decision. **Ask the user; do not start a third silent round.** Founder decisions are recorded in `~/duolingo-research/DECISIONS-LOG.md` and, for pipeline matters, `docs/P2-BLOCKERS.md`.

## Hard rules (each one cost a full run already)

- **Long commands never run in the foreground.** Installs, builds, tests over 10k-case properties, emulator boots, `coursekit build/bake`, and CI watches go to the background with a log file (`nohup <cmd> > <log> 2>&1 &`) and are polled (`sleep 90; tail -n 20 <log>`). The CI `build-es` job alone is ~24 minutes.
- **Only the phase's deps task** may change `pnpm-lock.yaml`, dependency lists in any `package.json`, `pnpm-workspace.yaml`, `tools/coursekit/pyproject.toml` or `uv.lock`. Everyone else uses what is installed and records what is missing.
- Expo packages only via `npx expo install` (INV-PLAT-01). Never hand-edit `apps/mobile/ios` or `android` (INV-PLAT-02): config plugins and local Expo Modules only. `expo-av` is dead; use `expo-audio`. e2e is Maestro (Detox is capped at RN 0.84). Keep the pnpm patch in `patches/` for `expo-modules-jsi` (it is what makes iOS build on Xcode 26.2); CI pins `/Applications/Xcode_26.2.app`.
- Every test that covers an invariant carries the id in its name: `it('[INV-SESS-01] …')`. Property tests use `PROPERTY_RUNS` (≥10,000) from `@freelingo/testkit`; `property-gates.test.ts` fails the tree if any `numRuns` is lower. `packages/core` stays free of react-native imports (purity test).
- **Honesty**: never claim a command ran or a screen rendered without the real output or the real screenshot path. CI-produced artefacts (`e2e/artifacts/<sha>/…`) are evidence; local simulator/emulator screenshots are corroboration. Every constant lives in a named config and carries the date and A/B arm it was observed under.
- **No API keys exist in this environment.** Anything that needs a hosted model or cloud TTS has a local path: the agent authors candidates and reviews into files the tools consume; TTS is Kokoro (Apache-2.0) for es/fr/ja and Piper (build-time only) for de; BYOK code paths are tested against a mock server.
- Disk: check `df -h ~` before big builds; below 15 GB free, delete `apps/mobile/ios/build`, `apps/mobile/android/build` and `~/Library/Developer/Xcode/DerivedData/Freelingo-*`.
- Commits: clear messages; keep the trailer convention `Co-Authored-By: <agent name> <email>` on every commit so authorship stays visible.

## Commands

```
pnpm install --frozen-lockfile        # node-linker=hoisted; never plain npm install
pnpm lint && pnpm typecheck && pnpm test
pnpm test:coverage-map                # every owned invariant id has a test
pnpm gate:expo-install                # INV-PLAT-01
cd tools/coursekit && uv sync --locked --group nlp --group lm --group tts --group align
uv run coursekit doctor es | build es | validate es | sample es | sign es
maestro test e2e/flows --output <dir>/report.xml --format junit --test-output-dir <dir>/maestro -e PLATFORM=ios|android
gh run list / gh run view <id> --log / gh run download <id>   # always in the background when watching
```
