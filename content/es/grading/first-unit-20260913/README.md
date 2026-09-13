# First-unit Spanish runtime authoring candidates

Status: **unreviewed authoring candidates; assembly blocked**. This is a bounded
20-exercise proposal from the immutable first-attempt RED Spanish output, not a
new course build, a complete first unit, or a passing content gate. There are no
independent review files or G6 approvals in this directory. Paid native review is
still absent: **PROVISIONAL (unreviewed by a paid native speaker)**.

`authoring.json` is the human-readable source of the 20 explicit decisions: input
shape, instruction/body, answer texts with authored preference ranks, one primary
objective, display event, explanatory feedback, source concerns, and lexical
meaning/classification. Its seven excluded typed sources have specific reasons.
The20 chosen SQL rows span all six original lessons and three original levels;
the full frozen first unit contains 173 exercises. No row or curriculum target was
erased from that frozen population.

## Exact machine-consumable files

- `bundle/source-facts.json` preserves complete actual selected SQL exercise/tag/
  lexeme/unit/sentence rows, matching G7 records, original G3 declaration and G2
  rows, and each exact G4 choice plus G5 first accepted candidate or corpus G0/G1.
  SHA256 binds all nine original input files, including the SQLite and runlog.
  Source joins use the chosen G4 slot and first surviving G5 candidate. The SQL
  reader uses an immutable main-file connection; no WAL rows enter a hashed source.
- `bundle/candidates.jsonl` has 20 unreviewed wrappers. Each `draft` follows the
  frozen runtime draft carrier **except the deliberately absent approvalId /
  approvalSha256 and review objects**. It preserves the real `record` unchanged.
  `proposedAnswers` and `presentation` express the new author's candidate set.
  Thus eight drafts need an explicit accepted-answer source amendment before the
  production writer can accept their G7/SQL joins. They are not silently projected
  into the old record or labelled approved.
- `bundle/lexical-catalog.jsonl` has eight explicit lexical declarations; seven are
  countable words, affirmative sí is explicitly an excluded particle. Meaning,
  canonical lexical surface and classification are authoring judgments awaiting
  review. Existing content-hash item IDs are derived using the actual producer's
  unchanged semantic recipe. Exact SQL lemma/POS and contextual token joins are
  required; the aggregate exercise scheduler IDs remain unchanged.
- `bundle/surface-catalog.jsonl` has 39 explicitly ranked response/target surfaces.
  Introduction witnesses are the exact Spanish prompt for reverse translation or
  first wrong-feedback answer for forward translation. These are potential display
  events, not evidence that a learner has observed anything.
- `bundle/path-candidate.json` proposes three canonical lesson nodes with two
  sessions each. The helper fills only the explicitly referenced lesson's exact
  chosen SQL exercise IDs, in actual slot order. `path-preflight.json` is the real
  path compiler's result for this bounded subset, with exact source hashes. The
  candidate declares a 9-point ceiling and `cefrChecked:false`; those are unapproved
  subset policy declarations, not a copied old pack CEFR claim. No full-pack path
  is emitted and no omitted original exercises disappear from the frozen source.
- `bundle/candidate-checks.json` records each structural result and source
  amendment. `production-refusal.json` records the actual production builder's
  failure on its genuinely absent approval validator. No always-true callback or
  fabricated review is supplied.
- `bundle/manifest.json` binds every output, the authored input, this helper's exact
  bytes and the four actual production compiler modules. Replay rejects drift.

## Deterministic replay

The helper is a new standalone module, with no shared CLI or dependency changes.
P6 alone predates the P7 grading/path compiler. Use the actual frozen compiler tree
explicitly; Python `-P` prevents the script directory from shadowing that tree.
The manifest rejects different compiler bytes. After integration, the equivalent
combined tree can be used if those module hashes still match.

```sh
export PYTHONPATH=/Users/mannbellani/freelingo-wt/p3-app/tools/coursekit/src
/Users/mannbellani/freelingo-wt/p7-kits/tools/coursekit/.venv/bin/python -P \
  /Users/mannbellani/freelingo-wt/p6-media/tools/coursekit/src/coursekit_es_u1_authoring.py \
  check --source-root /private/tmp/p2r5-ci-fca9/candidate \
  --authoring /Users/mannbellani/freelingo-wt/p6-media/content/es/grading/first-unit-20260913/authoring.json \
  --bundle /Users/mannbellani/freelingo-wt/p6-media/content/es/grading/first-unit-20260913/bundle
```

Use `export` with the same inputs and a **new empty destination path** to produce
another deterministic copy. Existing output directories are never overwritten.
Commands should run in a logged background job per repository policy. The helper
reads the source artifacts and writes only that explicitly new candidate directory;
it never invokes G0–G9, G6, signing, TTS or SQLite writes.

Focused tests use the actual compiler and original independent synthetic source
facts, not production-review substitutes:

```sh
PYTHONPATH=/Users/mannbellani/freelingo-wt/p3-app/tools/coursekit/src \
/Users/mannbellani/freelingo-wt/p7-kits/tools/coursekit/.venv/bin/python -m pytest \
  /Users/mannbellani/freelingo-wt/p6-media/tools/coursekit/tests/test_es_u1_authoring.py -q
```

The standalone P6 tree skips this one test module if its unintegrated production
compiler is unavailable; the explicit command above executes every witness. No
fixture fallback is substituted. This checkpoint does not claim a full-tree gate.

## Separate independent review and next assembly prerequisites

Reviewers should write a separate sidecar outside this authoring bundle, naming
reviewer/date, exact manifest and authoring file hashes, and one decision per
candidate exerciseId + SHA256 of the full candidate row. Include verdict and
specific notes for meaning, legitimate alternate completeness, preference ranks,
primary objective, lexical meaning/classification, and actual display witnesses.
Review each lexical/surface catalog row using its lexemeId/surfaceId and exact row
hash. For producer-ready component judgments, separately bind the exact
`draft.explanation`, `draft.schedulerObjective`, and every `draft.lexicalBindings`
row. Hash canonical UTF-8 JSON with sorted keys and no spaces; exclude only the
future `review` field. A review of these proposals is not a G6 approval or a claim
that proposed alternatives already exist in the source.

Before executable runtime assembly: adjudicate these source notes and eight answer
amendments, regenerate only the explicitly approved affected sources/identities,
obtain current full selected-source answer/G6 proof including each new Spanish or
English surface, finish reviewed profile/lesson/taught-form declarations and their
actual normalized dictionary proofs/credits, then run `build_grading_payload` with
its real approval validator and reviewed catalogs. Source-analysis defects are
preserved (e.g. hola PROPN, tardes versus SQL tarde POS, Señor/Señora POS); this leaf
neither coerces them nor declares them language-quality successes.
