import { useEffect, useState } from "react";
import type { PositionView, ReviewScreen, RuleHistoryView, RuleView, SessionView, SimulatorView, Summary } from "../lib/api-types";
import { formatTradeSignalLine } from "../lib/trade-signals";
import { sessionBootstrapCopy } from "../lib/boot-copy";
import { SESSION_HELP } from "../lib/clock";
import { parseCallbackInput } from "../lib/oauth";
import { getPendingConnect, getReviews, getRuleHistory, getRules, getSession, getSimulator, getSummary, loadCsrf, post, postJson, registerPasskey, signIn } from "./api";
import { AccountStrip } from "./AccountStrip";
import { ColumnMenu, SortHeader, ThemeFieldset, ThemeSwitch } from "./chrome";
import { Icon } from "./icons";
import { CONFIDENCE_TITLE, DISABLED_RULE_FILTERS, filterRules, POINTS_TITLE, RISK_TITLE, RULE_FILTERS, ruleFilterEnabled, ruleSortValue, TREND_TITLE, type RuleFilter } from "./rules-table";
import { formatSignedPct, formatSignedUsd } from "./strip";
import { columnVisibility, nextSort, readColumnPref, sortRows, type SortState } from "./table-sort";
import { SEC_CREDIT } from "../lib/sec-credit";
import { buildTopRows, heatMix, parseUsd, topSortValue, type TopRow } from "./top10-table";
import { SymbolLabel } from "./symbol";
import { AuthenticatorSettings, StepUpHost, TotpSignIn } from "./totp-ui";

type SettingsDraft = Summary["settings"];

const CONNECT_URL_KEY = "churntop10.connectUrl";
const CONNECT_AT_KEY = "churntop10.connectAt";

function connectUrlExpired(): boolean {
  const at = Number(sessionStorage.getItem(CONNECT_AT_KEY) ?? "0");
  return !at || Date.now() - at > 10 * 60 * 1000;
}

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  async function refresh() {
    await loadCsrf();
    const next = await getSession();
    setSession(next);
    if (next.authenticated && !next.recovery) setSummary(await getSummary());
  }

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load."));
  }, []);

  function go(href: string) {
    window.history.pushState({}, "", href);
    setPath(href);
  }

  async function run(action: () => Promise<Summary | void>) {
    setError("");
    try {
      const next = await action();
      if (next) setSummary(next);
      else await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    }
  }

  if (!session) {
    const boot = sessionBootstrapCopy(session, error);
    return <main className="boot"><p>{boot.heading}</p>{boot.error && <p className="error">{boot.error}</p>}</main>;
  }
  if (!session.authenticated || session.recovery) {
    return <SignIn session={session} error={error} onDone={() => run(async () => { await refresh(); })} />;
  }
  if (!summary) return <main className="boot"><p>Loading the account…</p>{error && <p className="error">{error}</p>}</main>;

  const page = path.startsWith("/top10") ? "top10" : path.startsWith("/rules") ? "rules" : path.startsWith("/simulator") ? "simulator" : path.startsWith("/review") ? "review" : path.startsWith("/settings") ? "settings" : "summary";
  const stampClass = summary.killed ? "" : summary.mode === "live" ? "live" : "view";
  const nav = [
    ["/", "summary", "Account Summary"],
    ["/top10", "top10", "Top 10"],
    ["/rules", "rules", "Rules"],
    ["/simulator", "simulator", "Simulator"],
    ["/review", "review", "Review"],
    ["/settings", "settings", "Settings"],
  ] as const;
  return (
    <div className="app">
      <StepUpHost totpEnabled={!!session.totpEnabled} />
      <header className="topbar">
        <h1 className="wordmark">Churn Top 10</h1>
        <div className={`stamp ${stampClass}`}>{summary.killed ? "New buys stopped" : summary.mode === "live" ? "Live" : "View only"}</div>
        <div className="meta">
          <span className="clock">{summary.clock}</span>
          <span>{summary.session}</span>
          <ThemeSwitch />
          <button className="icon-btn" type="button" onClick={() => run(async () => { await post("/api/auth/logout"); setSummary(null); })}><Icon name="logout" /> Sign out</button>
        </div>
      </header>
      <div className="desk">
        <nav className="sidebar" aria-label="Primary">
          {nav.map(([href, id, label]) => (
            <a key={id} href={href} className={page === id ? "active" : ""} onClick={(event) => { event.preventDefault(); go(href); }}>{label}</a>
          ))}
        </nav>
        <div className="main">
          <AccountStrip summary={summary} />
          {summary.mode !== "live" && <p className="banner">View Only. Live real-money trading stays off until you explicitly approve it. The Simulator has its own screen and fake money.</p>}
          {summary.mode === "live" && !summary.liveGate && <p className="banner warn">Live is selected, but the broker gate is off. No real Robinhood orders are sent. Use the Simulator screen to run selected rules with fake money.</p>}
          {summary.killed && <p className="banner warn">Sell All Positions is on. New buys are stopped. Real Robinhood orders are not cancelled or sold from here.</p>}
          {error && <p className="error">{error}</p>}
          {page === "summary" && <SummaryPage summary={summary} />}
          {page === "top10" && <TopPage summary={summary} onRun={run} />}
          {page === "rules" && <RulesPage />}
          {page === "simulator" && <SimulatorPage />}
          {page === "review" && <ReviewPage />}
          {page === "settings" && <SettingsPage summary={summary} totpEnabled={!!session.totpEnabled} onRun={run} onError={setError} onRefresh={refresh} />}
        </div>
      </div>
    </div>
  );
}

