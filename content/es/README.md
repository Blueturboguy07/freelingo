# `content/es/` — the Spanish course source

One file: [`curriculum.yaml`](./curriculum.yaml). It is the sixth input of the Spanish
language kit (`scope2/00` §2.1) — the A1 grammar-concept inventory plus the unit titles —
and it is the only part of a course a corpus cannot produce.

## It is original, and that is the one thing no test can check

**Every line of `curriculum.yaml` was written for this repository.** The thirty unit
titles, the thirty grammar-concept labels, the function labels, the section summaries and
the 990 target lexemes were authored here on 2026-09-12. Nothing was copied or
paraphrased from:

- the Instituto Cervantes' _Plan curricular_ (all rights reserved),
- the Council of Europe's CEFR descriptors, _Profile Deutsch_ or the CIEP
  _référentiels_ (commercial),
- Duolingo's unit titles, section names or guidebooks,
- any published course, syllabus, textbook, wordlist or CEFR lexicon.

Facts and levels are not protectable; **specific wording is**, and none was taken
(`scope2/00` §2.1 input 6, `03` F5–F6). This matters more here than anywhere else in the
pipeline: every other artefact is derived from something a validator can re-check, and a
copied unit title would pass `coursekit validate`, V1–V12, the reviewer sample and CI
without a single red mark. It is the one failure this file can have that no test catches,
so it is stated here instead.

## Licence

`curriculum.yaml` is **CC BY-NC-SA 4.0**, like everything under `content/` — see
[`../LICENSE`](../LICENSE) and [`../../NOTICE`](../../NOTICE) for why the content licence
differs from the code's AGPL-3.0. A derived course must carry the same licence and name
this repository.

## What is in it, and what G3 does with it

| In the file                                                                                                   | What it is                                                              |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `grammar_concepts[]` — 30 ids, each with a `label`, a `cefr` and a `probe`                                    | the A1 inventory. `probe` is how G4 decides a sentence exhibits it.     |
| `sections[]` — 3, each with `cefr_prose` and a `summary`                                                      | the section skeleton. `cefr_prose` is one of the seven shipped strings. |
| `sections[].units[]` — 30, each `title` / `function` / `grammar_concept` / `register_slot` / `target_lexemes` | the template of `scope2/00` §2.2, and the D1 tagging contract.          |

990 target lexemes across three A1 sections, 33 per unit, no lexeme introduced twice.
Sections 4–8 are **absent, not stubbed**: S023 renders future sections, and an empty
section is a visible unwritten section rather than a can-do promise nobody authored.

`level_count`, the global `unit_index`, `recycled_lemmas` and — the one that matters —
`section_cefr` are **not** in this file. G3 derives them:

- `level_count` from the published new-item budget (5–7 new words per lesson, `01`
  §Ordering), so the rate is satisfied by construction rather than asserted afterwards;
- `target_lemmas` as `target_lexemes ∩ the G2 lexicon`, budgeted — a lexeme the corpus
  never produced is deferred and counted, never silently dropped;
- `section_cefr` from **which grammar concepts a section contains**, then checked against
  the G2 lexicon's bands. That is the adversarial review's R23: CEFRLex is a per-lemma
  lexicon and the product attaches CEFR to sections (S023 `{{cefr_level}} • see details`,
  S024 `CEFR {{cefr_level}}`), so the shipped claim is a curriculum output and the lexicon
  is at best a sanity check on it.

## The A2 prose hole is real and is enforced here

Only **seven** `cefr_level_prose` values ship — `very early A1`, `early A1`, `high A1`,
`early B1`, `high B1`, `early B2`, `high B2` (str:2325–2331). **There is no A2 string**:
`high A1` is immediately followed by `early B1`, and the bare `A2` at str:2323 is a
`cefr_level` chip value, not prose (`deep/03` §review). A section whose derived chip is
`A2` therefore has a rendered chip and nothing to put in the S024 blurb. G3 reports that
rather than inventing a string. This course stops at `high A1` and never reaches it — the
rule is enforced anyway, because the fr/de/ja kits and Sections 4–8 will.

## Editing it

Change a title or a lexeme list, then re-run `coursekit build es --only g3 --only g4`.
The solver is deterministic: the same file produces the same ledger. Two things will
fail loudly rather than degrade —

- a unit whose `target_lexemes` cannot fit the new-item budget at any level count;
- a `grammar_concept` whose `probe` has no clauses, which would match every sentence and
  make the grammar constraint vacuous.

Adding a lexeme that already appears in an earlier unit is also refused: a lemma has
exactly one introduction unit, and V1 is the promise that nothing appears before it.
