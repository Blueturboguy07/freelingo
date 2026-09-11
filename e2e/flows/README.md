# Maestro flows

| Flow              | Gate                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `p0-db-path.yaml` | INV-PER-06 on device: document-region DB path, WAL, migrated `user_version`, packs directory excluded from backup |

The rest land at P3, in the order the plan gates them:

- `onboarding.yaml` — S001-S009, including reaching progress import
- `three-lessons.yaml` — onboarding to three completed lessons
- `kill-resume.yaml` — kill mid-session, reopen, resume the nine-field session state
- `quit-end.yaml` — quit rules and the end-of-session ceremony
- `placement.yaml`, `jump-here.yaml` — two of the ten session flavours
- `a11y-walk.yaml` — an accessibility-tree walk answering one instance of every exercise type (A11Y-04)

Naming: one flow per gate row in the plan's phase table, named after the gate.

Screenshots: `takeScreenshot: <name>` — a bare name, no directory and no `${ARTIFACT_DIR}`.
Maestro resolves the path inside its own run directory whatever you write, and a flow-level
`env:` default silently beats the `-e` CI passes, so a flow that spells out a destination is
stating something untrue. `native-e2e.yml` aims the run directory and collects the frames.
See [`docs/ci.md`](../../docs/ci.md).
