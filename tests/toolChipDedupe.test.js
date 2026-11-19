"use strict";

// A tool's chip arrives twice under one id: early (the model started the call,
// no arguments yet) and at dispatch (full input). Live, the two entries crashed
// the timeline's ng-repeat (`track by ev._key`, ngRepeat:dupes) and the whole
// reply bubble rendered empty, so a staged action card never showed. The frame
// sequence below is the one a live box sent for "block ip <addr>".

const R = require("../widget/widgetAssets/js/fsrPbRender.js");

const CLOCK = { now: () => 1700000000000, collapseThreshold: 600, interleaveText: true };

const LIVE = [
  { type: "tool_use", id: "toolu_A", name: "find", input: {} },
  { type: "tool_use", id: "toolu_A", name: "find",
    input: { kind: "action", action_type: "containment", target_type: "ip", query: "block IP address" } },
  { type: "tool_result", tool_use_id: "toolu_A", content: { ok: true, actions: [] } },
  { type: "tool_use", id: "toolu_B", name: "get_op_schema", input: {} },
  { type: "tool_use", id: "toolu_B", name: "get_op_schema",
    input: { connector: "fortigate-firewall", op: "block_ip_new" } },
  { type: "tool_result", tool_use_id: "toolu_B", content: { ok: true } },
];

function toolCalls(msg) {
  return msg.events.filter((e) => e.type === "tool_call");
}

test("a chip sent early and again at dispatch is one timeline entry", () => {
  const calls = toolCalls(R.buildAssistantMessage(LIVE, CLOCK));
  expect(calls.map((c) => c._toolUseId)).toEqual(["toolu_A", "toolu_B"]);
});

test("every timeline key is unique, so the ng-repeat cannot throw dupes", () => {
  const keys = R.buildAssistantMessage(LIVE, CLOCK).events.map((e) => e._key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("the kept entry carries the full arguments from the dispatch frame", () => {
  const [find, schema] = toolCalls(R.buildAssistantMessage(LIVE, CLOCK));
  expect(JSON.parse(find.inputDisplay)).toEqual(LIVE[1].input);
  expect(JSON.parse(schema.inputDisplay)).toEqual(LIVE[4].input);
});

test("the result still pairs with the merged entry", () => {
  const [find, schema] = toolCalls(R.buildAssistantMessage(LIVE, CLOCK));
  expect(find.resultStatus).not.toBe("pending");
  expect(schema.resultStatus).not.toBe("pending");
});

test("an early chip whose dispatch frame has not arrived yet stays pending", () => {
  const calls = toolCalls(R.buildAssistantMessage(LIVE.slice(0, 1), CLOCK));
  expect(calls).toHaveLength(1);
  expect(calls[0].resultStatus).toBe("pending");
});

test("a later empty-input frame does not wipe arguments already shown", () => {
  const seq = [LIVE[1], { type: "tool_use", id: "toolu_A", name: "find", input: {} }];
  const [find] = toolCalls(R.buildAssistantMessage(seq, CLOCK));
  expect(JSON.parse(find.inputDisplay)).toEqual(LIVE[1].input);
});

test("tool calls without an id are not merged", () => {
  const seq = [{ type: "tool_use", name: "find", input: {} },
               { type: "tool_use", name: "find", input: {} }];
  expect(toolCalls(R.buildAssistantMessage(seq, CLOCK))).toHaveLength(2);
});
