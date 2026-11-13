#!/usr/bin/env node
/**
 * Fail when src/, migrations/, or wrangler config change but docs/DESIGN.md does not.
 * Also fail when wrangler config, migrations, deploy scripts, routines-related docs,
 * or env/bindings docs change but docs/HANDOVER.md does not.
 *
 * GitHub's default checkout is shallow. When GITHUB_ACTIONS is set, this script
 * tries to fetch the PR base / origin/main so the compare works without a
 * workflow-file change (the default token cannot add a new workflow without
 * the `workflow` scope). For a dedicated job with fetch-depth: 0, see
 * docs/ci-design-job.pending.yml.
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

function fetchBases() {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const baseRef = process.env.GITHUB_BASE_REF;
  if (baseRef) sh(`git fetch --no-tags --depth=200 origin ${baseRef}`, true);
  sh("git fetch --no-tags --depth=200 origin main", true);
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

function isDesignPath(path) {
  return path.startsWith("src/")
    || path.startsWith("migrations/")
    || path === "wrangler.jsonc"
    || path === "wrangler.toml";
}

function isHandoverPath(path) {
  if (path === "wrangler.jsonc" || path === "wrangler.toml") return true;
  if (path.startsWith("migrations/")) return true;
  if (path === "DEPLOY.md" || path === "ROLLBACK.md") return true;
  if (path === ".dev.vars.example") return true;
  if (path === "docs/dev.md" || path === "docs/prod.md" || path === "docs/ACCESS.md") return true;
  if (/(^|\/)[^/]*routines?(-|\.|$)/i.test(path)) return true;
  if (path.startsWith("deploy/") || /(^|\/)([^/]*deploy[^/]*)$/i.test(path)) {
    if (path.startsWith("docs/")) return false;
    return path.endsWith(".mjs") || path.endsWith(".js") || path.endsWith(".md") || path.startsWith("deploy/");
  }
  return false;
}

fetchBases();
const base = resolveBase();
if (!base) {
  console.log("check-design: no compare base (unborn history). Skipping.");
  process.exit(0);
}

function changedFiles(compareBase) {
  const names = new Set();
  for (const command of [
    `git diff --name-only ${compareBase}...HEAD`,
    `git diff --name-only ${compareBase}`,
    `git diff --name-only --cached ${compareBase}`,
    "git ls-files --others --exclude-standard",
  ]) {
    const raw = sh(command, true);
    for (const line of raw.split("\n")) if (line) names.add(line);
  }
  return [...names];
}

const files = changedFiles(base);
const designNeeded = files.filter(isDesignPath);
const handoverNeeded = files.filter(isHandoverPath);
const designChanged = files.includes("docs/DESIGN.md");
const handoverChanged = files.includes("docs/HANDOVER.md");
let failed = false;

if (designNeeded.length > 0 && !designChanged) {
  failed = true;
  console.error("docs/DESIGN.md must be updated in the same change as code or config.");
  console.error(`Compared against ${base} (commits and working tree).`);
  console.error("Changed code/config files:");
  for (const file of designNeeded) console.error(`  - ${file}`);
  console.error("Update docs/DESIGN.md to describe the change, then commit it with this work.");
}

if (handoverNeeded.length > 0 && !handoverChanged) {
  failed = true;
  console.error("docs/HANDOVER.md must be updated in the same change as wrangler config, migrations, deploy scripts, routines docs, or env/bindings.");
  console.error(`Compared against ${base} (commits and working tree).`);
  console.error("Changed ops/env files:");
  for (const file of handoverNeeded) console.error(`  - ${file}`);
  console.error("Update docs/HANDOVER.md with current environments, ids, and state, then commit it with this work.");
}

if (failed) process.exit(1);

const notes = [];
if (designNeeded.length > 0) notes.push(`${designNeeded.length} code/config file(s) + DESIGN.md`);
if (handoverNeeded.length > 0) notes.push(`${handoverNeeded.length} ops/env file(s) + HANDOVER.md`);
console.log(notes.length ? `check-design ok: ${notes.join("; ")} (base ${base}).` : `check-design ok: no guarded files changed (base ${base}).`);
