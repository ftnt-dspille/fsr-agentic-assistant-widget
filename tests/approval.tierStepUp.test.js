"use strict";

// The approval card never said WHAT KIND of action it was gating.
//
// `tier` and `requires_step_up` are on every recorded approval -- five captures
// across two boxes -- and the widget read neither. So a tier-4 remediation
// (whose confirm_mode in the framework is `step_up`, not `approve`) asked for
// consent in exactly the same words, with the same two buttons, as a tier-2
// write. P2 says a state-changing action is gated on what the analyst can
// actually see; an approval card that cannot distinguish the most destructive
// class from the mildest one is gating on faith.
//
// The `tier N` badge reuses the existing .tools-tier CSS; nothing had to be
// invented, only connected.
//
// Firing/silencing pairs throughout -- a badge on every approval is a badge
// nobody reads.

const R = require("../widget/widgetAssets/js/fsrPbRender.js");
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };

function card(extra) {
  return R.buildAssistantMessage([Object.assign({
    type: "approval_request", approval_id: "ap-1", tool_use_id: "tu-1",
    tool: "run_playbook", summary: "Run the containment playbook",
    preview: { args: { name: "Block IP" } },
  }, extra)], OPTS).events.find((e) => e.type === "approval_request");
}

describe("the approval card carries its tier", () => {
  test("the wire tier reaches the render model", () => {
    expect(card({ tier: 3 }).tier).toBe(3);
    expect(card({ tier: 4 }).tier).toBe(4);
  });

  test("a card with no tier is 0, not undefined", () => {
    // The template tests `tier >= 3`; undefined would compare false today and
    // NaN-ish tomorrow. A number keeps the badge decision total.
    expect(card({}).tier).toBe(0);
  });

  test("a non-numeric tier does not become a badge", () => {
    expect(card({ tier: "high" }).tier).toBe(0);
  });
});

describe("requires_step_up", () => {
  test("the connector's own flag wins", () => {
    expect(card({ tier: 4, requires_step_up: true }).requiresStepUp).toBe(true);
  });

  test("a tier-3 approval is NOT step-up -- the silencing case", () => {
    // Every capture so far is exactly this: tier 3, requires_step_up false. If
    // the notice fired here it would be on every real approval on the box.
    expect(card({ tier: 3, requires_step_up: false }).requiresStepUp).toBe(false);
  });

  test("an absent flag falls back to the tier the connector also sent", () => {
    // Older connectors sent the tier without the flag. Deriving is the degraded
    // path, not the primary one.
    expect(card({ tier: 4 }).requiresStepUp).toBe(true);
    expect(card({ tier: 2 }).requiresStepUp).toBe(false);
  });

  test("an explicit false at tier 4 is respected over the derivation", () => {
    // The connector owns this decision. If the threshold ever moves, deriving
    // it here would put the widget in silent disagreement with the gate that
    // actually runs.
    expect(card({ tier: 4, requires_step_up: false }).requiresStepUp).toBe(false);
  });

  test("no tier and no flag is not step-up", () => {
    expect(card({}).requiresStepUp).toBe(false);
  });
});
