"use strict";

// "This playbook has run 16 times and last finished cleanly" is what an analyst
// wants before authorising another run -- and "never run before" is a different
// decision entirely.
//
// The connector has carried that in `context` on every recorded run_playbook
// approval (five captures, two boxes) since the feature existed, and the widget
// read none of it. It only reached the analyst because the connector ALSO
// appends a slice of it to the summary text, with a comment in operations.py
// saying the append exists because no card layout renders the structured form.
//
// This is that layout. Which makes the append duplication, so the renderer
// strips it -- in the widget rather than the connector, because removing it
// there would blank the line on every older widget.

const R = require("../widget/widgetAssets/js/fsrPbRender.js");
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };

// The real capture, verbatim.
const CTX = {
  playbook_uuid: "9d1a83d1-e9a6-4d6d-986f-173edf129617",
  playbook_url: "/playbooks/9d1a83d1-e9a6-4d6d-986f-173edf129617",
  last_run: "2026-08-10 (21h ago)",
  last_status: "finished",
  runs_24h: 1,
  runs_total: 16,
};

function card(extra) {
  return R.buildAssistantMessage([Object.assign({
    type: "approval_request", approval_id: "ap-1", tool_use_id: "tu-1",
    tool: "run_playbook", summary: "Run the ZTPF metadata playbook",
    preview: { args: { playbook: "ZTPF" } },
  }, extra)], OPTS).events.find((e) => e.type === "approval_request");
}

describe("run history reaches the card", () => {
  test("the captured context normalizes whole", () => {
    expect(card({ context: CTX }).runContext).toEqual({
      lastRun: "2026-08-10 (21h ago)", lastStatus: "finished",
      runs24h: 1, runsTotal: 16, neverRun: false,
    });
  });

  test("no context at all is null, not an empty history", () => {
    // Rendering "ran 0 times" for an approval that carries no context would be
    // a claim about the playbook, invented by the widget.
    expect(card({}).runContext).toBeNull();
  });

  test("a context with NO counts renders nothing rather than asserting", () => {
    // An older connector, or a lookup that failed. Silence is the honest
    // rendering of "we did not find out".
    expect(card({ context: { playbook_uuid: "x" } }).runContext).toBeNull();
  });

  test("partial counts survive -- one missing field is not a missing history", () => {
    const rc = card({ context: { last_run: "2026-08-10 (21h ago)", runs_total: 3 } })
      .runContext;
    expect(rc.runsTotal).toBe(3);
    expect(rc.runs24h).toBeNull();
    expect(rc.lastStatus).toBe("");
  });
});

describe("never run", () => {
  test("the connector's literal 'never' is recognised", () => {
    expect(card({ context: { last_run: "never", runs_total: 0 } }).runContext.neverRun)
      .toBe(true);
  });

  test("a zero total counts as never even with a date-shaped last_run", () => {
    expect(card({ context: { last_run: "", runs_total: 0 } }).runContext.neverRun)
      .toBe(true);
  });

  test("a playbook WITH history is not never -- the silencing case", () => {
    expect(card({ context: CTX }).runContext.neverRun).toBe(false);
  });
});

describe("the summary no longer says it twice", () => {
  test("the connector's appended run bits are stripped once rendered", () => {
    const c = card({
      summary: "Run the ZTPF metadata playbook · Last run: 2026-08-10 (21h ago) "
        + "· 1 run in the last 24h",
      context: CTX,
    });
    expect(c.summary).toBe("Run the ZTPF metadata playbook");
    expect(c.runContext.runsTotal).toBe(16);
  });

  test("the plural form is stripped too", () => {
    const c = card({ summary: "Do the thing · 10 runs in the last 24h", context: CTX });
    expect(c.summary).toBe("Do the thing");
  });

  test("a summary is NOT trimmed when no context came with it", () => {
    // Without the structured block there is nothing to replace the words with,
    // so stripping them would delete the only copy.
    const c = card({ summary: "Do the thing · Last run: yesterday" });
    expect(c.summary).toBe("Do the thing · Last run: yesterday");
  });

  test("a summary that merely mentions a last run keeps its own words", () => {
    // The strip is anchored to the separator the connector joins with. A
    // general trim would eat prose the model wrote.
    const c = card({
      summary: "The last run of this playbook failed, so review it first",
      context: CTX,
    });
    expect(c.summary).toBe("The last run of this playbook failed, so review it first");
  });
});
