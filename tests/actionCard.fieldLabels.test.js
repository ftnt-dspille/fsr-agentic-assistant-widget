"use strict";

// The action card's editable fields must read as labels, never raw param ids.
// GA rehearsal: a FortiGate block card showed `time_to_live`, `vdom` as the
// field labels -- the connector sent no `title`, so the fallback leaked the key.
// The approval card already humanizes; the action card must match it.

const R = require("../widget/widgetAssets/js/fsrPbRender.js");
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };

function card(args) {
  return R.buildAssistantMessage([{
    type: "action_card", id: "appr-f", tool: "run_op",
    connector: "fortinet-fortigate", operation: "block_ip_new", args: args,
  }], OPTS).events.find((e) => e.type === "action_card");
}

function labelsFor(args) {
  const c = card(args);
  return R.resolveActionFields(c, c.args).map((f) => f.label);
}

describe("action card field labels", () => {
  test("a raw snake_case param becomes a readable label", () => {
    const labels = labelsFor({ time_to_live: "1 Hour", vdom: "root" });
    expect(labels).toContain("Time to live");
    expect(labels).toContain("Vdom");
    labels.forEach((l) => expect(l).not.toMatch(/_/));
  });

  test("security acronyms stay uppercase in the label", () => {
    expect(labelsFor({ ip: "1.2.3.4" })).toContain("IP");
  });

  test("a connector-supplied title wins over the humanized fallback", () => {
    const c = R.buildAssistantMessage([{
      type: "action_card", id: "appr-t", tool: "run_op",
      connector: "x", operation: "y",
      params: [{ name: "time_to_live", title: "Block duration", visible: true }],
      args: { time_to_live: "1 Hour" },
    }], OPTS).events.find((e) => e.type === "action_card");
    expect(R.resolveActionFields(c, c.args).map((f) => f.label)).toContain("Block duration");
  });
});
