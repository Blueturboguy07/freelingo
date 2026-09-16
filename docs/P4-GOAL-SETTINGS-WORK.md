# P4 daily-goal persistence checkpoint — 2026-09-13

Implementation checkpoint; the P4 phase gate remains pending.

`SqliteGoalSettings` writes the selected 10/20/30/50 XP goal in the retained app
SQLite database. Both onboarding and Settings use this owner through the factory's
existing serialized action queue. The former external native setter is removed.
Publication and reminder reconciliation run only after the transaction commits.
If publication fails, the preference remains saved; repeating the same selection
retries publication without repeating the database write.

For an existing current-day quest set, the owner validates its seeded identities
and reads the actual trailing seven-day XP window. Missing days count as zero only
after the first recorded account day. It rederives unfinished targets with the
existing core economy function, preserves completed rows byte-for-byte, and changes
no earned XP, gems, chest history, session receipts or ceremony rows. It creates no
quests for a day with no existing set. Any invalid persisted inputs or failed SQL
statement aborts the whole transaction.

S006/S132 and INV-ECO-01/05/10/21 are the bounded scope. Full foreground day
reconciliation, the native publication provider, device Settings flows and phase
CI evidence remain separate integration work.

## Verification

- Seven service tests use real SQLite: settings, seeded quest changes, completed
  reward preservation, invalid data and transaction rollback. The initial test-first
  missing-module failure is retained in `/private/tmp/p4-goal-settings-red.*`.
- Four factory regressions failed against the old native delegation, then passed
  through the actual onboarding/Settings routes. Together with existing factory
  tests, the focused run passed 25/25 in 1.60 seconds. Typecheck, lint and invariant
  ownership also exited 0: `/private/tmp/p4-goal-factory-green.*`.
- An independent agent authored eight additional real-SQLite witnesses, all green:
  `/private/tmp/p4-goal-settings-independent/result.xml`. They cover the exact
  history window, invalid civil days/fractional XP, a failure on the second target
  update, day changes, completed rows and corrupted quest identities. A separate
  read of the factory wiring found no blocking issue.

The broader shared app run passed 623/624 tests, but the unchanged actual 50-word
Scholar reward case timed out during severe measured host memory pressure, with
three Vitest reporter RPC errors. That output is preserved at
`/private/tmp/p3-path-native-goal-integration.*`; it is not a green integration gate.
A narrow isolated recheck is recorded separately. No test timeout or property floor
was raised to obtain a pass.
