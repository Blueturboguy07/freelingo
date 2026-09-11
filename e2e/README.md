# `e2e/` — behaviour on real devices

```
e2e/flows/       Maestro flows (behaviour, native snapshot matrix, a11y-tree walks, locale launch args)
e2e/baselines/   committed native snapshot baselines; any change is reviewed, never auto-accepted
e2e/artifacts/   CI OUTPUT ONLY — `<sha>/<test-id>.png`. Never write here by hand.
```

**Maestro, not Detox.** Detox is capped at React Native 0.84; SDK 57 ships 0.86.

**Only CI produces artefacts.** A screenshot without a CI URL does not count as evidence
that something works. `e2e/artifacts/` is git-ignored except for `.gitkeep`, and the
`native-e2e` workflow uploads `e2e/artifacts/<sha>/` as a build artefact.

**A flow names its screenshot and nothing else** — `takeScreenshot: <test-id>`. A flow
cannot write into `e2e/artifacts/` however it is spelled: Maestro resolves every
`takeScreenshot` inside its own run directory. So `native-e2e.yml` points that run
directory at `e2e/artifacts/<sha>/<platform>/maestro` and collects the frames out of it
afterwards, failing the job if it collected none — a flow that asserts nothing visible
cannot pass as evidence. The measured contract, including why `-e ARTIFACT_DIR=…` does not
work, is in [`docs/ci.md`](../docs/ci.md).

P0 status: one flow, `flows/p0-db-path.yaml`, gating INV-PER-06 on device. `native-e2e.yml`
runs it on an iOS simulator and an Android emulator; a `flows exist` job counts the flows
first and fails the run if the directory is empty, because `maestro test` over an empty
directory exits 0.
