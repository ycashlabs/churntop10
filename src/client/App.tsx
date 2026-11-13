import { useEffect, useState } from "react";
import type { PositionView, ReviewScreen, RuleHistoryView, RuleView, SessionView, SimulatorView, Summary } from "../lib/api-types";
import { formatTradeSignalLine } from "../lib/trade-signals";
import { sessionBootstrapCopy } from "../lib/boot-copy";
import { SESSION_HELP } from "../lib/clock";
import { parseCallbackInput } from "../lib/oauth";
import { getPendingConnect, getReviews, getRuleHistory, getRules, getSession, getSimulator, getSummary, loadCsrf, post, postJson, registerPasskey, signIn } from "./api";

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
    return <main className="shell"><p>{boot.heading}</p>{boot.error && <p className="error">{boot.error}</p>}</main>;
  }
  if (!session.authenticated || session.recovery) {
    return <SignIn session={session} error={error} onDone={() => run(async () => { await refresh(); })} />;
  }
  if (!summary) return <main className="shell"><p>Loading the account…</p>{error && <p className="error">{error}</p>}</main>;

  const page = path.startsWith("/top10") ? "top10" : path.startsWith("/rules") ? "rules" : path.startsWith("/simulator") ? "simulator" : path.startsWith("/review") ? "review" : path.startsWith("/settings") ? "settings" : "summary";
  return (
    <main className="shell">
      <header>
        <div>
          <h1>Churn Top 10</h1>
          <nav>
            <a href="/" className={page === "summary" ? "active" : ""} onClick={(event) => { event.preventDefault(); go("/"); }}>Account Summary</a>
            <a href="/top10" className={page === "top10" ? "active" : ""} onClick={(event) => { event.preventDefault(); go("/top10"); }}>Top 10</a>
            <a href="/rules" className={page === "rules" ? "active" : ""} onClick={(event) => { event.preventDefault(); go("/rules"); }}>Rules</a>
            <a href="/simulator" className={page === "simulator" ? "active" : ""} onClick={(event) => { event.preventDefault(); go("/simulator"); }}>Simulator</a>
            <a href="/review" className={page === "review" ? "active" : ""} onClick={(event) => { event.preventDefault(); go("/review"); }}>Review</a>
            <a href="/settings" className={page === "settings" ? "active" : ""} onClick={(event) => { event.preventDefault(); go("/settings"); }}>Settings</a>
          </nav>
        </div>
        <div className="meta">
          <div className="stamp">{summary.killed ? "New buys stopped" : summary.mode === "live" ? "Live" : "View only"}</div>
          <div>{summary.clock}</div>
          <div>{summary.session}</div>
          <button className="quiet" type="button" onClick={() => run(async () => { await post("/api/auth/logout"); setSummary(null); })}>Sign out</button>
        </div>
      </header>
      {summary.mode !== "live" && <p className="banner">View Only. Live real-money trading stays off until you explicitly approve it. The Simulator has its own screen and fake money.</p>}
      {summary.mode === "live" && !summary.liveGate && <p className="banner">Live is selected, but the broker gate is off. No real Robinhood orders are sent. Use the Simulator screen to run selected rules with fake money.</p>}
      {summary.killed && <p className="banner">Sell All Positions is on. New buys are stopped. Real Robinhood orders are not cancelled or sold from here.</p>}
      {error && <p className="error">{error}</p>}
      {page === "summary" && <SummaryPage summary={summary} />}
      {page === "top10" && <TopPage summary={summary} onRun={run} />}
      {page === "rules" && <RulesPage />}
      {page === "simulator" && <SimulatorPage />}
      {page === "review" && <ReviewPage />}
      {page === "settings" && <SettingsPage summary={summary} onRun={run} />}
    </main>
  );
}

