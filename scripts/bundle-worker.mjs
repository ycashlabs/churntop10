import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await esbuild.build({
  entryPoints: ["src/worker/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers"],
  conditions: ["workerd", "worker", "browser"],
  mainFields: ["browser", "module", "main"],
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
});
