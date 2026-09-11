/**
 * `Db` implemented on Node 24's built-in `node:sqlite` (DatabaseSync).
 *
 * This is the CI/test runtime: no native build, no expo-sqlite. The app implements the
 * same interface on expo-sqlite, so every engine test runs against the real SQL.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Db, DbRow } from '@freelingo/schema';

export interface NodeDbOptions {
  /** ':memory:' by default; pass a file path for golden-DB fixtures. */
  readonly location?: string;
}

export function createNodeDb(options: NodeDbOptions = {}): Db {
  const handle = new DatabaseSync(options.location ?? ':memory:');
  let depth = 0;

  return {
    run(sql, params = []) {
      handle.prepare(sql).run(...(params as never[]));
    },
    all<T extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []) {
      return handle.prepare(sql).all(...(params as never[])) as unknown as T[];
    },
    get<T extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []) {
      return handle.prepare(sql).get(...(params as never[])) as unknown as T | undefined;
    },
    withExclusiveTransaction<T>(fn: () => T): T {
      if (depth > 0) throw new Error('nested exclusive transaction: one commit, one transaction');
      depth += 1;
      handle.exec('BEGIN EXCLUSIVE');
      try {
        const result = fn();
        handle.exec('COMMIT');
        return result;
      } catch (error) {
        handle.exec('ROLLBACK');
        throw error;
      } finally {
        depth -= 1;
      }
    },
    close() {
      handle.close();
    },
  };
}
