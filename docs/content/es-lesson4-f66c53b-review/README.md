# Independent lesson4 authoring review — 2026-09-14

Six lexical recognition proposals are accepted at the linguistic/component level. All 100 raw Spanish/English pairs are natural, meaning-preserving source proposals; 83 cannot currently enter these destination windows. This review is bound to root author commit `f66c53b79357f9f5e1ecadde00604dcd0fad5307` and does not edit its files.

The six explicit answer sets for nombre, apellido, señor, señora, mucho and yo are sound. Every offered option set has exactly one accepted choice and avoids obvious valid synonyms as decoys. Exact canonical G2 IDs and G4 hashes match. A real pinned `spacy_es` self-test and analysis confirmed all six declared bare lemma/POS pairs. The additional accepted forms are explicit independently reviewed sets here; this does not promote all contextual glossary exclusions into answers. Yo was already a known G4 lemma: six proposals are not proof of six new word introductions or runtime scheduling eligibility.

## Actual source checks

The unchanged G5 `_axis` ran read-only over all 100 canonical raw pairs with each exact frozen G4 ledger, current POS-based minimum and existing same-unit corpus duplicate set. No stage ran, no raw bank was loaded/modified, no candidate was selected, and no backtranslation/perplexity/LanguageTool/G6 result was invented.

| Gap / target | Raw proposals | Pass current G5 axes | Reject vocabulary |
|---|---:|---:|---:|
| 4 / nombre | 20 | 1 | 19 |
| 5 / apellido | 20 | 1 | 19 |
| 6 / señor | 20 | 6 | 14 |
| 7 / señora | 20 | 6 | 14 |
| 8 / mucho ADV | 20 | 3 | 17 |

Rows 57 and 77, “Por favor, señor/señora, espere.”, are grammatically sound formal requests but use usted imperative **espere**, incompatible with default-tú unit1. G5 rejects them first as out-of-vocabulary; the independent register finding is preserved separately. Retain both raw rows as rejected inventory, without silently changing the wording.

Row 21, “Apellido, por favor.”, is the sole G5-compatible surname sentence, but the actual source analysis labels Apellido **PROPN**. It therefore does not yet prove the intended apellido/NOUN whole-source runtime lexical objective. The separate bare apellido source does analyze as NOUN. A later author revision can supply a natural contextual noun source and fresh analysis; never relabel this token or carry the old review to different text.

The three compatible mucho rows are “No, no mucho.”, “No mucho, gracias.” and “Sí, mucho, gracias.”; their actual target token is ADV. The 20-row raw floor remains intact for each gap, including rejects. Eight exact overlaps with the historical bank remain explicitly documented by the author; these are not claimed as 100 new loaded rows, and current submission must reconcile exact slot/ledger/duplicate identities before stage counting.

There are 224 exact component/check decisions and a separate 100-pair `rubric.jsonl` sidecar. The scorer actually reread each Spanish pair under the unchanged published v1 rubric: 94 score 4 and six score 3 for explicit conventional English wording differences. `independent-readings.txt` records the agent’s English readings; this is not a model round-trip, an engine run, or a G6 approval. Each score binds the complete raw row, exact two-language pair, slot/order and rubric hash. The two formal espere requests retain score 4 because the shown English preserves their polite meaning/address; the separate destination-register rejection is not translation loss. No score was inferred from a prior accepted boolean.

There are 224 exact component/check decisions. Linguistic pair acceptance is not a complete typed answer inventory, G6 grammar/pair proof, runtime teaching credit or permission to replace a selected corpus source. Current source submission/selection, full answer proof, actual generator/producer/loader integration, native display, validators/sample and CI remain required. No new full pack gate was run.

**PROVISIONAL (unreviewed by a paid native speaker)**.
