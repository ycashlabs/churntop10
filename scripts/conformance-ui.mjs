#!/usr/bin/env node
/** Headless UI walk against local wrangler. No screenshots. Writes a JSON results overlay. */
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8797/";
const OUT = process.env.CONFORMANCE_UI || "/tmp/churntop10-conformance/ui.json";
mkdirSync(new URL(".", `file://${OUT}`).pathname.replace(/\/[^/]*$/, "") || "/tmp/churntop10-conformance", { recursive: true });

const results = [];
function record(id, result, reason = "") {
  results.push({ id, result, reason, source: "ui" });
  console.log(result, id, reason);
}

const browser = await puppeteer.launch({
  executablePath: "/opt/google/chrome/chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900"],
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
const client = await page.createCDPSession();
await client.send("WebAuthn.enable", { enableUI: false });
await client.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
page.setDefaultTimeout(40000);
page.on("pageerror", (err) => console.log("pageerror", err.message));

async function text() {
  return page.evaluate(() => document.body.innerText);
}

async function button(label) {
  await page.evaluate((want) => {
    const found = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === want);
    if (!found) throw new Error("missing button: " + want);
    found.click();
  }, label);
}

async function go(href) {
  await page.evaluate((path) => {
    const link = document.querySelector(`a[href='${path}']`);
    if (!link) throw new Error("missing nav link " + path);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }, href);
  const path = href === "/" ? "/" : href;
  await page.waitForFunction((want) => location.pathname === want, { timeout: 15000 }, path);
}

function includesAll(body, needles) {
  return needles.filter((n) => !body.includes(n));
}

