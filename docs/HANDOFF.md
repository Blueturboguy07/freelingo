# Handoff — 2026-09-12

The build was run by Claude (Fable 5.1) as an orchestrated workflow from 2026-09-11 to 2026-09-12 and stopped at a safe point so that Codex can continue it with the same method. Everything is committed and pushed. Read `AGENTS.md` first; this file says exactly where things stand and what to do next.

## Where the build stands

| Phase | State | Evidence |
|---|---|---|
| P0 Foundation | **GREEN** | `docs/P0-REPORT.md`. Monorepo, CI on the public repo, testkit, six invariants at 10k+ cases, pack-signing key custody, persistence gate proven on the Android emulator and the iOS simulator (Maestro flow `e2e/flows/p0-db-path.yaml`; iOS needed the pnpm patch for `expo-modules-jsi` and the CI pin to Xcode 26.2). |
| P1 Engine | **GREEN** | `docs/P1-REPORT.md`. `packages/core` complete for §1–§10, §13, §14 engine parts and SEC-01/02; 1,258 tests, 230 fast-check properties; 13 ids deferred to P3–P5 by design (listed in `docs/owned/journey.json`). Mutation job produces no score yet (non-gating, see B7). |
| P2 Spanish pack | **RED after three rounds; round 4 in flight** | `docs/P2-REPORT.md` (and `P2-REPORT-round1/2.md`), `docs/P2-BLOCKERS.md`. The pipeline exists end to end but **no Spanish pack has ever been produced on `main`** because G5 fails on 22 empty candidate slots (B19). Round 4's six branches are pushed (below). |
| P3–P8 | not started | briefs in `docs/phases/P3.md … P8.md` |

## The six round-4 branches (pushed to origin; worktrees under `~/freelingo-wt/`)

| Branch | Purpose | State when stopped |
|---|---|---|
| `p2r4/author-u01-u06` | author the 7 empty slots in units 1–6 (140 candidate rows), settle `usted` in u1/l3/s3 | started, no commits beyond main |
| `p2r4/author-u07-u23` | author the 6 empty slots in units 7–23 (120 rows) and fix the B3 defect patterns in those files | started, no commits beyond main |
| `p2r4/author-u24-u30` | author the 9 empty slots in units 24–30 (180 rows) | started, no commits beyond main |
| `p2r4/pipeline-g6-to-g9` | take the completed candidate bank through G6–G9, produce the first real pack, prove the NOT PROVEN gate items | **2 commits ahead incl. a WIP snapshot** — read `git log origin/main..p2r4/pipeline-g6-to-g9` and the diff before continuing |
| `p2r4/sample-accent-rate` | B18: give `SampleItem` a clip ref and voice role so accent consistency is scoreable; redraw and score the 300-item sample once a pack exists | **1 WIP snapshot commit** — read it first |
| `p2r4/ci-reporter-timeout` | B20: the `vitest-worker Timeout calling onTaskUpdate` reporter flake on slow runners | started, no commits beyond main |

Each task's full brief, lane and invariant ids are in `docs/phases/P2.md` ("Round-4 tasks"). The planner's raw output for every round is in `docs/handoff/claude-run-journal-extract.json`.

## Open blockers and the rulings that resolve them

Founder rulings so far are in `~/duolingo-research/DECISIONS-LOG.md` (2026-09-12 sections) and `docs/P2-BLOCKERS.md` ("Founder rulings"). Two more were made at handoff:

- **B19 — 22 empty slots, and `u1/l3/s3` reserves `usted` in a course whose register is `tú`.** Ruling: `usted` (and its conjugation forms) is a **curriculum defect in unit 1**; move it to the formal/informal-address unit (u23, `formal_informal_address`), regenerate the gap brief, and add a G3 validator: **no slot may reserve a lemma whose register is outside its unit's declared register**. The remaining slots are authoring work against the regenerated brief (`content/es/authoring/gap-brief.jsonl`, 20 candidates per slot, never below the over-generation floor).
- **B3 — the agent-scored sample measures 4.00 % wrong (12/300) against the 2 % gate; three repeated patterns account for six.** Ruling: fix the three patterns at their source (generator rule or candidate file), redraw the sample with a new seed (`SAMPLE_SEED` is a named constant), re-score, and **publish whatever the provisional rate is** with the PROVISIONAL string. The automated gate accepts an agent-scored rate ≤ 2 %; the paid native review remains a release prerequisite.
- **B20 (infra)**: the reporter timeout is runner speed, not the suite; the fix lane is `p2r4/ci-reporter-timeout`. Until fixed, a red `ci.yml` with all tests passing is re-run once before it counts.
- **B7 (non-gating)**: Stryker `coverageAnalysis: off` and tighter INV-DAT generators, P3 chore.

## What to do next, in order

