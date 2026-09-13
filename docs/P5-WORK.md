# P5 native feature work

Authorized in parallel with the Spanish audit on 2026-09-13. Shared dependency checkpoint: 814d5e6. No P5 gate is claimed.

1. Snapshot-only widget model, draw-time civil boundary, complete state machine, deterministic deep links, reload budget and falsifier/property tests (WID01–10; EC-WID01–15).
2. Native WidgetKit/Glance rendering and snapshot bridge through app-owned config plugins; all build numbers match; no widget SQLite imports (PLAT06).
3. Speaking permissions/locale/capability and interruption ladder, actual ASR adapter and cleanup, always skippable (S054–55/S041; MOD/PLAT04/09, PER09, A11Y12).
4. Per-surface audio ownership and baked-first/TTS availability adapter with explicit unavailable reasons (AUD01/02, PLAT05).
5. Explain My Answer and Roleplay provider interfaces, baked-first stable explanations, timeout/reachability/ja-register guards and mock BYOK (S046/S138–140; LLM01–07, SEC03).
6. Share-card rendering and native integration tests, device flows and explicit manual checklist (PLAT03/07/08, WID07, PER10).

Root owns new core/{widget,explainer,speech}, mobile/native and targets/plugins; App and SQLite integration live in their separate integration task. Dependency additions return to the sole deps task. User interface tests do not count as device evidence.
