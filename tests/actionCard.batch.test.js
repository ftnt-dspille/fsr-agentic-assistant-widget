"use strict";

// Batched approval. A model building something emits its writes together --
// seven step creates for a seven-step ZTP profile. The connector puts them on
// ONE card (`batch`), and one decision covers the lot. The card has to show
// every write before the analyst approves, labelled so the rows can be told
// apart: the connector's summary is "Create <module>" for all seven.

const R = require("../widget/widgetAssets/js/fsrPbRender.js");
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };
const STEPS = "ztpf_automation_profile_steps";

function card(extra) {
  return R.buildAssistantMessage([Object.assign({
    type: "action_card", id: "appr-b", tool: "create_record",
    summary: "Create " + STEPS, args: { name: "Pre-Upgrade System Status", stepSequence: 1 },
    target: { module: STEPS },
    changes: [{ field: "name", after: "Pre-Upgrade System Status" },
              { field: "stepSequence", after: 1 }],
  }, extra)], OPTS).events.find((e) => e.type === "action_card");
}

function row(name, seq) {
  return { tool: "create_record", summary: "Create " + STEPS,
           args: { module: STEPS, fields: { name: name, stepSequence: seq } },
           target: { module: STEPS },
           changes: [{ field: "name", after: name }, { field: "stepSequence", after: seq }] };
}

describe("a batched card", () => {
  const c = card({ batch: [row("Upgrade Firmware 7.6.8", 2), row("Post-Upgrade System Status", 3)] });

  test("lists every other write, labelled by the record's own name", () => {
    expect(c.batch.map((b) => b.label)).toEqual(
      ["Upgrade Firmware 7.6.8", "Post-Upgrade System Status"]);
    // The name is the label, so it is not repeated as a change.
    expect(c.batch[0].changes).toEqual([{ field: "stepSequence", after: 2 }]);
  });

  test("says how much one click approves", () => {
    expect(c.confirmLabel).toBe("Approve all 3");
    expect(c.batchHeading).toBe("This approval also covers 2 more changes:");
  });

  test("a nameless row falls back to its summary", () => {
    const u = card({ batch: [{ tool: "update_record", summary: "Update step 4",
                               changes: [{ field: "stepSequence", after: 5 }] }] });
    expect(u.batch[0].label).toBe("Update step 4");
    expect(u.batchHeading).toBe("This approval also covers 1 more change:");
  });

  test("junk rows are dropped, not rendered blank", () => {
    const j = card({ batch: [null, "x", row("Real", 2)] });
    expect(j.batch.map((b) => b.label)).toEqual(["Real"]);
    expect(j.confirmLabel).toBe("Approve all 2");
  });
});

test("a single-call card is unchanged", () => {
  const c = card({});
  expect(c.batch).toEqual([]);
  expect(c.confirmLabel).toBe("Confirm & Execute");
  expect(c.batchHeading).toBe("");
});