function SignIn({ session, error, onDone }: { session: SessionView; error: string; onDone: () => void }) {
  const [email, setEmail] = useState("tom2258@gmail.com");
  const [note, setNote] = useState("");
  const params = new URLSearchParams(window.location.search);
  return (
    <main className="shell signin">
      <h1>Churn Top 10</h1>
      <p>One owner. Passkey to sign in. Email is only for recovery.</p>
      {session.recovery && <p className="banner">Recovery confirmed. Register a new passkey to replace the old one.</p>}
      {params.get("recovery") === "invalid" && <p className="error">That recovery link is invalid or already used.</p>}
      {error && <p className="error">{error}</p>}
      {note && <p>{note}</p>}
      <div className="row">
        {!session.registered || session.recovery ? (
          <button type="button" onClick={() => registerPasskey().then(onDone).catch((err: unknown) => setNote(err instanceof Error ? err.message : "Could not register."))}>Create passkey</button>
        ) : (
          <button type="button" onClick={() => signIn().then(onDone).catch((err: unknown) => setNote(err instanceof Error ? err.message : "Could not sign in."))}>Sign in</button>
        )}
      </div>
      {!session.recovery && (
        <form onSubmit={(event) => {
          event.preventDefault();
          post("/api/auth/recovery", { email }).then(() => setNote("If that email is the owner, a recovery link was issued.")).catch((err: unknown) => setNote(err instanceof Error ? err.message : "Could not start recovery."));
        }}>
          <label>Recovery email<input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></label>
          <button className="quiet" type="submit">Email a recovery link</button>
        </form>
      )}
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

function TopPage({ summary, onRun }: { summary: Summary; onRun: (action: () => Promise<Summary | void>) => void }) {
  const [symbols, setSymbols] = useState(summary.top10.map((row) => row.symbol).join("\n"));
  useEffect(() => { setSymbols(summary.top10.map((row) => row.symbol).join("\n")); }, [summary]);
  return (
    <section className="card">
      <h2>Top 10</h2>
      <p>This list is editable anytime and limits new first buys only. Positions in a name you later remove are still managed and can still be sold. Adds to a held name follow the scaling-in rules.</p>
      <table>
        <thead><tr><th>Symbol</th><th>Bid</th><th>Ask</th><th>Last</th></tr></thead>
        <tbody>
          {summary.top10.map((row) => <tr key={row.symbol}><td>{row.symbol}</td><td>{row.bid}</td><td>{row.ask}</td><td>{row.last}</td></tr>)}
        </tbody>
      </table>
      <label>Symbols, one per line
        <textarea rows={10} value={symbols} onChange={(event) => setSymbols(event.target.value)} />
      </label>
      <div className="row">
        <button type="button" onClick={() => onRun(() => post("/api/top10", { symbols: symbols.split(/\s+/).filter(Boolean) }))}>Save list</button>
      </div>
    </section>
  );
}

function SettingsPage({ summary, onRun }: { summary: Summary; onRun: (action: () => Promise<Summary | void>) => void }) {
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
    <section className="card">
      <h2>Settings</h2>
      <p>{SESSION_HELP}</p>
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
      <TradingCapitalFields summary={summary} draft={draft} onChange={(value) => setDraft({ ...draft, tradingCapital: value })} />
      <p className="muted">There are no buy amount fields. Sizing is the 20% starter (2% of the position’s Trading capital snapshot), signal-sized adds, and a 10% per-symbol cap on that snapshot. Sells have no dollar limit. The app never borrows.</p>
      <div className="row">
        <button type="button" onClick={() => onRun(() => post("/api/settings", draft))}>Save caps</button>
        {summary.mode === "view_only" ? (
          <button type="button" onClick={() => onRun(() => post("/api/mode", { mode: "live" }))}>Switch to Live</button>
        ) : (
          <button className="quiet" type="button" onClick={() => onRun(() => post("/api/mode", { mode: "view_only" }))}>Switch to View Only</button>
        )}
        <SellAllButton onDone={() => onRun(async () => undefined)} />
        {summary.killed && <button className="quiet" type="button" onClick={() => onRun(() => post("/api/resume"))}>Allow new buys again</button>}

      </div>

      <h3>Robinhood</h3>
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
      {summary.robinhoodStatus !== "not_connected" && (
        <div className="row">
          <button className="quiet" type="button" onClick={() => onRun(async () => {
            if (!window.confirm("Disconnect Robinhood? The app forgets its saved sign-in. Robinhood orders are not touched.")) return undefined;
            clearConnect();
            return post("/api/robinhood/disconnect");
          })}>Disconnect Robinhood</button>
        </div>
      )}
      <p>Saving caps, editing the Top 10 or a rule, marking a rule Proven, and switching to Live or connecting Robinhood each ask for the passkey again. Sell All Positions asks for a confirm step, not a passkey. It sells simulated positions only and does not place or cancel real Robinhood orders.</p>
    </section>
  );
}

function score(card: RuleView["scorecard"]): string {
  if (card.tradeCount === 0) return "No trades yet.";
  const win = card.winRate === null ? "—" : `${Math.round(card.winRate * 100)}%`;
  const avg = card.avgProfit === null ? "—" : `$${card.avgProfit.toFixed(2)}`;
  const worst = card.worstLoss === null ? "—" : `$${card.worstLoss.toFixed(2)}`;
  return `Win rate ${win}. Avg profit ${avg}. Worst loss ${worst}. ${card.tradeCount} trades.`;
}

function RulesPage() {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<RuleHistoryView[]>([]);
  const [historyFor, setHistoryFor] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftSide, setDraftSide] = useState<"buy" | "sell">("buy");
  const [draftBody, setDraftBody] = useState("");
  const [editing, setEditing] = useState<string>("");
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
  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <section className="card">
        <h2>Rules contract</h2>
        <p>You edit the text; the app proofreads by saving a history entry for every change, status change, and approval. Only you can mark a rule Proven. Live trading uses only Proven rules. The Simulator can run any selected rules, including Experimenting ones. Editing a Proven rule creates a new Experimenting version; open trades keep the versions they started with.</p>
        {rules.map((rule) => (
          <article className="rule" key={rule.id}>
            <header>
              <h3>{rule.name} <span className="muted">v{rule.version}</span></h3>
              <div className={`stamp ${rule.status}`}>{rule.status}</div>
            </header>
            <p className="muted">{rule.side === "buy" ? "Buy rule" : "Sell rule"} · {rule.signals.length ? rule.signals.join(", ") : "Uses Settings percentages"}</p>
            <p>{rule.body}</p>
            <p className="muted">{score(rule.scorecard)}</p>
            <div className="row">
              <button className="quiet" type="button" onClick={() => { setEditing(rule.id); setDraftName(rule.name); setDraftSide(rule.side); setDraftBody(rule.body); }}>Edit / rename</button>
              {rule.status !== "proven" && <button type="button" onClick={() => run(() => postJson("/api/rules/" + rule.id + "/status", { status: "proven" }))}>Mark Proven</button>}
              {rule.status === "proven" && <button className="quiet" type="button" onClick={() => run(() => postJson("/api/rules/" + rule.id + "/status", { status: "experimenting" }))}>Move to Experimenting</button>}
              {rule.status !== "retired" && <button className="quiet" type="button" onClick={() => run(() => postJson("/api/rules/" + rule.id + "/status", { status: "retired" }))}>Retire</button>}
              <button className="quiet" type="button" onClick={() => showHistory(rule.familyId)}>History</button>
            </div>
          </article>
        ))}
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
        {sim.tradingCapital?.paused && <p className="banner">Open exposure is at or above Trading capital. New buys wait until exposure is back under.</p>}
        <h3>Rules to run</h3>
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
        <table>
          <thead><tr><th>Symbol</th><th>Side</th><th>Role</th><th>Status</th><th>Price</th></tr></thead>
          <tbody>
            {sim.orders.length === 0 && <tr><td colSpan={5}>No orders yet.</td></tr>}
            {sim.orders.map((order, index) => (
              <tr key={`${order.symbol}-${order.role}-${index}`}><td>{order.symbol}</td><td>{order.side}</td><td>{order.role}</td><td>{order.status}</td><td>{order.price}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>Latest check</h2>
        <ul className="proposals">
          {sim.events.map((event, index) => <li key={`e-${index}`}><strong>{event.action}</strong> {event.detail}</li>)}
          {sim.proposals.map((proposal) => <li key={`${proposal.symbol}-${proposal.at}`}><strong>{proposal.symbol}</strong> {proposal.verdict}. {proposal.message}</li>)}
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
    <div className="confirm">
      <p>This sells every simulated position, stops new buys, and does not send or cancel real Robinhood orders. Confirm?</p>
      {note && <p className="error">{note}</p>}
      <div className="row">
        <button className="danger" type="button" onClick={() => {
          postJson("/api/sell-all", { confirm: true }).then(() => { setConfirming(false); onDone(); }).catch((err: unknown) => setNote(err instanceof Error ? err.message : "Could not sell."));
        }}>Confirm sell all</button>
        <button className="quiet" type="button" onClick={() => setConfirming(false)}>Cancel</button>
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
    <div className="card" id="robinhood-paste">
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
      <p className="muted">This saved dollar figure is snapshotted onto each new position. Changing it does not alter open positions. Quick fills use the current balance ({capital?.balanceUsd ?? "n/a"}).</p>
      {capital?.warn && <p className="banner">Trading capital is above the current balance. New trades will use {capital.effectiveUsd}.</p>}
      {capital?.paused && <p className="banner">Open exposure ({capital.exposureUsd}) is at or above Trading capital. New buys are paused until exposure is back under.</p>}
      <div className="row wrap">
        {(capital?.presets ?? []).map((preset) => (
          <button key={preset.pct} className="quiet" type="button" onClick={() => onChange(preset.dollars)}>{preset.pct}% ({preset.dollars.toFixed(2)})</button>
        ))}
      </div>
    </div>
  );
}

function PositionsPanel({ title, positions, empty, onChanged }: { title: string; positions: PositionView[]; empty: string; onChanged: () => void }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {positions.length === 0 && <p>{empty}</p>}
      {positions.map((position) => (
        <article className="rule" key={position.id}>
          <header>
            <h3>{position.symbol}</h3>
            <div className="muted">{position.quantity} @ {position.avgCost} · last {position.last} · P&L {position.pnl}</div>
          </header>
          <p className="muted">Trading capital snapshot {position.tradingCapital}. Target {position.profitTargetPct}% / stop {position.stopLossPct}% of average cost. {[position.buyRule, position.sellRule].filter(Boolean).join(" · ")}</p>
          <table>
            <thead><tr><th>Side</th><th>Qty</th><th>Price</th><th>Status</th><th>Reason</th></tr></thead>
            <tbody>
              {position.trades.length === 0 && <tr><td colSpan={5}>No trades recorded yet.</td></tr>}
              {position.trades.map((trade) => (
                <tr key={trade.id}>
                  <td>{trade.side}</td>
                  <td>{trade.quantity}</td>
                  <td>{trade.price}</td>
                  <td>{trade.status}</td>
                  <td>
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
    <div className="confirm">
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
  );
}

function EditExitsButton({ position, onDone }: { position: PositionView; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [profit, setProfit] = useState(position.profitTargetPct);
  const [stop, setStop] = useState(position.stopLossPct);
  const [note, setNote] = useState("");
  if (!open) return <button className="quiet" type="button" onClick={() => setOpen(true)}>Edit target / stop</button>;
  return (
    <div className="confirm">
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
        <table>
          <thead><tr><th>Rule</th><th>Mode</th><th>Trades</th><th>Win rate</th><th>Avg P&L %</th><th>Worst loss</th></tr></thead>
          <tbody>
            {data.ruleScores.length === 0 && <tr><td colSpan={6}>No score snapshots yet. They are computed daily after trades close.</td></tr>}
            {data.ruleScores.map((row, index) => (
              <tr key={`${row.rule}-${row.mode}-${index}`}><td>{row.rule}</td><td>{row.mode}</td><td>{row.trades}</td><td>{row.winRate == null ? "—" : `${Math.round(row.winRate * 100)}%`}</td><td>{row.avgPnlPct == null ? "—" : row.avgPnlPct.toFixed(2)}</td><td>{row.worstLoss == null ? "—" : row.worstLoss.toFixed(2)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      {data.reviews.map((review) => (
        <section className="card" key={review.positionId}>
          <h3>{review.symbol} · {review.exitType} · {review.pnl} ({review.pnlPct})</h3>
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
