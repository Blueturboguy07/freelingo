# Manual device checklist

Status: **NOT RUN**. No person has signed this checklist. It is prepared from the ten D-kind rows in `docs/invariants.md` on 2026-09-13; the emulator reboot check remains E-kind and is listed separately. A property test cannot substitute for a device observation.

For every row record: reviewer name, UTC date, app git SHA/build, device model, OS version, exact setup/actions, outcome (`pass`/`fail`/`blocked`), evidence path and notes. A blank or blocked row is not a pass. Keep iOS and Android results separately where both apply.

| Invariant   | Required observation                                                                                                                                                                                                                                                                             | Status / evidence |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| INV-PACK-11 | Packs live outside the backed-up directory, verified by an actual backup-manifest assertion on device — not by trusting "cache is typically excluded"                                                                                                                                            | NOT RUN           |
| INV-WID-04  | Forced reloads are debounced to rendered-state transitions, ≤1 per 15 minutes; the daily total stays under the measured budget                                                                                                                                                                   | NOT RUN           |
| INV-NOT-06  | Pending local notifications never exceed the platform ceiling (~64 on iOS); the scheduler sizes against the platform, not the SDK docs                                                                                                                                                           | NOT RUN           |
| INV-PLAT-04 | Speech recognition feature-detects before use (`getSupportedLocales()`), sets the no-beep option on Android, and degrades to typed/skippable rather than failing                                                                                                                                 | NOT RUN           |
| INV-PLAT-05 | The audio session mode is set **per surface** and restored afterwards. Property: entering and leaving every audio surface in any order leaves the session category in its documented default, and no surface both requires lock-screen control and mixing                                        | NOT RUN           |
| INV-AUD-07  | Highlight lag never exceeds one keypoint interval on any aligned line. Falsifier: a 1.4 s seven-keypoint line whose highlight advances in fewer than six steps or lands >120 ms late                                                                                                             | NOT RUN           |
| INV-PER-10  | Device gate: the on-device backup manifest lists only the checkpointed DB file and stays inside the platform quota. Falsifier: a manifest containing a pack file or a `-wal` sibling                                                                                                             | NOT RUN           |
| INV-SND-05  | For any burst of pair completions at most one answer-class cue plays per 120 ms, its pitch equals the pitch for the combo value at that instant, and haptics coalesce to one Success per exercise while a wrong pair keeps its immediate Error haptic                                            | NOT RUN           |
| INV-SND-07  | One trace item emits exactly one success notification and one correct chime regardless of stroke count, with per-stroke ticks under the existing suppression window. Falsifier: a 12-stroke trace emitting twelve correct-answer stings in four seconds                                          | NOT RUN           |
| INV-PLAT-09 | For any audio-session interruption injected at any point of a recording, the item returns to idle, the consecutive-ASR-failure counter is unchanged, and the pre-mic audio mode is restored. Falsifier: an interruption that increments the failure counter or leaves the category set to record | NOT RUN           |

## Additional plan observations

| Scenario                         | Required observation                                                                                                  | Status / evidence |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Haptics and settings             | Correct/wrong/trace cues on a real phone; sound and haptics toggles independent                                       | NOT RUN           |
| Silent switch / interruption     | Lesson, speaking, story and radio honour the documented audio mode and restore it on exit                             | NOT RUN           |
| Low Power Mode / timezone flight | Widget remains truthful when throttled across midnight or after a zone change                                         | NOT RUN           |
| Next-day reminder                | A real permission-granted device receives one reminder at the chosen local time; completed streak cancels danger copy | NOT RUN           |
| One-day widget trace             | Session bursts, resume, no-history and completed-below-goal states; preserve reload event evidence                    | NOT RUN           |
| INV-PLAT-07 (automated E-kind)   | Android emulator reboot preserves the next reminder; record CI artifact alongside corroborating device observation    | NOT RUN           |

## Sign-off

Release SHA: pending. Reviewer: pending. Date: pending. Required rows passed: 0/10. Additional scenarios completed: 0/6. No approval is implied by generating this file.
