# Durable Hub state — 2026-09-13

Implemented and independently reviewed leaf; S091–S100 / INV-HUB-05,08,10. No phase/native gate claim.

`SqliteHubStateStore` freezes deterministic daily choice identities and the current cursor with a fresh input comparison inside its transaction. Only the current or exact next switch is accepted. Stale course/day/completion callbacks and partial writes roll back. It does not grade or spend shared review items. Completed IDs are derived from actual completed/replayed global sessions joined to their exact course/day Hub sources, including valid fallback offers. Old completion-cache rows must match these receipts. Exact offer kind/suffix, link economy flavour, global committed flavour and path/null-node requirements prevent another mode being marked complete. Saved choice/real launched Rewind identities provide cooldown dates without touching learning history.

Independent review reproduced two wrong-mode/global-flavour completions at `/private/tmp/p4-hub-boost-independent/witness.xml`. Both now reject;16 original/positive/invalid source controls pass at `/private/tmp/p4-hub-source-correction-independent/result.xml`, including slash-containing source identifiers. Root15 state tests,8 boost tests and core Hub integration pass with full root/mobile types/lint/invariant ownership in `/private/tmp/p4-hub-current-green.*`.

The actual pack/scheduler read model and read-only path preview are separate integration work. This leaf does not claim that the complete Hub is connected to the native app yet.
