# Saved lesson media composition — 2026-09-14

Implementation and bounded independent review pass. The real native resource constructor and App entry remain outstanding.

The factory now requires `activateLessonMedia` from its native resource owner. It reconciles the actual saved exercise after serialized operations, including operations that reject after committing. Snapshot reads share that same queue and await media readiness. Resume choices, ceremonies and background state disarm lesson media; foreground rebinds the preserved source. Native failures block that snapshot and remain inspectable alongside an original operation failure.

`createLessonMediaBinding` connects this required port to the real native compositor. It binds session/course, queue slot, replay phase, exact exercise variant and the declared normal/slow requests. Repeated reads and ordinary typing preserve the current lease. Source changes drain old native cleanup before enabling the new request. The pack's Japanese reading is required only when an audio control actually exists; text-only and microphone-only Japanese prompts retain their locale with empty playback text and no invented TTS. Separately baked slow audio is marked once so native playback does not slow it twice.

Tests-first: the absent binding initially failed collection; five factory witnesses then failed against the old factory. Independent review found two Japanese non-audio regressions. The unchanged six independent witnesses now pass, and their permanent counterparts are in `lessonMediaBinding.source.test.ts`. The exact binding is also exercised against the actual native compositor and media owner, with doubles only at the platform-driver boundary.

Final combined check: **67/67**, no skips, `/private/tmp/p3-factory-media-integrated.xml`; root/mobile typecheck, lint and owned-invariant coverage all exit0. Independent six-case replay: `/private/tmp/p3-media-independent/green.xml`. Compressed original failures, results and exact source hashes are retained in `docs/work/p3-factory-media-evidence/`. This evidence covers application/native composition behavior; it is not a native-device, full-app-entry or phase gate.
