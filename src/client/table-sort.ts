export type SortDir = "asc" | "desc";

export interface SortState {
  key: string;
  dir: SortDir;
}

export function nextSort(current: SortState | null, key: string, numeric: boolean): SortState {
  if (!current || current.key !== key) return { key, dir: numeric ? "desc" : "asc" };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

export function compareValues(a: string | number | null | undefined, b: string | number | null | undefined, dir: SortDir): number {
  const empty = (value: string | number | null | undefined) => value == null || value === "";
  if (empty(a) && empty(b)) return 0;
  if (empty(a)) return 1;
  if (empty(b)) return -1;
  let delta = 0;
  if (typeof a === "number" && typeof b === "number") delta = a - b;
  else delta = String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
  return dir === "asc" ? delta : -delta;
}

export function sortRows<T>(rows: T[], value: (row: T) => string | number | null | undefined, dir: SortDir): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const delta = compareValues(value(a.row), value(b.row), dir);
      return delta === 0 ? a.index - b.index : delta;
    })
    .map((item) => item.row);
}

export interface ColumnDef {
  id: string;
  locked?: boolean;
}

/** `stored === null` means the default (every column). Locked columns stay on. */
export function columnVisibility(stored: string[] | null, columns: ColumnDef[]): Record<string, boolean> {
  const known = new Set(columns.map((column) => column.id));
  const picked = stored?.filter((id) => known.has(id)) ?? null;
  const use = picked ? new Set(picked) : new Set(columns.map((column) => column.id));
  const out: Record<string, boolean> = {};
  for (const column of columns) out[column.id] = !!column.locked || use.has(column.id);
  return out;
}

export function readColumnPref(storage: { getItem(key: string): string | null } | null, key: string): string[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) return null;
    return parsed;
  } catch {
    return null;
  }
}
