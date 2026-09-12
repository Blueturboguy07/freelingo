/**
 * `data/` — persistence and export/import (§13 PER/DAT, engine parts).
 *
 * The integrity ladder, the commit write order, the disk check, the archive manifest, and
 * the two halves of the durability guarantee this app actually makes: a file the learner
 * exports and a file they import.
 */
export * from './integrity.js';
export * from './commit.js';
export * from './disk.js';
export * from './manifest.js';
export * from './export.js';
export * from './import.js';
export * from './ranges.js';
export * from './durability.js';
