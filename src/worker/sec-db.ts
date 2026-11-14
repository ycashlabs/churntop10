import type { SecStore } from "../lib/sec-sync.js";
import type { SecWrite } from "../lib/sec.js";

export function d1SecStore(db: D1Database): SecStore {
  return {
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const statement = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
      return (await statement.all<T>()).results;
    },
    async write(writes: SecWrite[]): Promise<void> {
      if (writes.length === 0) return;
      await db.batch(writes.map((write) => db.prepare(write.sql).bind(...write.params)));
    },
  };
}
