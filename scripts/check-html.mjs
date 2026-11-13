import { readFileSync } from "node:fs";

const html = readFileSync("dist/assets/index.html", "utf8");
if (/<script(?![^>]*\ssrc=)/i.test(html)) {
  console.error("index.html contains an inline script");
  process.exit(1);
}
if (/<style[\s>]/i.test(html)) {
  console.error("index.html contains an inline style");
  process.exit(1);
}
if (!html.includes('src="/static/')) {
  console.error("index.html is missing the bundled script");
  process.exit(1);
}
console.log("html ok");
