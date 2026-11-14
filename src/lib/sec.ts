import { normalizeSic, sectorForSic } from "./sic.js";

/** SEC fair-access file of ticker, name, exchange, and CIK. At most once per day. */
export const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";

/** Submissions document for one zero-padded CIK. At most once per company per week. */
export function submissionUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${cik}.json`;
}

/** Declared app name and contact. Used when SEC_USER_AGENT is unset or has no email. */
export const DEFAULT_SEC_USER_AGENT = "churntop10 tom@churncapital.com";

export const TICKERS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SIC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Gap between SEC calls in one cron tick. 150ms is 6.6 requests/second, under the 10/second fair-access cap. */
export const SEC_MIN_GAP_MS = 150;
export const SEC_MAX_REQUESTS_PER_SECOND = 10;

/** Top 10, then open positions, then recent simulator orders. Keeps the write ceiling small. */
export const MAX_SHOWN_TICKERS = 40;

export interface ExchangeHit {
  cik: string;
  ticker: string;
  name: string;
  exchange: string;
}

export interface StoredCompany {
  cik: string;
  ticker: string;
  name: string;
  exchange: string;
  sic: string | null;
  sicDescription: string | null;
  sector: string | null;
  namesFetchedAt: number | null;
  sicFetchedAt: number | null;
  updatedAt: number;
}

export interface SecWrite {
  sql: string;
  params: unknown[];
}

export interface SubmissionResult {
  sic: string | null;
  sicDescription: string | null;
}

export function resolveSecUserAgent(configured: string | undefined): string {
  const value = configured?.trim();
  if (value && value.includes("@")) return value;
  return DEFAULT_SEC_USER_AGENT;
}

export function secHeaders(userAgent: string): Record<string, string> {
  return {
    "user-agent": resolveSecUserAgent(userAgent),
    accept: "application/json",
    "accept-encoding": "gzip, deflate",
  };
}

export function cikKey(value: unknown): string | null {
  let raw = value;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) raw = String(Math.trunc(raw));
  if (typeof raw !== "string") return null;
  const digits = raw.trim();
  if (!/^\d{1,10}$/.test(digits) || /^0+$/.test(digits)) return null;
  return digits.padStart(10, "0");
}

export function normalizeTicker(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ticker = value.trim().toUpperCase();
  if (!ticker || ticker.length > 10) return null;
  return ticker;
}

/**
 * Parse company_tickers_exchange.json.
 * Returns null when the shape is not the SEC file (a failure, not an empty universe).
 * The first row for a ticker wins.
 */
export function parseCompanyTickersExchange(body: unknown): ExchangeHit[] | null {
  const rows = exchangeRows(body);
  if (!rows) return null;
  const out: ExchangeHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const hit = exchangeHit(row);
    if (!hit || seen.has(hit.ticker)) continue;
    seen.add(hit.ticker);
    out.push(hit);
  }
  return out;
}

function exchangeRows(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.data)) return null;
  if (Array.isArray(record.fields)) {
    const fields = record.fields.map((field) => String(field));
    return record.data.map((item) => {
      if (!Array.isArray(item)) return item;
      const obj: Record<string, unknown> = {};
      fields.forEach((field, index) => {
        obj[field] = item[index];
      });
      return obj;
    });
  }
  return record.data;
}

function exchangeHit(row: unknown): ExchangeHit | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  const cik = cikKey(record.cik ?? record.cik_str);
  const ticker = normalizeTicker(record.ticker);
  const nameRaw = record.name ?? record.title;
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!cik || !ticker || !name) return null;
  const exchangeRaw = record.exchange;
  const exchange = typeof exchangeRaw === "string" ? exchangeRaw.trim() : "";
  return { cik, ticker, name, exchange };
}

/**
 * Parse a submissions JSON document.
 * Null means the body was not a company document.
 * An empty SIC is a successful read (ETFs and many funds) and yields a null industry.
 */
export function parseSubmission(body: unknown): SubmissionResult | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const sic = normalizeSic(record.sic ?? record.sicCode);
  const descRaw = record.sicDescription ?? record.sic_description;
  const sicDescription = typeof descRaw === "string" ? descRaw.trim() : "";
  if (!sic) return { sic: null, sicDescription: null };
  return { sic, sicDescription: sicDescription || null };
}

export function selectShownTickers(lists: { top10: string[]; positions: string[]; orders: string[] }, cap = MAX_SHOWN_TICKERS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const symbol of [...lists.top10, ...lists.positions, ...lists.orders]) {
    const ticker = normalizeTicker(symbol);
    if (!ticker || !/^[A-Z]{1,5}$/.test(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
    if (out.length >= cap) break;
  }
  return out;
}

export function exchangeDue(tickersFetchedAt: number, now: number): boolean {
  return !(tickersFetchedAt > 0) || now - tickersFetchedAt >= TICKERS_MAX_AGE_MS;
}

export function sicDue(sicFetchedAt: number | null, now: number): boolean {
  return sicFetchedAt == null || now - sicFetchedAt >= SIC_MAX_AGE_MS;
}

export interface SicAttempt {
  ok: boolean;
  sic: string | null;
  sicDescription: string | null;
}

/**
 * CIKs whose submissions file is due. First shown ticker wins when two symbols share a CIK.
 * `exchange` is null when the daily file was not fetched on this tick.
 */
export function ciksNeedingSic(input: {
  now: number;
  shown: string[];
  stored: StoredCompany[];
  exchange: ExchangeHit[] | null;
}): string[] {
  const storedByTicker = new Map(input.stored.map((row) => [row.ticker, row]));
  const storedByCik = new Map(input.stored.map((row) => [row.cik, row]));
  const exchangeByTicker = new Map((input.exchange ?? []).map((row) => [row.ticker, row]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ticker of input.shown) {
    const hit = input.exchange ? exchangeByTicker.get(ticker) : undefined;
    const stored = storedByTicker.get(ticker) ?? (hit ? storedByCik.get(hit.cik) : undefined);
    const cik = hit?.cik ?? stored?.cik;
    if (!cik || seen.has(cik)) continue;
    const sameCompany = stored && stored.cik === cik ? stored : storedByCik.get(cik);
    if (!sicDue(sameCompany?.sicFetchedAt ?? null, input.now)) {
      seen.add(cik);
      continue;
    }
    if (!hit && !sameCompany) continue;
    seen.add(cik);
    out.push(cik);
  }
  return out;
}

function sameCompany(a: StoredCompany, b: StoredCompany): boolean {
  return a.cik === b.cik
    && a.ticker === b.ticker
    && a.name === b.name
    && a.exchange === b.exchange
    && a.sic === b.sic
    && a.sicDescription === b.sicDescription
    && a.sector === b.sector
    && a.namesFetchedAt === b.namesFetchedAt
    && a.sicFetchedAt === b.sicFetchedAt;
}

/**
 * Writes for shown companies only. Unchanged rows are omitted.
 * A ticker that appears in the SEC file but is not shown produces no write.
 * Two shown tickers that share a CIK produce one row; the earlier shown ticker is kept.
 */
export function planCompanyWrites(input: {
  now: number;
  shown: string[];
  stored: StoredCompany[];
  exchange: ExchangeHit[] | null;
  submissions: Map<string, SicAttempt>;
}): SecWrite[] {
  const storedByTicker = new Map(input.stored.map((row) => [row.ticker, row]));
  const storedByCik = new Map(input.stored.map((row) => [row.cik, row]));
  const exchangeByTicker = new Map((input.exchange ?? []).map((row) => [row.ticker, row]));
  const claimed = new Set<string>();
  const writes: SecWrite[] = [];
  const released = new Set<string>();

  for (const ticker of input.shown) {
    const hit = input.exchange ? exchangeByTicker.get(ticker) : undefined;
    const storedAtTicker = storedByTicker.get(ticker);
    const cik = hit?.cik ?? storedAtTicker?.cik ?? null;
    if (!cik || claimed.has(cik)) continue;
    const stored = storedByCik.get(cik) ?? (storedAtTicker?.cik === cik ? storedAtTicker : undefined);
    if (!hit && !stored) continue;
    claimed.add(cik);

    const name = hit?.name ?? stored?.name;
    if (!name) continue;
    const exchange = hit?.exchange ?? stored?.exchange ?? "";
    const attempt = input.submissions.get(cik);
    let sic = stored?.sic ?? null;
    let sicDescription = stored?.sicDescription ?? null;
    let sector = stored?.sector ?? null;
    let sicFetchedAt = stored?.sicFetchedAt ?? null;
    if (attempt?.ok) {
      sic = attempt.sic;
      sicDescription = attempt.sic ? attempt.sicDescription : null;
      sector = sectorForSic(sic);
      sicFetchedAt = input.now;
    } else if (attempt && !attempt.ok) {
      sicFetchedAt = input.now;
    }
    const identityChanged = !stored || stored.ticker !== ticker || stored.name !== name || stored.exchange !== exchange;
    const namesFetchedAt = identityChanged ? input.now : stored?.namesFetchedAt ?? input.now;
    const next: StoredCompany = {
      cik,
      ticker,
      name,
      exchange,
      sic,
      sicDescription,
      sector,
      namesFetchedAt,
      sicFetchedAt,
      updatedAt: input.now,
    };
    if (stored && sameCompany(stored, { ...next, updatedAt: stored.updatedAt })) continue;

    for (const other of input.stored) {
      if (other.ticker === ticker && other.cik !== cik && !released.has(other.cik)) {
        released.add(other.cik);
        writes.push({
          sql: "UPDATE companies SET ticker = ?, updated_at = ? WHERE cik = ?",
          params: [`CIK${other.cik}`, input.now, other.cik],
        });
      }
    }

    if (!stored) {
      writes.push({
        sql: `INSERT INTO companies (cik, ticker, name, exchange, sic, sic_description, sector, names_fetched_at, sic_fetched_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [next.cik, next.ticker, next.name, next.exchange, next.sic, next.sicDescription, next.sector, next.namesFetchedAt, next.sicFetchedAt, next.updatedAt],
      });
    } else {
      writes.push({
        sql: `UPDATE companies
              SET ticker = ?, name = ?, exchange = ?, sic = ?, sic_description = ?, sector = ?, names_fetched_at = ?, sic_fetched_at = ?, updated_at = ?
              WHERE cik = ?`,
        params: [next.ticker, next.name, next.exchange, next.sic, next.sicDescription, next.sector, next.namesFetchedAt, next.sicFetchedAt, next.updatedAt, next.cik],
      });
    }
  }
  return writes;
}

export function planSyncMarker(now: number): SecWrite {
  return {
    sql: `INSERT INTO sec_sync (id, tickers_fetched_at) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET tickers_fetched_at = excluded.tickers_fetched_at
          WHERE sec_sync.tickers_fetched_at IS NOT excluded.tickers_fetched_at`,
    params: [now],
  };
}
