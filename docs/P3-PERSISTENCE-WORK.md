# P3/P4 durable persistence work — 2026-09-13

Implementation checkpoint; no phase or native gate is claimed.

Migration v5 adds complete per-surface scheduler cards, modality membership, mastery high-water/set, append-only introduction and anomaly records, historical hold windows, ordered attempt facts and staged exact-variant answer receipts. Old day-grained item rows and incomplete historical attempts remain explicit legacy evidence; no surface card is fabricated from them. Session context/slot binding and day/reward carriers follow in later migrations.

Eight real SQLite falsifiers first failed before migration, then passed: independent surfaces, signed replay chronology, answer-time/variant receipts and rollback, migration interruption, introduction ordering, hold/anomaly history, course cascade and legacy preservation. Evidence: `/private/tmp/p3-scheduler-schema-{red,green}.xml`. Full schema checks: `/private/tmp/p3-scheduler-schema-all2.xml`; typecheck, scoped lint and diff checks passed. The initial full run hit the existing 60-second timeout in the 10,000-case active-time ledger property after expanding migration setup. That property now migrates once and resets its ledger/totals between the same independent histories; it still executes PROPERTY_RUNS real SQLite commit histories and the same assertion.

The golden generator retains every existing historical database byte rather than regenerating old evidence. All v0–v4 SHA256 comparisons are identical (`/private/tmp/p3-scheduler-golden-byte-audit.json`); only their forward expectations add the declared defaults/nulls/empty tables. New v5 includes two surfaces, an exact variant receipt, an ordered replay, mastery and closed hold/anomaly evidence. All golden forward checks passed.

The iOS stable-boot-clock decision remains pending. These SQL carriers do not relax that policy or assert native timing evidence.
