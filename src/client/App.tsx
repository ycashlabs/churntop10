import { useEffect, useState } from "react";
import type { SessionView, Summary } from "../lib/api-types";
import { getPendingConnect, getSession, getSummary, loadCsrf, post, registerPasskey, signIn } from "./api";

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

  if (!session) return <main className="shell"><p>Loading…</p></main>;
  if (!session.authenticated || session.recovery) {
    return <SignIn session={session} error={error} onDone={() => run(async () => { await refresh(); })} />;
  }
  if (!summary) return <main className="shell"><p>Loading the account…</p>{error && <p className="error">{error}</p>}</main>;

  const page = path.startsWith("/top10") ? "top10" : path.startsWith("/settings") ? "settings" : "summary";
  return (
    <main className="shell">
      <header>
        <div>
          <h1>Churn Top 10</h1>
          <nav>
            <a href="/" className={page === "summary" ? "active" : ""} onClick={(event) => { event.preventDefault(); go("/"); }}>Account Summary</a>
            <a href="/top10" className={page === "top10" ? "active" : ""} onClick={(event) => { event.preventDefault(); go("/top10"); }}>Top 10</a>
            <a href="/settings" className={page === "settings" ? "active" : ""} onClick={(event) => { event.preventDefault(); go("/settings"); }}>Settings</a>
          </nav>
        </div>
        <div className="meta">
          <div className={summary.mode === "live" ? "stamp" : "stamp"}>{summary.killed ? "Killed" : summary.mode === "live" ? "Live" : "View only"}</div>
          <div>{summary.clock}</div>
          <div>{summary.session}</div>
          <button className="quiet" type="button" onClick={() => run(async () => { await post("/api/auth/logout"); setSummary(null); })}>Sign out</button>
        </div>
      </header>
      {summary.mode !== "live" && <p className="banner">View Only. Checks are saved and nothing is sent.</p>}
      {summary.mode === "live" && !summary.liveGate && <p className="banner">Live is selected. The broker gate is off, so fills stay in the simulator.</p>}
      {summary.killed && <p className="banner">Kill switch is on. New buys are stopped. Working entries in the simulator are cancelled. Real Robinhood orders are not cancelled from here.</p>}
      {error && <p className="error">{error}</p>}
      {page === "summary" && <SummaryPage summary={summary} />}
      {page === "top10" && <TopPage summary={summary} onRun={run} />}
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
        <h2>Robinhood</h2>
        {summary.robinhoodStatus === "error" && <p className="error">{summary.robinhoodError ?? "Robinhood could not be read."} Reconnect from <a href="/settings">Settings</a>.</p>}
        {summary.robinhoodStatus === "not_connected" && <p>Not connected. Connect from <a href="/settings">Settings</a>. Until then, Top 10 quotes come from the recorded book from 13 Nov 2026.</p>}
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
        <h2>Simulator {summary.simulator.maskedAccount}</h2>
        <dl>
          <dt>Equity</dt><dd>{summary.simulator.equity}</dd>
          <dt>Cash</dt><dd>{summary.simulator.cash}</dd>
          <dt>Daily loss</dt><dd>{summary.simulator.dailyLoss} / {summary.simulator.dailyLossCap}</dd>
          <dt>Day trades</dt><dd>{summary.simulator.dayTrades} / {summary.simulator.pdtLimit}</dd>
          <dt>Quotes</dt><dd>{summary.quoteSource === "robinhood" ? "Live" : "Recorded"}</dd>
        </dl>
        <table>
          <thead><tr><th>Position</th><th>Qty</th><th>Last</th><th>P&L</th></tr></thead>
          <tbody>
            {summary.simulator.positions.length === 0 && <tr><td colSpan={4}>No simulated positions.</td></tr>}
            {summary.simulator.positions.map((position) => (
              <tr key={position.symbol}><td>{position.symbol}</td><td>{position.quantity}</td><td>{position.last}</td><td>{position.pnl}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>Orders</h2>
        <table>
          <thead><tr><th>Symbol</th><th>Side</th><th>Role</th><th>Status</th></tr></thead>
          <tbody>
            {summary.simulator.orders.length === 0 && <tr><td colSpan={4}>No orders yet.</td></tr>}
            {summary.simulator.orders.map((order, index) => (
              <tr key={`${order.symbol}-${order.role}-${index}`}><td>{order.symbol}</td><td>{order.side}</td><td>{order.role}</td><td>{order.status}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>Latest check</h2>
        <ul className="proposals">
          {summary.proposals.length === 0 && <li>No check yet. Run one from Top 10.</li>}
          {summary.proposals.map((proposal) => <li key={`${proposal.symbol}-${proposal.at}`}><strong>{proposal.symbol}</strong> {proposal.verdict}. {proposal.message}</li>)}
        </ul>
      </section>
    </div>
  );
}

function TopPage({ summary, onRun }: { summary: Summary; onRun: (action: () => Promise<Summary | void>) => void }) {
  const [symbols, setSymbols] = useState(summary.top10.map((row) => row.symbol).join("\n"));
  useEffect(() => { setSymbols(summary.top10.map((row) => row.symbol).join("\n")); }, [summary]);
  return (
    <section className="card">
      <h2>Top 10</h2>
      <p>New buys have to be on this list. Names you already hold can still be sold, and a buy that adds to one of them is not treated as a new name.</p>
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
        <button className="quiet" type="button" onClick={() => onRun(() => post("/api/cycle"))}>Run check</button>
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
      <label>Profit target, percent of account balance (0.1–3)
        <input type="number" min={0.1} max={3} step={0.1} value={draft.profitTargetPct} onChange={(event) => setNumber("profitTargetPct", event.target.value)} />
      </label>
      <label>Stop-loss, percent from entry (0.1–5)
        <input type="number" min={0.1} max={5} step={0.1} value={draft.stopLossPct} onChange={(event) => setNumber("stopLossPct", event.target.value)} />
      </label>
      <label>Order cap, percent of equity (1–25)
        <input type="number" min={1} max={25} step={1} value={draft.maxOrderPct} onChange={(event) => setNumber("maxOrderPct", event.target.value)} />
      </label>
      <label>Daily loss stop, percent of the day's starting equity (0.1–5)
        <input type="number" min={0.1} max={5} step={0.1} value={draft.dailyLossPct} onChange={(event) => setNumber("dailyLossPct", event.target.value)} />
      </label>
      <div className="row">
        <button type="button" onClick={() => onRun(() => post("/api/settings", draft))}>Save caps</button>
        {summary.mode === "view_only" ? (
          <button type="button" onClick={() => onRun(() => post("/api/mode", { mode: "live" }))}>Switch to Live</button>
        ) : (
          <button className="quiet" type="button" onClick={() => onRun(() => post("/api/mode", { mode: "view_only" }))}>Switch to View Only</button>
        )}
        <button className="danger" type="button" onClick={() => onRun(() => post("/api/kill"))}>Kill switch</button>
        {summary.killed && <button className="quiet" type="button" onClick={() => onRun(() => post("/api/resume"))}>Clear kill switch</button>}

      </div>

      <h3>Robinhood</h3>
      <p className="rh-status">
        {summary.robinhoodStatus === "connected" && <>Connected to {summary.robinhood?.maskedAccount ?? "your account"}.</>}
        {summary.robinhoodStatus === "not_connected" && <>Not connected.</>}
        {summary.robinhoodStatus === "error" && <span className="error">{summary.robinhoodError ?? "Robinhood could not be read."}</span>}
      </p>
      <div className="row">
        <button type="button" onClick={() => {
          setShowPaste(true);
          setPasted("");
          onRun(async () => {
            const body = await post("/api/robinhood/connect") as Summary & { url?: string };
            if (body.url) {
              setConnectUrl(body.url);
              sessionStorage.setItem(CONNECT_AT_KEY, String(Date.now()));
            }
            await loadPending();
            return undefined;
          });
        }}>{summary.robinhoodStatus === "not_connected" ? "Connect Robinhood" : "Reconnect Robinhood"}</button>
        {!showPaste && !pending && !connectUrl && <button className="quiet" type="button" onClick={() => setShowPaste(true)}>Paste Robinhood address</button>}
        {summary.robinhoodStatus !== "not_connected" && (
          <button className="quiet" type="button" onClick={() => onRun(async () => {
            if (!window.confirm("Disconnect Robinhood? The app forgets its saved sign-in. Robinhood orders are not touched.")) return undefined;
            clearConnect();
            return post("/api/robinhood/disconnect");
          })}>Disconnect Robinhood</button>
        )}
      </div>
      {(showPaste || pending || connectUrl) && (
        <div className="card" id="robinhood-paste">
          <h3>Paste Robinhood address</h3>
          {pending && <p>A Robinhood sign-in is waiting{pendingUntil ? ` until ${new Date(pendingUntil).toLocaleTimeString()}` : ""}. Paste the address to finish.</p>}
          <ol>
            <li>{connectUrl ? <a href={connectUrl} target="_blank" rel="noopener noreferrer">Open Robinhood sign-in</a> : "Click Connect Robinhood to open Robinhood sign-in"} and approve.</li>
            <li>Robinhood then sends you to a page that won't load (it starts with <code>http://127.0.0.1:47621/callback</code>). That's expected.</li>
            <li>Copy the whole address from that tab's address bar and paste it here within 10 minutes.</li>
          </ol>
          <label>Address from the page that didn't load
            <input value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="http://127.0.0.1:47621/callback?code=…" autoComplete="off" spellCheck={false} />
          </label>
          <div className="row">
            <button type="button" disabled={!pasted.trim()} onClick={() => onRun(async () => {
              try {
                await post("/api/robinhood/complete", { callbackUrl: pasted });
                clearConnect();
              } catch (err) {
                setShowPaste(true);
                throw err;
              } finally {
                await loadPending();
              }
            })}>Finish connecting</button>
            <button className="quiet" type="button" onClick={clearConnect}>Close</button>
          </div>
        </div>
      )}
      <p>Saving caps, editing the Top 10, switching to Live, and connecting or disconnecting Robinhood each ask for the passkey again. The kill switch does not.</p>
    </section>
  );
}
