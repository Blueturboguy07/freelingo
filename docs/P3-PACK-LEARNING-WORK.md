# Learning pack storage checkpoint — 2026-09-13

Local implementation evidence only; no Spanish pack, language-quality or phase release gate is claimed.

The read-only v1 base DDL is unchanged. New packs may carry an explicit grading:v1 capability with both exercise_runtime and indexed grading_word tables; legacy packs remain readable for catalogue/credits/recovery but do not gain invented runtime grading. The real G9 write_pack function now accepts the reviewed producer payload and exact dictionary credits, streams all word rows into the SQLite transaction, and replaces the destination only after success. Unknown table data and grading metadata without its complete payload are rejected. Dictionary notices retain their complete text separately from the credited owner in the loader's optional notice field; the App credits composition must render it.

Four schema falsifiers and fourteen initial real producer→SQLite checks first failed, then passed. Independent review found four same-ID SQL content mutations and a changed dictionary source proof that could publish stale grading or credit information. The writer now compares the actual complete exercise rows against the producer's frozen exerciseRowsSha256 and checks every streamed dictionary profile/count/hash/proof against frozen metadata both before and after complete consumption. These witnesses are committed as regressions. Existing files survive late source read errors with no partial output left behind.

Final affected gate: 118 Python checks and 118 TypeScript schema/loader/grading checks, zero failures or skips; Ruff, typecheck and lint exit 0. Evidence: /private/tmp/p3-grading-g9-reviewed.{log,xml,exit}, /private/tmp/p3-pack-learning-reviewed.xml. Independent witnesses: /private/tmp/p3-pack-learning-review/test_exact_writer.py (5 initial failures, 2 controls; all 7 pass unchanged after repair). The first notice test had a missing local helper; corrected and replayed against the old loader to record the actual lost-notice RED at /private/tmp/p3-dictionary-notice-red2.xml before green2.

Remaining integration: the production G9 stage must assemble its current reviewed population and call this optional writer path; runtime-item decoding, exact visible introduction events and actual authored Spanish grading data are separate work. No production approval, missing dictionary owner, language-review result or answer surface is supplied by a fallback.


## Native verification producer boundary — 2026-09-13

G8's 16-character clip identity describes generation inputs, not delivered file bytes. G9 now includes signed `audioFiles` entries measured from each delivered Opus file (relative path, byte count, SHA-256). The signing block also carries the exact compact Python payload bytes, bound to all unsigned manifest fields; this preserves numeric spellings such as `1.0` and `1e-07` when native JavaScript verifies the signature. Existing Python signatures remain verifiable without the additive payload field.

Three real producer counterexamples were red before the change. All 49 manifest/signing tests and Ruff pass. Independent review passed 13 additional Python witnesses and 8 repository/SQLite witnesses, including actual Python signing through the native repository with floats and Unicode; report `/private/tmp/p3-installed-pack-review/report.md`. No content population, production signing, CI phase gate or release was performed.
