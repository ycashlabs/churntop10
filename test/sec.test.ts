import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "../src/lib/headers.js";
import { displaySecText, EM_DASH, SEC_CREDIT } from "../src/lib/sec-credit.js";
import {
  cikKey,
  DEFAULT_SEC_USER_AGENT,
  exchangeDue,
  MAX_SHOWN_TICKERS,
  parseCompanyTickersExchange,
  parseSubmission,
  planCompanyWrites,
  SEC_MAX_REQUESTS_PER_SECOND,
  SEC_MIN_GAP_MS,
  SEC_TICKERS_URL,
  secHeaders,
  selectShownTickers,
  submissionUrl,
  TICKERS_MAX_AGE_MS,
  type SecWrite,
  type StoredCompany,
} from "../src/lib/sec.js";
import { runSecSync, type SecStore } from "../src/lib/sec-sync.js";
import { SIC_DIVISIONS, sectorForSic } from "../src/lib/sic.js";
import { letterMark, LETTER_TONES } from "../src/lib/symbol-mark.js";
import { buildTopRows } from "../src/client/top10-table.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = TICKERS_MAX_AGE_MS;
const WEEK = 7 * DAY;

function applyMigrations(db: DatabaseSync): void {
  for (const name of [
    "0001_init.sql", "0002_v2.sql", "0003_v3.sql", "0004_live_sync.sql",
    "0005_trade_signals_threshold.sql", "0006_trade_signals_name_reason.sql",
    "0007_auth_totp.sql", "0008_companies.sql",
  ]) {
    const sql = readFileSync(join(root, "migrations", name), "utf8");
    for (const part of sql.split(";")) {
      const statement = part.trim();
      if (statement) db.exec(statement);
    }
  }
}

function storeFor(db: DatabaseSync): SecStore & { writes: SecWrite[]; changed: number } {
  return {
    writes: [],
    changed: 0,
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async write(writes: SecWrite[]): Promise<void> {
      this.writes.push(...writes);
      for (const write of writes) {
        const result = db.prepare(write.sql).run(...(write.params as never[]));
        this.changed += Number(result.changes);
      }
    },
  };
}

function letters(index: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return `${alphabet[Math.floor(index / 26)] ?? "Z"}${alphabet[index % 26] ?? "A"}`;
}

function seedTop(db: DatabaseSync, symbols: string[]): void {
  symbols.forEach((symbol, index) => {
    db.prepare("INSERT INTO top10 (rank, symbol) VALUES (?, ?)").run(index + 1, symbol);
  });
}

function exchangeFile(rows: Array<[number, string, string | null, string | null]>, extra = 0): unknown {
  const data: unknown[] = rows.map((row) => row);
  for (let i = 0; i < extra; i += 1) data.push([2_000_000 + i, `NOISE ${i}`, `X${i}`, "OTC"]);
  return { fields: ["cik", "name", "ticker", "exchange"], data };
}

const CORE: Array<[number, string, string, string]> = [
  [320193, "Apple Inc.", "AAPL", "Nasdaq"],
  [789019, "MICROSOFT CORP", "MSFT", "Nasdaq"],
  [1045810, "NVIDIA CORP", "NVDA", "Nasdaq"],
  [884394, "SPDR S&P 500 ETF TRUST", "SPY", "NYSE"],
  [1318605, "Tesla, Inc.", "TSLA", "Nasdaq"],
  [1652044, "Alphabet Inc.", "GOOGL", "Nasdaq"],
  [1652044, "Alphabet Inc.", "GOOG", "Nasdaq"],
];

function submissionFor(cik: string): unknown {
  const sic: Record<string, { sic: string; sicDescription: string }> = {
    "0000320193": { sic: "3571", sicDescription: "Electronic Computers" },
    "0000789019": { sic: "7372", sicDescription: "Services-Prepackaged Software" },
    "0001045810": { sic: "3674", sicDescription: "Semiconductors & Related Devices" },
    "0001318605": { sic: "3711", sicDescription: "Motor Vehicles & Passenger Car Bodies" },
    "0001652044": { sic: "7370", sicDescription: "Services-Computer Programming, Data Processing, Etc." },
  };
  return sic[cik] ?? { sic: "", sicDescription: "" };
}

