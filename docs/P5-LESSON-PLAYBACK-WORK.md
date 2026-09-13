# Native lesson playback binding

Implementation checkpoint, 2026-09-13. Not a P5 or native-device gate.

The Expo lesson driver resolves audio only through the verified installed-pack repository and accepts local file URIs. It plays delivered audio first, then uses an explicitly selected installed system voice when available. The native speech revision marker prevents old unpatched binaries from supplying fallback TTS. Voice discovery is refreshed, detached from native callback data and restricted to the requested locale; a bare language may use an installed regional voice.

Slow playback preserves pitch at the approved 0.75 rate. A separately baked slow take plays at rate 1, with the actual LessonPlayer forwarding that distinction. If that file is missing and a system voice is used, speech still uses the slow rate. Two original behavioral failures exposed the missing caller flag and double-slowdown; both now pass.

One driver belongs to the serialized lesson media owner. Completion, interruption, failures and a named 120-second resource watchdog settle a request once. Late callbacks cannot affect the next request. Stop releases listeners and the native player even if another cleanup step fails; native release failures remain visible to the owner's channel quarantine.

Validation: 28 affected playback/media/player checks, root/mobile typecheck and lint passed at /private/tmp/p5-playback-final.*. Independent review passed the original 11 driver checks plus three private resource/lifetime counterexamples at /private/tmp/p3-playback-review/run2.xml. Those exercise native adapter mocks; actual device playback, offline synthesis, audio-focus/route changes, audio-mode integration and the complete native service factory remain to verify.
