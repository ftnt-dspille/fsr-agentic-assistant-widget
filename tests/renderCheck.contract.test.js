"use strict";

// ─── tools/render_check.cjs stays on the shared render contract ─────────────
// render_check is the node bridge the Python eval loop shells out to. It once
// carried its own copy of the vocabulary, missed enhancement_offer and
// verdict_card, and flagged valid `awaiting` tool statuses as violations, so
// it passed or failed transcripts the widget would not. The vocabulary now
// lives in tools/render_contract.json, read by both. These tests fail when the
// tool stops reading it, or when it rejects a fixture the widget renders.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const TOOLS = path.join(__dirname, "..", "tools");
const FIXTURES = path.join(__dirname, "..", "widget", "widgetAssets", "fixtures");
const TOOL = path.join(TOOLS, "render_check.cjs");
const CONTRACT = JSON.parse(fs.readFileSync(path.join(TOOLS, "render_contract.json"), "utf8"));

// One node process per fixture (each loads the renderer, ~0.3-0.5s), so the fixtures
// run through a small async pool instead of one after another.
function runTool(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [TOOL, file]);
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (status) => {
      let out = null;
      try { out = JSON.parse(stdout); } catch (e) { out = { ok: false, violations: [stdout || stderr] }; }
      resolve({ status, out });
    });
  });
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }));
  return results;
}

// A fixture the replay can check: it has at least one responses[].response.transcript
// (the same shape tests/render.pipeline.test.ts walks). Other shapes are not transcripts.
function hasTranscript(data) {
  return (data.responses || []).some((r) => r && r.response && Array.isArray(r.response.transcript));
}

describe("render_check.cjs reads the shared render contract", () => {
  test("it loads its vocabulary from render_contract.json, not an inline copy", () => {
    const src = fs.readFileSync(TOOL, "utf8");
    expect(src).toContain("render_contract.json");
    expect(src).not.toMatch(/new Set\(\[\s*"/);
    // A quoted render type may appear only as a per-type check (`ev.type === "x"`),
    // never as a list entry: every quoted use must be such a comparison.
    for (const t of CONTRACT.renderEventTypes) {
      const quoted = src.split(`"${t}"`).length - 1;
      const compared = src.split(`=== "${t}"`).length - 1;
      expect({ type: t, listEntries: quoted - compared }).toEqual({ type: t, listEntries: 0 });
    }
  });

  test("the contract lists the render types that were missing from the tool", () => {
    expect(CONTRACT.renderEventTypes).toEqual(expect.arrayContaining(["enhancement_offer", "verdict_card", "activity"]));
    expect(CONTRACT.toolStatuses).toEqual(expect.arrayContaining(["awaiting", "guard"]));
  });

  test("every fixture transcript the widget renders also passes render_check", async () => {
    const names = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json"))
      .filter((name) => hasTranscript(JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"))));
    const results = await mapPool(names, 8, (name) => runTool(path.join(FIXTURES, name)));
    const failures = [];
    results.forEach(({ status, out }, i) => {
      if (status !== 0 || out.ok !== true) failures.push(`${names[i]}: ${(out.violations || []).join("; ")}`);
    });
    expect(names.length).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  }, 120000);
});
