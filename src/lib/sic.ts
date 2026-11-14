/**
 * SIC division ranges from the Standard Industrial Classification Manual.
 * Sector labels are the short names used in the Top 10 table.
 * Division E (4000–4999) is labeled Transportation & Utilities.
 * Division H (6000–6799) is labeled Finance, Insurance & Real Estate
 * (the Finance/Insurance/Real Estate group).
 * Codes in the gaps (1800–1999, 6800–6999, 9000–9099, 9730–9899) have no sector.
 */
export const SIC_DIVISIONS: ReadonlyArray<{ from: number; to: number; sector: string }> = [
  { from: 100, to: 999, sector: "Agriculture, Forestry & Fishing" },
  { from: 1000, to: 1499, sector: "Mining" },
  { from: 1500, to: 1799, sector: "Construction" },
  { from: 2000, to: 3999, sector: "Manufacturing" },
  { from: 4000, to: 4999, sector: "Transportation & Utilities" },
  { from: 5000, to: 5199, sector: "Wholesale" },
  { from: 5200, to: 5999, sector: "Retail" },
  { from: 6000, to: 6799, sector: "Finance, Insurance & Real Estate" },
  { from: 7000, to: 8999, sector: "Services" },
  { from: 9100, to: 9729, sector: "Public Administration" },
  { from: 9900, to: 9999, sector: "Nonclassifiable" },
];

/** Four-digit SIC, or null when the filing has no usable code. */
export function normalizeSic(value: unknown): string | null {
  let raw = value;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 9999) raw = String(raw);
  if (typeof raw !== "string") return null;
  const digits = raw.trim();
  if (!/^\d{1,4}$/.test(digits)) return null;
  const sic = digits.padStart(4, "0");
  if (sic === "0000") return null;
  return sic;
}

/** Broad sector for a SIC code. Null when the code is missing or falls in a gap. */
export function sectorForSic(value: unknown): string | null {
  const sic = typeof value === "string" && /^\d{4}$/.test(value) ? value : normalizeSic(value);
  if (!sic) return null;
  const code = Number(sic);
  for (const division of SIC_DIVISIONS) {
    if (code >= division.from && code <= division.to) return division.sector;
  }
  return null;
}
