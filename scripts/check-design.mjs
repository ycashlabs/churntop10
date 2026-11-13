#!/usr/bin/env node
/**
 * Fail when src/, migrations/, or wrangler config change in a branch/PR
 * but docs/DESIGN.md does not. Every such change must update the rebuild doc
 * in the same PR.
 */
import { execSync } from "node:child_process";

function sh(command, allowFail = false) {
  try {
    return execSync(command, { encoding: "utf8" }).trim();
  } catch (error) {
    if (allowFail) return "";
    throw error;
  }
}

function hasRef(ref) {
  return Boolean(sh(`git rev-parse --verify --quiet ${ref}`, true));
}

function resolveBase() {
  if (process.env.DESIGN_BASE) return process.env.DESIGN_BASE;
  if (process.env.GITHUB_EVENT_NAME === "pull_request" && process.env.GITHUB_BASE_REF) {
    const remote = `origin/${process.env.GITHUB_BASE_REF}`;
    if (hasRef(remote)) return remote;
    if (hasRef(process.env.GITHUB_BASE_REF)) return process.env.GITHUB_BASE_REF;
  }
  const before = process.env.GITHUB_EVENT_BEFORE;
  if (before && !/^0+$/.test(before) && hasRef(before)) return before;
  for (const candidate of ["origin/main", "main"]) {
    if (hasRef(candidate)) return sh(`git merge-base HEAD ${candidate}`);
  }
  return "";
}

function isCodePath(path) {
  return path.startsWith("src/")
    || path.startsWith("migrations/")
    || path === "wrangler.jsonc"
    || path === "wrangler.toml";
}

const base = resolveBase();
if (!base) {
  console.log("check-design: no compare base (unborn history). Skipping.");
  process.exit(0);
}

const raw = sh(`git diff --name-only ${base}...HEAD`);
const files = raw ? raw.split("\n").filter(Boolean) : [];
const code = files.filter(isCodePath);
const designChanged = files.includes("docs/DESIGN.md");

if (code.length > 0 && !designChanged) {
  console.error("docs/DESIGN.md must be updated in the same change as code or config.");
  console.error(`Compared ${base}...HEAD.`);
  console.error("Changed code/config files:");
  for (const file of code) console.error(`  - ${file}`);
  console.error("Update docs/DESIGN.md to describe the change, then commit it with this work.");
  process.exit(1);
}

if (code.length > 0) {
  console.log(`check-design ok: ${code.length} code/config file(s) changed and docs/DESIGN.md was updated (base ${base}).`);
} else {
  console.log(`check-design ok: no src/, migrations/, or wrangler config changes (base ${base}).`);
}
