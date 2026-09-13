# Permanent vocabulary evidence

Implementation checkpoint, 2026-09-13. Not a P4 gate.

Migration v10 adds an explicit known-history header, an immutable introduced-word ledger and a separate immutable learned-word claim. The shared word key is the existing semantic content hash, so multiple sentence exercises or courses cannot award the same reviewed lexical identity twice. Authored canonical semantics and countability are stored with the first display proof; learned claims retain review evidence and reference a permanent committed-session receipt. None of these tables cascades with course removal.

Legacy scalar counters and learner rows are unchanged. The migration adds no fabricated word identities or known-empty header. Fresh-account initialization must supply that header only when its history is known; importing/reconciling unknown legacy identity history remains explicit application work.

The SQL boundary checks shape, identity format, ownership and immutability. The runtime must independently validate the exact reviewed semantic hash and source declaration, actual display event, and two qualifying consecutive retirement reviews before inserting evidence. JSON object shape alone is not a proof that those events occurred. Course-specific quarantine remains separate from lifetime awards.

Validation: four original SQLite regressions failed before v10 and pass after it; all125 schema checks (including10,000-case properties), root/mobile typecheck, lint and owned-invariant coverage passed at /private/tmp/p4-v10-word-all.*. All10 prior database files are byte-identical and every prior expected learner row is unchanged; only the three empty new tables were added to old migration expectations (/private/tmp/p4-v10-golden-audit.json). Independent bounded DDL/test review found no blocking issue. Native fresh-account initialization and the exact runtime proof consumer remain to integrate.
