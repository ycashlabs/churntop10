/** Day change from a quote the app already parsed. No new quote fields. */

export function quoteChange(last: number, previousClose: number | undefined): { change: number; changePct: number } | null {
  if (previousClose == null || !Number.isFinite(previousClose) || previousClose === 0 || !Number.isFinite(last)) return null;
  const raw = last - previousClose;
  return {
    change: Math.round(raw * 100) / 100,
    changePct: Math.round((raw / previousClose) * 10000) / 100,
  };
}
