import type { D1Database } from "@cloudflare/workers-types";
/** Small SQL runner shared by the D1 backend and the migration tests. */
export interface MiniDb {
  exec(sql: string, params?: unknown[]): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
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
  };
}