1. `git fetch origin && git checkout main && git pull`. Rebuild the worktrees if `~/freelingo-wt/` is gone: `git worktree add ~/freelingo-wt/<name> <branch>` for each round-4 branch.
2. Land **`p2r4/ci-reporter-timeout`** first (small, unblocks trustworthy CI), then the code half of **`p2r4/sample-accent-rate`**.
3. Apply the B19 ruling (curriculum move + G3 validator + regenerated brief), then the three authoring branches against the regenerated brief. Keep `MIN_CANDIDATES_PER_SLOT = 20`; do not lower it.
4. **`p2r4/pipeline-g6-to-g9`**: run `uv run coursekit build es` end to end **in the background** (~25 min), fix what breaks in G6–G9, get `coursekit validate es` to exit 0 with V8 naming a real engine (LanguageTool sidecar is already in `build-es`), bake with Kokoro, package, sign, and make `pack-ci.yml` attach the first `es-pack-<sha>` artefact. Prove: V1–V4 100 %, V5–V12/F1–F5, audio bank ≤ 120 MB, zero UNRESOLVED licences, `packages/core` loads the CI-built pack.
5. Score the redrawn sample (B3 ruling), write the provisional rate into the manifest and `docs/pack-provenance.md`.
6. Write `docs/P2-REPORT.md` with `GATE: GREEN` as its first line and the CI run URLs, then continue with `docs/phases/P3.md`. Between phases nothing is needed from the founder unless a gate is red twice.

## Things that need the founder, not an agent

- A paid native Spanish reviewer for the 300-item sample (~$300–800) before any release.
- App Store Connect credentials for TestFlight (P8 leaves it a documented manual step).
- Azure or Polly credentials if vendor-backed locale claims are ever wanted (Kokoro is accepted for now).

## Environment caveats on this Mac (checked 2026-09-12 15:40 CDT)

- **The Android SDK is gone.** A different Claude session's disk cleanup at 2026-09-12 04:30 UTC removed `~/Library/Android`, `~/.gradle` and `~/.android`: the SDK, Gradle's home and every AVD. The headless `Pixel_3a_API_34` emulator (`emulator-5554`, pid 32883) is still running only because the process holds the deleted binaries open. **Do not kill it**; it can still take `adb install` of a CI-built APK and run Maestro until it dies. `npx expo run:android` cannot work locally until the SDK is reinstalled: `brew install --cask android-commandlinetools`, export `ANDROID_HOME=$HOME/Library/Android/sdk`, then `sdkmanager --sdk_root="$ANDROID_HOME" "platform-tools" "emulator" "system-images;android-34;google_apis;arm64-v8a"` plus whatever platform and build-tools versions the first `npx expo run:android` error names, then `avdmanager create avd -n Pixel_3a_API_34 -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_3a`. Android Studio 2023.3 is still in `/Applications` as an alternative installer. The **Android gate is CI** (`native-e2e.yml`, ubuntu + `reactivecircus/android-emulator-runner`), which is unaffected; local Android runs were always corroboration only.
- iOS is intact: the `iPhone 17 Pro Test` simulator (`D17B7885-ACFB-4B21-B938-65D2205F8DEF`) is booted; build with `EXPO_PUBLIC_FREELINGO_E2E=1 npx expo run:ios --device <UDID>` so the diagnostics screen the Maestro flows rely on is compiled in.
- Disk: 61 GB free (86 % used). Keep the `df -h ~` rule from `AGENTS.md`.
- The same cleanup removed `~/Library/Application Support/Codex`, so `codex doctor` warns that thread rows point at missing rollout files. Auth (ChatGPT login) and the CLI itself are fine.

## Resume mechanics (if the Claude workflow is ever resumed instead)

Script: `~/duolingo-research/build/p1-p8.workflow.js`; run id `wf_ba7e09ae-ab2`. `Workflow({scriptPath, resumeFromRunId: 'wf_ba7e09ae-ab2', args: {repo: '~/freelingo', date: '2026-09-11'}})` replays cached agents. The harness kills any agent silent for 180 s, which is why every long command must run in the background.

## How to launch Codex so it works the way the Claude run did

The Claude workflow ran its agents with full disk and network access and no per-command approvals; that is what let it create worktrees under `~/freelingo-wt/`, drive the simulator, call `gh`, and watch CI. The equivalent Codex invocation, from the repo root so `AGENTS.md` is picked up:

```
cd ~/freelingo && ~/.npm-global/bin/codex --sandbox danger-full-access --ask-for-approval never --search "$(sed -n '/^> /p' docs/HANDOFF.md | sed 's/^> //')"
```

`--sandbox danger-full-access` is required because the build writes outside the repo (`~/freelingo-wt`, DerivedData, `~/.maestro`) and needs the network for `gh`, `uv sync`, `pnpm install` and pack downloads. `--ask-for-approval never` matches "no stops between phases"; the stop condition (red twice) is enforced by the prompt, not by approvals. `--search` gives it web search, which the Claude agents also had. Add `-m <model>` to choose the model. For a fully unattended run that logs to a file, use `codex exec` with the same flags under `nohup … > ~/freelingo-codex.log 2>&1 &`.

## Kickoff prompt for Codex

> Read `AGENTS.md` and `docs/HANDOFF.md`, then `docs/P2-BLOCKERS.md` and `docs/phases/P2.md`. Continue P2 round 4 from the six pushed branches in the order the handoff gives, following the build loop in `AGENTS.md` (test first, adversarial self-review, integrate with CI evidence, `GATE:` line in the report). Run every long command in the background and poll. When P2 is green, continue with `docs/phases/P3.md` through `P8.md` without stopping, unless a gate is red twice, in which case ask me.
