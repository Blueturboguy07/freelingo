/**
 * Who may open the diagnostics surface.
 *
 * `DevDiagnostics` is the INV-PER-06 device gate made visible: it prints the resolved DB
 * path, the journal mode and the backup-exclusion verdict. It must not exist in a build a
 * learner installs, and it must exist in the build `native-e2e` runs the flow against —
 * and those are not the same condition, which is the trap this module exists to name.
 *
 * `native-e2e` builds **Release** on both platforms on purpose: Release embeds the JS
 * bundle, which is what makes `--no-bundler` honest. `__DEV__` is false in a Release
 * build, so a `__DEV__`-only surface is invisible to the very job that gates it. Measured
 * 2026-09-11 on emulator-5554: the flow reached `app-title`, long-pressed it, and failed
 * with `Assertion is false: id: dev-diagnostics is visible`.
 *
 * So the gate is `__DEV__` OR an explicit opt-in flag. The flag is an `EXPO_PUBLIC_`
 * variable, inlined by Metro at bundle time, so a store build that does not set it does
 * not merely hide the screen — it does not contain the branch that opens it.
 *
 * The reference must stay a literal member access on `process.env`: Metro substitutes the
 * text, so a computed lookup by variable name silently yields undefined in a release
 * bundle and the screen is gone with no error. A testkit gate enforces that.
 */

/** Named config. Set to `1` by the `native-e2e` build steps, and by nothing else. */
export const E2E_FLAG_NAME = 'EXPO_PUBLIC_FREELINGO_E2E';
export const E2E_FLAG_ON = '1';

/** Pure, so the rule is testable without a bundler or a device. */
export function isDiagnosticsEnabled(isDev: boolean, flag: string | undefined): boolean {
  return isDev || flag === E2E_FLAG_ON;
}

export const DIAGNOSTICS_ENABLED = isDiagnosticsEnabled(
  __DEV__,
  process.env.EXPO_PUBLIC_FREELINGO_E2E,
);