describe("SEC file parsing", () => {
  it("reads the exchange file, skips blank tickers, and keeps the first row for a ticker", () => {
    const parsed = parseCompanyTickersExchange(exchangeFile([
      [320193, "Apple Inc.", "AAPL", "Nasdaq"],
      [320193, "APPLE OTHER", "aapl", "NYSE"],
      [0, "Skip", null, "Nasdaq"],
      [789019, "MICROSOFT CORP", "MSFT", null],
    ]));
    expect(parsed).toEqual([
      { cik: "0000320193", ticker: "AAPL", name: "Apple Inc.", exchange: "Nasdaq" },
      { cik: "0000789019", ticker: "MSFT", name: "MICROSOFT CORP", exchange: "" },
    ]);
    expect(parseCompanyTickersExchange({ nope: true })).toBeNull();
    expect(parseCompanyTickersExchange({ fields: ["cik", "name", "ticker", "exchange"], data: [] })).toEqual([]);
  });

  it("reads sic and sicCode, and treats a blank SIC as no industry", () => {
    expect(parseSubmission({ sic: "3571", sicDescription: "Electronic Computers" })).toEqual({
      sic: "3571",
      sicDescription: "Electronic Computers",
    });
    expect(parseSubmission({ sicCode: 7372, sicDescription: "Services-Prepackaged Software" })?.sic).toBe("7372");
    expect(parseSubmission({ sic: "", sicDescription: "" })).toEqual({ sic: null, sicDescription: null });
    expect(parseSubmission({ sic: "0000", sicDescription: "Missing" })).toEqual({ sic: null, sicDescription: null });
    expect(parseSubmission("nope")).toBeNull();
    expect(cikKey(320193)).toBe("0000320193");
    expect(submissionUrl("0000320193")).toBe("https://data.sec.gov/submissions/CIK0000320193.json");
  });

  it("sends a declared User-Agent and stays under 10 requests per second", () => {
    expect(secHeaders("")).toMatchObject({ "user-agent": DEFAULT_SEC_USER_AGENT, accept: "application/json" });
    expect(secHeaders("Desk owner@example.com")["user-agent"]).toBe("Desk owner@example.com");
    expect(secHeaders("churntop10")["user-agent"]).toBe(DEFAULT_SEC_USER_AGENT);
    expect(DEFAULT_SEC_USER_AGENT).toBe("churntop10 tom@churncapital.com");
    expect(1000 / SEC_MIN_GAP_MS).toBeLessThan(SEC_MAX_REQUESTS_PER_SECOND);
    expect(SEC_TICKERS_URL).toBe("https://www.sec.gov/files/company_tickers_exchange.json");
  });
});

describe("SIC division sectors", () => {
  it("maps the standard division ranges and leaves gaps empty", () => {
    expect(SIC_DIVISIONS.map((division) => division.sector)).toEqual([
      "Agriculture, Forestry & Fishing",
      "Mining",
      "Construction",
      "Manufacturing",
      "Transportation & Utilities",
      "Wholesale",
      "Retail",
      "Finance, Insurance & Real Estate",
      "Services",
      "Public Administration",
      "Nonclassifiable",
    ]);
    const samples: Array<[unknown, string | null]> = [
      ["0100", "Agriculture, Forestry & Fishing"],
      ["0999", "Agriculture, Forestry & Fishing"],
      [1000, "Mining"],
      ["1499", "Mining"],
      ["1500", "Construction"],
      ["1799", "Construction"],
      ["1800", null],
      ["2000", "Manufacturing"],
      ["3571", "Manufacturing"],
      ["3999", "Manufacturing"],
      ["4000", "Transportation & Utilities"],
      ["4999", "Transportation & Utilities"],
      ["5000", "Wholesale"],
      ["5199", "Wholesale"],
      ["5200", "Retail"],
      ["5999", "Retail"],
      ["6000", "Finance, Insurance & Real Estate"],
      ["6799", "Finance, Insurance & Real Estate"],
      ["6800", null],
      ["7372", "Services"],
      ["8999", "Services"],
      ["9000", null],
      ["9100", "Public Administration"],
      ["9729", "Public Administration"],
      ["9730", null],
      ["9900", "Nonclassifiable"],
      ["9999", "Nonclassifiable"],
      ["", null],
      [null, null],
    ];
    for (const [code, sector] of samples) expect(sectorForSic(code), String(code)).toBe(sector);
  });
});

