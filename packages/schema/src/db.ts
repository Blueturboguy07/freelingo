/**
 * The `Db` interface both runtimes implement.
 *
 * - App: `expo-sqlite` (WAL, `withExclusiveTransactionAsync`).
 * - Node tests / CI: Node 24's built-in `node:sqlite` `DatabaseSync` — no native build.
 *
 * Nothing above this interface may know which one it is talking to.
 */
export interface DbRow {
  readonly [column: string]: unknown;
}

export interface Db {
  /** Run a statement with bound parameters. Never interpolate SQL (INV-SEC-02). */
  run(sql: string, params?: readonly unknown[]): void;
  all<T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]): T[];
  get<T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]): T | undefined;
  /**
   * Run `fn` inside ONE exclusive transaction. Either every statement lands or none
   * does; a kill mid-way must leave no partial state (INV-CER-01).
   */
  withExclusiveTransaction<T>(fn: () => T): T;
  close(): void;
}
