import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: "/opt/google/chrome/chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
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
page.setDefaultTimeout(20000);
await page.goto("http://localhost:8787/", { waitUntil: "networkidle0" });
await page.click("button");
await page.waitForFunction(() => document.body.innerText.includes("Account Summary"));
const viewOnly = await page.evaluate(() => document.body.innerText);
if (!viewOnly.includes("View Only") && !viewOnly.includes("View only")) throw new Error(`missing view only banner: ${viewOnly.slice(0, 400)}`);
if (viewOnly.includes("SIM0000999")) throw new Error("full simulator account number leaked");
await page.click("a[href='/top10']");
await page.waitForFunction(() => document.body.innerText.includes("AAPL"));
await page.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "Save list");
  button?.click();
});
await page.evaluate(() => document.querySelector("a[href='/settings']")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
await page.waitForFunction(() => document.body.innerText.includes("Switch to Live"));
await page.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "Switch to Live");
  button?.click();
});
await page.waitForFunction(() => document.body.innerText.includes("broker gate is off"));
await page.evaluate(() => document.querySelector("a[href='/top10']")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
await page.waitForFunction(() => document.body.innerText.includes("$355.00"));
await page.evaluate(() => document.querySelector("a[href='/settings']")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
await page.waitForFunction(() => document.body.innerText.includes("Save caps"));
await page.$eval("input", (input) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, "1.5");
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "Save caps");
  button?.click();
});
await page.waitForFunction(() => !document.body.innerText.includes("Confirm with your passkey") && document.querySelector("input")?.value === "1.5");
await page.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "Sell All Positions");
  button?.click();
});
await page.waitForFunction(() => document.body.innerText.includes("Confirm sell all"));
await page.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "Confirm sell all");
  button?.click();
});
await page.waitForFunction(() => document.body.innerText.includes("Sell All Positions is on") || document.body.innerText.includes("New buys stopped"));
const finalText = await page.evaluate(() => document.body.innerText);
if (finalText.includes("544784028") || finalText.includes("5UD70362")) throw new Error("real account number rendered");
console.log("browser check ok");
await browser.close();