function SignIn({ session, error, onDone }: { session: SessionView; error: string; onDone: () => void }) {
  const [email, setEmail] = useState("tom2258@gmail.com");
  const [note, setNote] = useState("");
  const params = new URLSearchParams(window.location.search);
  const owner = session.email || "tom2258@gmail.com";
  const monogram = owner.trim().charAt(0).toUpperCase() || "T";
  return (
    <main className="auth-shell">
      <div className="auth-tools"><ThemeSwitch /></div>
      <div className="auth-card">
        <p className="auth-subbrand">Churn Capital</p>
        <h1 className="auth-brand">Churn Top 10</h1>
        <p className="auth-sub">One owner. Sign in with your passkey, or with an authenticator code if you have set one up. Email is only for recovery.</p>
        {session.recovery && <p className="banner">Recovery confirmed. Register a new passkey to replace the old one.</p>}
        {params.get("recovery") === "invalid" && <p className="error">That recovery link is invalid or already used.</p>}
        {error && <p className="error">{error}</p>}
        {note && <p>{note}</p>}
        <div className="account-row">
          <div className="avatar" aria-hidden="true">{monogram}</div>
          <div>
            <div className="who">{owner}</div>
            <div className="role">Owner</div>
          </div>
        </div>
        {!session.registered || session.recovery ? (
          <button className="pill" type="button" onClick={() => registerPasskey().then(onDone).catch((err: unknown) => setNote(err instanceof Error ? err.message : "Could not register."))}><Icon name="key" size={20} /> Create passkey</button>
        ) : (
          <button className="pill" type="button" onClick={() => signIn().then(onDone).catch((err: unknown) => setNote(err instanceof Error ? err.message : "Could not sign in."))}><Icon name="key" size={20} /> Sign in</button>
        )}
        {session.totpEnabled && !session.recovery && <TotpSignIn onDone={onDone} onNote={setNote} />}
        {!session.recovery && (
          <form className="auth-block" onSubmit={(event) => {
            event.preventDefault();
            post("/api/auth/recovery", { email }).then(() => setNote("If that email is the owner, a recovery link was issued.")).catch((err: unknown) => setNote(err instanceof Error ? err.message : "Could not start recovery."));
          }}>
            <label>Recovery email<input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></label>
            <button className="pill quiet" type="submit"><Icon name="mail" size={20} /> Email a recovery link</button>
          </form>
        )}
      </div>
    </main>
  );
}

function SummaryPage({ summary }: { summary: Summary }) {
  const rh = summary.robinhood;
  return (
    <div className="grid">
      <section className="card">
        <h2>Robinhood account</h2>
        {summary.robinhoodStatus === "error" && <p className="error">{summary.robinhoodError ?? "Robinhood could not be read."} Reconnect from <a href="/settings">Settings</a>.</p>}
        {summary.robinhoodStatus === "not_connected" && <p>Not connected. Connect from <a href="/settings">Settings</a>. This screen shows only the real Robinhood account. Fake-money trading lives on the Simulator screen.</p>}
        {!summary.connected || !rh ? null : (
          <dl>
            <dt>Account</dt><dd>{rh.maskedAccount}</dd>
            <dt>Name</dt><dd>{rh.nickname}</dd>
            <dt>Type</dt><dd>{rh.brokerageType}</dd>
            <dt>Trading</dt><dd>{rh.tradingType}</dd>
            <dt>Agent account</dt><dd>{rh.agentic ? "Yes" : "No"}</dd>
            <dt>Portfolio</dt><dd>{rh.totalValue}</dd>
            <dt>Cash</dt><dd>{rh.cash}</dd>
            <dt>Buying power</dt><dd>{rh.buyingPower}</dd>
            <dt>Pending deposits</dt><dd>{rh.pendingDeposits}</dd>
            <dt>Unsettled</dt><dd>{rh.unsettled}</dd>
            <dt>Today realized</dt><dd>{rh.todayPnl}</dd>
          </dl>
        )}
      </section>
      <section className="card">
        <h2>Session</h2>
        <p>{SESSION_HELP}</p>
        <dl>
          <dt>Clock</dt><dd>{summary.clock}</dd>
          <dt>Session</dt><dd>{summary.session}</dd>
          <dt>Quotes</dt><dd>{summary.quoteSource === "robinhood" ? "Live Robinhood" : "Recorded book (Robinhood not connected)"}</dd>
        </dl>
      </section>
      <PositionsPanel title="Live positions" positions={summary.positions ?? []} empty="No open live positions. Robinhood holdings are imported here automatically. Live real-money trading stays off until you approve it." onChanged={() => window.location.reload()} />
    </div>
  );
}

const TOP_COLUMNS = [
  { id: "rank", label: "#", locked: true },
  { id: "symbol", label: "Symbol", locked: true },
  { id: "sector", label: "Sector" },
  { id: "industry", label: "Industry" },
  { id: "last", label: "Last" },
  { id: "bid", label: "Bid" },
  { id: "ask", label: "Ask" },
  { id: "change", label: "Change" },
  { id: "changePct", label: "Change %" },
  { id: "position", label: "Position" },
  { id: "pnl", label: "P&L" },
  { id: "target", label: "Target" },
  { id: "stop", label: "Stop" },
  { id: "rule", label: "Rule" },
  { id: "check", label: "Check" },
];
const TOP_NUMERIC = new Set(["rank", "last", "bid", "ask", "change", "changePct", "pnl", "target", "stop"]);
const TOP_LEFT = new Set(["rank", "symbol", "sector", "industry", "position", "rule", "check"]);
const TOP_PREF = "churntop10.top10.columns.v2";

