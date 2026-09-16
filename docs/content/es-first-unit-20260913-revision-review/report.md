Independent Spanish revision review — 2026-09-13

**Nine candidate answer sets accepted; two need revision. The proposed first session is not launchable.** This is a review of eleven deliberately selected author candidates at commit c0c5c5dd0741793bad19de362b7de96fdf2b0996, not a random sample or a new pack error-rate measurement. **PROVISIONAL (unreviewed by a paid native speaker)**.

The three recognition introductions correctly show hola, día and noche as Spanish prompts with one valid offered English meaning each. Their English distractors do not teach unseen Spanish, and none needs audio or images. The eight source revisions remove the earlier greeting/context problems and use natural preferred translations. Two unrestricted English answer sets still omit ordinary equivalents:

| Candidate | Required author revision |
|---|---|
| b03de7ed176e07a1 — Bien, gracias. ¿Y tú? | Include and review the explicit well reading already promised by the explanation, such as “Well, thank you. And you?” and “Well, thanks. And you?”. The ordinary “I'm fine, thanks. And you?” also remains absent. |
| 16f59b19698b62a0 — Bien. ¿Y tú? | The set accepts short “Good” but omits the common expanded replies “I'm good. And you?” and “I am good. And you?”. |

These are linguistic judgments about the exact submitted forms and omissions. No assembled grader was run, and no unlimited-paraphrase acceptance is claimed. Individual accepted surface/explanation/lexical decisions do not approve the completeness of a rejected candidate's answer set.

The first-session proposal contains exactly three exercises. An independent witness imports the current production generateSession and DEFAULT_FLAVOUR_MATRIX, maps those exact candidate IDs to real registry families, supplies the fresh account's empty due pool and leaves the lesson configuration unchanged. It returns offered=false, reason=nothingDue, and an empty queue because the minimum is six. See [generation.json](generation.json), [first-session.test.ts](first-session.test.ts) and [first-session.xml](first-session.xml). The witness passes because it reproduces this block; it does not certify a runnable lesson. Content must supply enough eligible authored sources and preserve the existing four-hour production delay. The later typed sources also need their exact target introductions in the complete path.

[review.py](review.py) reproduces source hashes, exact SQL proposal/record/response/lesson joins, canonical-first answer ranks, Spanish display surfaces, token offsets, semantic word identities and recognition option separation. It checked 11 source/candidate rows, 48 surface declarations, 7 lexical declarations and 13 bindings. The author's frozen-bundle check also replayed successfully against the pinned current compiler. Logs are in [run.log](run.log); the actual check results are [checks.json](checks.json). This replay checks the recorded local G5/production-shape evidence; it does not run G6 or full pack validation.

[decisions.jsonl](decisions.jsonl) holds 113 independently authored judgments with exact canonical object hashes; [review-manifest.json](review-manifest.json) binds every frozen input file. Source-pair judgments cover text and preferred translation, not the correctness of every preserved parser annotation. In particular, hola's intended interjection comes from its reviewed lexical evidence while the recorded parser output remains untouched. Deferred illustration assets are hashed for provenance but were not included in this linguistic review.

The next author pass must correct the two response sets and expand the starter population. Current whole-source and alternate approvals, reviewed response-language profiles/dictionaries, full path reconciliation, G7/G9 assembly, fresh validators/sample scoring and paid native review remain necessary. This review changes no authoring bytes, approves no source on the author's behalf, publishes nothing, and marks no phase gate green.
