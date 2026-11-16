"use strict";

// ─── Tool wall-time: per-tool duration + turn roll-up + pending ticker seed ──
//
// Phase 1 (connector) stamps server-side `duration_ms` on each tool_result
// wire frame. These tests pin the render side of the contract:
//   - duration_ms threads onto the paired tool_call as durationMs/durationLabel
//   - a still-pending tool_use gets a _startedAt seed (the ticker anchor) and
//     no frozen label
//   - buildAssistantMessage rolls a turn-level total + slowest-tool callout
//   - formatDuration's human format is stable across the sub-s / s / m bands
//
// The live count-up itself is driven by the controller's $interval; the math it
// uses (formatDuration(now - _startedAt)) is exercised here directly.

const R = require("../widget/widgetAssets/js/fsrPbRender.js");

const CLOCK = { now: () => 1700000000000, collapseThreshold: 600, interleaveText: true };

function build(transcript) {
  return R.buildAssistantMessage(transcript, CLOCK);
}

describe("formatDuration", () => {
  test("sub-second → ms", () => {
    expect(R.formatDuration(0)).toBe("0ms");
    expect(R.formatDuration(123)).toBe("123ms");
    expect(R.formatDuration(999)).toBe("999ms");
  });
  test("under 10s → one decimal; 10-59s → whole seconds", () => {
    expect(R.formatDuration(1000)).toBe("1.0s");
    expect(R.formatDuration(4700)).toBe("4.7s");
    expect(R.formatDuration(47000)).toBe("47s");
  });
  test("minute and above → MmSSs", () => {
    expect(R.formatDuration(60000)).toBe("1m00s");
    expect(R.formatDuration(67000)).toBe("1m07s");
    expect(R.formatDuration(125000)).toBe("2m05s");
  });
  test("non-finite / negative → null (no label)", () => {
    expect(R.formatDuration(-1)).toBeNull();
    expect(R.formatDuration(NaN)).toBeNull();
    expect(R.formatDuration("x")).toBeNull();
    expect(R.formatDuration(undefined)).toBeNull();
  });
});

describe("duration threads onto the paired tool_call", () => {
  test("completed tool freezes durationMs + label from the wire frame", () => {
    const msg = build([
      { type: "tool_use", id: "tu-1", name: "siem_events_for_incident", input: { id: 5 } },
      { type: "tool_result", tool_use_id: "tu-1", content: '{"ok":true}', duration_ms: 47000 },
    ]);
    const call = msg.events.find((e) => e.type === "tool_call");
    expect(call.durationMs).toBe(47000);
    expect(call.durationLabel).toBe("47s");
    expect(call.resultStatus).toBe("success");
  });

  test("a tool_result without duration_ms leaves durationMs null", () => {
    const msg = build([
      { type: "tool_use", id: "tu-2", name: "get_record", input: {} },
      { type: "tool_result", tool_use_id: "tu-2", content: '{"ok":true}' },
    ]);
    const call = msg.events.find((e) => e.type === "tool_call");
    expect(call.durationMs).toBeNull();
    expect(call.durationLabel).toBeNull();
  });

  test("a still-pending tool_use seeds _startedAt and stays unlabelled", () => {
    const msg = build([
      { type: "tool_use", id: "tu-3", name: "siem_search_host", input: {} },
    ]);
    const call = msg.events.find((e) => e.type === "tool_call");
    expect(call.resultStatus).toBe("pending");
    expect(call._startedAt).toBe(CLOCK.now());
    expect(call.durationMs).toBeNull();
    expect(call.durationLabel).toBeNull();
    // What the controller's ticker would render 12s in:
    expect(R.formatDuration(CLOCK.now() + 12000 - call._startedAt)).toBe("12s");
  });
});

describe("turn-level roll-up", () => {
  test("totals measured tools + flags the slowest when >1", () => {
    const msg = build([
      { type: "tool_use", id: "a", name: "get_record", input: {} },
      { type: "tool_result", tool_use_id: "a", content: '{"ok":true}', duration_ms: 1200 },
      { type: "tool_use", id: "b", name: "siem_events_for_incident", input: {} },
      { type: "tool_result", tool_use_id: "b", content: '{"ok":true}', duration_ms: 58000 },
    ]);
    expect(msg.toolTotalMs).toBe(59200);
    expect(msg.toolTotalLabel).toBe("59s");
    expect(msg.slowestTool).toEqual({
      name: "siem_events_for_incident",
      label: "Siem events for incident",
      durationMs: 58000,
      durationLabel: "58s",
    });
  });

  test("a single measured tool gets a total but no slowest callout (noise)", () => {
    const msg = build([
      { type: "tool_use", id: "a", name: "get_record", input: {} },
      { type: "tool_result", tool_use_id: "a", content: '{"ok":true}', duration_ms: 800 },
    ]);
    expect(msg.toolTotalLabel).toBe("800ms");
    expect(msg.slowestTool).toBeNull();
  });

  test("no measured tools → null roll-up (nothing to show)", () => {
    const msg = build([
      { type: "tool_use", id: "a", name: "get_record", input: {} },
      { type: "tool_result", tool_use_id: "a", content: '{"ok":true}' },
    ]);
    expect(msg.toolTotalMs).toBeNull();
    expect(msg.toolTotalLabel).toBeNull();
    expect(msg.slowestTool).toBeNull();
  });
});
