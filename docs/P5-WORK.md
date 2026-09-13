# P5 native feature work

Authorized in parallel with the Spanish audit on 2026-09-13. Shared dependency checkpoint: 814d5e6. No P5 gate is claimed.

1. Snapshot-only widget model, draw-time civil boundary, complete state machine, deterministic deep links, reload budget and falsifier/property tests (WID01–10; EC-WID01–15).
2. Native WidgetKit/Glance rendering and snapshot bridge through app-owned config plugins; all build numbers match; no widget SQLite imports (PLAT06).
3. Speaking permissions/locale/capability and interruption ladder, actual ASR adapter and cleanup, always skippable (S054–55/S041; MOD/PLAT04/09, PER09, A11Y12).
4. Per-surface audio ownership and baked-first/TTS availability adapter with explicit unavailable reasons (AUD01/02, PLAT05).
5. Explain My Answer and Roleplay provider interfaces, baked-first stable explanations, timeout/reachability/ja-register guards and mock BYOK (S046/S138–140; LLM01–07, SEC03).
6. Share-card rendering and native integration tests, device flows and explicit manual checklist (PLAT03/07/08, WID07, PER10).

Root owns new core/{widget,explainer,speech}, mobile/native and targets/plugins; App and SQLite integration live in their separate integration task. Dependency additions return to the sole deps task. User interface tests do not count as device evidence.

## Native speech and persistent clock checkpoint — 2026-09-13

The app-owned speech controller probes the requested installed locale and explicit microphone/speech grants, waits for announcement/stop lifecycle boundaries, and always requests on-device recognition. Independent callback witnesses and exact patched Swift guards are green. The shared native dependency patch also prevents unsupported iOS locale requests from allocating a recognition request and makes authorization helpers read-only. This is not a device speech or accuracy gate.

The uncommitted Android clock candidate uses `elapsedRealtime` and `Settings.Global.BOOT_COUNT`. Its iOS candidate uses `mach_continuous_time` with `KERN_BOOTTIME`, which independent review refuted as a stable boot identity. The clock policy decision remains pending; this candidate is not connected to the production App. Missing/malformed native time returns null and a suspension write rejects it.

Earlier validation included 20 clock/speech adapter tests and an actual Mac Swift helper probe (105.367ms advancement). Those results do not establish iOS clock-change/reboot correctness.

Primary platform references: [Apple continuous clock](https://developer.apple.com/documentation/kernel/1646199-mach_continuous_time), [Android SystemClock](https://developer.android.com/reference/android/os/SystemClock), [Android boot counter](https://developer.android.com/reference/kotlin/android/provider/Settings.Global).

Independent clock review refuted the proposed iOS boot marker: KERN_BOOTTIME shifts with wall-clock changes, and Apple iOS18+ no longer allows apps to read kern.bootsessionuuid. A simulated reset whose new uptime exceeds the saved reading also extends a simple counter-domain pause beyond60 minutes. `/private/tmp/p4-clock-review/{findings.md,report.xml}` records the failing witness and primary sources. The clock module remains uncommitted and is not production-ready. A founder choice on conservative early expiry versus keeping this gate blocked is pending; the earlier Mac probe does not resolve this requirement.

## Media ownership and Android bootstrap — 2026-09-13

The app-owned lesson media controller serializes Radio handoff, speech/playback cancellation and mode restoration. It rejects unavailable local playback and prevents announcement overlap. Two independent asynchronous counterexamples were reproduced and fixed: a canceled mode acquisition whose restore fails now quarantines the owner, and a disposed owner cannot cancel a later owner's native speech. The unchanged independent witnesses pass3/3 (`/private/tmp/p3-media-owner-review/green.xml`); the combined owner/speech suite passes23 tests (`/private/tmp/p5-media-review-green2.xml`), with typecheck and scoped lint green. Actual Expo playback/announcement driver binding remains unfinished.

Android SDK36/build-tools36.0.0/NDK27.1.12297006/CMake3.22.1 restored. Expo-generated Android debug build passed557 tasks in14m15s (`/private/tmp/p5-android-native-build.log`). Installed on the surviving test emulator without replacing the emulator process. The actual P0 persistence Maestro flow passed1/1 in23s; only the scratch flow's dev-server URL accepts8082 because8081 is occupied by the local language checker. Evidence under `e2e/artifacts/local-056b226-dirty-android-bootstrap/`, including `report.xml` and `maestro/2026-09-13_080613/p0-db-path/takeScreenshot/p0-db-path.png`. It proves native bootstrap/WAL/document DB/cache backup exclusion, not P3 screens, speech accuracy, pixel parity, or the unresolved iOS clock policy.
