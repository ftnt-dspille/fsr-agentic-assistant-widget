"use strict";

// UI-scenario sweep: under-exercised card types (status_card / info_card /
// ioc_card) drawn by the renderer but with no e2e coverage. A null/sparse
// entry in details/rows/tags previously threw in normalizeBlocks, crashing the
// whole message render (same crash-class as the approval-popup bug — a renderer
// throw freezes the Angular digest). These assert the render survives.

const R = require("../widget/widgetAssets/js/fsrPbRender.js");
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };

function render(events) {
  return R.buildAssistantMessage(events, OPTS);
}

describe("malformed cards do not crash the renderer", () => {
  test("status_card with a null entry in details[] renders, skipping the null", () => {
    const events = [
      { type: "status_card", summary: "Containment status",
        details: [null, { label: "host", value: "smithDesktop" }, "bad", 42] },
    ];
    let msg;
    expect(() => { msg = render(events); }).not.toThrow();
    const card = msg.events.find((e) => e.type === "info_card");
    expect(card).toBeTruthy();
    const rows = (card.blocks.find((b) => b.kind === "rows") || {}).rows || [];
    // Every row is a well-formed {label,value,severity} — no throw, no null row.
    rows.forEach((r) => {
      expect(typeof r.label).toBe("string");
      expect("value" in r).toBe(true);
    });
    // The real entry survived.
    expect(rows.some((r) => r.value === "smithDesktop")).toBe(true);
  });

  test("info_card with null entries in tags[] and rows[] does not throw", () => {
    const events = [
      { type: "info_card", title: "IOC", blocks: [
        { kind: "tags", tags: [null, "malware", { label: "c2" }] },
        { kind: "rows", rows: [null, { label: "ip", value: "1.2.3.4" }] },
      ] },
    ];
    let msg;
    expect(() => { msg = render(events); }).not.toThrow();
    const card = msg.events.find((e) => e.type === "info_card");
    const tags = (card.blocks.find((b) => b.kind === "tags") || {}).tags || [];
    expect(tags.every((t) => typeof t.label === "string")).toBe(true);
    expect(tags.some((t) => t.label === "malware")).toBe(true);
  });

  test("ioc_card with no blocks at all renders an empty card, no throw", () => {
    const events = [{ type: "ioc_card", title: "198.51.100.4" }];
    expect(() => render(events)).not.toThrow();
  });
});

describe("interactive events survive malformed entries", () => {
  test("manual_input with a null field entry does not throw", () => {
    const events = [
      { type: "manual_input", question: "Confirm hosts",
        fields: [null, { name: "hosts", default: "a,b" }, "bad"] },
    ];
    let msg;
    expect(() => { msg = render(events); }).not.toThrow();
    const mi = msg.events.find((e) => e.type === "manual_input");
    // The real field seeded; the null/string entries skipped, not crashed.
    expect(mi.values.hosts).toBe("a,b");
  });

  test("action_card with a null param_schema entry does not throw", () => {
    const events = [
      { type: "action_card", connector: "fortigate", operation: "block_ip",
        param_schema: [null, { name: "ip", type: "text", required: true }],
        args: { ip: "1.2.3.4" } },
    ];
    let msg;
    expect(() => { msg = render(events); }).not.toThrow();
    const card = msg.events.find((e) => e.type === "action_card");
    expect(() => R.actionCardComplete(card)).not.toThrow();
  });

  test("playbook_offer with a null ops_summary entry does not throw", () => {
    const events = [
      { type: "playbook_offer", summary: "Save?",
        ops_summary: [null, { connector: "fortigate", operation: "block_ip" }, "bad"] },
    ];
    let msg;
    expect(() => { msg = render(events); }).not.toThrow();
    const offer = msg.events.find((e) => e.type === "playbook_offer");
    expect(offer.opsSummary.some((o) => o.operation === "block_ip")).toBe(true);
  });
});
