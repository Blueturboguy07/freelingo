# Expo event emitter compiler compatibility

Status: focused compiler review, independent patch review and the tracked whole iOS app build pass. Simulator bridge verification and phase gates remain pending.

The tracked widget app build at `45fe0ef` stopped with exit 65 in Expo Modules Core 57.0.18, before WidgetPublication compiled. Xcode 26.2 / Swift 6.2.3 rejected both event-emitter overloads for sending the weak local emitter across the JavaScript actor boundary. The real build log is `/private/tmp/p5-widget-ios-app/build.log`.

The sole dependency lane applies the exact EventEmitter.swift from [Expo commit d01580058a40e2650efca4dad1015255d500bf99](https://github.com/expo/expo/blob/d01580058a40e2650efca4dad1015255d500bf99/packages/expo-modules-core/ios/Core/Events/EventEmitter.swift). It uses the package's existing `NonisolatedUnsafeWeakVar` helper and reads its weak value inside each actor closure. Payload conversion, event dispatch and weak app-context capture remain unchanged. Package versions, the Xcode pin and all existing patches remain unchanged.

Original file SHA-256: `66b5033150d788e6c392fda9c1abfe597ede029e08d378205847ee026cd1793d`.
Patched file SHA-256: `425a0e5c5b26fbee0ef668b620ca9d3686aa3bcd0ff770dfd7f897bc3ac761ce`.
Patch SHA-256: `c5001aa0844a91b522fece9f9775446a3cddf6524436f65e102a79a610ed2855`.

`pnpm patch-commit` completed with exit 0 using the existing dependency graph, downloading no packages. Its log and original/upstream bytes are in `/private/tmp/p5-expo-emitter-deps/`.

Independent compiler evidence is in `/private/tmp/p5-emitter-repro/`: the original reproducer fails compilation (1); the patched version compiles and runs (0/0) under Swift 6 with complete concurrency checking. Both overloads cover emitter deallocation before queued delivery, missing targets and app-context loss. A weak-to-strong mutation compiles but fails the lifetime assertion. Independent patch application in `/private/tmp/p5-emitter-patch-independent/result.json` proves the checked patch produces the pinned upstream bytes and its hash matches the lockfile. These focused checks do not establish a complete native app or phase gate.

## Whole-app retry — 2026-09-14

The tracked-only widget source `45fe0ef` plus frozen dependency checkpoint `b628d96` built as `ea1e307ead7f64acc86c8bdd6da988e8c7b90828` in `/private/tmp/p5-widget-ios-app-source`. The installed EventEmitter bytes match the reviewed hash above. The frozen install, CocoaPods and actual Xcode app build all returned 0; the app build took 193 seconds. `WidgetPublicationModule.swift` and `AtomicWidgetPublication.swift` compiled and the Freelingo application linked. Generated native files were produced by Expo/CocoaPods; the held DeviceClock candidate was excluded.

Evidence: `/private/tmp/p5-widget-ios-app-retry/{install.log,build.log,results.json,provenance.json}`. Product: `/private/tmp/p5-widget-ios-app/derivedData/Build/Products/Debug-iphonesimulator/Freelingo.app`. The original failure remains in its original directory. This proves the tracked native app compiles with the patch; it does not yet prove simulator widget behavior, parity, complete P3–P8 composition or CI gates.
