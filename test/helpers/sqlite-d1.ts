/**
 * A D1-shaped adapter over Node's built-in SQLite (`node:sqlite`), so the Story
 * snapshot SQL runs against a real SQLite engine — the one D1 is built on —
 * in the Node test suite. In-memory and per call: nothing touches the disk.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1Like, D1StatementLike } from '../../src/worker/story-store.js';

export interface SqliteD1 extends D1Like {
  /** The underlying database, for seeding rows a test needs verbatim. */
  sqlite: DatabaseSync;
}

export function sqliteD1(): SqliteD1 {
  const sqlite = new DatabaseSync(':memory:');
  const statement = (sql: string, values: unknown[] = []): D1StatementLike => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    run: () => Promise.resolve(sqlite.prepare(sql).run(...(values as SQLInputValue[]))),
    all: <T>() =>
      Promise.resolve({ results: sqlite.prepare(sql).all(...(values as SQLInputValue[])) as T[] }),
  });
  return {
    sqlite,
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      const results: unknown[] = [];
      for (const s of statements) results.push(await s.run());
      return results;
    },
  };
}