describe("shown tickers and write plan", () => {
  it("keeps Top 10 ahead of positions and caps the set", () => {
    const positions = Array.from({ length: 50 }, (_, index) => letters(index));
    const shown = selectShownTickers({ top10: ["AAPL", "aapl", "BRK.A", "SPY"], positions, orders: ["MSFT", "AAPL"] });
    expect(shown[0]).toBe("AAPL");
    expect(shown[1]).toBe("SPY");
    expect(shown).toHaveLength(MAX_SHOWN_TICKERS);
    expect(shown).not.toContain("MSFT");
    expect(shown).not.toContain("BRK.A");
    expect(shown.filter((ticker) => ticker === "AAPL")).toHaveLength(1);
    expect(selectShownTickers({ top10: ["AAPL"], positions: ["SPY"], orders: ["MSFT"] })).toEqual(["AAPL", "SPY", "MSFT"]);
  });

  it("does not write unchanged rows or tickers the app does not show", () => {
    const stored: StoredCompany = {
      cik: "0000320193", ticker: "AAPL", name: "Apple Inc.", exchange: "Nasdaq",
      sic: "3571", sicDescription: "Electronic Computers", sector: "Manufacturing",
      namesFetchedAt: 10, sicFetchedAt: 10, updatedAt: 10,
    };
    const exchange = parseCompanyTickersExchange(exchangeFile([[320193, "Apple Inc.", "AAPL", "Nasdaq"], [999, "Other Co", "ZZZZ", "NYSE"]]));
    expect(exchange).not.toBeNull();
    const writes = planCompanyWrites({
      now: 20,
      shown: ["AAPL"],
      stored: [stored],
      exchange,
      submissions: new Map(),
    });
    expect(writes).toEqual([]);
    const changed = planCompanyWrites({
      now: 20,
      shown: ["AAPL", "ZZZZ"],
      stored: [],
      exchange,
      submissions: new Map([["0000000999", { ok: true, sic: null, sicDescription: null }]]),
    });
    expect(changed).toHaveLength(2);
    expect(changed.every((write) => write.sql.startsWith("INSERT"))).toBe(true);
  });
});

