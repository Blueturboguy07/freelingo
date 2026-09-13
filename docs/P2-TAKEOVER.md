GATE: RED

# P2 takeover checkpoint — 2026-09-12

The founder asked this desktop task to stop the previous Codex CLI and continue here.
PID 51836 and its launcher/helper exited after SIGTERM. Existing code, worktrees,
review material and the generated audio-manifest change were preserved.

This checkpoint supplements the frozen round-3 `P2-REPORT.md`; it does not claim that
P2 passed or that P3 began. `HANDOFF.md` describes the earlier handoff and is stale
about round-4 implementation progress.

## Source and integration state

At takeover, local `main` was `e2f25cd`, one commit ahead of `origin/main` (`65e1f81`),
and was cherry-picking `3e47e79`. The conflict in
`tools/coursekit/tests/test_g7_expand.py` was additive: retain the gloss/pro-drop tests
and the punctuation-span cloze test. Both sets are now present, without conflict
markers. The cherry-pick was completed as `4f19f1f` after verification. The sole round-5
deps/contracts task was independently reviewed and integrated as `cfe12ed`; it adds
no dependency. Additional defects in the combined G7 source are listed below. No new
round-5 pack build or CI run had started at this checkpoint.

Already on main: all three authoring lanes, the formal-address curriculum move, sample
audio references, reporter fixes, G5/G6 census repairs, and G9 review provenance code.
Pending branches remain available:

| Branch | Tip | Work |
| --- | --- | --- |
| `p2r4/g7-distractor-cloze` | `3e47e79` | Integrated as `4f19f1f`; cloze morphology and source spans |
| `p2r4/accepted-alternates` | `93b3e23` | Authored alternate contract and propagation |
| `p2r4/pair-quality` | `fa0ad07` | Rejected bilingual-pair quarantine |
| `p2r4/sample-score` | `8f45205` | Completed review of the existing local draw |

## CI evidence and the stop condition

Two completed round-4 pack attempts failed after the resumed repair work:

