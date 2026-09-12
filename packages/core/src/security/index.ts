/**
 * `security/` — §19 SEC. P1 owns SEC-01 (the storage-time sanitiser) and SEC-02 (the
 * `execAsync` gate); SEC-03 (BYOK headers) lands at P5 with the Explainer.
 */
export * from './sanitise.js';
export * from './exec-gate.js';
