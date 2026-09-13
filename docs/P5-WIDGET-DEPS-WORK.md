# Widget native dependencies — 2026-09-13

Root-owned dependency declaration slice, required before the separate native widget implementation. No native build or resolution claim yet.

- Glance AppWidget1.2.0 is the stable release dated2026-08-26 in the [official release notes](https://developer.android.com/jetpack/androidx/releases/glance).
- DataStore preferences1.1.7 is a pinned released version in the [official DataStore notes](https://developer.android.com/jetpack/androidx/releases/datastore).
- The Compose compiler plugin uses the configured root Kotlin version, following [Kotlin compiler migration guidance](https://kotlinlang.org/docs/compose-compiler-migration-guide.html) and the installed ExpoModulesCore57.0.18 Android buildscript. Installed React Native0.86.3 declares Kotlin2.1.20; no independent compiler version is invented.
- iOS uses existing ExpoModulesCore and platform Foundation/WidgetKit, minimum16.4. `ios/WidgetExtension` is excluded from the app pod; the implementation config plugin must register it as a separate extension target.

Only the local module Gradle/Podspec declarations are created here; no JavaScript dependency list, lockfile, generated ios/android app directory, signing credential or native source is changed. Resolution/target build validation belongs to the next real native-module build after module metadata and implementation exist.
