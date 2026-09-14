# Widget bridge diagnostic

This E2E-only probe tests the installed native `WidgetPublication` module. It does not report real-account publication, WidgetKit/Glance drawing, reload timing, or visual parity.

Build a simulator-signed iOS app through Expo's generated project so `group.org.freelingo.app.widget` is an actual entitlement. Compile the JS bundle with `EXPO_PUBLIC_FREELINGO_E2E=1`; ordinary development builds do not expose this probe. The existing app-title long press opens Diagnostics. The button invokes native acquire, read, write, read, reload, exact-byte restoration, read, and release. `bridge-passed` is emitted only after restoration and release complete. Reload success means a request was submitted to WidgetKit, not that the target drew.

Use `python3 e2e/scripts/widget-bridge-simulator.py --device <UDID> --artifacts <new-absolute-directory> --url <E2E-Metro-dev-client-URL>` in a logged background process. The harness terminates the app, saves the prior publication and its permissions, and seeds the explicit null-snapshot baseline only if no publication exists. It runs the dedicated Maestro flow without clearing app data, terminates the app again, and restores the original bytes or original file absence in `finally`. `result.json` proves exact restoration independently of the flow outcome. An embedded E2E bundle can omit `--url`.

The probe itself refuses an absent baseline. Never run the flow directly against learner state or initialize missing history as a successful source. The fixture has `snapshotJson: null` and contains no invented learner values. Backup files stay local to the chosen artifact directory.

Focused evidence: `/private/tmp/p5-widget-bridge-probe/final2.xml` has 14 passing probe/UI/native-port tests, with root/mobile typechecks and focused lint passing. Four private mutations of readback, restore, reload, and release are killed in `/private/tmp/p5-widget-bridge-mutants/results.json`. The simulator flow result is separate evidence recorded by the harness.

The flow deliberately lives outside `e2e/flows`: native CI runs that default directory on both platforms without this iOS-only fixture harness. Tags are not an exclusion mechanism. Each simulator command has a 30-second bound; the combined Maestro driver/flow has a 180-second bound, after which the harness terminates its own process group and still restores the original publication. These are diagnostic resource limits, not runtime or WidgetKit timing promises.

The original run at isolated source `2ab02b0280af60c64fc979253473343c53b8c71d` failed with `IOSDriverTimeoutException` before executing the flow. `/private/tmp/p5-widget-ios-simulator/run1/result.json` records Maestro exit 1 and exact restoration of original file absence. It is not a bridge pass.
