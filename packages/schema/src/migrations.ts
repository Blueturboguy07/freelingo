/**
 * Migration registry. `PRAGMA user_version` is the only version marker; every migration
 * runs inside one exclusive transaction, and the golden-DB corpus (P1) replays them all.
 */
import type { Db } from './db.js';

export interface Migration {
  readonly userVersion: number;
  readonly name: string;
  up(db: Db): void;
}

/** P0 seed: the committed-session ledger INV-CER-01 is asserted against. */
export const MIGRATIONS: readonly Migration[] = [
  {
    userVersion: 1,
    name: 'ledger-and-committed-sessions',
    up(db) {
      db.run(`CREATE TABLE IF NOT EXISTS account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        xp INTEGER NOT NULL DEFAULT 0,
        gems INTEGER NOT NULL DEFAULT 0
      )`);
      db.run(`INSERT OR IGNORE INTO account (id, xp, gems) VALUES (1, 0, 0)`);
      db.run(`CREATE TABLE IF NOT EXISTS committed_session (
        session_id TEXT PRIMARY KEY,
        committed_at TEXT NOT NULL
      )`);
    },
  },
] as const;

export const LATEST_USER_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.userVersion), 0);

export function migrate(db: Db): number {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (const migration of MIGRATIONS) {
    if (migration.userVersion <= current) continue;
    db.withExclusiveTransaction(() => {
      migration.up(db);
      // PRAGMA cannot take a bound parameter; the value is an integer from this module.
      db.run(`PRAGMA user_version = ${migration.userVersion}`);
    });
  }
  return LATEST_USER_VERSION;
}
