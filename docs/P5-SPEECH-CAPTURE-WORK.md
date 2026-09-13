# Native speech capture evidence

Implementation checkpoint, 2026-09-13. This is not a P5 phase gate.

The native recognizer now forwards its actual final word segments, timing, and confidence through the lesson media port and actual LessonPlayer into session state. The session checkpoint keeps a detached snapshot; a subsequent result without segments clears the previous evidence. No transcript tokenizer creates replacement segments. The pure speaking grader accepts these exact SDK observations or uses its declared character fallback when segment evidence is unavailable or unalignable.

Three failing-before-fix witnesses covered the native callback, actual player caller, and saved-session boundary. Follow-up checks include the strict mobile session codec and mutation of the original SDK array. The existing amplitude and no-audio rules are unchanged.

Validation: /private/tmp/p3-speech-segments-red.xml and caller-red.xml preserve real failures; /private/tmp/p3-speech-segments-final.xml records the final affected suites. Full TypeScript and lint results are in /private/tmp/p3-speech-segments-final.log. Native device ASR and approved production speech metadata still require their separate evidence; these checks do not claim that a device microphone flow ran.
