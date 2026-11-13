import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "dist/index.js";
const source = readFileSync(path, "utf8");
const hits = codegenHits(source);
if (hits.length > 0) {
  for (const hit of hits) {
    console.error(`${path}:${hit.line}: ${hit.kind}: ${hit.excerpt}`);
  }
  process.exit(1);
}
console.log(`bundle ok: no runtime codegen in ${path}`);

function codegenHits(source) {
  const patterns = [
    { kind: "new Function", regex: /\bnew\s+Function\b/g },
    { kind: "eval()", regex: /\beval\s*\(/g },
    { kind: "Function()", regex: /\bFunction\s*\(/g },
  ];
  const hits = [];
  for (const { kind, regex } of patterns) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(source))) {
      const line = source.slice(0, match.index).split("\n").length;
      const excerpt = source.slice(Math.max(0, match.index - 20), match.index + match[0].length + 40).replace(/\s+/g, " ").trim();
      hits.push({ kind, line, excerpt });
    }
  }
  return hits;
}
