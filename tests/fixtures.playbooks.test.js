"use strict";

// ─── Canonical example-playbook fixtures (Track D1) ──────────────────────────
//
// Guards the committed fixture set under tests/fixtures/playbooks/ so it can't
// rot: every fixture in scenarios.json exists, parses as FSR YAML, and actually
// exhibits the defect (or cleanliness) its scenario claims. This runs box-free —
// it structurally inspects the YAML, it does not compile or seed. Public-repo
// hygiene: asserts no box IPs / credentials leaked into the fixtures.

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "fixtures", "playbooks");
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "scenarios.json"), "utf8"));

// Minimal FSR-YAML step extractor: names, types, and every `next:` target
// (step-level and inside decision conditions). Enough to assert reference
// integrity without a real parser.
function parse(yaml) {
  const lines = yaml.split("\n");
  const steps = [];   // { name, type }
  const nextRefs = []; // target names referenced by next:
  let cur = null;
  const indentOf = (l) => l.length - l.replace(/^\s+/, "").length;
  const val = (s) => s.trim().replace(/^["']|["']$/g, "").trim();
  let inSteps = false, stepsIndent = -1;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const ind = indentOf(line);
    if (!inSteps) { if (/^\s*steps\s*:\s*$/.test(line)) { inSteps = true; stepsIndent = ind; } continue; }
    if (ind <= stepsIndent) { inSteps = /^\s*steps\s*:\s*$/.test(line); if (inSteps) stepsIndent = ind; cur = null; continue; }
    let m;
    if ((m = line.match(/^\s*-\s*(.*)$/))) {
      cur = { keyIndent: line.indexOf("-") + 2 };
      steps.push(cur);
      const rest = m[1], im = rest.match(/^(name|type)\s*:\s*(.+)$/);
      if (im) cur[im[1]] = val(im[2]);
      continue;
    }
    if ((m = line.match(/^\s*next\s*:\s*(.+?)(?:\s*#.*)?$/))) { nextRefs.push(val(m[1])); continue; }
    if (cur && ind === cur.keyIndent) {
      if ((m = line.match(/^\s*name\s*:\s*(.+)$/))) cur.name = val(m[1]);
      else if ((m = line.match(/^\s*type\s*:\s*(.+)$/))) cur.type = val(m[1]);
    }
  }
  return { steps: steps.filter((s) => s.name), nextRefs };
}

describe("Track D1 — canonical example-playbook fixtures", () => {
  test("every scenario file exists and is non-trivial FSR YAML", () => {
    for (const sc of manifest.scenarios) {
      const p = path.join(DIR, sc.file);
      expect(fs.existsSync(p)).toBe(true);
      const yaml = fs.readFileSync(p, "utf8");
      expect(yaml).toMatch(/^playbooks:/m);
      const { steps } = parse(yaml);
      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(steps.some((s) => s.type === "start")).toBe(true);
    }
  });

  test("clean fixtures resolve every next-reference to a real step", () => {
    for (const sc of manifest.scenarios.filter((s) => s.clean)) {
      const { steps, nextRefs } = parse(fs.readFileSync(path.join(DIR, sc.file), "utf8"));
      const names = new Set(steps.map((s) => s.name));
      const dangling = nextRefs.filter((r) => !names.has(r));
      expect({ id: sc.id, dangling }).toEqual({ id: sc.id, dangling: [] });
    }
  });

  test("broken_step_ref actually has a dangling next-reference", () => {
    const sc = manifest.scenarios.find((s) => s.id === "broken_step_ref");
    const { steps, nextRefs } = parse(fs.readFileSync(path.join(DIR, sc.file), "utf8"));
    const names = new Set(steps.map((s) => s.name));
    expect(nextRefs.some((r) => !names.has(r))).toBe(true);
  });

  test("missing_error_handling has a mutating connector op and no decision after it", () => {
    const { steps } = parse(fs.readFileSync(path.join(DIR, "missing_error_handling.yml"), "utf8"));
    expect(steps.some((s) => s.type === "connector")).toBe(true);
    expect(steps.some((s) => s.type === "decision")).toBe(false); // the whole point
  });

  test("extensible is a clean multi-step base ready to receive a step", () => {
    const { steps } = parse(fs.readFileSync(path.join(DIR, "extensible.yml"), "utf8"));
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.some((s) => s.type === "end")).toBe(true);
  });

  test("run_failure_sample declares a local execution_id requirement", () => {
    const sc = manifest.scenarios.find((s) => s.id === "run_failure_sample");
    expect(sc.needs_local).toContain("execution_id");
    const { steps } = parse(fs.readFileSync(path.join(DIR, sc.file), "utf8"));
    expect(steps.some((s) => s.type === "decision")).toBe(true);
  });

  test("no box IPs or credentials leaked into any fixture (public-repo hygiene)", () => {
    for (const sc of manifest.scenarios) {
      const yaml = fs.readFileSync(path.join(DIR, sc.file), "utf8");
      expect(yaml).not.toMatch(/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);   // lab IPs
      expect(yaml).not.toMatch(/password\s*[:=]/i);
    }
  });
});
