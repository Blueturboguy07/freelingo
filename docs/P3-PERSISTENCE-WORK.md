# P3/P4 durable persistence work — 2026-09-13

Implementation checkpoint; no phase or native gate is claimed.

Migration v5 adds complete per-surface scheduler cards, modality membership, mastery high-water/set, append-only introduction and anomaly records, historical hold windows, ordered attempt facts and staged exact-variant answer receipts. Old day-grained item rows and incomplete historical attempts remain explicit legacy evidence; no surface card is fabricated from them. Session context/slot binding and day/reward carriers follow in later migrations.

Eight real SQLite falsifiers first failed before migration, then passed: independent surfaces, signed replay chronology, answer-time/variant receipts and rollback, migration interruption, introduction ordering, hold/anomaly history, course cascade and legacy preservation. Evidence: `/private/tmp/p3-scheduler-schema-{red,green}.xml`. Full schema checks: `/private/tmp/p3-scheduler-schema-all2.xml`; typecheck, scoped lint and diff checks passed. The initial full run hit the existing 60-second timeout in the 10,000-case active-time ledger property after expanding migration setup. That property now migrates once and resets its ledger/totals between the same independent histories; it still executes PROPERTY_RUNS real SQLite commit histories and the same assertion.

The golden generator retains every existing historical database byte rather than regenerating old evidence. All v0–v4 SHA256 comparisons are identical (`/private/tmp/p3-scheduler-golden-byte-audit.json`); only their forward expectations add the declared defaults/nulls/empty tables. New v5 includes two surfaces, an exact variant receipt, an ordered replay, mastery and closed hold/anomaly evidence. All golden forward checks passed.

The iOS stable-boot-clock decision remains pending. These SQL carriers do not relax that policy or assert native timing evidence.

## v6 launch, completion intent and daily pools

Six new SQLite falsifiers reproduced RED and passed after implementation. Migration v6 retains immutable original economy flavour, practice ratio, exact pack hash, start zone/clock and captured boost. A complete first-write completion stamp freezes its active time too; retry cannot silently shift the reward day. Slots bind the exact source exercise and semantic item, with a composite owner FK. Committed attempts gain nullable legacy-safe source exercise/pack hash columns. Daily review has an explicit empty-day marker, serve-time spent state, and separate Hub offers/completions. Global onboarding and selection seed remain account facts; course selectors cascade and enforce at most one active/selected row. Startup reconciliation and actual adapter actions remain separate implementation work.

Evidence: `/private/tmp/p3-context-schema-{red,green,all}.xml`. All94 schema checks, typecheck, scoped lint and diff checks passed. v0–v5 committed DB bytes remain identical (`/private/tmp/p3-context-golden-byte-audit.json`); v6 fixture includes an active exact-variant binding, empty and spent pools, fallback Hub completion and account/course selectors. No native/UI gate is implied.
