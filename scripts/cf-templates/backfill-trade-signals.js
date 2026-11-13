async () => {
  // Dry-run backfill of trade_signals from audit/proposal payloads.
  // Set apply to true only with an explicit owner go-ahead. Never places orders.
  const apply = false;
  const a = accountId;
  const db = "REPLACE_WITH_TARGET_D1_ID";
  async function q(sql) {
    const res = await cloudflare.request({
      method: "POST",
      path: `/accounts/${a}/d1/database/${db}/query`,
      body: { sql },
    });
    if (!res.success) throw new Error(JSON.stringify(res.errors));
    return res.result?.[0]?.results || [];
  }
  const trades = await q(`
    SELECT t.id, p.symbol, t.side, t.created_at AS createdAt
    FROM trades t
    JOIN positions p ON p.id = t.position_id
    WHERE t.source = 'app'
    ORDER BY t.created_at
  `);
  const existing = await q("SELECT DISTINCT trade_id AS id FROM trade_signals");
  const have = new Set(existing.map((row) => row.id));
  const audits = await q("SELECT action, at, detail FROM audit_index WHERE action IN ('sim_entry','sim_add','weakness_exit_filled','stop_exit_filled','broker_stop_filled','target_filled','sell_all_filled','live_order') ORDER BY at");
  const proposals = await q("SELECT symbol, created_at AS createdAt, payload FROM proposals");
  const SIGNAL_THRESHOLDS = {
    price_above_20m_avg: 0, volume_above_recent: 1, spy_up: 0, spy_falling: 0,
    spy_not_falling_hard: -0.5, below_avg_cost: 0, above_20m_low: 0,
    no_sell_volume_spike: 1.5, below_20m_avg: 0, rising_volume: 1,
  };
  function parseSignals(payload) {
    let value = payload;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return []; }
    }
    if (!Array.isArray(value)) return [];
    return value.filter((item) => item && typeof item.id === "string").map((item) => ({
      id: item.id,
      name: typeof item.name === "string" ? item.name : item.id,
      value: typeof item.value === "number" ? item.value : null,
      threshold: typeof item.threshold === "number" ? item.threshold : (item.id in SIGNAL_THRESHOLDS ? SIGNAL_THRESHOLDS[item.id] : null),
      fired: item.fired === true,
      reason: typeof item.reason === "string" ? item.reason : "",
    }));
  }
  const BUY = new Set(["sim_entry", "sim_add", "live_order"]);
  const SELL = new Set(["weakness_exit_filled", "stop_exit_filled", "broker_stop_filled", "target_filled", "sell_all_filled"]);
  const planned = [];
  for (const trade of trades) {
    if (have.has(trade.id)) continue;
    const proposal = proposals.find((item) => item.symbol === trade.symbol && Number(item.createdAt) === Number(trade.createdAt));
    let signals = proposal ? parseSignals(proposal.payload) : [];
    if (signals.length === 0) {
      const allowed = trade.side === "buy" ? BUY : SELL;
      const match = audits
        .map((audit) => {
          let detail = {};
          try { detail = JSON.parse(audit.detail); } catch { detail = {}; }
          return { audit, detail, symbol: detail.symbol };
        })
        .filter((item) => item.symbol === trade.symbol && allowed.has(item.audit.action))
        .filter((item) => Math.abs(Number(item.audit.at) - Number(trade.createdAt)) <= 120000)
        .sort((a, b) => Math.abs(Number(a.audit.at) - Number(trade.createdAt)) - Math.abs(Number(b.audit.at) - Number(trade.createdAt)))[0];
      if (match) signals = parseSignals(match.detail.signals);
    }
    for (const signal of signals) {
      planned.push({ tradeId: trade.id, symbol: trade.symbol, side: trade.side, ...signal });
    }
  }
  if (!apply) return { dryRun: true, count: planned.length, rows: planned };
  const results = [];
  for (const row of planned) {
    const sql = "INSERT INTO trade_signals (trade_id, signal_id, value, passed, threshold, name, reason) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (trade_id, signal_id) DO UPDATE SET value = excluded.value, passed = excluded.passed, threshold = excluded.threshold, name = excluded.name, reason = excluded.reason;";
    const res = await cloudflare.request({
      method: "POST",
      path: `/accounts/${a}/d1/database/${db}/query`,
      body: { sql, params: [row.tradeId, row.id, row.value == null ? null : String(row.value), row.fired ? "1" : "0", row.threshold == null ? null : String(row.threshold), row.name, row.reason] },
    });
    results.push({ tradeId: row.tradeId, signalId: row.id, ok: res.success, errors: res.errors });
  }
  return { dryRun: false, count: planned.length, results };
}
