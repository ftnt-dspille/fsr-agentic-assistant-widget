// A playbook offer's step list is analyst-facing: it must never fall back to a
// raw connector.operation id when the framework gives no label.
//
// The B2 (GA demo readiness) rehearsal found the offer card "names connector
// ops": ops_summary rows without a `label` rendered "fortinet-fortiedr.
// isolate_endpoint" verbatim, both on the card and in the exported transcript
// (which reads this same normalized label). The humanized operation is the
// analyst-facing affordance; the raw id never belongs in the label.

const R = require("../widget/widgetAssets/js/fsrPbRender");

const CLOCK = { now: () => 1700000000000, collapseThreshold: 600 };

function offer(ev) {
  const msgs = R.normalizeTranscript
    ? R.normalizeTranscript([ev], CLOCK)
    : R.buildAssistantMessage([ev], CLOCK);
  for (const m of (Array.isArray(msgs) ? msgs : [msgs])) {
    for (const e of (m.events || [])) {
      if (e.type === "playbook_offer") return e;
    }
  }
  return null;
}

describe("playbook offer op labels never leak a raw connector.operation id", () => {
  test("an op with no label is humanized, not shown as connector.operation", () => {
    const c = offer({
      type: "playbook_offer",
      id: "o1",
      summary: "Save this investigation as a repeatable playbook?",
      ops_summary: [
        { connector: "fortinet-fortiedr", operation: "isolate_endpoint", step_type: "action" },
      ],
    });
    const label = c.opsSummary[0].label;
    expect(label).toBe("Isolate endpoint");
    // Guard against any regression that reintroduces the raw id in the label.
    expect(label).not.toContain("fortinet-fortiedr");
    expect(label).not.toContain("isolate_endpoint");
    expect(label).not.toContain(".");
  });

  test("a framework-provided label is left untouched", () => {
    const c = offer({
      type: "playbook_offer",
      id: "o2",
      summary: "s",
      ops_summary: [
        { connector: "fortinet-fortiedr", operation: "isolate_endpoint",
          step_type: "action", label: "Isolate the endpoint" },
      ],
    });
    expect(c.opsSummary[0].label).toBe("Isolate the endpoint");
  });
});
