"use strict";

// ─── "How I worked this out": reasoning folded from usage frames ────────────
//
// The connector carries the model's per-round reasoning summary on the usage
// wire frame (Anthropic summarized thinking). buildAssistantMessage gathers it
// across the whole turn into one collapsed panel (msg._reasoning), de-dashed
// like the prose, and null when the model emitted none -- so the panel never
// shows empty for a standard model. These pin that behaviour; the connector
// test (test_usage_thinking) pins that the frame carries the field.

const R = require("../widget/widgetAssets/js/fsrPbRender.js");

const CLOCK = { now: () => 1700000000000, collapseThreshold: 600, interleaveText: true };
const build = (t) => R.buildAssistantMessage(t, CLOCK);

describe("reasoning panel", () => {
  test("one round's reasoning rides the usage frame into msg._reasoning", () => {
    const msg = build([
      { type: "tool_use", id: "a", name: "edr_host", input: { host: "The-Flame" } },
      { type: "tool_result", tool_use_id: "a", content: { ok: true } },
      { type: "usage", model: "claude-sonnet-5", input_tokens: 10, output_tokens: 400,
        thinking: "I should check the host in FortiEDR first, then the SIEM events." },
      { type: "text", text: "Here is what happened." },
    ]);
    expect(msg._reasoning).toEqual([
      "I should check the host in FortiEDR first, then the SIEM events."]);
  });

  test("every round that emitted reasoning is kept, in order", () => {
    const msg = build([
      { type: "usage", thinking: "First, look at the host." },
      { type: "tool_use", id: "a", name: "edr_host", input: {} },
      { type: "tool_result", tool_use_id: "a", content: { ok: true } },
      { type: "usage", thinking: "The host shows 32 critical events." },
      { type: "usage", thinking: "I will present a verdict now." },
      { type: "text", text: "Verdict." },
    ]);
    expect(msg._reasoning).toEqual([
      "First, look at the host.",
      "The host shows 32 critical events.",
      "I will present a verdict now.",
    ]);
  });

  test("a round with empty reasoning adds nothing", () => {
    const msg = build([
      { type: "usage", thinking: "Only this round reasons." },
      { type: "usage", thinking: "" },
      { type: "usage", thinking: "   " },
      { type: "usage" },
      { type: "text", text: "Done." },
    ]);
    expect(msg._reasoning).toEqual(["Only this round reasons."]);
  });

  test("no reasoning anywhere leaves _reasoning null, not []", () => {
    const msg = build([
      { type: "usage", model: "gpt-5.4", input_tokens: 5, output_tokens: 20 },
      { type: "text", text: "Standard-model answer." },
    ]);
    expect(msg._reasoning).toBeNull();
  });

  test("reasoning is de-dashed like the prose (latin-1 box, hyphens only)", () => {
    const msg = build([
      // em and en dashes built from char codes so the source file stays ASCII
      // (the connector is latin-1; a literal dash here fails the commit hook).
      { type: "usage", thinking: "The host " + String.fromCharCode(0x2014) + " x " + String.fromCharCode(0x2013) + " y" },
      { type: "text", text: "x" },
    ]);
    // plainDashes collapses em/en dashes to a plain separator; assert no
    // em/en dash survives into the panel text.
    expect(msg._reasoning).toHaveLength(1);
    expect(msg._reasoning[0]).not.toContain(String.fromCharCode(0x2014));
    expect(msg._reasoning[0]).not.toContain(String.fromCharCode(0x2013));
  });

  test("the reasoning never leaks into the answer prose", () => {
    const msg = build([
      { type: "usage", thinking: "SECRET-REASONING-MARKER weighing the evidence." },
      { type: "text", text: "The analyst-facing answer." },
    ]);
    expect(msg.text).not.toMatch(/SECRET-REASONING-MARKER/);
    const textEvents = msg.events.filter((e) => e.type === "text");
    textEvents.forEach((e) => expect(e.text).not.toMatch(/SECRET-REASONING-MARKER/));
  });
});
