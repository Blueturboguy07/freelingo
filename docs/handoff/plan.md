# Freelingo — build plan (v1)

For approval. Written 2026-09-11 from the research corpus at `~/duolingo-research/`, then adversarially reviewed against it (26 findings, all folded in). Every rule points at a spec file; every test points at an invariant id.

## Context

Freelingo is an open-source, **local-only** (no accounts, no server, no social), pixel-parity clone of Duolingo's paid experience, parrot mascot, Duolingo's green kept, one non-negotiable: people actually learn. Locked scope: `~/duolingo-research/SCOPE.md`; every founder answer with grounding: `DECISIONS-LOG.md`.

| Artefact | Path |
|---|---|
| Product map: 151 screens/state groups, every state and copy slot, 9 deliberate departures | `deep/00-PRODUCT-MAP.md` |
| Invariants: 181 executable properties, growing to ~300 after the merge pass | `deep/00-INVARIANTS.md` |
| Edge cases: 283 catalogued, 388 hunted cases still to merge (drafted, waiting on write access) | `deep/00-EDGE-CASES.md`, `deep/hunted-cases.json`, `~/.claude/plans/vectorized-coalescing-sun-agent-a5710186927061545.md` |
| Ten specs with adversarial reviews appended | `deep/01…10-*.md` |
| Content framework G0–G9 + validators V1–V12 | `scope2/00-FRAMEWORK-ANSWER.md`, `deep/10` |
| Reference: 236 guest screenshots + measured tokens (614×811 CSS px viewport, DPR 2) | `screens/`, `scope/08`, `scope/09`, `scope/10` |

Three runs: scope (done), deep map (done), **build (this plan → run three)**.

## What "Super parity" means here (corrected)

Explain My Answer (free since 2026-01-01) and the Practice Hub (free since 2026-04-28) are **free-tier** features; shipping them is not "exceeding Super". The real Super deltas are **no ads, unlimited mistakes (hearts render `∞`), and free Legendary entry**. **Roleplay is the one place Freelingo exceeds Super** (it is Max-only). Video Call is v2. **Both** streak mechanics ship: the 2026 recovery challenge (S145–S146) and a monthly Streak Repair (one per calendar month, a dated config constant, idempotent on the month key), per your decision to keep the scope line. The README honesty block says exactly this.

## Non-negotiables

1. Local-only. SQLite is the source of truth. Network only for pack download and BYOK calls the user opts into.
2. Super parity as defined above; no paywall, no gem-gated learning.
3. Every product-map state has a defined render. An undefined state is a build bug.
4. A failing invariant blocks the release; an invariant with no owning test is worse than a failing one. Every invariant id maps to a phase (coverage table below) and `pnpm test:coverage-map` fails CI if any id has no test.
5. Content ships only through `coursekit validate` and a paid native-speaker sample with a ≤2% wrong-item gate; the measured rate is shown to the learner.
6. **Code AGPL + CLA; content packs CC BY-NC-SA.** Public repo `Blueturboguy07/freelingo` (free macOS CI depends on it). The split exists so the packs can embed CEFRLex-derived grading (CC BY-NC-SA) while the app stays open source; a commercial fork may take the code but not the packs. The licence allow-list is **per artefact**: NC data is allowed into packs and forbidden in code.

## Rulings (approve or override; each is one line to change)

### Spec-vs-spec contradictions (the 11 `X` rows in the catalogue)

