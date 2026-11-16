"use strict";

// The run_op action card's header/summary must never show the analyst a raw
// connector.operation id or a record IRI (GA demo rehearsal, isolate card).
// Backstops the connector's _clean_run_op_summary.

const R = require("../widget/widgetAssets/js/fsrPbRender.js");
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };

function card(extra) {
  return R.buildAssistantMessage([Object.assign({
    type: "action_card", id: "appr-h", tool: "run_op",
    connector: "fortinet-fortiedr", operation: "isolate_collector",
    args: { type: "Name", devices: "The-Flame" },
  }, extra)], OPTS).events.find((e) => e.type === "action_card");
}

describe("run_op action card summary hygiene", () => {
  test("no summary -> humanized op, never the raw id", () => {
    const c = card({});
    expect(c.summary).toBe("Isolate collector");
    expect(c.summary).not.toContain("fortinet-fortiedr");
    expect(c.summary).not.toContain("isolate_collector");
  });

  test("a raw connector.operation token is humanized", () => {
    const c = card({ summary: "fortinet-fortiedr.isolate_collector" });
    expect(c.summary).toBe("Isolate collector");
  });

  test("a record IRI is stripped from the summary", () => {
    const c = card({
      summary: "Isolate the host in alerts/4def1db2-ad9e-43e6-93cb-4117eab62785",
    });
    expect(c.summary).not.toContain("4def1db2");
    expect(c.summary).not.toContain("alerts/");
    expect(c.summary).toBe("Isolate the host in the alert record");
  });

  test("an /api/3-prefixed IRI is stripped", () => {
    const c = card({
      summary: "Update /api/3/incidents/4def1db2-ad9e-43e6-93cb-4117eab62785",
    });
    expect(c.summary).not.toContain("/api/3/");
    expect(c.summary).toBe("Update the incident record");
  });

  test("acronyms in the humanized fallback stay uppercase", () => {
    const c = card({ connector: "cisco-asa", operation: "block_ip", args: {} });
    expect(c.summary).toBe("Block IP");
  });

  test("a clean analyst summary is left untouched", () => {
    const c = card({ summary: "Isolate The-Flame on FortiEDR" });
    expect(c.summary).toBe("Isolate The-Flame on FortiEDR");
  });
});
