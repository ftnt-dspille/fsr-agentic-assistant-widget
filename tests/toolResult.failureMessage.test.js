"use strict";

// ─── A failed tool must render its diagnosis ────────────────────────────────
//
// `message` on a tool result is model-facing steering text, so the renderer
// strips it from the analyst's transcript. That was applied unconditionally,
// including to FAILURES — where `message` is the only field that says why.
//
// Live on 206: a manual-input resume failed and the widget rendered
//   { "ok": false, "code": "resume_error", "run_pk": "388" }
// while the wire carried
//   "resuming run 388 failed: 400 ... {'workflow': ['Select a valid choice.
//    That choice is not one of the available choices.']}"
// With the one explanatory field hidden, the failure read as "the playbook got
// approved and then nothing happens".
//
// Contract: strip `message` on success, KEEP it on `ok: false`. `suggested_card`
// is internal either way.

const R = require("../widget/widgetAssets/js/fsrPbRender.js");

const CLOCK = { now: () => 1700000000000, collapseThreshold: 600, interleaveText: true };

function resultFor(content) {
  const msg = R.buildAssistantMessage([
    { type: "tool_use", id: "call_1", name: "resume_playbook", input: { run: "388" } },
    { type: "tool_result", tool_use_id: "call_1", content: content },
  ], CLOCK);
  const call = msg.events.find((e) => e.type === "tool_call");
  return JSON.parse(call.resultDisplay);
}

describe("tool_result rendering — failure diagnosis", () => {
  test("ok:false KEEPS message (the diagnosis)", () => {
    const out = resultFor({
      ok: false,
      code: "resume_error",
      run_pk: "388",
      message: "resuming run 388 failed: Select a valid choice.",
    });
    expect(out.message).toBe("resuming run 388 failed: Select a valid choice.");
    expect(out.code).toBe("resume_error");
  });

  test("ok:false still strips suggested_card", () => {
    const out = resultFor({
      ok: false, code: "resume_error", message: "why it broke",
      suggested_card: { type: "action_card" },
    });
    expect(out.message).toBe("why it broke");
    expect(out).not.toHaveProperty("suggested_card");
  });

  test("ok:true still strips message (model-facing steering, not analyst text)", () => {
    const out = resultFor({
      ok: true, run_pk: "6839",
      message: "Resume it with resume_playbook(run='6839', ...)",
    });
    expect(out).not.toHaveProperty("message");
    expect(out.run_pk).toBe("6839");
  });

  test("a payload with no ok field is treated as success (unchanged behaviour)", () => {
    const out = resultFor({ count: 3, message: "steering text" });
    expect(out).not.toHaveProperty("message");
    expect(out.count).toBe(3);
  });
});