| Case | Ruling | Invariant |
|---|---|---|
| EC-FRZ-01 freeze walk | Consume a freeze for a missed day iff it was owned before that day began | FRZ-01 |
| EC-ECO-02 boost timing | Multiplier read at **session start** and recorded on the row, **but expires with the boost**: if `commit_time > boost_expiry + boostGraceSeconds` the session commits at 1× and S067 shows a one-line explanation; grace is a named constant | ECO-02 |
| EC-ECO-01 goal tiers | 10/20/30/50 XP for Casual/Regular/Serious/Intense, one named table | ECO-01 |
| EC-FRZ-08 repair vs recovery | **Both.** Recovery challenge (3 lessons, 2-day window, partial progress persisted) **and** a monthly Streak Repair modal (deep/04 §9) with `streakRepairsPerMonth = 1`. INV-REC-01's "the string Streak Repair appears nowhere" grep gate is deleted and replaced by: repair is idempotent on `(year, month)`, never stacks with a freeze on the same day, and restores `streak = previous_streak` with today unsatisfied | REC-01..03 (amended) |
| EC-WID-01 widget data | Snapshot only, never SQLite | WID-01 |
| EC-STK-02 travel vs tamper | A `local_day` regression is honoured iff UTC is monotonic **and** the zone changed | DAY-02 |
| EC-PTH-21 unit boundary | Node unlock is linear within a unit **and unit n+1 unlocks only when the last node of unit n is complete**; no early unlock on the first level; property over generated paths | PATH-01 |
| EC-COM-09 sound classes | Never two cues of the same class; shimmer at −6 dB on a second bus | SND-01 |
| EC-STK-14 rollover deferral | `maxRolloverDeferralSeconds = 300` in the economy config; a killed session can never starve rollover | DAY-09 |
| EC-MOD-03 suspension | Toggling a modality ON clears a running suspension; OFF never starts one | MOD-03 |
| EC-PER-08 imported gaps | Imported gap days count as **missed**, never `unlived`; the confirm dialog states the freeze cost before it is paid | DAT-04 |

### Founder rulings (catalogue §V)

| Case | Ruling |
|---|---|
| EC-GRD-03 dropped token | Soft-correct `You missed a word.` when exactly one function-class token is missing; else hard wrong |
| EC-STK-19 freeze vs Perfect Streak | A frozen day resets the weekly Perfect Streak; the main streak survives |
| EC-ECO-13 gem sinks | Gems buy **cosmetics and Streak Freezes** (S121 `purchasable` stays; the 2026 freeze price is a dated config constant, not the 2023 200-gem figure) |
| EC-CER-14 ceremony dwell | After 5 consecutive goal-met days, collapse S078+S080 into a row on S067 **only when the bundle is gems-only**; any freeze, boost, or tier grant keeps its full screen. The collapsed S067 state gets a copy slot in the map before P4 |
| EC-PACK-17 accents | One locale per course (es-ES, fr-FR, de-DE, ja-JP); cast breadth from Azure Neural within the locale, Polly backup |
| EC-PACK-18 ja "young" voice | SSML prosody is the only lever; accepted |
| EC-PLAT-09 Rive terms | No `.riv` in the repo until editor terms are cleared; code poses in v1 |
| EC-PLAT-06 public repo | Yes |
| S043 `Put the events in order` | **Out of v1** (no grading contract, no taxonomy home) |
| CEFR claim (Q8 revisited) | **Resolved by the licence split.** Spanish and French packs use ELELex/FLELex at G2 and ship as CC BY-NC-SA; their cards read `A1 · CEFR-checked`. German (DAFlex publishes no files) and Japanese (no resource) read `Beginner · frequency-ordered · no CEFR resource`. S023/S024 CEFR chips and prose render only for es/fr |

### Corrections to existing invariants (in place, at P0)

INV-DAY-03: `unlived` only for a date jumped over by a zone change, never a powered-off phone. INV-MOD-01: fail open and expire the suspension on a detected monotonic reset (reboot). INV-SEC-01: sanitise every user-text field (typed answers, tier-3 diff, report note). EC-GRD-16: add alternate-okurigana headwords to the ja accepted set.

### Content-pipeline corrections adopted from `deep/10`

NLLB v1 (ODC-By) replaces the "Tatoeba-only" posture for selection and validation; the Tatoeba CC0 route is dead for es/de/ja (hundreds of sentences); JParaCrawl forbidden; LanguageTool ja = 735 grammar rules, no spell check; Piper's only ja voice is NC so Kokoro is the open ja fallback; hermitdave frequency data is CC BY-SA-4.0 and the derived ordering is declared share-alike in the manifest; **CEFRLex is used at G2 for es/fr only, and only because the packs are NC**; section CEFR labels remain a G3 output checked against the lexicon.

## Architecture

### Repository (monorepo, pnpm + uv)

