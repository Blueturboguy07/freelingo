# Spanish first-unit author revision 3

This is a separate authoring revision of frozen `c0c5c5dd0741793bad19de362b7de96fdf2b0996`, following the independent review recorded by root in `f4bc2f9`. It adds the two concrete English answer omissions and a six-exercise recognition starter. **This author has not independently approved these changes.** All older author bundles and reviews remain intact.

## What changed

`b03de7ed176e07a1` retains its eight English answers and appends ten explicitly authored well/fine/good/thanks replies. `16f59b19698b62a0` retains its seven answers and appends “I'm good. And you?” and “I am good. And you?”. The canonical answer, exact Spanish source, exercise ID, semantic item ID, scheduler surfaces and lexical bindings remain unchanged. The other nine candidate rows are byte-equivalent after canonical serialization; their hashes are recorded in `bundle/changes.json`.

The starter preserves the three independently accepted introductions and adds:

| Order | Spanish prompt | Correct English choice | Source and objective |
|---|---|---|---|
| 1 | hola | hello | Unchanged accepted introduction. |
| 2 | día | day | Unchanged accepted introduction. |
| 3 | noche | night | Unchanged accepted introduction. |
| 4 | bueno | good | Exact current G2 ADJ and independently reviewed glossary; G4 slot 1. |
| 5 | tarde | late | Exact current G2 ADV and independently reviewed glossary; G4 slot 3. The noun “afternoon” is a different sense. |
| 6 | Hola, buenas noches. | Hello, good evening. | A new recognition shape over unchanged source `34a30591894d99bc`, exact G4 slot 4, targeting its actual noche/NOUN. |

There are **six distinct semantic exercise items, six displayed Spanish surfaces, and five lexical word identities**. The phrase reuses the same noche word identity; it does not create a sixth word. The actual introduction budget uses the six declared scheduler items, below the unchanged fresh-day cap of 40. All six are `meaningSelect` recognition; the five bare words have NEW WORD and the full greeting has NEW PHRASE. The exact visible Spanish prompt is the introduction witness. English decoys teach no Spanish vocabulary. No images, audio, unseen production items, duplicate exercise IDs, or synthetic due rows pad the queue.

The greeting was already an authored whole source in revision 2. This variant keeps that source object and ID exactly, and keeps the older typed candidate unchanged. Its shared surface previously had `introduction:null`; this proposal adds its first explicit prompt-phase introduction declaration for the new recognition exercise. It does not replace an existing display declaration or claim that loading the catalog is an exposure receipt. Only two new source objects, bueno and tarde, are added. Their IDs are proposal identities, not claimed issued G0/G5 IDs.

The preliminary `Buenas noches.` draft was rejected before export because actual G1 tagged noches PROPN. Its authoring and actual analysis remain under `verification/rejected-first-draft/`. No parser output was relabeled. The existing full greeting has the actual noun analysis and is reused instead of manufacturing a duplicate sentence record.

## What the local evidence proves

- Three actual pinned `spacy_es` / `es_core_news_md-3.8.0` analyses and unchanged current G5 `_axis` checks pass over exact frozen G4 windows; all required targets, allowed lemmas and register checks remain. The existing early verb-less minimum policy admits the bare words. No minimum was lowered.
- Fourteen actual production exercise-schema and shape checks pass, covering the complete revised subset.
- Sixteen focused Python checks pass with zero skips, including a byte-identical export replay, preservation of all old source objects and nine candidate rows, exact canonical IDs, six visible introductions/five word identities, and refusals of stale/missing/self-approved source evidence. The test-first source-kind integration run had two failures among eight tests; the earlier missing-module collection failure is setup evidence only.
- Three actual core generator/budget tests pass. The exact six authored variants yield `offered:true`; removing any one yields `offered:false` under the unchanged six-item lesson minimum and empty due pool. The unchanged four-hour production gate is false immediately before its boundary and true at it. The real generator result is in `verification/generation.json`.
- Four isolated guard removals each make their corresponding actual rejected falsifier pass, recorded in `verification/guard-mutations.json`. These do not mutate production files.

The generator witness uses the exact authored candidate set as its resolver input, with no asset/audio requirements. This proves the real generator accepts this population; it **does not** prove an installed signed pack, verified runtime decoder, source approval, native rendering or complete path integration. `first-session.json` remains a proposed first session, not a replacement for the approved G3 three-level/six-session path or its full exercise population. New proposed SQL slots are 3/5/6; the old typed slot 4 and three introductory slots 0/1/2 remain.

## Replay and review

Use the existing interpreter with explicit source paths and `-P`; no dependencies are added. The compiler and source fingerprints are recorded in the bundle and verification provenance. From the worktree:

```sh
PYTHONPATH="$COMPILER/tools/coursekit/src" "$PYTHON" -P tools/coursekit/src/coursekit_es_u1_revision3.py check --revision content/es/grading/first-unit-20260913-revision-3 --out content/es/grading/first-unit-20260913-revision-3/bundle
PYTHONPATH="$COMPILER/tools/coursekit/src" "$PYTHON" -P -m pytest -p no:cacheprovider tools/coursekit/tests/test_es_u1_revision3.py -q
"$PYTHON" -P content/es/grading/first-unit-20260913-revision-3/verification/guard_mutations.py --module tools/coursekit/src/coursekit_es_u1_revision3.py --revision content/es/grading/first-unit-20260913-revision-3
```

For a fresh local analysis, run `analyse` with `PYTHONPATH="$UPSTREAM/tools/coursekit/src"` and a new output path; it never overwrites evidence. For the actual generator, use the checked-in `verification/vitest.config.mts` and `first-session.test.ts` with the explicitly recorded installed p3-app core source. These are three narrow Node tests, not a broad property or native suite. XML evidence is losslessly gzipped to retain its exact original bytes.

Independent review should bind each changed candidate, source, explanation, scheduler objective, lexical binding and affected catalog row to its exact canonical hash. The nine untouched candidate decisions can retain their existing exact-hash provenance; no prior review is copied onto changed objects. `verification/review-request.json` lists the proposed objects and hashes, with no approval fields.

Current G6/source approvals, the reviewed lexical-source adapter, response profiles and dictionaries, teaching policy, G7/G9 insertion, full path population reconciliation, validators/sample, signing and actual native launch remain pending. No hosted call, G5 stage/20-row-floor run, full pack build or paid native review was performed. **PROVISIONAL (unreviewed by a paid native speaker)**.
