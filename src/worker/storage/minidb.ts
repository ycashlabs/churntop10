import type { D1Database } from "@cloudflare/workers-types";
import type { SqlWrite } from "../../lib/sim-persist.js";

/** Small SQL runner shared by the D1 backend and the migration tests. */
export interface MiniDb {
  exec(sql: string, params?: unknown[]): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  batch?(writes: SqlWrite[]): Promise<void>;
}

export async function runWrites(mini: MiniDb, writes: SqlWrite[]): Promise<void> {
  if (writes.length === 0) return;
  if (mini.batch) {
    await mini.batch(writes);
    return;
  }
  for (const write of writes) await mini.exec(write.sql, write.params ?? []);
}

export function d1Mini(db: D1Database): MiniDb {
  return {
    async exec(sql: string, params: unknown[] = []) {
      await db.prepare(sql).bind(...params).run();
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return (await db.prepare(sql).bind(...params).all<T>()).results;
    },
    async first<T>(sql: string, params: unknown[] = []) {
      return (await db.prepare(sql).bind(...params).first<T>()) ?? undefined;
    },
    async batch(writes: SqlWrite[]) {
      if (writes.length === 0) return;
      await db.batch(writes.map((write) => db.prepare(write.sql).bind(...(write.params ?? []))));
    },
  };
}
