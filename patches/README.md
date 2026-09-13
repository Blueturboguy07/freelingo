# Pinned native patches

`expo-modules-jsi@57.1.0.patch` retains the existing Xcode 26.2 compatibility repair.

`expo-speech-recognition@57.0.0.patch` enforces local speech recognition at the
requested iOS recognizer, before microphone preparation. Version 57.0.0's default
locale capability probe is advisory: another requested locale can lack on-device
support. Such a request now raises the existing unavailable error instead of
leaving the system request's on-device flag false. The existing error/end cleanup
path remains responsible for releasing capture.

The two native `has...` permission helpers now read authorization status. Only
explicit onboarding/settings request methods may prompt. JavaScript continues to
check grants before starting and waits for native `end` before another capture.

Run `python3 scripts/check-native-speech-policy.py` on macOS after a frozen install.
It extracts the installed native methods and executes them against controlled Swift
OS doubles: unsupported locales fail before request allocation, supported requests
retain the local-only flag, and start-time grant checks never invoke prompt APIs.
The explicit permission request remains exercised. These are source control-flow
checks; real iOS/Android builds, audio-session recovery, and device network behavior
still require the P5 native evidence gate.