```
freelingo/
  apps/mobile/         Expo SDK 57 app (iOS, Android; web target only for token tests)
  packages/core/       PURE TypeScript engine, no React Native imports, headless
  packages/schema/     pack SQLite schema, progress schema, migration registry, golden DB fixtures
  packages/ui/         tokens (scope/10 + deep/08), 3D button atom, cards, chips, bars, mascot poses
  packages/testkit/    virtual clock, IANA zone matrix (+9, −7/−8, +14, Lord Howe), two-course fixture, arbitraries
  tools/coursekit/     Python: G0–G9, V1–V12 + Freelingo validators, characters stage, `build/validate/bake/pack/sample/sign`
  content/<lang>/      curriculum.yaml (original grammar inventory + unit titles), characters.yaml (ja), never corpora
  art/                 parrot + cast sources (SVG), pose sheets, node/chest/trophy/story-cover art, sound bank
  targets/             WidgetKit target (@bacons/apple-targets) + android Glance module
  e2e/                 Maestro flows, native snapshot baselines, a11y-tree walks, curated parity frames
  .github/workflows/   unit+property+mutation (Linux), native e2e (macOS), pack CI, release
```

The engine-as-pure-package pattern is the one that held up in Iris (`packages/iris-core`): the app renders engine output and forwards taps; it never computes a rule.

### Stack (verified 2026-09-11, `deep/09`)

| Concern | Choice | Trap |
|---|---|---|
| Runtime | Expo SDK 57 / RN 0.86 / React 19.2, New Architecture only | `npx expo install` always (Reanimated 4.5 + worklets 0.10 pin); CI gate INV-PLAT-01 |
| DB | `expo-sqlite`, WAL, `PRAGMA user_version` migrations in `withExclusiveTransactionAsync`; progress in `Paths.document`; packs in `Paths.cache` + a config plugin writing `NSURLIsExcludedFromBackupKey` / `dataExtractionRules` | No first-party backup-exclusion API; verify with a real backup manifest on device (INV-PACK-11) |
| Animation | Reanimated 4.5 + Skia 2.11; mascot poses behind `MascotRenderer` | |
| Audio | `expo-audio`; `Audio.preload` per lesson, `clearPreloadedSource` on exit; per-surface audio mode; Radio = `useAudioPlaylist` + `setActiveForLockScreen` (`doNotMix`) | 3-minute background ceiling otherwise |
| TTS fallback | `expo-speech` Default/Enhanced | Baked bank first (INV-AUD-01) |
| ASR | `expo-speech-recognition@57`, on-device where available, `continuous: true`, feature-detect via `getSupportedLocales()` | Speak never costs a heart |
| LLM | `Explainer` interface; evaluate `expo-local-llm` 0.6 (Apple FM iOS 26+; Gemini Nano API 26+, <4k-token input, not on unlocked bootloaders) and `@react-native-ai/apple`; BYOK via `fetch` with `Authorization`, `anthropic-version`, `content-type`, optional `anthropic-workspace-id`; excluded from web | All wrappers are pre-1.0; ML Kit GenAI Additional ToS must be read against AGPL |
| Widgets | `@bacons/apple-targets` 5.0 (App Group + `ExtensionStorage`), Glance 1.2 (minSdk 23, Glance composables only) | Build numbers must match across targets; WidgetKit budget is 40–70 refreshes/day, a timeline entry is not a refresh |
| Fonts | Nunito (SIL OFL) bundled; `label-button` 15/700/0.8px | |
| Tests | Vitest + fast-check (P/U), Stryker mutation nightly, Maestro (E, S, a11y walks), `coursekit validate` (C), manual D checklist | Detox is capped at RN 0.84; Playwright only for token-conformance on the web target |
| CI/build | GitHub Actions (public repo ⇒ free macOS minutes, but plan wall-clock, not minutes); `eas build --local` daily; EAS **Starter ($19)** for release candidates because Free's 45-minute timeout will kill a Skia+Rive+widget iOS build and burn one of 15 monthly builds | |

### Data model

