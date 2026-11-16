// An offer for a connector the analyst cannot use yet still arrives, with a
// plain warning. The card must carry it (message + steps) and never the raw
// connector id or reason enum.

const R = require("../widget/widgetAssets/js/fsrPbRender");

const CLOCK = { now: () => 1700000000000, collapseThreshold: 600 };

function card(ev) {
  const msgs = R.normalizeTranscript
    ? R.normalizeTranscript([ev], CLOCK)
    : R.buildAssistantMessage([ev], CLOCK);
  for (const m of (Array.isArray(msgs) ? msgs : [msgs])) {
    for (const e of (m.events || [])) if (e.type === ev.type) return e;
  }
  return null;
}

const SETUP = [
  { connector: "fortiedr", reason: "not_configured", message: "FortiEDR is not set up yet.",
    setup_steps: ["Add FortiEDR under Connectors.", "Enter credentials."] },
  { connector: "fortigate", reason: "not_shared", message: "FortiGate is not shared with your team.",
    setup_steps: [] },
];

describe.each(["playbook_offer", "enhancement_offer"])("%s runs_after_setup", (type) => {
  test("carries message and steps, nothing machine-facing", () => {
    const c = card({ type, id: "o1", summary: "s", runs_after_setup: SETUP });
    expect(c.runsAfterSetup).toEqual([
      { message: "FortiEDR is not set up yet.", steps: ["Add FortiEDR under Connectors.", "Enter credentials."] },
      { message: "FortiGate is not shared with your team.", steps: [] },
    ]);
    expect(JSON.stringify(c.runsAfterSetup)).not.toMatch(/not_configured|not_shared|fortiedr/);
  });

  test("missing, malformed or message-less input becomes []", () => {
    expect(card({ type, id: "o2", summary: "s" }).runsAfterSetup).toEqual([]);
    expect(card({ type, id: "o3", summary: "s", runs_after_setup: "x" }).runsAfterSetup).toEqual([]);
    expect(card({ type, id: "o4", summary: "s", runs_after_setup: [null, { reason: "not_shared" }, 5] }).runsAfterSetup).toEqual([]);
    expect(card({ type, id: "o5", summary: "s", runs_after_setup: [{ message: "m", setup_steps: "no" }] }).runsAfterSetup)
      .toEqual([{ message: "m", steps: [] }]);
  });
});

test("playbook_offer carries warnings too", () => {
  const c = card({ type: "playbook_offer", id: "w1", summary: "s", warnings: [{ message: "Careful", step_name: "A" }] });
  expect(c.warnings).toEqual([{ message: "Careful", step: "A", inChange: true }]);
  expect(card({ type: "playbook_offer", id: "w2", summary: "s" }).warnings).toEqual([]);
});
