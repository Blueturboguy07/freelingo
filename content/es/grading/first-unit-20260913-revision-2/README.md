# Spanish first-unit author revision 2

Eleven **unreviewed author candidates**: three recognition introductions and eight replacements for the rejected candidates in author commit `7dc0bd2e37119fce64e764daf517549d5a980249`. No frozen author or review file is changed. The preceding independent review is committed separately as `1f6e3cf` under `docs/content/es-first-unit-20260913-review/`.

The proposed first session shows **hola → día → noche** as visible Spanish prompts with a NEW WORD cue, English choices, and exact prompt-phase introduction declarations. All three use `meaningSelect`, a recognition role. They have no image or audio dependency. Source-backed Spanish scheduler surfaces and lexical identities are declared explicitly; English wrong options provide no Spanish teaching credit. The actual app still needs independent approvals and integration before this can launch. Loading this proposal is not a display receipt.

The existing four-hour production delay is unchanged. The eight typed revisions are a later candidate pool, **excluded from this first session**. `first-session.json` is only a first-session proposal; it is not a replacement complete path, Score ceiling, CEFR claim, or declaration that the 173 original first-unit exercises can be dropped. The approved G3 unit still has three levels and six sessions. Full path/source-population reconciliation remains required.

## Sources and revisions

`authoring.json` binds each changed candidate to the original row's canonical SHA256. `bundle/source-changes.json` records proposed new source, exercise, and semantic item IDs. The new source IDs belong to this authoring proposal: they are **not claimed to be issued G0 or accepted G5 IDs**. G7/G9 integration must join the actual source/approval identities obtained by the pipeline. No proposed SQLite row has been inserted.

| Original exercise | New whole source / task |
|---|---|
| `57b13098f7415a04` | `Hola, buenas noches.` / `Hello, good evening.` corrects the arrival greeting. |
| `fed7d95f643679e3` | `Adiós, buenas noches.` / `Goodbye, good night.` is one coherent departure; explicit reversed-order Spanish alternative. |
| `36ba32390399ac9f` | `Sí, por favor.` / `Yes, please.` accepts both authored Spanish orders. |
| `464154843186dcc4` | Spanish `Ella es buena.` becomes reverse typing with natural character/quality English answers. |
| `ba369b2c6536fec7` | `Encantado, mucho gusto.` has natural English meeting-formula answers. Reserved `encantado` remains. |
| `8844061cfdcc221d` | Spanish `Bien, gracias. ¿Y tú?` becomes reverse typing with explicit English short/expanded replies. |
| `27adb987c8bb5e3d` | `Bien. ¿Y tú?` accepts the concrete omitted English replies. |
| `8bd62a7a1c4ce632` | `Mucho gusto, señor.` / `Nice to meet you, sir.` replaces the awkward meeting/departure combination. |

The two changed primary objectives are explicitly authored decisions, not silent token fixes. The departure now has `noche/NOUN` because its former `sí` no longer occurs. The polite affirmative has `favor/NOUN`: actual canonical G1 reads `sí/ADV`, while frozen G2 declares `sí/INTJ`. Both chosen objectives occur in the real canonical G1 and unchanged G2. Their prior objectives and reasons remain in `objectiveChange`. All eight candidates have lexical objectives and claim no new grammar-concept teaching; the unit grammar context remains in the source snapshots.

Reverse routing keeps the natural source meanings without adding unvalidated Spanish `estar`/`persona` vocabulary to the existing lesson allowance. English alternatives are reverse-only. These are proposed supported sets for independent review, not a claim to enumerate every possible paraphrase.

`inputs/` contains exact selected G4, G3, G2, and three existing independently accepted glossary rows, plus hashes of their original full files. The fresh G4 windows are authoritative; the older sentence-local known lists are not substituted. Bare `hola` retains the parser's real POS output; its intended INTJ lexeme uses the separately reviewed G2/glossary evidence supported by the producer's lexical-source contract. No G1 tokens or G2 ranks are changed.

`inputs/local-analysis.json` records actual `spacy_es` / `es_core_news_md-3.8.0` analysis and current G5 `_axis` checks for all 13 Spanish surfaces. The verb-less early lesson uses the existing `min_tokens_for_slot` exception; later canonical sources retain the actual minimum of three. All reserved targets, known/new windows, and unit register checks remain in force. This read-only local check is not a G5 stage, full candidate inventory/20-row-floor evaluation, LanguageTool/G6 certification, or independent linguistic approval. Every source and alternate still needs the current upstream approval route.

Proposed introduction SQL slots are explicitly 0/1/2. The eight replacements retain their original SQL lesson/slot positions; these differ from source G4 slot indices, which remain separately exact. A new first-session proposal must be reconciled with the preserved original population during path integration.

## Deferred illustrations

`assets/` contains three original CC BY-NC-SA 4.0 SVGs and their real 384×384 PNG renders. They were rasterized using the already-installed `rsvg-convert` and visually inspected. `bundle/assets.json` binds exact bytes, source, creator, notice, and image descriptions. The separate picture previews have **no approval** and are blocked by the missing verified native image resolver. They are excluded from the active first session and do not block its image-free recognition route.

## Local verification and replay

The new exporter uses no added dependency and imports no production compiler until requested. Run with an explicit existing interpreter and source trees; `-P` prevents its own adjacent checkout from shadowing the chosen `coursekit` package. Each command writes a new output path; existing evidence must be preserved when rechecking.

```sh
PYTHONPATH="$UPSTREAM/tools/coursekit/src" "$PYTHON" -P tools/coursekit/src/coursekit_es_u1_revision.py analyse --revision content/es/grading/first-unit-20260913-revision-2 --out /private/tmp/es-u1-current-analysis.json
PYTHONPATH="$COMPILER/tools/coursekit/src" "$PYTHON" -P tools/coursekit/src/coursekit_es_u1_revision.py check --revision content/es/grading/first-unit-20260913-revision-2 --out content/es/grading/first-unit-20260913-revision-2/bundle
PYTHONPATH="$COMPILER/tools/coursekit/src" "$PYTHON" -P -m pytest tools/coursekit/tests/test_es_u1_revision.py tools/coursekit/tests/test_es_u1_authoring.py -q
"$PYTHON" -P content/es/grading/first-unit-20260913-revision-2/verification/guard_mutations.py --module tools/coursekit/src/coursekit_es_u1_revision.py --revision content/es/grading/first-unit-20260913-revision-2
```

The integrated tests regenerate the bundle into a temporary directory and require byte-identical files. Compiler/source/driver hashes are checked; stale analyses, incomplete populations, shifted token spans, changed source identity, rejected local axes, author self-approval, wrong target options, and production introductions are refused. Test-first logs, scoped test output, unchanged core role/delay caller results, and four isolated guard-removal mutations are recorded under `verification/`.

No full pack build, G6 approval, full validator/sample gate, signing, TTS, native UI run, or paid native review was performed. **PROVISIONAL (unreviewed by a paid native speaker)**. Independent reviewers must bind the new authoring, candidate, source, explanation, objective, lexical and surface objects to their exact hashes; this author cannot approve their own revision. Reviewed response-language profiles, dictionaries/teaching policy, current source approvals, actual G7/G9 integration, and a complete approved path remain required for assembly.