describe("SEC sync write bound and fallback", () => {
  const now = Date.parse("2026-11-14T15:00:00Z");

  function openDb(symbols: string[]): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    seedTop(db, symbols);
    return db;
  }

  it("writes only shown companies, then one clock row per day, and nothing until the clocks elapse", async () => {
    const db = openDb(["AAPL", "MSFT", "NVDA", "SPY"]);
    const calls: string[] = [];
    const gaps: number[] = [];
    const headersSeen: Record<string, string>[] = [];
    const fetchJson = async (url: string, headers: Record<string, string>) => {
      calls.push(url);
      headersSeen.push(headers);
      if (url === SEC_TICKERS_URL) return exchangeFile(CORE, 2000);
      const cik = url.slice(url.indexOf("CIK") + 3, url.indexOf(".json"));
      return submissionFor(cik);
    };
    const first = storeFor(db);
    const populated = await runSecSync(first, { now, userAgent: "", fetchJson, sleep: async (ms) => { gaps.push(ms); } });
    expect(populated.ok).toBe(true);
    expect(populated.exchangeFetched).toBe(true);
    expect(populated.submissionCiks).toEqual(["0000320193", "0000789019", "0001045810", "0000884394"]);
    expect(populated.writes).toBe(5);
    expect(first.changed).toBe(5);
    const names = db.prepare("SELECT ticker, name, sector, sic_description FROM companies ORDER BY ticker").all() as Array<{ ticker: string; name: string; sector: string | null; sic_description: string | null }>;
    expect(names.map((row) => row.ticker)).toEqual(["AAPL", "MSFT", "NVDA", "SPY"]);
    expect(names.find((row) => row.ticker === "AAPL")).toMatchObject({ name: "Apple Inc.", sector: "Manufacturing", sic_description: "Electronic Computers" });
    expect(names.find((row) => row.ticker === "SPY")).toMatchObject({ name: "SPDR S&P 500 ETF TRUST", sector: null, sic_description: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM companies").get()).toEqual({ n: 4 });
    expect(gaps.length).toBe(4);
    expect(gaps.every((gap) => gap === SEC_MIN_GAP_MS)).toBe(true);
    expect(headersSeen[0]?.["user-agent"]).toBe(DEFAULT_SEC_USER_AGENT);
    expect(headersSeen[0]?.authorization).toBeUndefined();

    const quiet = storeFor(db);
    const again = await runSecSync(quiet, {
      now: now + 60 * 60 * 1000,
      userAgent: DEFAULT_SEC_USER_AGENT,
      fetchJson: () => { throw new Error("should not fetch"); },
    });
    expect(again).toMatchObject({ ok: true, exchangeFetched: false, submissionCiks: [], writes: 0 });
    expect(quiet.writes).toEqual([]);

    const nextDay = storeFor(db);
    let exchangeCalls = 0;
    const daily = await runSecSync(nextDay, {
      now: now + DAY + 1000,
      userAgent: DEFAULT_SEC_USER_AGENT,
      fetchJson: async (url) => {
        if (url !== SEC_TICKERS_URL) throw new Error(url);
        exchangeCalls += 1;
        return exchangeFile(CORE, 2000);
      },
    });
    expect(exchangeCalls).toBe(1);
    expect(daily.submissionCiks).toEqual([]);
    expect(daily.writes).toBe(1);
    expect(nextDay.changed).toBe(1);
    expect(nextDay.writes[0]?.sql).toContain("sec_sync");
    expect(db.prepare("SELECT COUNT(*) AS n FROM companies").get()).toEqual({ n: 4 });
  });

  it("bounds a weekly SIC refresh to one write per shown company plus the daily clock", async () => {
    const db = openDb(["AAPL", "MSFT"]);
    const fetchJson = async (url: string) => {
      if (url === SEC_TICKERS_URL) return exchangeFile(CORE, 500);
      const cik = url.slice(url.indexOf("CIK") + 3, url.indexOf(".json"));
      return submissionFor(cik);
    };
    await runSecSync(storeFor(db), { now, userAgent: DEFAULT_SEC_USER_AGENT, fetchJson, sleep: async () => undefined });
    const week = storeFor(db);
    const refreshed = await runSecSync(week, {
      now: now + WEEK + 1000,
      userAgent: DEFAULT_SEC_USER_AGENT,
      fetchJson,
      sleep: async () => undefined,
    });
    expect(refreshed.submissionCiks).toHaveLength(2);
    expect(refreshed.writes).toBe(3);
    expect(week.changed).toBe(3);
    expect(week.writes.filter((write) => write.sql.includes("sec_sync"))).toHaveLength(1);
    expect(week.writes.filter((write) => write.sql.startsWith("UPDATE companies"))).toHaveLength(2);
  });

  it("does not throw or wipe names when SEC is down, and does not retry inside the window", async () => {
    const db = openDb(["AAPL", "SPY"]);
    const fetchJson = async (url: string) => {
      if (url === SEC_TICKERS_URL) return exchangeFile(CORE, 10);
      const cik = url.slice(url.indexOf("CIK") + 3, url.indexOf(".json"));
      return submissionFor(cik);
    };
    await runSecSync(storeFor(db), { now, userAgent: DEFAULT_SEC_USER_AGENT, fetchJson, sleep: async () => undefined });
    const down = storeFor(db);
    let calls = 0;
    const failed = await runSecSync(down, {
      now: now + DAY + 1000,
      userAgent: DEFAULT_SEC_USER_AGENT,
      fetchJson: async () => {
        calls += 1;
        throw new Error("sec down");
      },
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("exchange_unavailable");
    expect(failed.writes).toBe(1);
    expect(db.prepare("SELECT name FROM companies WHERE ticker = 'AAPL'").get()).toEqual({ name: "Apple Inc." });
    const later = await runSecSync(storeFor(db), {
      now: now + DAY + 2000,
      userAgent: DEFAULT_SEC_USER_AGENT,
      fetchJson: async () => {
        calls += 1;
        throw new Error("should not retry");
      },
    });
    expect(later.writes).toBe(0);
    expect(calls).toBe(1);
  });

  it("stores the name and an empty SIC when the submissions read fails", async () => {
    const db = openDb(["SPY"]);
    const result = await runSecSync(storeFor(db), {
      now,
      userAgent: DEFAULT_SEC_USER_AGENT,
      sleep: async () => undefined,
      fetchJson: async (url) => {
        if (url === SEC_TICKERS_URL) return exchangeFile([[884394, "SPDR S&P 500 ETF TRUST", "SPY", "NYSE"]]);
        throw new Error("submissions down");
      },
    });
    expect(result.ok).toBe(false);
    const row = db.prepare("SELECT name, sic, sic_description, sector FROM companies WHERE ticker = 'SPY'").get() as { name: string; sic: string | null; sic_description: string | null; sector: string | null };
    expect(row).toEqual({ name: "SPDR S&P 500 ETF TRUST", sic: null, sic_description: null, sector: null });
    expect(displaySecText(row.sector)).toBe(EM_DASH);
    expect(displaySecText(row.sic_description)).toBe(EM_DASH);
  });

  it("caps stored rows at the shown set even when the file and the book are larger", async () => {
    const db = openDb(["AAPL"]);
    const extra = Array.from({ length: 50 }, (_, index) => letters(index));
    extra.forEach((symbol, index) => {
      db.prepare(`INSERT INTO positions (id, mode, symbol, status, trading_capital_snapshot, profit_target_pct, stop_loss_pct, avg_cost, qty, opened_at, source)
        VALUES (?, 'sim', ?, 'open', 10000, 1, 1, 10, 1, ?, 'app')`).run(`p${index}`, symbol, index);
    });
    const rows: Array<[number, string, string, string]> = [[320193, "Apple Inc.", "AAPL", "Nasdaq"]];
    extra.forEach((symbol, index) => rows.push([3_000_000 + index, `Co ${symbol}`, symbol, "NYSE"]));
    const result = await runSecSync(storeFor(db), {
      now,
      userAgent: DEFAULT_SEC_USER_AGENT,
      sleep: async () => undefined,
      fetchJson: async (url) => {
        if (url === SEC_TICKERS_URL) return exchangeFile(rows, 1000);
        return { sic: "3571", sicDescription: "Electronic Computers" };
      },
    });
    const stored = db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number };
    expect(stored.n).toBe(MAX_SHOWN_TICKERS);
    expect(result.writes).toBe(MAX_SHOWN_TICKERS + 1);
    expect(result.submissionCiks).toHaveLength(MAX_SHOWN_TICKERS);
  });

  it("keeps one CIK row when two shown tickers share a company", async () => {
    const db = openDb(["GOOGL", "GOOG"]);
    await runSecSync(storeFor(db), {
      now,
      userAgent: DEFAULT_SEC_USER_AGENT,
      sleep: async () => undefined,
      fetchJson: async (url) => {
        if (url === SEC_TICKERS_URL) return exchangeFile(CORE);
        return submissionFor("0001652044");
      },
    });
    const rows = db.prepare("SELECT cik, ticker FROM companies").all() as Array<{ cik: string; ticker: string }>;
    expect(rows).toEqual([{ cik: "0001652044", ticker: "GOOGL" }]);
  });

  it("does not call SEC or throw when the companies table is missing", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    db.exec("DROP TABLE companies");
    let calls = 0;
    const result = await runSecSync(storeFor(db), {
      now,
      userAgent: DEFAULT_SEC_USER_AGENT,
      fetchJson: async () => {
        calls += 1;
        return {};
      },
    });
    expect(result.ok).toBe(false);
    expect(result.writes).toBe(0);
    expect(calls).toBe(0);
    expect(exchangeDue(0, now)).toBe(true);
    expect(exchangeDue(now, now + 1000)).toBe(false);
  });
});

describe("table fallback and letter mark", () => {
  it("shows the company, sector, and industry, or an em dash when SIC is missing", () => {
    const quote = { symbol: "AAPL", bid: "$1", ask: "$1", last: "$1", tradable: true, change: 1, changePct: 1 };
    const [plain] = buildTopRows({ top10: [quote], live: [], sim: [], proposals: [] });
    expect(plain?.name).toBe("");
    expect(plain?.sector).toBe(EM_DASH);
    expect(plain?.industry).toBe(EM_DASH);
    const [named] = buildTopRows({
      top10: [{ ...quote, company: { name: "Apple Inc.", exchange: "Nasdaq", industry: "Electronic Computers", sector: "Manufacturing" } }],
      live: [],
      sim: [],
      proposals: [],
    });
    expect(named?.name).toBe("Apple Inc.");
    expect(named?.sector).toBe("Manufacturing");
    expect(named?.industry).toBe("Electronic Computers");
    const [fund] = buildTopRows({
      top10: [{ ...quote, symbol: "SPY", company: { name: "SPDR S&P 500 ETF TRUST", exchange: "NYSE", industry: null, sector: null } }],
      live: [],
      sim: [],
      proposals: [],
    });
    expect(fund?.name).toBe("SPDR S&P 500 ETF TRUST");
    expect(fund?.sector).toBe(EM_DASH);
    expect(fund?.industry).toBe(EM_DASH);
  });

  it("builds a stable first-letter mark and credits the SEC without a seal or a remote host", () => {
    expect(letterMark("AAPL")).toEqual(letterMark("AAPL"));
    expect(letterMark("nvda").letter).toBe("N");
    expect(letterMark("").letter).toBe("?");
    expect(letterMark("MSFT").tone).toBeGreaterThanOrEqual(0);
    expect(letterMark("MSFT").tone).toBeLessThan(LETTER_TONES);
    expect(SEC_CREDIT).toContain("SEC public company data");
    expect(SEC_CREDIT.toLowerCase()).not.toContain("seal");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("sec.gov");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
    const app = readFileSync(join(root, "src/client/App.tsx"), "utf8");
    const trader = readFileSync(join(root, "src/worker/trader.ts"), "utf8");
    expect(app).not.toContain("api.nasdaq.com");
    expect(app).not.toContain("data.sec.gov");
    expect(trader).not.toContain("api.nasdaq.com");
    const tick = trader.slice(trader.indexOf("async tickSimulator"), trader.indexOf("async simulator("));
    const summary = trader.slice(trader.indexOf("async summary("), trader.indexOf("async summaryRead"));
    expect(tick).toContain("syncSecCompanies");
    expect(summary).not.toContain("syncSecCompanies");
    expect(trader).toContain('ALLOW_LIVE_TRADING === "1"');
  });
});
