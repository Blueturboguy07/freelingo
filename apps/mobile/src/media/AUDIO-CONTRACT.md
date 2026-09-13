# Native media contract

Dependencies checkpoint: 814d5e6; installed expo-audio 57.0.5, inspected 2026-09-13.
`expo-audio/build/AudioModule.types.d.ts` declares AudioPlayer.setActiveForLockScreen
and AudioPlayer.seekTo. Its AudioPlaylist class declares play/pause/seekTo/skipTo,
but no lock-screen activation method. A search of installed native and JS playlist
sources also found no such method.

The phase brief's proposed useAudioPlaylist + setActiveForLockScreen combination
therefore cannot be implemented against the installed API. Root approved the narrow
adaptation: useAudioPlayer with one pre-stitched complete episode file, enabling
actual setActiveForLockScreen and doNotMix. The file is gapless by construction;
segment/question boundaries stay in the core runtime and never split the decoder.
No silent surrogate player, missing API cast, or fabricated background proof.

Radio requires a complete bank and exposes Repair audio for a missing asset. Story
line playback may use a previously resolved matching device voice, with karaoke off.
Listening mode requires the complete stitched baked story asset. All player updates
use the named 50 ms interval from core. Device latency and sustained background audio
remain unproven until real iOS/Android runs are recorded.

Players receive content, an exact saved state, asset-resolution data, and explicit
onSave/onAttempt/onComplete/onRepair/onClose callbacks. The App owns SQLite and reward
transactions. onComplete is emitted only for an explicit foreground press, and its
caller must deduplicate the commit by run id. Starting a graded session must invoke
the Radio interruption handle before it changes the audio profile.
