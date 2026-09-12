/**
 * `packs/` — the pack lifecycle harness (§14 PACK, engine parts).
 *
 * P1 owns the harness: the six-state enum, verify-before-install, the additive-only /
 * quarantine rule and the metered-fetch rule. The C-kind INV-PACK ids (the `coursekit`
 * content gates: the ledger, licences, story structure, the character stage) belong to
 * P2 and are not claimed here.
 */
export * from './state.js';
export * from './install.js';
export * from './items.js';
export * from './ed25519.js';
export * from './hashing.js';