- **`account` region**: streak, freezes, Perfect Streak, Society tier, gems, boost inventory, cosmetics, daily goal, quests, badges, achievements, personal records, `lifetime_xp`, modality suspension, notification history.
- **`course_progress[course]`**: course XP, Score + `score_floor`, path/node/unit/section state, legendary flags, mistake queue, FSRS rows (content-hashed item ids), `session_state` (≤1 per course, nine resume fields).
- **Attempts are append-only events** keyed `(session_id, exercise_index)`; every counter is recomputable from them.
- **Content pack** = read-only SQLite (`lexeme`, `grammar_concept`, `sentence`+provenance+licence+attribution owner, `exercise`, `exercise_item_tag`, `unit`, `unit_item`, `story`, `radio_episode`, `character_lesson`, `audio`, `meta`) + content-addressed Opus audio + **signed manifest** (validator report, defect rate, licences). Pack state is a **six-value** enum: `{not-downloaded, partial, installed, corrupt, unverified, withdrawn}`; an invalid signature is `unverified`, never `corrupt`.
- **Per-sentence credits** (S152, new): Tatoeba is attribution-only and its CC0 subset is empty for es/de/ja, so every attribution-required sentence must be reachable from a rendered surface (report sheet S045 and About S137). New invariant INV-PACK-17.
- **Signing**: ed25519 key generated at P0, private key in CI secrets, public key in the app; INV-PACK-18 verifies before install. Hosting: GitHub Releases per pack version (2 GB/asset cap is fine; bandwidth is best-effort), with Cloudflare R2 as the fallback if egress becomes a problem.
- **Export/import**: progress dump + checksummed manifest, never audio; import is replace-only with a 24 h undo; reachable from onboarding (S003).

### Engine (`packages/core`) and invariant coverage

| Module | Owns | Invariant sections | Phase |
|---|---|---|---|
| `day/` | civil-date streak from a set, zone rule, `unlived`, grace, bounded rollover, freeze walk, recovery | §6 DAY, §7 FRZ/REC | P0 (DAY-01, DAY-05), rest P1 |
| `ceremony/` | ordered predicate queue with scope, single exclusive commit, bundle screen | §9 CER, PER-04 | P0 (CER-01), rest P1 |
| `session/` | queue generation, state machine, nine-field resume, one-in-flight, quit rules, ten flavours | §1 SESS, §3 COM, §4 MIS | P1 |
| `grading/` | three tiers, six soft notes, three named typo guards, alternates, multi-gap, accuracy denominator | §2 GRD | P1 |
| `scheduler/` | FSRS + early-review guard, clamped elapsed, idempotent attempts, review pools | §5 SCH | P1 |
| `economy/` | one config table (tiers, XP per flavour, boosts + grace, quest scaling, freeze price, cosmetics, `maxRolloverDeferralSeconds`), flavour matrix, per-mode ladders, two XP counters | §8 ECO | P1 |
| `path/` | node state as a pure function, unit boundary rule, tests, Score floor, Daily Refresh | §10 PATH | P1 |
| `packs/`, `migrations/` | six-state enum, partial vs corrupt, signature, quarantine on major bump, audio resolution, golden-DB migration corpus | §13 PER/DAT, §14 PACK/AUD | P1 (harness), P2 (pack gates) |
| `hub/` | modes, bounded mistake queue, `Switch session` list | §16 HUB | P4 |
| `notifications/` | calendar reminder, absolute-instant nudge, template scoring | §18 NOT | P4 |
| `course/` | removal scope, 24 h post-import lock | §21 CRS | P4 |
| `security/` | sanitiser, no interpolated SQL, BYOK header set | §19 SEC | P1 (SEC-01/02), P5 (SEC-03) |
| `modality/` | suspension record, gate states, in-place conversion | §11 MOD | P3 |
| UI-side | a11y contracts, typography matrix, LTR pin, sound classes | §11 A11Y/TYP/I18N, §12 SND | P3 |
| `stories/`, `radio/` | part model, denominators, anchors | §15 STO | P6 |
| `widget/` | total state machine, snapshot writer, draw-time remaining | §17 WID | P5 |
| build | expo install gate, no hand-edited native, Maestro green, per-surface audio mode, widget builds, permissions, EAS timeout, LLM gates | §20 PLAT/LLM | P0 (PLAT-01/02), P5 (rest) |

### Pixel parity method (executable version)

The reference corpus is 236 **guest, free-tier** frames of one A/B arm at a **614×811 CSS px** viewport, saved as JPEG. Freelingo never renders hearts counts, refill modals, sign-up walls, or leaderboards, so a blanket pixel diff fails by design. Three checks replace it:

1. **Token conformance** (P3 gate): computed styles of every component vs the measured table in `scope/10` (colours, radii, the 4 px lip, font sizes, letter-spacing, heights). Playwright on the web target at 614 CSS px.
2. **Curated parity frames** (P3 gate): ~15 frames whose Freelingo counterpart is meant to be identical (lesson chrome, option cards in each state, banners, match grid, path nodes, unit header, ceremony tiles), diffed at 614 CSS px with the heart/leaderboard/sign-up regions masked and a per-frame threshold.
3. **Self-baseline native snapshots** (every PR): Maestro screenshots on simulator + emulator, baselines committed, any change reviewed. Matrix `{3 font scales} × {3 widths} × {light, dark}` for INV-TYP-01/02; `ar` and `he` launch-arg locales for INV-I18N-01.

