import { letterMark } from "../lib/symbol-mark";

export function SymbolLabel({ symbol, name, exchange }: { symbol: string; name?: string | null; exchange?: string | null }) {
  const mark = letterMark(symbol);
  const company = name?.trim() ?? "";
  const venue = exchange?.trim() ?? "";
  const title = [company, venue].filter(Boolean).join(" · ") || symbol;
  return (
    <span className="symbol-label" title={title}>
      <svg className={`letter-avatar tone-${mark.tone}`} viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" />
        <text x="16" y="21" textAnchor="middle">{mark.letter}</text>
      </svg>
      <span className="symbol-text">
        <span className="sym">{symbol}</span>
        {company ? <span className="co">{company}</span> : null}
      </span>
    </span>
  );
}
