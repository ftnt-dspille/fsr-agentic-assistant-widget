"use strict";

// ─── Debug-session service methods (Track C3 debug drawer) ───────────────────
//
// start/step/continue/stopDebugSession drive the connector's stateful debug
// walker via the generic `call_mcp_tool` seam, always LIVE (the session lives in
// the connector's SessionStore; the mock track has no walker). This asserts the
// dispatch shape, tool names, arg defaults/overrides, and envelope unwrapping.

global.jasmine = global.jasmine || {};
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef

require("../widget/widgetAssets/js/fsrPbAgent.service.js");

const ng = window.angular; // eslint-disable-line no-undef
const CONNECTOR_NAME = "connector-fsr-agentic-assistant";

function makeHarness() {
  const calls = [];
  const connectorService = {
    executeConnectorAction: function (name, version, action, configId, payload) {
      calls.push({ name, version, action, configId, payload });
      return _$q.when({
        operation: action, status: "Success", message: "",
        data: { ok: true, status: { session_id: "dbg-1", done: false } }
      });
    }
  };
  const mockConnector = { execute: () => _$q.when({}) };
  let _$q, $httpBackend, service, $rootScope;
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("connectorService", connectorService);
    $provide.value("fsrPbMockConnectorService", mockConnector);
  });
  ng.mock.inject((_fsrPbAgentService_, _$q_, _$httpBackend_, _$rootScope_) => {
    service = _fsrPbAgentService_; _$q = _$q_; $httpBackend = _$httpBackend_; $rootScope = _$rootScope_;
  });
  $httpBackend.whenGET(/\/api\/integration\/connectors\/\?search=/).respond(200, {
    data: [{ name: CONNECTOR_NAME, version: "9.9.9",
      configuration: [{ name: "fsrpb-live", config_id: "cfg-live", default: true }] }]
  });
  return { service, calls, flush: () => { $httpBackend.flush(); $rootScope.$digest(); } };
}

const YAML = "playbooks:\n  - name: P\n    steps:\n      - name: Start\n        type: start\n";

describe("fsrPbAgentService — debug session methods", () => {
  test("startDebugSession dispatches start_debug_session with default args", () => {
    const h = makeHarness();
    let result;
    h.service.startDebugSession({}, YAML, { breakpoints: ["end"] }).then((r) => { result = r; });
    h.flush();
    const c = h.calls[0];
    expect(c.name).toBe(CONNECTOR_NAME);
    expect(c.action).toBe("call_mcp_tool");
    expect(c.payload.tool).toBe("start_debug_session");
    expect(c.payload.args).toEqual({
      yaml_text: YAML, execute_safe_ops: true, execute_unsafe_ops: false,
      max_steps: 30, breakpoints: ["end"]
    });
    expect(result).toEqual({ ok: true, status: { session_id: "dbg-1", done: false } });
  });

  test("startDebugSession omits breakpoints when none set; passes playbook/input", () => {
    const h = makeHarness();
    h.service.startDebugSession({}, YAML, { playbook: "P", input: { params: { x: 1 } }, maxSteps: 10 });
    h.flush();
    const args = h.calls[0].payload.args;
    expect("breakpoints" in args).toBe(false);
    expect(args.playbook).toBe("P");
    expect(args.input).toEqual({ params: { x: 1 } });
    expect(args.max_steps).toBe(10);
  });

  test("stepDebugSession sends the session id (+ optional branch override)", () => {
    const h = makeHarness();
    h.service.stepDebugSession({}, "dbg-1", { branchChoiceOverride: { d1: "yes" } });
    h.flush();
    expect(h.calls[0].payload.tool).toBe("step_debug_session");
    expect(h.calls[0].payload.args).toEqual({ session_id: "dbg-1", branch_choice_override: { d1: "yes" } });
  });

  test("continueDebugSession merges add_breakpoints / until / max_advance", () => {
    const h = makeHarness();
    h.service.continueDebugSession({}, "dbg-1", { addBreakpoints: ["end"], untilStepId: "mid", maxAdvance: 50 });
    h.flush();
    expect(h.calls[0].payload.tool).toBe("continue_debug_session");
    expect(h.calls[0].payload.args).toEqual({
      session_id: "dbg-1", until_step_id: "mid", add_breakpoints: ["end"], max_advance: 50
    });
  });

  test("stopDebugSession sends just the session id", () => {
    const h = makeHarness();
    h.service.stopDebugSession({}, "dbg-1");
    h.flush();
    expect(h.calls[0].payload.tool).toBe("stop_debug_session");
    expect(h.calls[0].payload.args).toEqual({ session_id: "dbg-1" });
  });
});