The README names the surfaces with no reference at all: Practice Hub, Stories, Radio, widget, recovery, Data/About, all test flavours.

### Content pipeline (`tools/coursekit`)

G0–G9 per `scope2/00` §2.3 with the `deep/10` corrections. Per-language kit: ≥200k aligned pairs (NLLB v1 ODC-By for selection/validation; shipped verbatim text prefers Tatoeba with per-sentence attribution until the crawl-text licence question is answered), lemmatised frequency list, morphology adapter (spaCy 3.8 es/fr/de; SudachiPy Mode A for ja), a voice cast, and an **original** curriculum (`content/<lang>/curriculum.yaml`, ~1 human-day per language). **Characters stage G3b** for Japanese: `content/ja/characters.yaml` (kana + kanji syllabary curriculum, not derivable from a corpus) with KanjiVG (CC BY-SA 3.0) stroke order, JmdictFurigana (CC BY-SA, JSON only) furigana, SudachiPy `reading_form()` readings; INV-PACK-16 and INV-TYP-03 own it. Audio: Azure Neural, one locale per course, four voices, baked once, transcoded to **Opus 20 kbps** in G9, content-addressed. **Audio budget is re-declared at 120 MB per language including Stories and Radio** (the 35–40 MB figure cannot hold 8,000 utterances at any intelligible bitrate); S001 and S133 copy show the real size; packs live outside backup so Android's 25 MB cap is unaffected. INV-PACK-15 asserts the manifest against this budget.

`INV-PACK-13` (licence allow-list, NC/ND excluded **at ingest**) is a **P2 entry criterion**: the allow-list config exists before G0 reads a byte.

### Art and sound (its own track)

The product map needs: five parrot poses at 64 px and 240 px, a phoenix pose set (S075), a 3–4 character cast with speech-bubble avatars (S034), two tableau sprite kinds (S020), chest/book/trophy/speaking/alphabet node art, story covers in `{gilded, active, locked}`, 13 achievements × tiers with no holes, cosmetics catalogue (the gem sink), nine widget states × three sizes, share-card composition, and a sound bank (stings, fanfare, shimmer bus, earcon). This is 150–300 h of AI-assisted SVG plus hand-tuning, or a commission. It runs in parallel from P1 and is a **P3 entry criterion**: mascot poses, cast, and sound bank exist before the lesson player is gated on them.

## Phases and gates

A phase is done when its gate is green in CI **and** an agent has shown the live run on the simulator via CI-produced artefacts. Gates are phrased as "every invariant id in the named sections has an owning green test", never a percentage, because the registry grows at P0.

