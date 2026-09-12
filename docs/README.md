# `docs/`

| File                    | What it is                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `invariants.md`         | the invariant registry, a **verbatim** copy of the research corpus (`~/duolingo-research/deep/00-INVARIANTS.md`). The single source of ids. |
| `invariants.sha256`     | the digest of that copy. `pnpm invariants:check` fails if `invariants.md` was hand-edited or the corpus has moved on.                       |
| `invariants-owned.json` | the ids that must have an owning test **right now**. `pnpm test:coverage-map` fails on a miss. Each phase adds its ids.                     |
| `ci.md`                 | what each workflow proves: the property floor, the Maestro flow guard, and how INV-PLAT-02 compares two prebuilds.                          |

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

### Python (`tools/coursekit`)

A Python function name cannot hold `[`, so there are **two** accepted claim forms and both
gates read both. Use either; several files use both on the same test.

**In the `def` name**, as the snake form of the id — what pytest prints and what
`pytest -k inv_aud_08` selects. Read case-insensitively, so `test_inv_aud_08_…` and
`test_INV_PACK_40_…` both count, and the digits are read verbatim (`inv_aud_08` →
`INV-AUD-08`, never `INV-AUD-8`):

```python
def test_inv_aud_08_the_rebake_key_includes_the_engine() -> None: ...
def test_INV_PACK_40_no_consumer_carries_its_own_inlined_notion_of_a_token() -> None: ...
```

**Or leading the test's own docstring**, in brackets — the direct analogue of
`it('[INV-DAY-01] …')`:

```python
def test_the_stage_refuses_a_forbidden_corpus(...) -> None:
    """[INV-PACK-13] refused at resolve(), before any request is made."""
```

**Leading only, and only a test's own docstring.** An id anywhere else in a docstring is
prose: `test_ledger_unit.py` cites INV-MOD-13 to explain why a test exists and does not
test it, and a whole-docstring scan would report that id as owned — silently, in a green
run. Module docstrings and assertion messages are never read.

Two conventions exist because two P2 lanes invented one each and both shipped real tests.
Reading one and not the other un-owned half of P2 while looking exactly right, which is
what the P2 integration found; see `docs/P2-REPORT.md` §3.
