import type { SortState } from "./table-sort";
import { useTheme, type ThemeName } from "./theme";
import { Icon } from "./icons";

export function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const next: ThemeName = theme === "light" ? "dark" : "light";
  const label = next === "dark" ? "Dark" : "Light";
  return (
    <button type="button" className="icon-btn" aria-label={`Theme: ${theme}. Switch to ${label}.`} onClick={() => setTheme(next)}>
      <Icon name={theme === "light" ? "moon" : "sun"} />
      <span>{label}</span>
    </button>
  );
}

export function ThemeFieldset() {
  const [theme, setTheme] = useTheme();
  return (
    <fieldset className="theme-set">
      <legend>Theme</legend>
      <label className="check"><input type="radio" name="theme" checked={theme === "light"} onChange={() => setTheme("light")} /> Light</label>
      <label className="check"><input type="radio" name="theme" checked={theme === "dark"} onChange={() => setTheme("dark")} /> Dark</label>
      <p className="muted">Light or Dark. The choice is saved in this browser.</p>
    </fieldset>
  );
}

export function SortHeader({ label, column, sort, numeric, align = "right", className = "", onSort }: {
  label: string;
  column: string;
  sort: SortState | null;
  numeric: boolean;
  align?: "left" | "right";
  className?: string;
  onSort: (column: string, numeric: boolean) => void;
}) {
  const active = sort?.key === column;
  return (
    <th
      className={`${align === "left" ? "l " : ""}sortable ${className}`.trim()}
      aria-sort={active ? (sort?.dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(column, numeric)}
    >
      <span className="th-label">{label}{active && <Icon name={sort?.dir === "asc" ? "chevronUp" : "chevron"} size={10} />}</span>
    </th>
  );
}

export function ColumnPanel({ open, columns, visible, onToggle }: {
  open: boolean;
  columns: { id: string; label: string; locked?: boolean }[];
  visible: Record<string, boolean>;
  onToggle: (id: string, on: boolean) => void;
}) {
  if (!open) return null;
  return (
    <div className="customize on">
      {columns.map((column) => (
        <label key={column.id}>
          <input type="checkbox" checked={!!visible[column.id]} disabled={!!column.locked} onChange={(event) => onToggle(column.id, event.target.checked)} />
          {column.label}
        </label>
      ))}
    </div>
  );
}

export function Sparkline({ samples, width = 72, height = 28 }: { samples: number[]; width?: number; height?: number }) {
  if (samples.length === 0) {
    return <svg width={width} height={height} className="spark" aria-hidden="true"><line x1="0" x2={width} y1={height - 2} y2={height - 2} stroke="currentColor" strokeDasharray="2 2" strokeWidth="1" opacity="0.45" /></svg>;
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const span = max - min || 1;
  const pad = 2;
  const point = (value: number, index: number) => {
    const x = samples.length === 1 ? width / 2 : pad + (index / (samples.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (value - min) / span) * (height - pad * 2);
    return { x, y };
  };
  const coords = samples.map(point);
  const first = coords[0];
  const lastSample = samples[samples.length - 1];
  const firstSample = samples[0];
  if (!first || lastSample == null || firstSample == null) {
    return <svg width={width} height={height} className="spark" aria-hidden="true" />;
  }
  const up = lastSample >= firstSample;
  return (
    <svg width={width} height={height} className="spark" aria-hidden="true">
      <line x1="0" x2={width} y1={first.y} y2={first.y} stroke="currentColor" strokeDasharray="2 2" strokeWidth="1" opacity="0.45" />
      {coords.length > 1 && <polyline fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth="1.5" points={coords.map((item) => `${item.x.toFixed(1)},${item.y.toFixed(1)}`).join(" ")} />}
    </svg>
  );
}