| Phase | Deliverable | Gate |
|---|---|---|
| **P0 Foundation** | Present the deletion candidate list and free ≥80 GB on this Mac after your approval (currently 14 GB at 97%); monorepo + CI on the public repo with the code/pack licence split and CLA bot; signing key custody; Expo skeleton with persistence layout + backup-exclusion plugin; `testkit`; **merge pass lands** (388 hunted cases, ~120–160 new invariants, four in-place corrections) and the invariant registry is re-baselined with a founder checkpoint on the count; INV-DAY-01, DAY-05, CER-01 green; PER-06 DB-path gate; PLAT-01/02 gates | DAY-01/05 + CER-01 at 10k cases in four zones; DB-path gate on sim + emu; coverage-map job exists |
| **P1 Engine** | Every `packages/core` module in the table above except hub/notifications/course/stories/radio/widget; economy config with every constant named and dated; migration harness + golden-DB corpus; SESS-01, SCH-01, GRD-06 among the first | Every id in §1–§10, §13, §14 (engine parts), SEC-01/02 green; committed falsifier inputs per invariant; Stryker score ≥ threshold nightly |
| **P2 Spanish pack v0** | `coursekit` G0–G9 + V1–V12 + Freelingo validators + `sign`; `content/es/curriculum.yaml`; audio bake (Azure es-ES ×4, Opus 20 kbps); manifest with provenance %, validator report, attribution table; **Spanish reviewer sample sent now** (300 items, ≤2% gate before P3 builds on the pack) | `coursekit validate` green; V1–V4 100%; bank within the 120 MB budget; every attribution-required sentence has an owner string; INV-PACK-13 allow-list active from the first ingest |
| **P3 Lesson player** | Onboarding S001–S009 (import reachable), path S010–S028, session shell + all exercise types S029–S056 minus S043, **all ten flavours S057–S066** (placement, jump-here, section test, Legendary, Unit Review, Daily Refresh, recovery lesson, endgame), banners, dialogs, `∞` meter, modality gates S054–S055; design system; mascot poses; sound bank; a11y contracts per type | Token conformance + curated frames; Maestro: onboarding → 3 lessons → kill/resume → quit/end → placement → jump-here; **Maestro a11y-tree walk answering one instance of every type** (A11Y-04); typography matrix; §1–§4, §11, §12 e2e ids green |
| **P4 Loop surfaces** | Ceremony S067–S090 (incl. the collapsed S067 state), Practice Hub S091–S100, Quests/Badges, Shop (cosmetics + freezes), Profile/records/calendar, Settings incl. Data export/import and course management, **credits S152**, notifications S141–S144, recovery S145–S146 **plus the monthly Streak Repair modal**, integrity S147–S151 | **Headless 30-day journey** in `packages/core` across two courses and four zones; **Maestro 3-day journey** via a debug-build `__setClockOffset` intent (UI renders each engine state); export→wipe→import; §6–§9, §13, §16, §18, §21 ids green; A11Y-03 focus audit |
| **P5 Native surfaces** | Widget (WidgetKit target + Glance) with snapshot contract; ASR speaking exercises with the permission ladder; TTS fallback; Explain My Answer + Roleplay (on-device + BYOK); share cards | WID-06 total state machine; ASR flows on emulator; LLM three-condition gate; SEC-03; §17, §20 ids green; D-kind items recorded (haptics, mic, widget freshness over a day, Low Power Mode, reminder fires next day, reboot survival PLAT-07) |
| **P6 Stories + Radio** | Formats + players S101–S117; coursekit story/radio generators through the same validators and cast; bake within budget | §15, AUD-03/04 green; Maestro story + episode flows |
| **P7 fr, de, ja packs** | French/German kits; Japanese kit incl. **characters stage**, script-variant sets, counters, keigo scoping, ruby rendering; reviewer samples for fr/de/ja | Pack gate per language; ja beta label on S001; defect rates in manifests |
| **P8 Release** | TestFlight (EAS Starter) + signed APK; README honesty block (parity definition, provenance %, defect rates, no-reference surfaces, CEFR policy); publik listing; `docs/` | Full suite + e2e green; D checklist signed; ≤2% for every shipped language |

## The build workflow (run three)

One Workflow per phase, resumable from run id, all agents on Opus, six steps:

1. **Spec-to-tasks**: tasks keyed by screen id / invariant id, with file ownership per task (CODEOWNERS-style). Exactly one task per phase may touch `pnpm-lock.yaml`, `packages/core/economy/config.ts`, or `packages/schema`; others file a request.
2. **Implement in worktrees**: test first from the invariant's falsifier input; definition of done = invariant ids green + reference frames matched + golden migration fixture if the schema changed.
3. **Verify**: unit + property locally, then push; **only CI produces artefacts**, named `<sha>/<test-id>.png` and uploaded by the workflow. An agent never writes to `e2e/artifacts/`; a screenshot without a CI URL does not count.
4. **Adversarial review**: a refuter reads the diff against the spec and the catalogue for that area. Refuted → step 2.
5. **Integration**: merge queue with rebase-and-retest (no parallel merges); full suite; the phase journey; mutation score.
6. **Founder checkpoint**: report with CI artefact URLs and gate results. **Reject path**: revert the phase branch, rerun spec-to-tasks with the refuter's findings. **Stop condition**: a phase that fails its gate twice escalates to a scope decision, not a third attempt.

Safeguards: network retries + resume (two runs died on DNS this week); disk check before each phase; wall-clock budgeting for macOS runners (unlimited minutes, limited concurrency); no green-on-unit-tests-alone.

## Verification

