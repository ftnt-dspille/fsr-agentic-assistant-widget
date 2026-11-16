"use strict";

// Regression: the "bizarre playbook approval popup then crash".
// push_playbook is tier-3, so its approval preview carried the FULL yaml_text;
// the widget rendered preview.args as JSON.stringify(...) → a multi-KB <pre>.
// The renderer now caps the approval display, and the action-card field
// resolver no longer throws on a card that has a schema but a missing
// paramIndex / malformed `visibility.when` (digest-time bindings must never
// throw — that freezes Angular).

const R = require("../widget/widgetAssets/js/fsrPbRender.js");
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };

describe("approval preview display is bounded", () => {
  test("a huge preview.args is truncated, not dumped whole", () => {
    const huge = "name: ".concat("x".repeat(8000));
    const events = [
      { type: "approval_request", tool: "push_playbook", approval_id: "ap-1",
        preview: { tool: "push_playbook", args: { yaml_text: huge } } },
    ];
    const msg = R.buildAssistantMessage(events, OPTS);
    const ev = msg.events.find((e) => e.type === "approval_request");
    expect(ev).toBeTruthy();
    expect(ev.display.length).toBeLessThan(huge.length);
    expect(ev.display).toContain("chars truncated");
    expect(ev.display).not.toContain("x".repeat(8000));
  });

  test("a summary still wins over the args dump", () => {
    const events = [
      { type: "approval_request", tool: "push_playbook", approval_id: "ap-2",
        summary: "Push 'Block C2 IP' to FortiSOAR",
        preview: { tool: "push_playbook", args: { yaml_text: "y".repeat(5000) } } },
    ];
    const ev = R.buildAssistantMessage(events, OPTS).events
      .find((e) => e.type === "approval_request");
    expect(ev.display).toBe("Push 'Block C2 IP' to FortiSOAR");
  });
});

describe("action-card field resolver never throws on malformed cards", () => {
  test("card with paramSchema + visibility but no paramIndex does not throw", () => {
    const card = {
      type: "action_card",
      paramSchema: [{ name: "ip", type: "text", required: true, schemaVisible: true }],
      visibility: { always: ["ip"], when: {} },
      args: {},
      // paramIndex intentionally absent (e.g. a hand-assembled/rehydrated card)
    };
    expect(() => R.actionCardComplete(card)).not.toThrow();
    expect(typeof R.actionCardComplete(card)).toBe("boolean");
  });

  test("malformed visibility.when (scalar instead of array) does not throw", () => {
    const card = {
      type: "action_card",
      paramSchema: [
        { name: "method", type: "select", required: true, schemaVisible: true,
          default: "a", options: [{ value: "a" }] },
        { name: "child", type: "text", required: false, schemaVisible: true },
      ],
      paramIndex: {
        method: { name: "method", type: "select", default: "a", schemaVisible: true },
        child: { name: "child", type: "text", schemaVisible: true },
      },
      visibility: { always: ["method"], when: { "method=a": "child" } }, // string, not array
      args: { method: "a" },
    };
    expect(() => R.actionCardComplete(card)).not.toThrow();
  });
});
