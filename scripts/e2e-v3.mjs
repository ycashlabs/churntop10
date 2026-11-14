import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const DIR = "/workspace/churntop10-dev/audit-v3";
mkdirSync(DIR, { recursive: true });

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
page.setDefaultTimeout(30000);

function button(label) {
  return page.evaluate((text) => {
    const found = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
    if (!found) throw new Error("missing button: " + text);
    found.click();
  }, label);
}

async function go(href) {
  await page.evaluate((path) => {
    document.querySelector(`a[href='${path}']`)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }, href);
}

async function shot(name) {
  const path = `${DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log("screenshot", path);
}

async function text() {
  return page.evaluate(() => document.body.innerText);
}

async function mustInclude(label, ...needles) {
  const body = await text();
  for (const needle of needles) {
    if (!body.includes(needle)) throw new Error(`${label} missing ${JSON.stringify(needle)}: ${body.slice(0, 800)}`);
  }
}

async function mustNotInclude(label, ...needles) {
  const body = await text();
  for (const needle of needles) {
    if (body.includes(needle)) throw new Error(`${label} unexpectedly has ${JSON.stringify(needle)}`);
  }
}

function todayInput() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

page.on("pageerror", (err) => console.log("pageerror", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warning") console.log("console", msg.type(), msg.text());
});
await page.goto("http://localhost:8787/", { waitUntil: "networkidle0" });

await page.waitForFunction(() => {
  const text = document.body.innerText;
  const labels = [...document.querySelectorAll("button")].map((item) => item.textContent?.trim());
  return text.includes("Account Summary") || labels.includes("Create passkey") || labels.includes("Sign in");
});
const opened = await page.evaluate(() => document.body.innerText);
if (!opened.includes("Account Summary")) {
  const labels = await page.evaluate(() => [...document.querySelectorAll("button")].map((item) => item.textContent?.trim()));
  console.log("gate buttons", labels);
  if (labels.includes("Create passkey")) await button("Create passkey");
  else if (labels.includes("Sign in")) await button("Sign in");
  else throw new Error("no auth button: " + opened.slice(0, 800));
  try {
    await page.waitForFunction(() => document.body.innerText.includes("Account Summary"), { timeout: 20000 });
  } catch (err) {
    await shot("00-auth-failed");
    const after = await text();
    throw new Error("auth did not reach Account Summary: " + after.slice(0, 1000) + " / " + err);
  }
}
await mustInclude("summary", "Account Summary", "Top 10", "Live Positions", "Rules", "Simulator", "Settings", "Review");
await mustNotInclude("summary", "SIM0000999", "544784028", "5UD70362", "Kill switch", "simulator cash", "Simulated cash");
await shot("01-account-summary");

await go("/top10");
await page.waitForFunction(() => document.body.innerText.includes("AAPL") || document.querySelector("textarea, input"));
await page.evaluate(() => {
  const field = document.querySelector("textarea, input");
  if (!field) throw new Error("no top10 field");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
    ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, "AAPL MSFT NVDA");
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
await button("Save list");
await page.waitForFunction(() => {
  const rows = [...document.querySelectorAll("table tr")].map((row) => row.innerText);
  const symbols = rows.filter((row) => /AAPL|MSFT|NVDA/.test(row));
  const extras = rows.some((row) => /AMZN|GOOGL|META|TSLA|LLY/.test(row));
  const failed = document.body.innerText.includes("Passkey confirmation failed") || document.body.innerText.includes("Request failed");
  if (failed) throw new Error("top10 save failed: " + document.body.innerText.slice(0, 500));
  return symbols.length >= 3 && !extras;
});
await mustInclude("top10", "AAPL", "MSFT", "NVDA");
await shot("02-top10");

await go("/settings");
await page.waitForFunction(() => document.body.innerText.includes("Trading capital, dollars") && document.body.innerText.includes("Set Trading Capital"));
await mustInclude("settings-capital", "Trading capital, dollars", "Daily loss stop, percent of Trading capital", "any positive percent, up to 100");

const presetClicked = await page.evaluate(() => {
  const found = [...document.querySelectorAll("button")].find((item) => (item.textContent ?? "").trim().startsWith("50%"));
  if (!found) return "";
  found.click();
  return found.textContent?.trim() ?? "";
});
if (!presetClicked) {
  await shot("00-capital-presets-missing");
  throw new Error("no 50% Trading capital quick-fill: " + (await text()).slice(0, 800));
}
console.log("clicked quick-fill", presetClicked);
await page.waitForFunction(() => {
  const field = [...document.querySelectorAll("label")].find((item) => item.innerText.includes("Trading capital, dollars"))?.querySelector("input");
  return field && Number(field.value) > 0;
});
await shot("03-settings-quick-fill");

await page.evaluate(() => {
  const field = [...document.querySelectorAll("label")].find((item) => item.innerText.includes("Trading capital, dollars"))?.querySelector("input");
  if (!field) throw new Error("no trading capital field");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, "12000");
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
await button("Set Trading Capital");
await page.waitForFunction(() => {
  if (document.body.innerText.includes("Passkey confirmation failed")) throw new Error("save caps failed");
  const field = [...document.querySelectorAll("label")].find((item) => item.innerText.includes("Trading capital, dollars"))?.querySelector("input");
  return field?.value === "12000";
});
await shot("04-settings-custom-capital");

await go("/simulator");
await page.waitForFunction(() => document.body.innerText.includes("Run check"));
await mustInclude("simulator", "Run check", "Trading capital");
await button("Run check");
await page.waitForFunction(() => {
  const latest = [...document.querySelectorAll("section")].find((item) => item.querySelector("h2")?.textContent === "Latest check");
  return !!latest && !latest.innerText.includes("No check yet");
});
await page.waitForFunction(() => /NVDA|AAPL|MSFT/.test(document.body.innerText) && document.body.innerText.includes("Trading capital snapshot"), { timeout: 20000 }).catch(async (err) => {
  await shot("00-no-open-position");
  throw new Error("simulator did not open a position: " + (await text()).slice(0, 1500) + " / " + err);
});
await shot("05-simulator-open");

await button("Run check");
await page.waitForFunction(() => {
  const latest = [...document.querySelectorAll("section")].find((item) => item.querySelector("h2")?.textContent === "Latest check");
  return !!latest && !latest.innerText.includes("No check yet");
});
const afterSecond = await text();
const added = /Add sized/i.test(afterSecond) || (afterSecond.match(/\bbuy\b/gi) ?? []).length >= 2;
if (!added) {
  console.log("second check did not clearly add; running a third check");
  await button("Run check");
  await page.waitForFunction(() => {
    const latest = [...document.querySelectorAll("section")].find((item) => item.querySelector("h2")?.textContent === "Latest check");
    return !!latest && !latest.innerText.includes("No check yet");
  });
}
const afterAdd = await text();
if (!/Add sized/i.test(afterAdd) && !(afterAdd.match(/\bbuy\b/gi) ?? []).length >= 2) {
  await shot("00-no-add");
  throw new Error("simulator did not add to the open position: " + afterAdd.slice(0, 2000));
}
await shot("06-simulator-add");

await page.evaluate(() => {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Edit capital");
  if (!found) throw new Error("no Edit capital button");
  found.click();
});
await page.waitForFunction(() => document.body.innerText.includes("Confirm capital change"));
await page.evaluate(() => {
  const box = [...document.querySelectorAll("div.confirm, .confirm")].find((item) => item.innerText.includes("Confirm capital change"));
  const field = box?.querySelector("input[type='number']") ?? [...document.querySelectorAll("input[type='number']")].find((item) => item.closest("div")?.innerText.includes("Confirm capital change"));
  if (!field) throw new Error("no capital edit field");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, "6000");
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
await button("Confirm capital change");
await page.waitForFunction(() => {
  if (document.body.innerText.includes("Could not edit")) throw new Error("capital edit failed: " + document.body.innerText.slice(0, 400));
  return document.body.innerText.includes("Trading capital snapshot") && document.body.innerText.includes("$6,000");
});
await shot("07-edit-capital");

await page.evaluate(() => {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Edit target / stop");
  if (!found) throw new Error("no Edit target / stop button");
  found.click();
});
await page.waitForFunction(() => document.body.innerText.includes("Save target and stop"));
await page.evaluate(() => {
  const profit = [...document.querySelectorAll("label")].find((item) => item.innerText.includes("Profit target"))?.querySelector("input");
  if (!profit) throw new Error("no profit target field");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(profit, "2.5");
  profit.dispatchEvent(new Event("input", { bubbles: true }));
});
await button("Save target and stop");
await page.waitForFunction(() => {
  if (document.body.innerText.includes("Passkey confirmation failed")) throw new Error("edit exits failed");
  return document.body.innerText.includes("Target 2.5%") && document.body.innerText.includes("Create passkey") === false;
});
await shot("08-edit-target");

await go("/settings");
await page.waitForFunction(() => document.body.innerText.includes("Sell All Positions"));
await button("Sell All Positions");
await page.waitForFunction(() => document.body.innerText.includes("Confirm sell all"));
await button("Confirm sell all");
await page.waitForFunction(() => document.body.innerText.includes("Sell All Positions is on") || document.body.innerText.includes("New buys are stopped") || document.body.innerText.includes("Allow new buys again"));
await shot("09-settings-sell-all");

await go("/review");
await page.waitForFunction(() => document.body.innerText.includes("Review") && !document.body.innerText.includes("Loading reviews"));
await page.waitForFunction(() => /NVDA|AAPL|MSFT/.test(document.body.innerText) && (document.body.innerText.includes("bot") || document.body.innerText.includes("P&L") || document.body.innerText.includes("held")), { timeout: 20000 }).catch(async (err) => {
  await shot("00-review-empty");
  throw new Error("Review screen has no closed position: " + (await text()).slice(0, 1500) + " / " + err);
});
await shot("10-review");

const symbol = (await text()).includes("NVDA") ? "NVDA" : (await text()).includes("AAPL") ? "AAPL" : "MSFT";
await page.evaluate((today, symbol) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  const symbolField = [...document.querySelectorAll("label")].find((item) => item.innerText.trim().startsWith("Symbol"))?.querySelector("input");
  if (symbolField) {
    setter?.call(symbolField, symbol);
    symbolField.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const mode = [...document.querySelectorAll("label")].find((item) => item.innerText.trim().startsWith("Mode"))?.querySelector("select");
  if (mode) {
    mode.value = "sim";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const session = [...document.querySelectorAll("label")].find((item) => item.innerText.trim().startsWith("Session"))?.querySelector("select");
  if (session) {
    session.value = "overnight";
    session.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const from = [...document.querySelectorAll("label")].find((item) => item.innerText.trim().startsWith("From"))?.querySelector("input");
  const to = [...document.querySelectorAll("label")].find((item) => item.innerText.trim().startsWith("To"))?.querySelector("input");
  if (from) {
    setter?.call(from, today);
    from.dispatchEvent(new Event("input", { bubbles: true }));
    from.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (to) {
    setter?.call(to, today);
    to.dispatchEvent(new Event("input", { bubbles: true }));
    to.dispatchEvent(new Event("change", { bubbles: true }));
  }
}, todayInput(), symbol);
await button("Apply filters");
await page.waitForFunction((symbol) => {
  const body = document.body.innerText;
  if (body.includes("Could not load reviews")) throw new Error("filter failed");
  return body.includes(symbol) && (body.includes("No closed positions match these filters") || body.includes("held"));
}, { timeout: 20000 }, symbol);
await mustInclude("review-filtered", symbol, "Apply filters", "Best and worst signals");
await shot("11-review-filters");

await go("/rules");
await page.waitForFunction(() => document.body.innerText.includes("First buy on strength"));
await mustInclude("rules", "Experimenting", "First buy on strength");
await shot("12-rules");

await go("/settings");
await page.waitForFunction(() => document.body.innerText.includes("Trading capital, dollars"));
await mustInclude("settings-final", "Trading capital", "Sell All Positions", "Daily loss stop");
await shot("13-settings");

const finalText = await text();
if (finalText.includes("544784028") || finalText.includes("5UD70362") || finalText.includes("SIM0000999")) {
  throw new Error("account number leaked");
}
console.log("e2e-v3 ok");
await browser.close();
