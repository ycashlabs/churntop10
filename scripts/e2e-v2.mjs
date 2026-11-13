import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const DIR = "/workspace/churntop10-dev/audit-v2";
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

await page.goto("http://127.0.0.1:8787/", { waitUntil: "networkidle0" });
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
  await page.waitForFunction(() => document.body.innerText.includes("Account Summary"));
}
await mustInclude("summary", "Account Summary", "Top 10", "Rules", "Simulator", "Settings");
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
await page.waitForFunction(() => !document.body.innerText.includes("Confirm with your passkey"));
await mustInclude("top10", "AAPL", "MSFT", "NVDA");
await shot("02-top10");

await go("/rules");
await page.waitForFunction(() => document.body.innerText.includes("First buy on strength") || document.body.innerText.includes("Create a rule"));
await mustInclude("rules", "Experimenting");
await button("Edit / rename");
await page.waitForFunction(() => document.body.innerText.includes("Save changes"));
await page.evaluate(() => {
  const field = [...document.querySelectorAll("input")].find((item) => item.value && item.value.includes("First buy"));
  if (!field) throw new Error("no rule name field");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, "First buy on strength (renamed)");
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
await button("Save changes");
await page.waitForFunction(() => document.body.innerText.includes("First buy on strength (renamed)"));
const provenButtons = await page.$$eval("button", (buttons) => buttons.filter((item) => item.textContent?.trim() === "Mark Proven").length);
if (provenButtons < 1) throw new Error("no Mark Proven button");
await button("Mark Proven");
await page.waitForFunction(() => document.body.innerText.includes("Proven") && !document.body.innerText.includes("Confirm with your passkey"));
await page.evaluate(() => {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "History");
  found?.click();
});
await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("history") || document.body.innerText.includes("approved") || document.body.innerText.includes("renamed"));
await mustInclude("history", "First buy on strength (renamed)");
await shot("03-rules-history");

await page.evaluate(() => {
  const name = document.querySelector("input[placeholder], input");
  const body = document.querySelector("textarea");
  const nameSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  const bodySetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  const nameField = [...document.querySelectorAll("input")].find((item) => !item.value || item.closest("section, form, div")?.innerText.includes("Create a rule"));
  if (nameField) {
    nameSetter?.call(nameField, "Probe buy");
    nameField.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (body) {
    bodySetter?.call(body, "A probe rule created in the walkthrough.");
    body.dispatchEvent(new Event("input", { bubbles: true }));
  }
  void name;
});
await button("Create rule");
await page.waitForFunction(() => document.body.innerText.includes("Probe buy"));

await go("/simulator");
await page.waitForFunction(() => document.body.innerText.includes("Run check"));
await mustInclude("simulator", "Run check");
await button("Run check");
await page.waitForFunction(() => /order was checked|sim_entry|proposal|position|starter|AAPL|no usable|idle|checked and not sent|filled|working/i.test(document.body.innerText));
await shot("04-simulator");

await go("/settings");
await page.waitForFunction(() => document.body.innerText.includes("Save caps"));
await mustInclude("settings", "Profit target", "Stop-loss", "Daily loss", "Order cap", "Sell All Positions", "no buy amount");
await page.$$eval("input[type='number']", (inputs) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (inputs[0]) {
    setter?.call(inputs[0], "1.5");
    inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (inputs[3]) {
    setter?.call(inputs[3], "100");
    inputs[3].dispatchEvent(new Event("input", { bubbles: true }));
  }
});
await button("Save caps");
await page.waitForFunction(() => !document.body.innerText.includes("Confirm with your passkey") && document.querySelector("input")?.value === "1.5");
await button("Sell All Positions");
await page.waitForFunction(() => document.body.innerText.includes("Confirm sell all"));
await button("Confirm sell all");
await page.waitForFunction(() => document.body.innerText.includes("Sell All Positions is on") || document.body.innerText.includes("New buys are stopped") || document.body.innerText.includes("Allow new buys again"));
await shot("05-settings-sell-all");

const finalText = await text();
if (finalText.includes("544784028") || finalText.includes("5UD70362") || finalText.includes("SIM0000999")) {
  throw new Error("account number leaked");
}
if (!finalText.includes("Sell All Positions")) throw new Error("missing sell-all confirmation result");
console.log("e2e-v2 ok");
await browser.close();