- `pnpm test`: Vitest + fast-check over `packages/core`, virtual clock, four zones, ≥10,000 cases per property.
- `pnpm test:falsify`: committed falsifier inputs per invariant. `pnpm test:mutation`: Stryker nightly with a threshold.
- `pnpm test:coverage-map`: every invariant id has an owning test.
- `pnpm e2e:tokens`: Playwright token conformance + curated frames at 614 CSS px.
- `maestro test e2e/flows/`: behaviour flows, native snapshot matrix, a11y-tree walks, locale launch args.
- `coursekit validate`, `coursekit sample`, `coursekit sign`: pack CI.
- Manual D checklist: haptics, mic ladder, widget freshness over a day, Low Power Mode, silent switch, reminder fires next day, reboot survival.

## Effort (honest)

| Piece | Hours |
|---|---|
| P0 foundation + merge pass + P1 engine | 300–400 |
| Content framework + Spanish (P2) | 700–900 |
| Lesson player + design system + flavours + a11y (P3) | 500–700 |
| Loop surfaces incl. credits, hub, notifications, integrity (P4) | 300–400 |
| Native surfaces on two platforms with pre-1.0 LLM wrappers (P5) | 250–400 |
| Stories + Radio, both pipelines (P6) | 250–350 |
| fr, de 60–100 each; ja 150–250 + characters stage 60–100 (P7) | 330–550 |
| Art and sound track (parallel) | 150–300 |
| Release, docs, CLA, listing (P8) + reviewer turnaround slack | 80–120 |
| **Total** | **≈2,900–4,100 h** |

Cash: audio bake single-digit dollars per language plus tens for Stories/Radio; LLM gap-fill ≈ $100 per language; native reviewers $300–800 per language ×4; EAS Starter $19/month at release; corpus box if chosen (below). Agent tokens are the real spend.

## Risks and unknowns

1. **Disk**: this Mac has 14 GB free at 97%. Your call is to clear space here. The survey found ~80–100 GB reclaimable, but every item is a deletion you approve first at P0: Downloads 49 GB (needs your review), `~/Library/Caches` 12 GB, Android SDK images 10 GB (keep one emulator image), old iOS DeviceSupport symbols 6 GB, `.publikclip` 8 GB, `.ollama` models 7 GB, `.codex` 7 GB, stale `node_modules` in retired projects ~15 GB (kneecap 7, slavework 2, Simplicity 2, others), Rust targets 3 GB, `VMs/` 4 GB (the failed Win11 UTM), `wipe-backup-20260805` 2 GB (already on GitHub per memory). Target ≥80 GB free. The pipeline never downloads the 94 GB NLLB set: G0 streams OPUS shards through the API with `--max-pairs 2,000,000` per language (~1 GB compressed each), which is far more than the ~250k raw candidates the ledger needs.
2. **Crawl-derived text under ODC-By**: a lawyer question. Until answered, NLLB is oracle-only and shipped text is Tatoeba; if it stays oracle-only, download only what sampling needs.
3. **Typo-forgiveness guard** (EC-GRD-05): one signed-in Duolingo session settles it; only you can run it. Until then the three named guards ship as config.
4. **Apple FM availability enum and per-session context**, **ML Kit device list**, **expo-audio tap-to-sound latency**, **backup exclusion on device**: measured in P3/P5, not read.
5. **ML Kit GenAI Additional Terms** vs AGPL: read before P5, same class as the Rive terms.
6. **Trade dress**: green and vocabulary kept by your decision; README states mechanics are re-implemented and every asset is original; App Store is a later decision.
7. **Spanish defect rate > 2%** discovered late would invalidate P3–P6; hence the sample is sent at the end of P2.

## Decisions already taken at review (recorded in DECISIONS-LOG at P0)

- **Licence**: code AGPL + CLA, content packs CC BY-NC-SA; es/fr cards `A1 · CEFR-checked`, de/ja `Beginner · frequency-ordered`.
- **Streak Repair**: kept, monthly, alongside the recovery challenge.
- **Disk**: clear space on this Mac after approving the candidate list; corpus ingest capped and streamed.
- **Art**: AI-assisted SVG inside the agent workflow.
- **Pack hosting**: GitHub Releases, Cloudflare R2 only if egress becomes a problem.

## Approval

Approving this plan accepts the rulings tables, the phase order with a founder checkpoint between phases, Azure as the voice vendor, and the 120 MB per-language audio budget. Any single line can be overridden in the approval note.
