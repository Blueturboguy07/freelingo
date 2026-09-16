# Widget history from the retained global receipt ledger

Status: implementation and independent component checks pass; native composition and phase gates remain pending.

`readSqliteWidgetHistory` reads the retained global committed-session ledger after the application's serialized day/reward chain. The immutable `account_word_state` header proves a fresh database origin because its initializer rejects any existing course, committed receipt or word history. Missing legacy history remains unavailable. Course removal retains both the global receipts and origin; no deleted course links are needed. Whole-database restoration must preserve both together.

The reader validates captured timestamps, zone stamps, outcomes, graded-attempt counts and credited-day decisions. Successful zero-XP placement counts as a lifetime lesson; quit, failed and recovery outcomes follow the actual economy matrix. The last completed date comes from actual streak-satisfying receipts. Deferred day keying can increase lifetime count without inventing a completed date. It neither writes SQL nor infers history from zero counters.

The first independent review refuted a same-day assumption with real core `rowAt` receipts: travel can legitimately credit the captured start date without midnight grace. The repair validates both original zone stamps and preserves either legitimate captured-day choice instead of recomputing history in the current zone. Same-zone grace still requires the real five-minute boundary. Six unchanged independent travel witnesses are retained in `SqliteWidgetHistory.travel.test.ts`.

Evidence:

- Initial missing-reader RED: `/private/tmp/p5-widget-history-red.*`.
- Independent original travel RED: `/private/tmp/p5-widget-history-independent/red.xml` (six checks; two refutations).
- Independent repaired reader: `/private/tmp/p5-widget-history-independent/green2.xml` (12/12, including malformed-stamp/schema controls).
- Exact repository reader and both test files: `/private/tmp/p5-widget-history-repo.xml` (14/14); `/private/tmp/p5-widget-history-repo.exit` is 0. Typecheck and focused ESLint also passed in its log.

This supplies trustworthy lifetime/history facts to the existing widget account projection. Binding current verified course/path/session facts and the native publisher to the app owner is still required. These results do not establish a native widget end-to-end or release gate.
