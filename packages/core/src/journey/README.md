# `packages/core/src/journey/` — the P1 phase gate

This directory is **not** an engine module. It is the phase gate made executable: it owns
no invariant (a gate that owns invariants can pass itself), it is excluded from
`stryker.config.json`'s `mutate` globs, and it is skipped inside a Stryker worker.

Four things live here.

| File                                                  | What it gates                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `script.ts`, `script.test.ts`                         | the 30-day two-course four-zone trace, as data, and the test that it still covers every clause of the P1 gate |
| `ports.ts`, `bind.ts`, `driver.ts`, `journey.test.ts` | the headless journey: the trace driven through the real modules, asserting end-state ledgers                  |
| `falsifier-corpus.ts`, `falsifier-corpus.test.ts`     | `pnpm test:falsify` — the committed falsifying inputs are found, validated **and executed**                   |
| `ownership.ts`, `phase-roster.test.ts`                | the union of the ownership files is exactly the phase roster, derived from the registry                       |

## Adding a falsifier input (every owned invariant needs one)

The P1 gate is _"committed falsifier inputs per invariant"_. One file per invariant, next
to the module it falsifies:

```
packages/core/src/day/__falsifiers__/INV-DAY-02.json
packages/core/src/day/__falsifiers__/INV-DAY-02.tamper.json    a second input, same id
```

```json
{
  "invariant": "INV-DAY-02",
  "why": "a westward flight an hour before midnight: UTC advances, local_day goes back",
  "source": "EC-STK-02",
  "check": { "module": "../zone.js", "export": "classifyDayKey" },
  "cases": [
    {
      "name": "zone changed, UTC monotonic: honoured",
      "args": [{ "…": "…" }],
      "expect": "travel-regression"
    },
    { "name": "same zone: refused as tampering", "args": [{ "…": "…" }], "expect": "tamper" },
    { "name": "a clock that went backwards throws", "args": [{ "…": "…" }], "throws": "monotonic" }
  ]
}
```

- the id in the file **name** and the `invariant` field must agree;
- `check.module` resolves relative to the `__falsifiers__` directory;
- `check.export` is called with `...case.args`. `"call": "single"` passes `case.input` as
  one argument instead;
- a case declares **exactly one** of `expect` (deep-equal, JSON-shaped) or `throws` (a
  substring of the error message). A case with neither cannot fail, and is rejected.

`pnpm test:falsify` imports the module and calls the function. A committed input that is
never executed is a comment with a `.json` extension, which is why the runner exists.

## Running the journey

```sh
pnpm exec vitest run --project core journey.test      # foreground
pnpm test                                             # as part of the suite
```

It prints three separate lists and each is its own assertion:

- **replayViolations** — a day whose rollover, replayed with the same arguments, decided
  something. INV-DAY-09, INV-FRZ-05.
- **refutations** — the engine and an independent reference disagree. Each line names the
  lane that owns it. This task never patches across a module boundary; a refutation goes
  back to its owner (plan §The build workflow, step 4).
- **notProven** — a clause that could not be executed because the lane that owns it has
  not landed. It fails the gate, and `docs/P1-REPORT.md` prints it under NOT PROVEN.

## Why the roster is derived and not typed out

`pnpm test:coverage-map` asks "does every claimed id have a test?" — a question a phase
can pass by claiming nothing. `phase-roster.test.ts` asks the other one: the roster is
computed from `docs/invariants.md` (the P1 invariant families plus `INV-SEC-01/02`), so a
merge pass that adds an id adds it to the roster on the same commit and the gate goes red
until somebody owns it. Deferrals are legal; silent gaps are not, so each deferral is a
line in `docs/owned/journey.json` with its reason.
