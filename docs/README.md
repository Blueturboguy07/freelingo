# `docs/`

| File                    | What it is                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `invariants.md`         | the invariant registry, a **verbatim** copy of the research corpus (`~/duolingo-research/deep/00-INVARIANTS.md`). The single source of ids. |
| `invariants.sha256`     | the digest of that copy. `pnpm invariants:check` fails if `invariants.md` was hand-edited or the corpus has moved on.                       |
| `invariants-owned.json` | the ids that must have an owning test **right now**. `pnpm test:coverage-map` fails on a miss. Each phase adds its ids.                     |

## Keeping the registry honest

`invariants.md` is generated, never hand-edited:

```sh
pnpm invariants:sync    # recopy from the corpus (maintainer machines only)
pnpm invariants:check   # CI gate: the copy is unmodified and current
```

This gate exists because it already failed once. A partial copy carried **293** ids while
the corpus carried **424** after the 2026-09-11 merge pass, and nothing noticed — a short
registry silently shrinks `test:coverage-map`, so a phase can "own" every id it knows about
and still miss 131 real ones. The corpus is research and lives outside the repo, so CI
verifies the digest instead of the corpus.

## Adding coverage

Write a test whose name contains the id in brackets, then add the id to
`invariants-owned.json`:

```ts
it('[INV-DAY-01] streak is the maximal contiguous run of distinct days ...', () => {});
```

`test:coverage-map` also fails when a test claims an id that is **not** in the registry, so
a typo in an id cannot hide as coverage.
