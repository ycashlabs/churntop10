import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = "dist/assets";
const manifest = {};

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    const body = readFileSync(full);
    const extension = extname(full).slice(1);
    const hash = createHash("sha256").update(body.toString("base64") + extension).digest("hex").slice(0, 32);
    const key = `/${relative(root, full).replaceAll("\\", "/")}`;
    manifest[key] = { hash, size: body.length };
  }
}

walk(root);
process.stdout.write(`${JSON.stringify({ manifest }, null, 2)}\n`);