| Commit | Run | Result |
| --- | --- | --- |
| `d7f5ad7` | [34722210508](https://github.com/Blueturboguy07/freelingo/actions/runs/34722210508) | G0 Tatoeba fetch failed with `ConnectError: [Errno 104] Connection reset by peer`, exit 1 |
| `65e1f81` | [34724358433](https://github.com/Blueturboguy07/freelingo/actions/runs/34724358433) | All ten build stages succeeded; signing rejected PEM-formatted `PACK_SIGNING_KEY`, exit 4 |

Run [34723114813](https://github.com/Blueturboguy07/freelingo/actions/runs/34723114813)
was canceled during G1. Its later gap diagnostic failed because G3 never ran; that is
not a separate gate failure. Other canceled intermediate runs are excluded as well.

The first counted failure is infrastructure and the second is signing compatibility.
`AGENTS.md` says a phase whose gate is red twice after fixes needs a founder decision.
Its B20 exception concerns the reporter timeout, not either failure above. This
checkpoint applied that stop condition before another pack attempt. The founder
subsequently authorized continuing in this desktop task on the unchanged gate. Round 5
therefore starts a new authorized repair round; previous failed evidence stays recorded.

On `65e1f81`, [core CI](https://github.com/Blueturboguy07/freelingo/actions/runs/34724358425)
and [native CI](https://github.com/Blueturboguy07/freelingo/actions/runs/34724358434)
succeeded. The native artifacts contain one passing persistence flow per platform;
they do not cover unbuilt P3 surfaces.

The pack log establishes `es: 10 stage(s) ok`, a G8 directory size of **6,998,636
bytes** against 120,000,000, and a successful sample stage. It does not print G5 fill,
exercise, or clip counts. Signing failed before build upload, so downstream validation
was skipped and no Spanish pack artifact exists for that run. No V1–V12 or core-loader
pass is claimed from it.

Local evidence copies: `/private/tmp/p2-audit-34722210508-failed.log`,
`/private/tmp/p2-audit-34724358433.log`, and
`/private/tmp/p2-audit-34723114813.log`. Native artifacts are under
`/private/tmp/freelingo-65e-artifacts/`.

## Local pack and review — corroboration only

`build/es/g9/pack.sqlite` exists: **10,514,432 bytes**, **6,099 exercises**. The local
G8 run reports **1,229 clips / 6,605,162 audio bytes**. These are local measurements,
not replacements for the missing CI artifact. Local G6 recorded `grammar_engine:
none`; the validator report predates the successful local G7/G9 run. Its results are
stale, and the manifest still contains `review: null` and `defectRate: null`.

The review in `8f45205` contains 300 unique scores, all joining the 300 unique exercise
ids in `build/es/sample-300.jsonl` (seed `20260912`):

**PROVISIONAL (unreviewed by a paid native speaker)**

| Verdict | Count | Fraction of this draw |
| --- | ---: | ---: |
| Wrong | 51 | 17.00% |
| Awkward | 22 | 7.33% |
| OK | 227 | 75.67% |

This draw is above the 2% automated gate and precedes pending quality repairs. It must
not be reused as the review of a changed population. It also has a source-join defect:
154 rows say `corpus` and 146 say `unknown`, with missing authored source text. These
numbers describe the actual draw, not a correctly stratified estimate of the intended
corpus/authored populations. All accent scores are null; playable-file checks did not
constitute auditory review. The paid native-speaker review remains a release prerequisite.

## Reproduced adversarial findings

1. `_spanish_accepted_surfaces('Él y yo comemos.')` admits `Y yo comemos.`; `Tú y yo.`
   admits `Y yo.`. A leading pronoun alone does not establish a removable simple subject.
2. `_sentence_draft` applies derived pro-drop to listening/transcription shapes. For
   `type_what_you_hear`, `Ella come pan.` also accepts `Come pan.`. Shape-specific
   answer rules must preserve the spoken sequence where the lesson contract requires it.
3. Alignment consumes lexical display tokens, while `build_glosses` indexes raw tokens
   including punctuation. For `¿Tienes pan?` / `Have bread?` and index pairs
   `[(0,0),(1,1)]`, it produces `{'¿': 'have', 'tener': 'bread'}`.
4. Authored resolved slots have `sid=None`; their sentence exercises therefore lose the
   candidate source identity required by sampling. Also reconcile `shipped_items()`'s
   last accepted G5 candidate with G7's first surviving candidate.
5. New distractor tests exercise the helper but do not fail if the actual sentence or
   grammar builder stops passing `allow_wrong_forms=False`. Add caller-level falsifiers.

## Verification during takeover

- `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage-map`: exit 0;
  **115 test files passed, 1 skipped; 1,317 tests passed, 6 skipped**.
- Focused G7/distractor Python tests: **118 passed, 1 skipped**, exit 0.
- `git diff --check`: passed.
- Full Python suite: interrupted after **531.64 seconds**, with two tests passed,
  while the optional live SimAlign measurement was waiting in an SSL read. This is
  incomplete verification, not a pass.
- Remaining Python checks with only that live measurement deselected: **989 passed,
  8 skipped, 1 deselected in 41.39 seconds**, exit 0.

Logs are `/private/tmp/freelingo-takeover-checks.log`,
`/private/tmp/freelingo-takeover-g7.log`,
`/private/tmp/freelingo-takeover-coursekit.log`, and
`/private/tmp/freelingo-takeover-coursekit-unit.log`, with adjacent `.exit` files.
Passing existing tests does not refute the adversarial findings above.

## Round-5 repair plan — authorized in the desktop task

Keep the 2% gate, the 20-candidate floor, all invariants, and the paid-review release
prerequisite. Six tasks, each in its own worktree; the sole deps task runs first and
alone. No new dependency is currently justified. Screens below identify the behavior
supported by the pack, not completed UI coverage.

| Task | Exclusive lane | Deliverable / owning requirements |
| --- | --- | --- |
| 1. Deps/contracts | `artifacts.py`, contract docs/tests, shared fixtures and `conftest.py`; dependency manifests only if needed | Freeze preferred/alternate answers and source identity; INV-GRD-03, INV-PACK-08/40/41; S001, S035–S041 |
| 2. Upstream validation | G4/G5/G6 modules/tests, back-translation and pair-quality modules, `config/g6.py`, rejected-pair data | Independently validate alternates, quarantine reviewed pairs, discard/resample failures; INV-PACK-06/08/10/14; S035–S039 |
| 3. G7 quality | G7 stage, distractors, `config/g7.py`, corresponding tests | Repair token indices, subject proof, shape rules, candidate identity and caller-level cloze guards; INV-GRD-03, INV-PACK-07/08/41/50/51; S033–S041 |
| 4. Signing / CI | Signing modules/tests, pack workflow, signature/real-pack-loader tests, `docs/ci.md` | Reproduce PEM mismatch with throwaway keys, preserve trusted-key custody, prove signed artifact/loader; INV-PACK-18; S001 |
| 5. Sampling / manifest | Sample module/command/config/tests, G9 package/database/manifest, `validators/pack.py`, review freshness and loader fixtures | Resolve exact sources, validate population/score identity, publish real provenance; B3, INV-PACK-14; S001 |
| 6. Independent review / integration | Review data/method/history, provenance/report/blocker/handoff docs, ownership evidence | Score a new immutable 300-item draw, publish its measured result, integrate sequentially with real CI evidence; P2 gate |

Split `93b3e23` across tasks 1–3 instead of merging its cross-lane changes concurrently.
Split `8f45205` between task 5's sample tests and task 6's historical review material;
preserve its old scores without treating them as the new draw. Task 2 precedes final
G7 integration. Task 5 alone owns `config/sample.py`; signing-constant requests from
task 4 go through that lane. Task 6 scores only once the integrated population is frozen.

Each code task writes falsifier tests first, has an independent adversarial pass, and
runs long checks in logged background processes. Integration rebases/retests one branch
at a time. P3 starts only after P2 has the required green evidence, or after an explicit
founder change to the gate; this repair round makes no such gate change.

## Round-5 work in progress

The founder requested an overall status: P0 and P1 are green, P2 remains red, and
P3–P8 have not started. `apps/mobile/App.tsx` still renders the database smoke test;
there is no usable lesson player, onboarding or learning path yet. Existing tokens and
mascot art are groundwork, not evidence that those screens render.

The sole deps task ran first and alone. Its integration checks passed lint, typecheck,
1,317 JavaScript tests (6 skipped), the invariant coverage map, and 1,016 Python tests
(8 skipped, the optional live SimAlign measurement deselected after its earlier network
stall). Logs: `/private/tmp/p2r5-deps-integration2.log` and
`/private/tmp/p2r5-deps-python.log`. A sandbox-only Python attempt could not bind its
localhost mock server; the rerun with localhost access passed.

Four code lanes then proceeded independently:

- `codex/p2r5-upstream`: alternate validation, exact bilingual rubric evidence and
  reviewed-pair quarantine. A read-only census of cached inputs found four new gaps
  (496→500), plus three existing slots whose split ledgers changed despite an unchanged
  unit-level union. The seven affected slots require 140 new candidates at the unchanged
  floor of 20; previous raw rows remain available to fail the stale-ledger guard.
- `codex/p2r5-g7`: exact source joins, lexical alignment indices, translation answer
  sets and safe cloze construction. Arbitrary nouns in an unconstrained blank can both
  be valid; such items need the supported translation scaffold or proven grammar.
- `codex/p2r5-signing`: strict Ed25519 PKCS8 compatibility and CI ordering that keeps
  candidate artifacts before gates, then validates/repackages/signs/loads a complete pack.
- `codex/p2r5-sample`: exact chosen sources, complete 300-item review, content/clip
  fingerprints, fresh validator reports and the corrected miniature loader fixture.
  Repair commit `89e8238` passed 1,046 Python tests (8 skipped; the optional live
  SimAlign measurement deselected), plus lint, typecheck, 1,317 JavaScript tests
  (6 skipped) and invariant ownership checks. A previous Python run passed assertions
  but aborted during native-library teardown; the unchanged retry exited 0.
  Logs: `/private/tmp/p2r5-sample-final-python2.log` and
  `/private/tmp/p2r5-sample-checks2.log`.

`codex/p2r5-integration` owns this checkpoint, historical review preservation and the
new review/report evidence. The old draw and its recorded scores are archived under
`content/es/review/history/p2-round4/`; they are not current scores. The new seed is
20260913, chosen before scoring. There is no new measured rate yet.

Local tests and branch reviews do not make the P2 gate green. Integration, the rebuilt
population, a fresh scored draw and actual CI artifacts are still required.

## Round-5 integration checkpoint

The sample branch integrated at `89e8238` and passed the required checks on main.
The upstream branch rebased to `64f9254` + `6ffff7f`; its integrated Python suite
passed 1,077 tests (8 skipped, one optional live SimAlign measurement deselected).
G7 rebased to `3eb51cf` + `812d3c2`; its integrated suite passed 1,150 Python tests
with the same exclusions. Each integration also passed lint, typecheck, the
JavaScript suite and the invariant coverage map. Evidence logs are
`/private/tmp/p2r5-integrate-sample.log`,
`/private/tmp/p2r5-integrate-upstream.log`, and
`/private/tmp/p2r5-integrate-g7.log`, each with exit 0.

The signing branch rebased to `95b50c2` and is integrated; its post-integration
checks are running. No fresh round-5 pack or CI artifact is claimed here.

A separate real LanguageTool 6.6 diagnostic checked 108 candidates / 114 answer
surfaces from the seven affected slots with G6's actual blocking rules: zero rejects,
all seven slots retain their leading candidate. This is bounded corroboration;
the full integrated G6 run and validator V8 still have to pass. Evidence:
`/private/tmp/p2r5-seven-slot-languagetool.json`.

The previous generated G4-G9 tail, sample and runlog were preserved under
`/private/tmp/p2r5-prior-build-tail/` before regeneration. The pre-existing dirty audio
manifest is separately backed up at `/private/tmp/p2r5-before-build-audio-manifest.json`
(SHA256 `6a8defdb42c69bfec1fc3104fa95a2e99cf73b491ed7decfd772bcccec3fea64`).