function TopPage({ summary, onRun }: { summary: Summary; onRun: (action: () => Promise<Summary | void>) => void }) {
  const [symbols, setSymbols] = useState(summary.top10.map((row) => row.symbol).join("\n"));
  const [sim, setSim] = useState<SimulatorView | null>(null);
  const [view, setView] = useState<"table" | "heat">("table");
  const [customize, setCustomize] = useState(false);
  const [visible, setVisible] = useState<Record<string, boolean>>(() => columnVisibility(readColumnPref(localStorage, TOP_PREF), TOP_COLUMNS));
  const [sort, setSort] = useState<SortState | null>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => { setSymbols(summary.top10.map((row) => row.symbol).join("\n")); }, [summary]);
  useEffect(() => { getSimulator().then(setSim).catch(() => undefined); }, []);
  function toggleColumn(id: string, on: boolean) {
    const next = { ...visible, [id]: on };
    setVisible(next);
    const stored = TOP_COLUMNS.filter((column) => next[column.id]).map((column) => column.id);
    localStorage.setItem(TOP_PREF, JSON.stringify(stored));
  }
  const rows = sortRows(buildTopRows({
    top10: summary.top10,
    live: summary.positions ?? [],
    sim: sim?.positions ?? [],
    proposals: sim?.proposals ?? [],
  }), (row) => sort ? topSortValue(row, sort.key) : row.rank, sort?.dir ?? "asc");
  function cell(row: TopRow, id: string) {
    if (id === "rank") return row.rank;
    if (id === "symbol") return <SymbolLabel symbol={row.symbol} name={row.name} exchange={row.company?.exchange} />;
    if (id === "sector") return row.sector;
    if (id === "industry") return row.industry;
    if (id === "last") return row.last;
    if (id === "bid") return row.bid;
    if (id === "ask") return row.ask;
    if (id === "change") return <Signed n={row.change} pill />;
    if (id === "changePct") return <Signed n={row.changePct} pct pill />;
    if (id === "position") return <span title={row.positionTitle}>{row.position}</span>;
    if (id === "pnl") return <Signed n={row.pnl} money />;
    if (id === "target") return <span title={row.targetTitle}>{row.target == null ? "—" : formatSignedPct(row.target)}</span>;
    if (id === "stop") return <span title={row.stopTitle}>{row.stop == null ? "—" : formatSignedPct(row.stop)}</span>;
    if (id === "rule") return row.rule;
    return <span title={row.checkTitle}>{row.check}</span>;
  }
  return (
    <section>
      <div className="page-head">
        <h2>Top 10</h2>
        <div className="seg" role="group" aria-label="Top 10 view">
          <button type="button" className={view === "table" ? "on" : ""} onClick={() => setView("table")}><Icon name="table" /> Table View</button>
          <button type="button" className={view === "heat" ? "on" : ""} onClick={() => setView("heat")}><Icon name="grid" /> Heatmap View</button>
        </div>
      </div>
      <p className="help">This list is editable anytime and limits new first buys only. Positions in a name you later remove are still managed and can still be sold. Adds to a held name follow the scaling-in rules.</p>
      <div className="toolbar">
        <ColumnMenu open={customize} onOpenChange={setCustomize} columns={TOP_COLUMNS} visible={visible} onToggle={toggleColumn} />
      </div>
      {view === "table" ? (
        <div className={`table-scroll${scrolled ? " is-scrolled" : ""}`} onScroll={(event) => setScrolled(event.currentTarget.scrollLeft > 0)}>
          <table className="data">
            <thead>
              <tr>
                {TOP_COLUMNS.filter((column) => visible[column.id]).map((column) => (
                  <SortHeader
                    key={column.id}
                    label={column.label}
                    column={column.id}
                    sort={sort}
                    numeric={TOP_NUMERIC.has(column.id)}
                    align={TOP_LEFT.has(column.id) ? "left" : "right"}
                    className={column.id === "rank" ? "sticky" : column.id === "symbol" ? "sticky2" : ""}
                    onSort={(key, numeric) => setSort((current) => nextSort(current, key, numeric))}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.symbol}>
                  {TOP_COLUMNS.filter((column) => visible[column.id]).map((column) => (
                    <td key={column.id} className={`${TOP_LEFT.has(column.id) ? "l " : ""}${column.id === "rank" ? "sticky" : column.id === "symbol" ? "sticky2 sym-td" : ""}`.trim()}>{cell(row, column.id)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="heatmap">
          {rows.map((row) => {
            const tone = heatMix(row.changePct);
            return (
              <div className="heat" key={row.symbol} style={tone} title={row.changePct == null ? "No previous close on this quote." : `${row.symbol} ${formatSignedPct(row.changePct)}`}>
                <div className="s"><SymbolLabel symbol={row.symbol} name={row.name} exchange={row.company?.exchange} /></div>
                <div>{row.last}</div>
                <div className="p">{row.changePct == null ? "—" : formatSignedPct(row.changePct)}</div>
              </div>
            );
          })}
        </div>
      )}
      <details className="editor">
        <summary>Symbols, one per line</summary>
        <textarea rows={10} aria-label="Symbols, one per line" value={symbols} onChange={(event) => setSymbols(event.target.value)} />
        <div className="row">
          <button type="button" onClick={() => onRun(() => post("/api/top10", { symbols: symbols.split(/\s+/).filter(Boolean) }))}>Save list</button>
        </div>
      </details>
      <p className="muted sec-credit">{SEC_CREDIT}</p>
    </section>
  );
}

function Signed({ n, pct = false, money = false, pill = false }: { n: number | null; pct?: boolean; money?: boolean; pill?: boolean }) {
  if (n == null) return <>—</>;
  const tone = n > 0 ? "up" : n < 0 ? "down" : "flat";
  const text = pct ? formatSignedPct(n) : money ? formatSignedUsd(n) : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}`;
  return <span className={pill ? `pill ${tone}` : tone}>{text}</span>;
}

function MoneyText({ text }: { text: string }) {
  const n = parseUsd(text);
  if (n == null) return <>{text}</>;
  const tone = n > 0 ? "up" : n < 0 ? "down" : "flat";
  return <span className={tone}>{text}</span>;
}

function SettingsPage({ summary, totpEnabled, onRun, onError, onRefresh }: { summary: Summary; totpEnabled: boolean; onRun: (action: () => Promise<Summary | void>) => void; onError: (message: string) => void; onRefresh: () => Promise<void> }) {
  const [draft, setDraft] = useState<SettingsDraft>(summary.settings);
  const [connectUrl, setConnectUrlState] = useState(() => sessionStorage.getItem(CONNECT_URL_KEY) ?? "");
  const [pasted, setPasted] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [pending, setPending] = useState(false);
  const [pendingUntil, setPendingUntil] = useState("");
  const [tabBlocked, setTabBlocked] = useState(false);
  function setConnectUrl(url: string) {
    if (url) sessionStorage.setItem(CONNECT_URL_KEY, url);
    else sessionStorage.removeItem(CONNECT_URL_KEY);
    setConnectUrlState(url);
  }
  function clearConnect() {
    setConnectUrl("");
    setPasted("");
    setShowPaste(false);
  }
  async function loadPending() {
    try {
      const next = await getPendingConnect();
      setPending(next.pending);
      setPendingUntil(next.expiresAt ?? "");
      if (!next.pending && connectUrlExpired()) setConnectUrl("");
    } catch {
      setPending(false);
    }
  }
  useEffect(() => {
    void loadPending();
    const onFocus = () => { void loadPending(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => { setDraft(summary.settings); }, [summary]);
  function setNumber(key: keyof SettingsDraft, value: string) {
    setDraft({ ...draft, [key]: Number(value) });
  }
  return (
    <div className="stack settings-page">
      <div className="page-head"><h2>Settings</h2></div>
      <p className="help">{SESSION_HELP}</p>
      <section className="card">
        <ThemeFieldset />
      </section>
      <section className="card">
      <h3 className="card-title"><Icon name="wallet" /> Trading capital and caps</h3>
      <div className="form-grid">
      <label>Profit target, percent above average cost (any positive percent, up to 100)
        <input type="number" min={0} max={100} step="any" value={draft.profitTargetPct} onChange={(event) => setNumber("profitTargetPct", event.target.value)} />
      </label>
      <label>Stop-loss, percent below average cost (any positive percent, up to 100)
        <input type="number" min={0} max={100} step="any" value={draft.stopLossPct} onChange={(event) => setNumber("stopLossPct", event.target.value)} />
      </label>
      <label>Daily loss stop, percent of Trading capital (any positive percent, up to 100)
        <input type="number" min={0} max={100} step="any" value={draft.dailyLossPct} onChange={(event) => setNumber("dailyLossPct", event.target.value)} />
      </label>
      <label>Order cap, orders per day (1–1000; may be set high, for example 100)
        <input type="number" min={1} max={1000} step={1} value={draft.orderCap} onChange={(event) => setNumber("orderCap", event.target.value)} />
      </label>
      <div className="wide">
      <TradingCapitalFields summary={summary} draft={draft} onChange={(value) => setDraft({ ...draft, tradingCapital: value })} />
      </div>
      </div>
      <p className="hint">There are no buy amount fields. Sizing is the 20% starter (2% of the position’s Trading capital snapshot), signal-sized adds, and a 10% per-symbol cap on that snapshot. Sells have no dollar limit. The app never borrows.</p>
      <div className="row">
        <button type="button" onClick={() => onRun(() => post("/api/settings", draft))}>Save caps</button>
      </div>
      </section>
      <section className="card">
      <h3 className="card-title"><Icon name="rightLeft" /> Mode</h3>
      <div className="row">
        {summary.mode === "view_only" ? (
          <button type="button" onClick={() => onRun(() => post("/api/mode", { mode: "live" }))}>Switch to Live</button>
        ) : (
          <button className="quiet" type="button" onClick={() => onRun(() => post("/api/mode", { mode: "view_only" }))}>Switch to View Only</button>
        )}
        {summary.killed && <button className="quiet" type="button" onClick={() => onRun(() => post("/api/resume"))}>Allow new buys again</button>}
      </div>
      </section>
      <section className="card">
      <h3 className="card-title"><Icon name="link" /> Robinhood</h3>
      <p className="rh-status">
        {summary.robinhoodStatus === "connected" && <>Connected to {summary.robinhood?.maskedAccount ?? "your account"}.</>}
        {summary.robinhoodStatus === "not_connected" && <>Not connected.</>}
        {summary.robinhoodStatus === "error" && <span className="error">{summary.robinhoodError ?? "Robinhood could not be read."}</span>}
      </p>
      {summary.robinhoodStatus !== "connected" || showPaste || pending || connectUrl ? (
        <RobinhoodConnect
          reconnect={summary.robinhoodStatus !== "not_connected"}
          connectUrl={connectUrl}
          tabBlocked={tabBlocked}
          pending={pending}
          pendingUntil={pendingUntil}
          pasted={pasted}
          setPasted={setPasted}
          onStart={() => {
            setShowPaste(true);
            setPasted("");
            onRun(async () => {
              const body = await post("/api/robinhood/connect") as Summary & { url?: string };
              if (body.url) {
                setConnectUrl(body.url);
                sessionStorage.setItem(CONNECT_AT_KEY, String(Date.now()));
                // Opening a tab before the passkey prompt would steal focus and fail the passkey, so open it after.
                // If the browser blocks it, the panel shows a big "Open Robinhood" button that is a fresh click.
                // "noopener" in the features makes window.open return null even on success, so drop the opener by hand.
                const tab = window.open(body.url, "_blank");
                if (tab) {
                  try { tab.opener = null; } catch { /* already cross-origin */ }
                }
                setTabBlocked(!tab);
              }
              await loadPending();
              return undefined;
            });
          }}
          onFinish={(value) => onRun(async () => {
            try {
              await post("/api/robinhood/complete", { callbackUrl: value });
              clearConnect();
            } catch (err) {
              setShowPaste(true);
              throw err;
            } finally {
              await loadPending();
            }
          })}
          onClose={summary.robinhoodStatus === "connected" ? clearConnect : undefined}
        />
      ) : (
        <div className="row">
          <button type="button" onClick={() => setShowPaste(true)}>Reconnect Robinhood</button>
        </div>
      )}
      </section>
      <AuthenticatorSettings enabled={totpEnabled} onError={onError} onRefresh={onRefresh}>
        {(danger) => (
          <section className="card danger-zone">
            <h3 className="card-title"><Icon name="warning" /> Danger zone</h3>
            <div className="row">
              <SellAllButton onDone={() => onRun(async () => undefined)} />
              {summary.robinhoodStatus !== "not_connected" && (
                <button className="danger" type="button" onClick={() => onRun(async () => {
                  if (!window.confirm("Disconnect Robinhood? The app forgets its saved sign-in. Robinhood orders are not touched.")) return undefined;
                  clearConnect();
                  return post("/api/robinhood/disconnect");
                })}>Disconnect Robinhood</button>
              )}
              {danger}
            </div>
          </section>
        )}
      </AuthenticatorSettings>
      <p className="hint">Saving caps, editing the Top 10 or a rule, marking a rule Proven, and switching to Live or connecting Robinhood each ask for the passkey again, or an authenticator code if you have set one up. Sell All Positions asks for a confirm step, not a passkey. It sells simulated positions only and does not place or cancel real Robinhood orders.</p>
      <section className="card">
        <p className="hint sec-credit">{SEC_CREDIT}</p>
      </section>
    </div>
  );
}

function score(card: RuleView["scorecard"]): string {
  if (card.tradeCount === 0) return "No trades yet.";
  const win = card.winRate === null ? "—" : `${Math.round(card.winRate * 100)}%`;
  const avg = card.avgProfit === null ? "—" : `$${card.avgProfit.toFixed(2)}`;
  const worst = card.worstLoss === null ? "—" : `$${card.worstLoss.toFixed(2)}`;
  return `Win rate ${win}. Avg profit ${avg}. Worst loss ${worst}. ${card.tradeCount} trades.`;
}

const RULE_COLUMNS = [
  { id: "name", label: "Name", locked: true },
  { id: "side", label: "Side" },
  { id: "status", label: "Status" },
  { id: "points", label: "Points" },
  { id: "trend", label: "Trend" },
  { id: "profit", label: "Profit" },
  { id: "win", label: "Win rate" },
  { id: "risk", label: "Risk" },
  { id: "confidence", label: "Confidence" },
  { id: "trades", label: "Trades" },
  { id: "last", label: "Last triggered" },
  { id: "signals", label: "Signals" },
  { id: "actions", label: "Actions", locked: true },
];
const RULE_NUMERIC = new Set(["profit", "win", "risk", "trades", "last"]);
const RULE_LEFT = new Set(["name", "side", "status", "signals", "actions"]);
const RULE_PREF = "churntop10.rules.columns";

function RulesPage() {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<RuleHistoryView[]>([]);
  const [historyFor, setHistoryFor] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftSide, setDraftSide] = useState<"buy" | "sell">("buy");
  const [draftBody, setDraftBody] = useState("");
  const [editing, setEditing] = useState<string>("");
  const [filter, setFilter] = useState<RuleFilter>("All");
  const [query, setQuery] = useState("");
  const [customize, setCustomize] = useState(false);
  const [visible, setVisible] = useState<Record<string, boolean>>(() => columnVisibility(readColumnPref(localStorage, RULE_PREF), RULE_COLUMNS));
  const [sort, setSort] = useState<SortState | null>(null);
  const [scrolled, setScrolled] = useState(false);
  async function refresh() {
    const body = await getRules();
    setRules(body.rules);
  }
  useEffect(() => { refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load rules.")); }, []);
  async function run(action: () => Promise<{ rules: RuleView[] }>) {
    setError("");
    try { setRules((await action()).rules); }
    catch (err) { setError(err instanceof Error ? err.message : "Request failed."); }
  }
  async function showHistory(familyId: string) {
    setHistoryFor(familyId);
    const body = await getRuleHistory(familyId);
    setHistory(body.history);
  }
  if (!rules) return <section className="card"><p>Loading rules…</p>{error && <p className="error">{error}</p>}</section>;
  const current = editing ? rules.find((rule) => rule.id === editing) : undefined;
  const filtered = filterRules(rules, filter, query, Date.now());
  const shown = sort ? sortRows(filtered, (rule) => ruleSortValue(rule, sort.key), sort.dir) : filtered;
  function toggleColumn(id: string, on: boolean) {
    const next = { ...visible, [id]: on };
    setVisible(next);
    localStorage.setItem(RULE_PREF, JSON.stringify(RULE_COLUMNS.filter((column) => next[column.id]).map((column) => column.id)));
  }
  function ruleCell(rule: RuleView, id: string) {
    const card = rule.scorecard;
    const empty = card.tradeCount === 0;
    if (id === "name") return <span title={`${rule.body} ${score(card)}`}>{rule.name} <span className="muted">v{rule.version}</span></span>;
    if (id === "side") return rule.side === "buy" ? "Buy rule" : "Sell rule";
    if (id === "status") return <span className={`stamp ${rule.status}`}>{rule.status}</span>;
    if (id === "points") return <span title={POINTS_TITLE}>—</span>;
    if (id === "trend") return <span title={TREND_TITLE}>—</span>;
    if (id === "profit") return empty ? "No trades yet." : card.avgProfit == null ? "—" : <Signed n={card.avgProfit} money />;
    if (id === "win") return card.winRate == null ? "—" : `${Math.round(card.winRate * 100)}%`;
    if (id === "risk") return <span title={RISK_TITLE}>{card.worstLoss == null ? "—" : <Signed n={card.worstLoss} money />}</span>;
    if (id === "confidence") return <span title={CONFIDENCE_TITLE}>—</span>;
    if (id === "trades") return empty ? "—" : String(card.tradeCount);
    if (id === "last") return rule.lastTriggeredAt == null ? "—" : new Date(rule.lastTriggeredAt).toLocaleString();
    if (id === "signals") return rule.signals.length ? rule.signals.join(", ") : "Uses Settings percentages";
    return (
      <div className="actions">
        <button className="tiny" type="button" onClick={() => { setEditing(rule.id); setDraftName(rule.name); setDraftSide(rule.side); setDraftBody(rule.body); }}>Edit / rename</button>
        {rule.status !== "proven" && <button className="tiny primary" type="button" onClick={() => run(() => postJson("/api/rules/" + rule.id + "/status", { status: "proven" }))}>Mark Proven</button>}
        {rule.status === "proven" && <button className="tiny" type="button" onClick={() => run(() => postJson("/api/rules/" + rule.id + "/status", { status: "experimenting" }))}>Move to Experimenting</button>}
        {rule.status !== "retired" && <button className="tiny" type="button" onClick={() => run(() => postJson("/api/rules/" + rule.id + "/status", { status: "retired" }))}>Retire</button>}
        <button className="tiny" type="button" onClick={() => showHistory(rule.familyId)}>History</button>
      </div>
    );
  }
  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <section>
        <div className="page-head"><h2>Rules contract</h2></div>
        <p className="help">You edit the text; the app proofreads by saving a history entry for every change, status change, and approval. Only you can mark a rule Proven. Live trading uses only Proven rules. The Simulator can run any selected rules, including Experimenting ones. Editing a Proven rule creates a new Experimenting version; open trades keep the versions they started with.</p>
        <div className="toolbar">
          <div className="chips" role="group" aria-label="Rule filters">
            {RULE_FILTERS.map((name) => {
              const enabled = ruleFilterEnabled(name);
              return (
                <button
                  key={name}
                  type="button"
                  className={`chip${filter === name ? " on" : ""}`}
                  disabled={!enabled}
                  title={DISABLED_RULE_FILTERS[name]}
                  aria-pressed={filter === name}
                  onClick={() => { if (enabled) setFilter(name); }}
                >{name}</button>
              );
            })}
          </div>
          <label className="search-wrap">
            <Icon name="search" />
            <input className="search" type="search" placeholder="Search" aria-label="Search rules" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <ColumnMenu open={customize} onOpenChange={setCustomize} columns={RULE_COLUMNS} visible={visible} onToggle={toggleColumn} />
        </div>
        <div className={`table-scroll${scrolled ? " is-scrolled" : ""}`} onScroll={(event) => setScrolled(event.currentTarget.scrollLeft > 0)}>
          <table className="data">
            <thead>
              <tr>
                {RULE_COLUMNS.filter((column) => visible[column.id]).map((column) => column.id === "actions" || column.id === "points" || column.id === "trend" || column.id === "confidence" ? (
                  <th key={column.id} className={RULE_LEFT.has(column.id) ? "l" : ""} title={column.id === "points" ? POINTS_TITLE : column.id === "trend" ? TREND_TITLE : column.id === "confidence" ? CONFIDENCE_TITLE : undefined}>{column.label}</th>
                ) : (
                  <SortHeader
                    key={column.id}
                    label={column.label}
                    column={column.id}
                    sort={sort}
                    numeric={RULE_NUMERIC.has(column.id)}
                    align={RULE_LEFT.has(column.id) ? "left" : "right"}
                    className={column.id === "name" ? "sticky" : ""}
                    onSort={(key, numeric) => setSort((current) => nextSort(current, key, numeric))}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((rule) => (
                <tr key={rule.id}>
                  {RULE_COLUMNS.filter((column) => visible[column.id]).map((column) => (
                    <td key={column.id} className={`${RULE_LEFT.has(column.id) ? "l " : ""}${column.id === "name" ? "sticky" : ""}`.trim()}>{ruleCell(rule, column.id)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>{current ? "Edit rule" : "Create a rule"}</h2>
        <label>Name<input value={draftName} onChange={(event) => setDraftName(event.target.value)} /></label>
        {!current && (
          <label>Side
            <select value={draftSide} onChange={(event) => setDraftSide(event.target.value as "buy" | "sell")}>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </label>
        )}
        <label>Plain-English text<textarea rows={4} value={draftBody} onChange={(event) => setDraftBody(event.target.value)} /></label>
        <div className="row">
          {current ? (
            <button type="button" onClick={() => run(async () => {
              const body = await postJson<{ rules: RuleView[] }>("/api/rules/" + current.id, { name: draftName, body: draftBody, signals: current.signals });
              setEditing(""); setDraftName(""); setDraftBody("");
              return body;
            })}>Save changes</button>
          ) : (
            <button type="button" onClick={() => run(async () => {
              const body = await postJson<{ rules: RuleView[] }>("/api/rules", { name: draftName, side: draftSide, body: draftBody, signals: [] });
              setDraftName(""); setDraftBody("");
              return body;
            })}>Create rule</button>
          )}
          {current && <button className="quiet" type="button" onClick={() => { setEditing(""); setDraftName(""); setDraftBody(""); }}>Cancel</button>}
        </div>
      </section>
      {historyFor && (
        <section className="card">
          <h2>History</h2>
          {history.length === 0 && <p>No history yet.</p>}
          <ul className="proposals">
            {history.map((row) => (
              <li key={row.id}><strong>{new Date(row.at).toLocaleString()}</strong> {row.action}{row.fromStatus ? ` ${row.fromStatus} → ${row.toStatus ?? ""}` : ""} · v{row.version}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SimulatorPage() {
  const [sim, setSim] = useState<SimulatorView | null>(null);
  const [rules, setRules] = useState<RuleView[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  async function load() {
    const [next, ruleBody] = await Promise.all([getSimulator(), getRules()]);
    setSim(next);
    setRules(ruleBody.rules);
    setSelected(next.selectedRuleIds.length ? next.selectedRuleIds : ruleBody.rules.map((rule) => rule.id));
  }
  useEffect(() => { load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load the simulator.")); }, []);
  async function runCycle() {
    setError("");
    try {
      const next = await postJson<SimulatorView>("/api/simulator/cycle", { ruleIds: selected });
      setSim(next);
      setSelected(next.selectedRuleIds.length ? next.selectedRuleIds : selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run the simulator.");
    }
  }
  function toggle(id: string) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }
  if (!sim) return <section className="card"><p>Loading the simulator…</p>{error && <p className="error">{error}</p>}</section>;
  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <section className="card">
        <h2>Simulator</h2>
        <p>Fake money only. This screen is separate from Account Summary. Run the rules you select. Off-hours stops are still watched on each cycle, normally every 5 minutes when a position is open.</p>
        <dl>
          <dt>Equity</dt><dd>{sim.equity}</dd>
          <dt>Cash</dt><dd>{sim.cash}</dd>
          <dt>Daily loss</dt><dd>{sim.dailyLoss} / {sim.dailyLossCap}</dd>
          <dt>Orders today</dt><dd>{sim.ordersToday} / {sim.orderCap}</dd>
          <dt>Quotes</dt><dd>{sim.quoteSource === "robinhood" ? "Live" : "Recorded"}</dd>
          {sim.tradingCapital && <><dt>Trading capital</dt><dd>{sim.tradingCapital.effectiveUsd}{sim.tradingCapital.warn ? " (capped at the current balance)" : ""}</dd></>}
        </dl>
        {sim.tradingCapital?.paused && <p className="banner warn">Open exposure is at or above Trading capital. New buys wait until exposure is back under.</p>}
      </section>
      <section className="card">
        <h3 className="card-title">Rules to run</h3>
        {rules.map((rule) => (
          <label key={rule.id} className="check">
            <input type="checkbox" checked={selected.includes(rule.id)} onChange={() => toggle(rule.id)} />
            {rule.name} <span className="muted">({rule.status})</span>
          </label>
        ))}
        <div className="row">
          <button type="button" onClick={() => runCycle()}>Run check</button>
        </div>
      </section>
      <PositionsPanel title="Simulated positions" positions={sim.positions} empty="No simulated positions." onChanged={() => load()} />
      <section className="card">
        <h2>Orders</h2>
        <table className="data">
          <thead><tr><th className="l">Symbol</th><th className="l">Side</th><th className="l">Role</th><th className="l">Status</th><th>Price</th></tr></thead>
          <tbody>
            {sim.orders.length === 0 && <tr><td colSpan={5}>No orders yet.</td></tr>}
            {sim.orders.map((order, index) => (
              <tr key={`${order.symbol}-${order.role}-${index}`}><td className="l sym-td"><SymbolLabel symbol={order.symbol} name={order.company?.name} exchange={order.company?.exchange} /></td><td className="l">{order.side}</td><td className="l">{order.role}</td><td className="l">{order.status}</td><td>{order.price}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>Latest check</h2>
        <ul className="proposals">
          {sim.events.map((event, index) => <li key={`e-${index}`}><strong>{event.action}</strong> {event.detail}</li>)}
          {sim.proposals.map((proposal) => <li key={`${proposal.symbol}-${proposal.at}`}><SymbolLabel symbol={proposal.symbol} name={proposal.company?.name} exchange={proposal.company?.exchange} /> {proposal.verdict}. {proposal.message}</li>)}
          {sim.events.length === 0 && sim.proposals.length === 0 && <li>No check yet. Select rules and run one.</li>}
        </ul>
      </section>
    </div>
  );
}

function SellAllButton({ onDone }: { onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  if (!confirming) {
    return <button className="danger" type="button" onClick={() => setConfirming(true)}>Sell All Positions</button>;
  }
  return (
    <div className="stepup-mask">
    <div className="card confirm" role="dialog" aria-label="Sell All Positions">
      <p>This sells every simulated position, stops new buys, and does not send or cancel real Robinhood orders. Confirm?</p>
      {note && <p className="error">{note}</p>}
      <div className="row">
        <button className="danger" type="button" onClick={() => {
          postJson("/api/sell-all", { confirm: true }).then(() => { setConfirming(false); onDone(); }).catch((err: unknown) => setNote(err instanceof Error ? err.message : "Could not sell."));
        }}>Confirm sell all</button>
        <button className="quiet" type="button" onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    </div>
    </div>
  );
}

function RobinhoodConnect(props: {
  reconnect: boolean;
  connectUrl: string;
  tabBlocked: boolean;
  pending: boolean;
  pendingUntil: string;
  pasted: string;
  setPasted: (value: string) => void;
  onStart: () => void;
  onFinish: (value: string) => void;
  onClose?: () => void;
}) {
  const { connectUrl, pending, pendingUntil, pasted, setPasted, onStart, onFinish, onClose } = props;
  const [hint, setHint] = useState("");
  const started = !!connectUrl || pending;
  function accept(value: string, auto: boolean) {
    setPasted(value);
    if (!value.trim()) { setHint(""); return; }
    const parsed = parseCallbackInput(value);
    if (!parsed.ok) { setHint(parsed.error); return; }
    setHint("");
    if (auto) onFinish(value);
  }
  return (
    <div className="inset-panel" id="robinhood-paste">
      <h3>{props.reconnect ? "Reconnect Robinhood" : "Connect Robinhood"} in 3 steps</h3>
      <ol className="steps">
        <li>
          <p><strong>Open Robinhood.</strong> You confirm with your passkey, then Robinhood opens in a new tab.</p>
          <div className="row">
            {connectUrl && props.tabBlocked ? (
              <a className="button" href={connectUrl} target="_blank" rel="noopener noreferrer">Open Robinhood sign-in</a>
            ) : (
              <button type="button" onClick={onStart}>{started ? "Start over" : "Open Robinhood sign-in"}</button>
            )}
            {connectUrl && !props.tabBlocked && <a href={connectUrl} target="_blank" rel="noopener noreferrer">Robinhood tab didn't open? Click here.</a>}
          </div>
        </li>
        <li>
          <p><strong>Log in and tap Approve.</strong> Robinhood then shows an error page such as <em>"This site can't be reached"</em> or <em>"127.0.0.1 refused to connect"</em>. <strong>That is expected</strong>: the sign-in worked and the code is in that page's address.</p>
        </li>
        <li>
          <p><strong>Copy that page's address and paste it below.</strong> Click the address bar, select all, copy, and paste here. It connects as soon as you paste.</p>
          {pending && <p className="muted">Waiting for your paste{pendingUntil ? ` until ${new Date(pendingUntil).toLocaleTimeString()}` : ""}.</p>}
          <label>Address of the error page
            <input
              value={pasted}
              onChange={(event) => accept(event.target.value, false)}
              onPaste={(event) => { event.preventDefault(); accept(event.clipboardData.getData("text"), true); }}
              placeholder="http://127.0.0.1:47621/callback?code=…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {hint && <p className="error">{hint}</p>}
          <div className="row">
            <button type="button" disabled={!pasted.trim()} onClick={() => accept(pasted, true)}>Finish connecting</button>
            {onClose && <button className="quiet" type="button" onClick={onClose}>Cancel</button>}
          </div>
        </li>
      </ol>
    </div>
  );
}

function TradingCapitalFields({ summary, draft, onChange }: { summary: Summary; draft: SettingsDraft; onChange: (value: number) => void }) {
  const capital = summary.tradingCapital;
  return (
    <div>
      <label>Trading capital, dollars
        <input type="number" min={0} step="0.01" value={draft.tradingCapital ?? capital?.saved ?? 0} onChange={(event) => onChange(Number(event.target.value))} />
      </label>
      <p className="hint">This saved dollar figure is snapshotted onto each new position. Changing it does not alter open positions. Quick fills use the current balance ({capital?.balanceUsd ?? "n/a"}).</p>
      {capital?.warn && <p className="banner warn">Trading capital is above the current balance. New trades will use {capital.effectiveUsd}.</p>}
      {capital?.paused && <p className="banner warn">Open exposure ({capital.exposureUsd}) is at or above Trading capital. New buys are paused until exposure is back under.</p>}
      <div className="preset-grid">
        {(capital?.presets ?? []).map((preset) => (
          <button key={preset.pct} className="quiet" type="button" onClick={() => onChange(preset.dollars)}>{preset.pct}% ({preset.dollars.toFixed(2)})</button>
        ))}
      </div>
    </div>
  );
}

function PositionsPanel({ title, positions, empty, onChanged }: { title: string; positions: PositionView[]; empty: string; onChanged: () => void }) {
  return (
    <section className="card wide">
      <h2>{title}</h2>
      {positions.length === 0 && <p>{empty}</p>}
      {positions.map((position) => (
        <article className="rule" key={position.id}>
          <header>
            <h3><SymbolLabel symbol={position.symbol} name={position.company?.name} exchange={position.company?.exchange} /></h3>
            <div className="muted">{position.quantity} @ {position.avgCost} · last {position.last} · P&L <MoneyText text={position.pnl} /></div>
          </header>
          <p className="muted">Trading capital snapshot {position.tradingCapital}. Target {position.profitTargetPct}% / stop {position.stopLossPct}% of average cost. {[position.buyRule, position.sellRule].filter(Boolean).join(" · ")}</p>
          <table className="data">
            <thead><tr><th className="l">Side</th><th>Qty</th><th>Price</th><th className="l">Status</th><th className="l">Reason</th></tr></thead>
            <tbody>
              {position.trades.length === 0 && <tr><td colSpan={5}>No trades recorded yet.</td></tr>}
              {position.trades.map((trade) => (
                <tr key={trade.id}>
                  <td className="l">{trade.side}</td>
                  <td>{trade.quantity}</td>
                  <td>{trade.price}</td>
                  <td className="l">{trade.status}</td>
                  <td className="l">
                    {trade.sizeReason}{trade.exitReason ? ` ${trade.exitReason}` : ""}
                    {trade.signals && trade.signals.length > 0 && (
                      <ul className="muted">
                        {trade.signals.map((signal) => (
                          <li key={signal.id}>{formatTradeSignalLine(signal)}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {position.status === "open" && (
            <div className="row">
              <EditCapitalButton position={position} onDone={onChanged} />
              <EditExitsButton position={position} onDone={onChanged} />
            </div>
          )}
        </article>
      ))}
    </section>
  );
}

function EditCapitalButton({ position, onDone }: { position: PositionView; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(Number(position.tradingCapital.replace(/[^0-9.-]/g, "")) || 0);
  const [note, setNote] = useState("");
  if (!open) return <button className="quiet" type="button" onClick={() => setOpen(true)}>Edit capital</button>;
  return (
    <div className="stepup-mask">
    <div className="card confirm" role="dialog" aria-label="Edit capital">
      <p>Change this position’s Trading capital snapshot only. This never sells shares. If the new cap is below current holdings, the app just stops adding.</p>
      <input type="number" min={0} step="0.01" value={value} onChange={(event) => setValue(Number(event.target.value))} />
      {note && <p className="error">{note}</p>}
      <div className="row">
        <button className="danger" type="button" onClick={() => {
          postJson("/api/positions/" + position.id + "/capital", { amount: value, confirm: true }).then(() => { setOpen(false); onDone(); }).catch((err: unknown) => setNote(err instanceof Error ? err.message : "Could not edit."));
        }}>Confirm capital change</button>
        <button className="quiet" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
    </div>
  );
}

function EditExitsButton({ position, onDone }: { position: PositionView; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [profit, setProfit] = useState(position.profitTargetPct);
  const [stop, setStop] = useState(position.stopLossPct);
  const [note, setNote] = useState("");
  if (!open) return <button className="quiet" type="button" onClick={() => setOpen(true)}>Edit target / stop</button>;
  return (
    <div className="stepup-mask">
    <div className="card confirm" role="dialog" aria-label="Edit target / stop">
      <label>Profit target %<input type="number" min={0} max={100} step="any" value={profit} onChange={(event) => setProfit(Number(event.target.value))} /></label>
      <label>Stop-loss %<input type="number" min={0} max={100} step="any" value={stop} onChange={(event) => setStop(Number(event.target.value))} /></label>
      {note && <p className="error">{note}</p>}
      <div className="row">
        <button type="button" onClick={() => {
          postJson("/api/positions/" + position.id + "/exits", { profitTargetPct: profit, stopLossPct: stop }).then(() => { setOpen(false); onDone(); }).catch((err: unknown) => setNote(err instanceof Error ? err.message : "Could not edit."));
        }}>Save target and stop</button>
        <button className="quiet" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
    </div>
  );
}

function ReviewPage() {
  const [data, setData] = useState<ReviewScreen | null>(null);
  const [error, setError] = useState("");
  const [symbol, setSymbol] = useState("");
  const [session, setSession] = useState("");
  const [mode, setMode] = useState("");
  const [rule, setRule] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  async function load() {
    const next = await getReviews({
      symbol,
      session,
      mode,
      rule,
      from: from ? String(new Date(`${from}T00:00:00`).getTime()) : "",
      to: to ? String(new Date(`${to}T23:59:59.999`).getTime()) : "",
    });
    setData(next);
  }
  useEffect(() => { load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load reviews.")); }, []);
  if (!data) return <section className="card"><p>Loading reviews…</p>{error && <p className="error">{error}</p>}</section>;
  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <section className="card">
        <h2>Review</h2>
        <p>Closed positions, imported live holdings, automatic bot notes, and scorecards. Filters apply to the list below.</p>
        <div className="row wrap">
          <label>Symbol<input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} /></label>
          <label>Session
            <select value={session} onChange={(event) => setSession(event.target.value)}>
              <option value="">Any</option>
              <option value="regular">Regular</option>
              <option value="extended">Extended</option>
              <option value="overnight">Overnight</option>
            </select>
          </label>
          <label>Mode
            <select value={mode} onChange={(event) => setMode(event.target.value)}>
              <option value="">Any</option>
              <option value="sim">Simulator</option>
              <option value="live">Live</option>
            </select>
          </label>
          <label>Rule id<input value={rule} onChange={(event) => setRule(event.target.value)} /></label>
          <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <button type="button" onClick={() => load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load reviews."))}>Apply filters</button>
        </div>
      </section>
      <section className="card">
        <h2>Best and worst signals</h2>
        <p className="muted">Best: {data.bestSignals.length ? data.bestSignals.map((item) => `${item.name} (${item.sample})`).join(", ") : "Not enough closed trades yet."}</p>
        <p className="muted">Worst: {data.worstSignals.length ? data.worstSignals.map((item) => `${item.name} (${item.sample})`).join(", ") : "Not enough closed trades yet."}</p>
        <h3>Rule scorecards</h3>
        <table className="data">
          <thead><tr><th className="l">Rule</th><th className="l">Mode</th><th>Trades</th><th>Win rate</th><th>Avg P&L %</th><th>Worst loss</th></tr></thead>
          <tbody>
            {data.ruleScores.length === 0 && <tr><td colSpan={6}>No score snapshots yet. They are computed daily after trades close.</td></tr>}
            {data.ruleScores.map((row, index) => (
              <tr key={`${row.rule}-${row.mode}-${index}`}><td className="l">{row.rule}</td><td className="l">{row.mode}</td><td>{row.trades}</td><td>{row.winRate == null ? "—" : `${Math.round(row.winRate * 100)}%`}</td><td>{row.avgPnlPct == null ? "—" : <Signed n={row.avgPnlPct} pct />}</td><td>{row.worstLoss == null ? "—" : <Signed n={row.worstLoss} money />}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      {data.reviews.map((review) => (
        <section className="card" key={review.positionId}>
          <h3 className="review-title"><SymbolLabel symbol={review.symbol} name={review.company?.name} exchange={review.company?.exchange} /> <span>· {review.exitType} · <MoneyText text={review.pnl} /> (<MoneyText text={review.pnlPct} />)</span></h3>
          <p className="muted">{review.mode} · {review.session} · held {review.holdMinutes} min · {review.addsCount} add{review.addsCount === 1 ? "" : "s"}{review.addsHelped == null ? "" : review.addsHelped ? " (helped)" : " (did not help)"} · {review.buyRule} · {review.sellRule}</p>
          <p>{review.botNote}</p>
          <label>Your note
            <textarea rows={2} value={note[review.positionId] ?? review.userNote} onChange={(event) => setNote({ ...note, [review.positionId]: event.target.value })} />
          </label>
          <button className="quiet" type="button" onClick={() => postJson("/api/reviews/" + review.positionId + "/note", { userNote: note[review.positionId] ?? review.userNote }).then(() => load()).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not save the note."))}>Save note</button>
        </section>
      ))}
      {data.reviews.length === 0 && <section className="card"><p>No closed positions match these filters.</p></section>}
    </div>
  );
}
