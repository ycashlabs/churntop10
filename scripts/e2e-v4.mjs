import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const DIR = "/workspace/churntop10-dev/audit-v4";
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
    if (!body.includes(needle)) throw new Error(`${label} missing ${JSON.stringify(needle)}: ${body.slice(0, 1200)}`);
  }
}

async function mustNotInclude(label, ...needles) {
  const body = await text();
  for (const needle of needles) {
    if (body.includes(needle)) throw new Error(`${label} unexpectedly has ${JSON.stringify(needle)}`);
  }
}

page.on("pageerror", (err) => console.log("pageerror", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warning") console.log("console", msg.type(), msg.text());
});
const BASE = process.env.BASE_URL || "http://localhost:8787/";
await page.goto(BASE, { waitUntil: "networkidle0" });

await page.waitForFunction(() => {
  const body = document.body.innerText;
  const labels = [...document.querySelectorAll("button")].map((item) => item.textContent?.trim());
  return body.includes("Account Summary") || labels.includes("Create passkey") || labels.includes("Sign in");
});
const opened = await text();
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
    throw new Error("auth did not reach Account Summary: " + (await text()).slice(0, 1000) + " / " + err);
  }
}

await mustInclude("summary-nav", "Account Summary", "Top 10", "Live Positions", "Rules", "Simulator", "Settings", "Review");
await mustNotInclude("summary-leak", "SIM0000999", "544784028", "5UD70362");
await go("/positions");
await page.waitForFunction(() => document.body.innerText.includes("TSLL") && document.body.innerText.includes("imported/manual"), { timeout: 20000 }).catch(async (err) => {
  await shot("00-no-imported-position");
  throw new Error("Live Positions did not show the imported TSLL fixture: " + (await text()).slice(0, 2000) + " / " + err);
});
await mustInclude("live-import", "Live positions", "TSLL", "imported/manual", "$11.05");
await shot("01-account-summary-imported-tsll");

await go("/review");
await page.waitForFunction(() => document.body.innerText.includes("Review") && !document.body.innerText.includes("Loading reviews"));
await page.waitForFunction(() => document.body.innerText.includes("TSLL") && document.body.innerText.includes("imported/manual"), { timeout: 20000 }).catch(async (err) => {
  await shot("00-review-no-import");
  throw new Error("Review did not show the imported TSLL position: " + (await text()).slice(0, 2000) + " / " + err);
});
await mustInclude("review-import", "TSLL", "imported/manual", "Imported from the Robinhood account");
await shot("02-review-imported-tsll");

await go("/simulator");
await page.waitForFunction(() => document.body.innerText.includes("Run check"));

async function resumeBuysIfNeeded() {
  const body = await text();
  if (body.includes("Allow new buys again") || body.includes("Sell All Positions is on")) {
    await go("/settings");
    await page.waitForFunction(() => document.body.innerText.includes("Allow new buys again") || document.body.innerText.includes("Sell All Positions"));
    const labels = await page.evaluate(() => [...document.querySelectorAll("button")].map((item) => item.textContent?.trim()));
    if (labels.includes("Allow new buys again")) {
      await button("Allow new buys again");
      await page.waitForFunction(() => !document.body.innerText.includes("Sell All Positions is on"));
    }
    await go("/simulator");
    await page.waitForFunction(() => document.body.innerText.includes("Run check"));
  }
}

await resumeBuysIfNeeded();

const hadOpen = await page.evaluate(() => {
  const body = document.body.innerText;
  return body.includes("Trading capital snapshot") && /AAPL|MSFT|NVDA|AMZN|GOOGL|META|AVGO|TSLA|JPM|LLY/.test(body);
});
if (hadOpen) {
  await go("/settings");
  await page.waitForFunction(() => document.body.innerText.includes("Sell All Positions"));
  await button("Sell All Positions");
  await page.waitForFunction(() => document.body.innerText.includes("Confirm sell all"));
  await button("Confirm sell all");
  await page.waitForFunction(() => document.body.innerText.includes("Allow new buys again") || document.body.innerText.includes("Sell All Positions is on"));
  const labels = await page.evaluate(() => [...document.querySelectorAll("button")].map((item) => item.textContent?.trim()));
  if (labels.includes("Allow new buys again")) await button("Allow new buys again");
  await go("/simulator");
  await page.waitForFunction(() => document.body.innerText.includes("Run check"));
}

await shot("03-simulator-empty-before-tick");
await button("Run check");
await page.waitForFunction(() => {
  const latest = [...document.querySelectorAll("section")].find((item) => item.querySelector("h2")?.textContent === "Latest check");
  return !!latest && !latest.innerText.includes("No check yet");
});
await page.waitForFunction(() => /AAPL|MSFT|NVDA|AMZN|GOOGL|META|AVGO|TSLA|JPM|LLY/.test(document.body.innerText) && document.body.innerText.includes("Trading capital snapshot"), { timeout: 20000 }).catch(async (err) => {
  await shot("00-no-starter");
  throw new Error("simulator did not open a starter from no open positions: " + (await text()).slice(0, 2000) + " / " + err);
});
await mustInclude("sim-starter", "Trading capital snapshot");
await shot("04-simulator-starter-from-empty");

const finalText = await text();
if (finalText.includes("544784028") || finalText.includes("5UD70362") || finalText.includes("SIM0000999")) {
  throw new Error("account number leaked");
}
console.log("e2e-v4 ok");
await browser.close();
