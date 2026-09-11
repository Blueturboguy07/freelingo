/**
 * The `Db` interface every runtime implements.
 *
 * - App: `expo-sqlite` in WAL (`apps/mobile/src/db/ExpoDb.ts`).
 * - Node tests / CI: Node 24's built-in `node:sqlite` (`packages/testkit/src/nodeDb.ts`).
 *
 * Nothing above this interface may know which one it is talking to, and nothing below it
 * may leak a driver type upwards.
 *
 * `@freelingo/schema` declares the identical interface for the migration harness, which
 * cannot import this package (schema already depends on core; the other direction would
 * be a cycle). The two are structurally identical on purpose, and drift is caught at
 * compile time rather than by eye: `apps/mobile/src/db/ExpoDb.ts` types its adapter as
 * *this* `Db` and hands the same value to `@freelingo/schema`'s `migrate()`, so
 * `pnpm typecheck` fails the moment either declaration moves.
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
