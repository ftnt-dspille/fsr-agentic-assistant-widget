"use strict";

// ─── fsrPbRender.js must be exactly what fsrPbRender.ts compiles to ─────────
//
// The .ts is the source (tsconfig `include`); the .js is what ships and what
// every other test loads. Hand edits landed in the .js twice without the .ts
// (the offer card's `finalYaml`, the choice card's `allowText`), so the next
// `tsc` would have silently deleted both features. Edit the .ts, then run
// `tsc -p tsconfig.json` from this widget directory.

const fs = require("fs");
const path = require("path");
// Resolve typescript from the harness wherever the run starts: the sibling
// checkout, or the harness cwd when this widget is a worktree outside the repo.
const ts = require(require.resolve("typescript", { paths: [
  path.join(__dirname, "..", "..", "..", "fortisoar-widget-harness"),
  process.cwd(),
  path.join(process.cwd(), "fortisoar-widget-harness"),
] }));


const ROOT = path.join(__dirname, "..");
const JS_DIR = path.join(ROOT, "widget", "widgetAssets", "js");

test("fsrPbRender.js equals the compiled fsrPbRender.ts", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "tsconfig.json"), "utf8"));
  const { options } = ts.convertCompilerOptionsFromJson(cfg.compilerOptions, ROOT);
  const src = fs.readFileSync(path.join(JS_DIR, "fsrPbRender.ts"), "utf8");
  const compiled = ts.transpileModule(src, { compilerOptions: options }).outputText;
  const shipped = fs.readFileSync(path.join(JS_DIR, "fsrPbRender.js"), "utf8");
  expect(shipped === compiled).toBe(true);
});
