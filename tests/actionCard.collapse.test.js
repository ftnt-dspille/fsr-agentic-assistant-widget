"use strict";

// #129 -- an executed action_card kept rendering its full editable arg form,
// every input disabled, forever. The turn reads as unfinished: the analyst
// approved a containment and the screen still shows a form waiting to be
// filled. The collapsed rendering is a RECEIPT -- what actually ran -- and the
// form stays one click behind "Show details".
//
// The receipt is asserted on CONTENT, not existence: a summary that drops the
// value it is summarizing is the #1/#2 defect class again (a card that renders
// while saying nothing true).

const R = require("../widget/widgetAssets/js/fsrPbRender.js");
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };

function card(extra) {
  return R.buildAssistantMessage([Object.assign({
    type: "action_card", id: "card-1", connector: "fortigate",
    operation: "block_ip", summary: "Block 203.0.113.7",
    args: { ip: "203.0.113.7" },
  }, extra)], OPTS).events.find((e) => e.type === "action_card");
}

describe("the receipt says what ran", () => {
  test("each visible field that carried a value gets a labeled row", () => {
    const rows = R.actionCardArgSummary(card({
      param_schema: [
        { name: "ip", title: "IP Address", type: "text", required: true, visible: true },
        { name: "comment", title: "Comment", type: "text", visible: true },
      ],
      args: { ip: "203.0.113.7", comment: "phish C2" },
    }));
    expect(rows).toEqual([
      { name: "ip", label: "IP Address", value: "203.0.113.7" },
      { name: "comment", label: "Comment", value: "phish C2" },
    ]);
  });

  test("an unset optional arg is dropped -- a receipt of blanks is noise", () => {
    const rows = R.actionCardArgSummary(card({
      param_schema: [
        { name: "ip", title: "IP Address", type: "text", required: true, visible: true },
        { name: "comment", title: "Comment", type: "text", visible: true },
      ],
      args: { ip: "203.0.113.7", comment: "   " },
    }));
    expect(rows.map((r) => r.name)).toEqual(["ip"]);
  });

  test("a password is masked at rest -- it is masked in the form", () => {
    const rows = R.actionCardArgSummary(card({
      param_schema: [{ name: "token", title: "Token", type: "password", visible: true }],
      args: { token: "s3cr3t" },
    }));
    expect(rows).toEqual([{ name: "token", label: "Token", value: "••••••••" }]);
  });

  test("multiselect and checkbox read as values, not as [object Object]", () => {
    const rows = R.actionCardArgSummary(card({
      param_schema: [
        { name: "tags", title: "Tags", type: "multiselect", visible: true },
        { name: "force", title: "Force", type: "checkbox", visible: true },
      ],
      args: { tags: ["c2", "phish"], force: false },
    }));
    expect(rows).toEqual([
      { name: "tags", label: "Tags", value: "c2, phish" },
      { name: "force", label: "Force", value: "no" },
    ]);
  });

  test("an empty multiselect is dropped, but false is NOT -- 'no' is an answer", () => {
    const rows = R.actionCardArgSummary(card({
      param_schema: [
        { name: "tags", title: "Tags", type: "multiselect", visible: true },
        { name: "force", title: "Force", type: "checkbox", visible: true },
      ],
      args: { tags: [], force: false },
    }));
    expect(rows.map((r) => r.name)).toEqual(["force"]);
  });

  test("legacy cards with no param_schema still summarize their fields", () => {
    // The pre-2.4.0 shape -- the receipt must not go blank on it.
    const rows = R.actionCardArgSummary(card({ args: { ip: "203.0.113.7" } }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.value === "203.0.113.7")).toBe(true);
  });

  test("a hidden branch's field is not in the receipt -- it was not sent", () => {
    // The receipt must agree with resolveActionFields, or it claims an arg the
    // execution never carried.
    const c = card({
      param_schema: [
        { name: "mode", title: "Mode", type: "select", visible: true,
          options: ["quarantine", "block"] },
        { name: "duration", title: "Duration", type: "text", visible: true },
      ],
      visibility: { always: ["mode"], when: { "mode=quarantine": ["duration"] } },
      args: { mode: "block", duration: "60" },
    });
    expect(R.actionCardArgSummary(c).map((r) => r.name)).toEqual(["mode"]);
  });

  test("no card summarizes to nothing rather than throwing", () => {
    expect(R.actionCardArgSummary(null)).toEqual([]);
  });
});
