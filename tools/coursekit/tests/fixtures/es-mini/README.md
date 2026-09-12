# `es-mini` — the Spanish fixture every P2 lane builds against

200 Spanish/English pairs, a surface-form frequency list, a lemma map and a banded lemma
table. It exists because P2 runs as two waves over eight lanes and **a lane in wave 2
cannot consume another lane's live output**: G4 needs a ledger before G2 is written, G7
needs selected items before G4 is written, and a lane that waits for its upstream does
nothing for a week. This is what they develop and test against instead.

## Provenance — the part that matters

**Every Spanish sentence here was written for this repository.** Not copied, not
sampled, not paraphrased: not from Tatoeba, OPUS, OpenSubtitles, NLLB, Cervantes,
Duolingo, or any lexicon or course. They are ordinary A1 sentences about greetings,
family, food, numbers, colour, the house, work, the city, weather and a daily routine —
twenty of each — because that is the register the pipeline has to handle and because
nobody owns "La casa es blanca."

That matters for more than tidiness. `INV-PACK-13` puts the licence allow-list at
**ingest**, before G0 reads a byte, and the invariant registry calls it "the only
invariant whose failure cannot be fixed after release". A fixture carrying corpus text
of unclear provenance would be exactly the thing that invariant exists to stop, sitting
inside the test suite that is supposed to enforce it.

## Licences, and why there are two

| Rows             | Licence     | `attribution_required` | `attribution_owner`      |
| ---------------- | ----------- | ---------------------- | ------------------------ |
| 160              | `CC0-1.0`   | `false`                | `null`                   |
| 40 (every fifth) | `CC-BY-4.0` | `true`                 | `Freelingo contributors` |

Both grants are real — the text is original to this repository, so it can be released
under either — and the split is deliberate. `V10` and `INV-PACK-13` need rows that carry
a resolved licence; `INV-PACK-17` needs rows whose attribution has to be **reachable
from a rendered credits surface** (S152, itself reachable from the report sheet S045 and
About S137). A fixture that was uniformly CC0 would let an attribution bug pass every
test in the suite, because no row would ever require attribution.

The real Spanish course is not CC0 either. The review measured the Tatoeba CC0 subset at
**2,266 bytes for `spa`** (228 B for `jpn`, 1,852 B for `deu`) against a 6.3 MB full
export, so "use the CC0 subset and skip the credits screen" is not an option that exists
for three of the four v1 languages. Attribution is the shipping path, and this fixture
exercises it.

## What is in here

| File              | Shape                                   | Notes                                                                                                                                                                     |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sentences.jsonl` | `ingested_sentence` records (G0 output) | Validates against the frozen contract in `coursekit.artifacts`.                                                                                                           |
| `frequency.tsv`   | `surface<TAB>count`, desc               | hermitdave's shape **on purpose**: surface forms, not lemmas. Its real lists are the same, which is why they must go through the G1 adapter before they touch the ledger. |
| `lemma-map.tsv`   | `surface<TAB>lemma<TAB>pos`             | Produced by `es_core_news_md` 3.8.0, the wheel pinned by URL in `pyproject.toml`.                                                                                         |
| `banded.jsonl`    | `banded_lemma` records (G2 output)      | 348 lemmas, `band_source: "frequency_decile"`.                                                                                                                            |
| `manifest.json`   | counts and licences                     | What the tests assert against.                                                                                                                                            |

## Everything here is re-derived by the tests, not trusted

`tests/test_artifacts.py` recomputes, in plain Python with no model loaded:

- every `sentence_id` and `dedup_hash` from the text;
- the whole of `frequency.tsv` from `sentences.jsonl`;
- every lemma frequency in `banded.jsonl` by summing `frequency.tsv` through
  `lemma-map.tsv`;
- every `decile` from the rank, and every `band` from the decile.

A separate test loads the pinned spaCy model and checks `lemma-map.tsv` is what that
model actually produces — skipped when the `nlp` group is absent, run in CI, which syncs
it. So if somebody bumps the lemmatiser, the fixture goes red rather than quietly
re-partitioning under the lanes that build on it. That is the same hazard the `nlp`
group's wheel-URL pin exists for, at fixture scale.

## The fixture is not a registered source

`source_id` is `freelingo-fixture`, and nothing by that name exists in
`config.SOURCES`. `coursekit.inputs.resolve` therefore refuses it, which is the point:
no build path can reach this data, and a fixture sentence cannot end up in a pack.

## Regenerating

Regenerate only to add sentences or after a deliberate lemmatiser change — never to make
a failing test pass. The generator lives with the change that needs it; the derivation
rules it must follow are the ones the tests above assert, and the band rule is exactly:
deciles 1-4 → A1, 5-7 → A2, 8-9 → B1, 10 → B2.