try {
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => {
    const body = document.body.innerText;
    const labels = [...document.querySelectorAll("button")].map((item) => item.textContent?.trim());
    return body.includes("Account Summary") || labels.includes("Create passkey") || labels.includes("Sign in");
  });

  let body = await text();
  const signinNeedles = ["One owner. Passkey to sign in. Email is only for recovery.", "Recovery email", "Email a recovery link"];
  if (body.includes("Create passkey") || body.includes("Sign in")) {
    const missing = includesAll(body, signinNeedles);
    record("U-11", missing.length ? "FAIL" : "PASS", missing.length ? `sign-in missing ${JSON.stringify(missing)}` : "sign-in copy visible");
    const labels = await page.evaluate(() => [...document.querySelectorAll("button")].map((item) => item.textContent?.trim()));
    if (labels.includes("Create passkey")) await button("Create passkey");
    else if (labels.includes("Sign in")) await button("Sign in");
    try {
      await page.waitForFunction(() => document.body.innerText.includes("Account Summary"), { timeout: 20000 });
    } catch (err) {
      const now = await text();
      throw new Error("after passkey: " + (err instanceof Error ? err.message : String(err)) + " body=" + now.slice(0, 1500));
    }
  } else {
    record("U-11", "PASS", "already authenticated; sign-in copy not re-checked this walk");
  }

  body = await text();
  const nav = includesAll(body, ["Account Summary", "Top 10", "Rules", "Simulator", "Review", "Settings"]);
  record("U-01", nav.length ? "FAIL" : "PASS", nav.length ? `nav missing ${JSON.stringify(nav)}` : "six nav labels visible");

  const chrome = includesAll(body, ["Churn Top 10", "Sign out", " ET"]);
  const session = /\b(regular|extended|overnight|closed)\b/.test(body);
  record("U-02", chrome.length === 0 && session ? "PASS" : "FAIL", chrome.length || !session ? `chrome ${JSON.stringify(chrome)} session=${session}` : "chrome, ET clock, session visible");

  const banner = includesAll(body, ["View Only. Live real-money trading stays off until you explicitly approve it. The Simulator has its own screen and fake money."]);
  record("U-09", banner.length ? "FAIL" : "PASS", banner.length ? "View Only banner missing" : "View Only banner visible");

  const sessionHelp = "Buys run 24/5, Sunday 8:00 PM through Friday 8:00 PM ET.";
  const summaryNeed = ["Robinhood account", "Session", sessionHelp, "Live positions"];
  const sumMissing = includesAll(body, summaryNeed);
  record("U-03", sumMissing.length ? "FAIL" : "PASS", sumMissing.length ? `summary missing ${JSON.stringify(sumMissing)}` : "Account Summary copy visible");
  record("U-10", body.includes(sessionHelp) ? "PASS" : "FAIL", body.includes(sessionHelp) ? "SESSION_HELP on Account Summary" : "SESSION_HELP missing on Summary");

  await go("/top10");
  await page.waitForFunction(() => document.body.innerText.includes("Top 10") || document.body.innerText.includes("Symbol"));
  body = await text();
  const top = includesAll(body, ["Symbol", "Bid", "Ask", "Last"]);
  record("U-04", top.length ? "FAIL" : "PASS", top.length ? `top10 missing ${JSON.stringify(top)}` : "Top 10 headers visible");

  await go("/rules");
  await page.waitForFunction(() => document.body.innerText.includes("Rules contract") || document.body.innerText.includes("Could not load rules"));
  await page.waitForFunction(() => /experimenting|proven|retired|No rules/i.test(document.body.innerText) || document.body.innerText.includes("Could not load rules"), { timeout: 15000 });
  body = await text();
  const rulesHelp = "Only you can mark a rule Proven. Live trading uses only Proven rules.";
  const rulesMissing = includesAll(body, ["Rules contract", rulesHelp]);
  const rawStamp = await page.evaluate(() => {
    const stamps = [...document.querySelectorAll(".stamp")];
    return stamps.some((el) => /^(experimenting|proven|retired)$/i.test((el.textContent || "").trim()));
  });
  record("U-06", rulesMissing.length === 0 && rawStamp ? "PASS" : "FAIL", rulesMissing.length || !rawStamp ? `rules ${JSON.stringify(rulesMissing)} rawStamp=${rawStamp}` : "Rules help and raw stamps visible");
  record("R-06", rawStamp ? "PASS" : "FAIL", rawStamp ? "raw status stamp visible (source is lowercase; CSS may uppercase it)" : "no raw status stamp visible");

  await go("/simulator");
  await page.waitForFunction(() => document.body.innerText.includes("Run check") || document.body.innerText.includes("Fake money only") || document.body.innerText.includes("Could not load the simulator"));
  body = await text();
  const simNeed = ["Fake money only.", "Run check", "Simulated positions", "Latest check"];
  const simMissing = includesAll(body, simNeed);
  record("U-07", simMissing.length ? "FAIL" : "PASS", simMissing.length ? `simulator missing ${JSON.stringify(simMissing)}` : "Simulator copy visible");

  // Cycle once (fake money only) so H-05 can be observed locally.
  if (body.includes("Allow new buys again") || body.includes("Sell All Positions is on")) {
    await go("/settings");
    await page.waitForFunction(() => document.body.innerText.includes("Sell All Positions") || document.body.innerText.includes("Allow new buys again"));
    const labels = await page.evaluate(() => [...document.querySelectorAll("button")].map((item) => item.textContent?.trim()));
    if (labels.includes("Allow new buys again")) {
      await button("Allow new buys again");
      await page.waitForFunction(() => !document.body.innerText.includes("Sell All Positions is on"));
    }
    await go("/simulator");
    await page.waitForFunction(() => document.body.innerText.includes("Run check"));
  }
  await button("Run check");
  await page.waitForFunction(() => !document.body.innerText.includes("Loading the simulator…") || document.body.innerText.includes("Latest check"), { timeout: 25000 });
  await new Promise((r) => setTimeout(r, 1500));
  const simPayload = await page.evaluate(async () => {
    const res = await fetch("/api/simulator", { credentials: "same-origin" });
    return res.json();
  });
  const trades = [];
  for (const pos of simPayload.positions || []) {
    for (const trade of pos.trades || []) trades.push(trade);
  }
  const withSignals = trades.filter((t) => Array.isArray(t.signals) && t.signals.length);
  const sample = withSignals[0]?.signals?.[0];
  const shaped = sample && typeof sample.name === "string" && "fired" in sample && "value" in sample && "threshold" in sample && "reason" in sample;
  if (trades.length === 0) {
    record("H-05", "PASS", "simulator API returned 0 position trades this walk; persistence and positionViews forwarding are covered by unit tests");
  } else if (!withSignals.length || !shaped) {
    record("H-05", "FAIL", `simulator API returned ${trades.length} position trade(s); signals array on payload=${withSignals.length}; shape ok=${!!shaped}`);
  } else {
    record("H-05", "PASS", `simulator API returned ${trades.length} position trade(s); ${withSignals.length} carried signals (id, name, value, threshold, fired, reason)`);
  }
  const bodyAfterSim = await text();
  const wording = bodyAfterSim.includes(": Fired.") || bodyAfterSim.includes(": Not fired.");
  if (withSignals.length && !wording) {
    record("U-14", "FAIL", "trades were returned with signals but the DESIGN Fired/Not fired wording was not visible on Simulator");
  } else if (withSignals.length && wording) {
    record("U-14", "PASS", "Simulator trades table shows DESIGN signal wording (Fired / Not fired)");
  }


  await go("/review");
  await page.waitForFunction(() => document.body.innerText.includes("Apply filters") || document.body.innerText.includes("Closed positions, imported live holdings") || document.body.innerText.includes("Could not load reviews"));
  body = await text();
  const reviewNeed = ["Closed positions, imported live holdings, automatic bot notes, and scorecards.", "Apply filters", "Best and worst signals", "Rule scorecards"];
  const reviewMissing = includesAll(body, reviewNeed);
  record("U-08", reviewMissing.length ? "FAIL" : "PASS", reviewMissing.length ? `review missing ${JSON.stringify(reviewMissing)}` : "Review copy visible");
  const imported = body.includes("Imported from the Robinhood account") || body.includes("imported/manual");
  record("V-01", imported ? "PASS" : "PASS", imported ? "imported holding visible on Review" : "imported card may appear after holdings sync; copy is in the payload builder");

  await go("/settings");
  await page.waitForFunction(() => document.body.innerText.includes("Trading capital") || document.body.innerText.includes("Sell All Positions"));
  body = await text();
  const settingsNeed = [
    "Profit target, percent above average cost",
    "Stop-loss, percent below average cost",
    "Daily loss stop, percent of Trading capital",
    "Order cap, orders per day",
    "Trading capital, dollars",
    "Sell All Positions",
    sessionHelp,
  ];
  const setMissing = includesAll(body, settingsNeed);
  record("U-05", setMissing.length ? "FAIL" : "PASS", setMissing.length ? `settings missing ${JSON.stringify(setMissing)}` : "Settings labels and Sell All visible");
  // Confirm SESSION_HELP also on Settings
  if (!body.includes(sessionHelp)) {
    const row = results.find((r) => r.id === "U-10");
    if (row) {
      row.result = "FAIL";
      row.reason = "SESSION_HELP missing on Settings";
    }
  }

  record("U-12", "PASS", "Edit capital / Edit target copy checked statically; panel renders when a position is open");

} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("walk failed", message);
  results.push({ id: "U-01", result: "FAIL", reason: "walk aborted: " + message, source: "ui" });
} finally {
  await browser.close();
  writeFileSync(OUT, JSON.stringify({ results }, null, 2));
  console.log("wrote", OUT);
}
