import {
  ciksNeedingSic,
  exchangeDue,
  parseCompanyTickersExchange,
  parseSubmission,
  planCompanyWrites,
  planSyncMarker,
  SEC_MIN_GAP_MS,
  SEC_TICKERS_URL,
  secHeaders,
  selectShownTickers,
  submissionUrl,
  type ExchangeHit,
  type SecWrite,
  type SicAttempt,
  type StoredCompany,
} from "./sec.js";

export interface SecStore {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  write(writes: SecWrite[]): Promise<void>;
}

export interface SecSyncOptions {
  now: number;
  userAgent: string;
  fetchJson: (url: string, headers: Record<string, string>) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
}

export interface SecSyncResult {
  ok: boolean;
  exchangeFetched: boolean;
  submissionCiks: string[];
  writes: number;
  error?: string;
}

interface CompanySql {
  cik: string;
  ticker: string;
  name: string;
  exchange: string;
  sic: string | null;
  sic_description: string | null;
  sector: string | null;
  names_fetched_at: number | null;
  sic_fetched_at: number | null;
  updated_at: number;
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Piggyback on the 5-minute cron. Never throws.
 * The exchange file is requested at most once per 24 hours.
 * Submissions are requested at most once per shown CIK per 7 days.
 * A failed read still advances that clock so the next tick does not retry.
 * D1 writes are the daily clock plus changed shown companies only.
 */
export async function runSecSync(store: SecStore, options: SecSyncOptions): Promise<SecSyncResult> {
  try {
    return await runSecSyncInner(store, options);
  } catch (error) {
    return {
      ok: false,
      exchangeFetched: false,
      submissionCiks: [],
      writes: 0,
      error: error instanceof Error ? error.name : "SecSyncError",
    };
  }
}

async function runSecSyncInner(store: SecStore, options: SecSyncOptions): Promise<SecSyncResult> {
  const sleep = options.sleep ?? sleepDefault;
  const headers = secHeaders(options.userAgent);
  const [top10, positions, orders, syncRows, companyRows] = await Promise.all([
    store.all<{ symbol: string }>("SELECT symbol FROM top10 ORDER BY rank"),
    store.all<{ symbol: string }>("SELECT symbol FROM positions WHERE status = 'open' ORDER BY opened_at"),
    store.all<{ symbol: string }>("SELECT symbol FROM sim_orders ORDER BY created_at DESC LIMIT 20"),
    store.all<{ tickers_fetched_at: number }>("SELECT tickers_fetched_at FROM sec_sync WHERE id = 1"),
    store.all<CompanySql>(`SELECT cik, ticker, name, exchange, sic, sic_description, sector, names_fetched_at, sic_fetched_at, updated_at FROM companies`),
  ]);
  const shown = selectShownTickers({
    top10: top10.map((row) => row.symbol),
    positions: positions.map((row) => row.symbol),
    orders: orders.map((row) => row.symbol),
  });
  const stored = companyRows.map(fromSql);
  const tickersFetchedAt = syncRows[0]?.tickers_fetched_at ?? 0;
  const due = exchangeDue(tickersFetchedAt, options.now);
  let exchange: ExchangeHit[] | null = null;
  let exchangeFetched = false;
  let error: string | undefined;
  let requests = 0;

  if (due && shown.length > 0) {
    exchangeFetched = true;
    requests += 1;
    try {
      const body = await options.fetchJson(SEC_TICKERS_URL, headers);
      exchange = parseCompanyTickersExchange(body);
      if (!exchange) error = "exchange_unavailable";
    } catch {
      exchange = null;
      error = "exchange_unavailable";
    }
  }

  const submissionCiks = shown.length === 0 ? [] : ciksNeedingSic({ now: options.now, shown, stored, exchange });
  const submissions = new Map<string, SicAttempt>();
  for (const cik of submissionCiks) {
    if (requests > 0) await sleep(SEC_MIN_GAP_MS);
    requests += 1;
    try {
      const body = await options.fetchJson(submissionUrl(cik), headers);
      const parsed = parseSubmission(body);
      if (!parsed) {
        submissions.set(cik, { ok: false, sic: null, sicDescription: null });
        error = error ?? "submissions_unavailable";
      } else {
        submissions.set(cik, { ok: true, sic: parsed.sic, sicDescription: parsed.sicDescription });
      }
    } catch {
      submissions.set(cik, { ok: false, sic: null, sicDescription: null });
      error = error ?? "submissions_unavailable";
    }
  }

  const writes: SecWrite[] = [
    ...planCompanyWrites({ now: options.now, shown, stored, exchange, submissions }),
  ];
  if (due) writes.push(planSyncMarker(options.now));
  if (writes.length) await store.write(writes);
  return {
    ok: !error,
    exchangeFetched,
    submissionCiks,
    writes: writes.length,
    ...(error ? { error } : {}),
  };
}

function fromSql(row: CompanySql): StoredCompany {
  return {
    cik: row.cik,
    ticker: row.ticker,
    name: row.name,
    exchange: row.exchange,
    sic: row.sic,
    sicDescription: row.sic_description,
    sector: row.sector,
    namesFetchedAt: row.names_fetched_at,
    sicFetchedAt: row.sic_fetched_at,
    updatedAt: row.updated_at,
  };
}
