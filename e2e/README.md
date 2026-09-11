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

P0 status: no flows yet. `native-e2e.yml` boots a simulator and uploads proof that the
runner works; the `maestro test e2e/flows` step is commented with a TODO and turns on at
P3, together with the first flows.
