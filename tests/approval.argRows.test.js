"use strict";

// The approval card used to render its arguments as a raw `JSON.stringify` dump
// in a <pre>. A human approving a containment action needs "which indicator, on
// which device" at a glance, not a brace-matched blob. The renderer now emits
// ordered label/value rows (`argRows`) and keeps the JSON behind `rawArgs` for
// the "show raw" toggle.

const R = require("../widget/widgetAssets/js/fsrPbRender.js");
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };

function approvalEvent(events) {
  return R.buildAssistantMessage(events, OPTS).events
    .find((e) => e.type === "approval_request");
}

describe("approval card renders structured args, not a JSON dump", () => {
  test("scalar args become humanized label/value rows in wire order", () => {
    const ev = approvalEvent([
      { type: "approval_request", tool: "mcp_soc__block_indicator",
        approval_id: "ap-1",
        preview: { tool: "mcp_soc__block_indicator",
                   args: { indicator: "198.51.100.3",
                           indicator_type: "IP Address",
                           collectorId: 4412 } } },
    ]);

    expect(ev.argRows.map((r) => [r.label, r.value])).toEqual([
      ["Indicator", "198.51.100.3"],
      ["Indicator type", "IP Address"],
      ["Collector ID", "4412"],
    ]);
    expect(ev.argRows.every((r) => r.complex === false)).toBe(true);
  });

  test("acronym keys are not mangled by title-casing", () => {
    const ev = approvalEvent([
      { type: "approval_request", tool: "t", approval_id: "ap-2",
        preview: { args: { ip: "198.51.100.1", url: "http://x", sha256: "ab", uuid: "u-1" } } },
    ]);
    expect(ev.argRows.map((r) => r.label))
      .toEqual(["IP", "URL", "SHA256", "UUID"]);
  });

  test("internal underscore sentinels never reach the analyst", () => {
    const ev = approvalEvent([
      { type: "approval_request", tool: "t", approval_id: "ap-3",
        preview: { args: { indicator: "1.2.3.4", _approved: true, _summary: "x" } } },
    ]);
    expect(ev.argRows.map((r) => r.key)).toEqual(["indicator"]);
  });

  test("non-scalar args are flagged complex and serialized, not dropped", () => {
    const ev = approvalEvent([
      { type: "approval_request", tool: "t", approval_id: "ap-4",
        preview: { args: { params: { limit: 25 }, tags: ["a", "b"] } } },
    ]);
    const byKey = Object.fromEntries(ev.argRows.map((r) => [r.key, r]));
    expect(byKey.params.complex).toBe(true);
    expect(byKey.params.value).toBe('{"limit":25}');
    expect(byKey.tags.value).toBe('["a","b"]');
  });

  test("rawArgs keeps the full JSON for the toggle, collapsed by default", () => {
    const ev = approvalEvent([
      { type: "approval_request", tool: "t", approval_id: "ap-5",
        preview: { args: { indicator: "1.2.3.4" } } },
    ]);
    expect(ev._rawOpen).toBe(false);
    expect(JSON.parse(ev.rawArgs)).toEqual({ indicator: "1.2.3.4" });
  });

  test("a summary is carried separately so it can head the table", () => {
    const ev = approvalEvent([
      { type: "approval_request", tool: "t", approval_id: "ap-6",
        summary: "Block 198.51.100.3 at the perimeter",
        preview: { args: { indicator: "198.51.100.3" } } },
    ]);
    expect(ev.summary).toBe("Block 198.51.100.3 at the perimeter");
    expect(ev.argRows).toHaveLength(1);   // summary does not suppress the table
  });

  test("no args at all → no rows, and display carries the fallback sentence", () => {
    const ev = approvalEvent([
      { type: "approval_request", tool: "t", approval_id: "ap-7" },
    ]);
    expect(ev.argRows).toEqual([]);
    expect(ev.rawArgs).toBe("");
    expect(ev.display).toContain("Approve to run it.");
  });
});

describe("a playbook approval reads in the analyst's words", () => {
  // Live: "Approval required: run_playbook  tier 3", then "Record
  // /api/3/ztpf_automation_actions/<uuid>", "Follow true", "Timeout 180".
  const ev = approvalEvent([
    { type: "approval_request", tool: "run_playbook", approval_id: "ap-pb", tier: 3,
      preview: { tool: "run_playbook", args: {
        playbook: "Render Script Payload - Action",
        record: "/api/3/ztpf_automation_actions/cc33ee85-1836-458e-8f01-8b6bf9bf03c8",
        follow: true, timeout: 180 } } },
  ]);

  test("the title is the action, not the function name", () => {
    expect(ev.title).toBe("Run playbook");
  });

  test("the tier is said in words", () => {
    expect(ev.tierLabel).toBe("Changes data");
    const t4 = approvalEvent([{ type: "approval_request", tool: "t", approval_id: "x", tier: 4 }]);
    expect(t4.tierLabel).toBe("High impact");
    const t2 = approvalEvent([{ type: "approval_request", tool: "t", approval_id: "y", tier: 2 }]);
    expect(t2.tierLabel).toBe("");
  });

  test("rows name the playbook and the kind of record; run knobs stay in details", () => {
    expect(ev.argRows.map((r) => [r.label, r.value])).toEqual([
      ["Playbook", "Render Script Payload - Action"],
      ["Record", "Ztpf automation actions record"],
    ]);
    expect(ev.rawArgs).toContain("cc33ee85-1836-458e-8f01-8b6bf9bf03c8");
    expect(ev.rawArgs).toContain('"timeout": 180');
  });

  test("a flag reads yes or no", () => {
    const f = approvalEvent([{ type: "approval_request", tool: "t", approval_id: "f",
      preview: { args: { isolate: true, notify: false } } }]);
    expect(f.argRows.map((r) => r.value)).toEqual(["Yes", "No"]);
  });
});
