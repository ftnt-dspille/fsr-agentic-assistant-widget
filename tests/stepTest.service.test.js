"use strict";

// ─── stepTest service method (Track C3 — per-step Verify probe) ──────────────
//
// fsrPbAgentService.stepTest(cfg, yaml, stepId, opts) drives the connector's
// generic `call_mcp_tool` seam with tool="step_test", so the widget's Verify
// tab can probe a single step (render its args + execute safe ops) without the
// full AI chat loop. It is ALWAYS live (a probe against the mock track renders
// nothing meaningful), so it routes through _executeReal → the resolved
// connector. This asserts the dispatch shape, arg defaults/overrides, the
// confirm→needs_confirm gate wiring, and envelope unwrapping.

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
    // Echo a SOAR execute envelope so the service's _unwrapEnvelope returns .data.
    executeConnectorAction: function (name, version, action, configId, payload) {
      calls.push({ name, version, action, configId, payload });
      return _$q.when({
        operation: action,
        status: "Success",
        message: "",
        data: { ok: true, step_id: payload.args && payload.args.step_id, status: "rendered" }
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

  // _resolveConnector queries the connector list; answer with our connector +
  // the preferred live config so the dispatch resolves name/version/configId.
  $httpBackend.whenGET(/\/api\/integration\/connectors\/\?search=/).respond(200, {
    data: [{
      name: CONNECTOR_NAME,
      version: "9.9.9",
      configuration: [{ name: "fsrpb-live", config_id: "cfg-live", default: true }]
    }]
  });

  return {
    service, calls, $rootScope,
    flush: () => { $httpBackend.flush(); $rootScope.$digest(); }
  };
}

const YAML = "playbooks:\n  - name: P\n    steps:\n      - name: Start\n        type: start\n        next: End\n      - name: End\n        type: end\n";

describe("fsrPbAgentService.stepTest", () => {
  test("dispatches call_mcp_tool(step_test) to the live connector with default args", () => {
    const h = makeHarness();
    let result;
    h.service.stepTest({}, YAML, "start").then((r) => { result = r; });
    h.flush();

    expect(h.calls.length).toBe(1);
    const c = h.calls[0];
    expect(c.name).toBe(CONNECTOR_NAME);
    expect(c.version).toBe("9.9.9");
    expect(c.configId).toBe("cfg-live");
    expect(c.action).toBe("call_mcp_tool");
    expect(c.payload.tool).toBe("step_test");
    expect(c.payload.args).toEqual({
      yaml_text: YAML,
      step_id: "start",
      execute_safe_ops: true, // defaults on
      confirm: false          // defaults off (non-safe ops gate to needs_confirm)
    });
    // Envelope unwrapped to the bare tool payload.
    expect(result).toEqual({ ok: true, step_id: "start", status: "rendered" });
  });

  test("opts override execute_safe_ops / confirm and pass playbook + input through", () => {
    const h = makeHarness();
    h.service.stepTest({}, YAML, "get_alert", {
      executeSafeOps: false,
      confirm: true,
      playbook: "P",
      input: { params: { id: "42" } }
    });
    h.flush();

    const args = h.calls[0].payload.args;
    expect(args.execute_safe_ops).toBe(false);
    expect(args.confirm).toBe(true);
    expect(args.playbook).toBe("P");
    expect(args.input).toEqual({ params: { id: "42" } });
  });

  test("omits playbook/input when not supplied (no undefined keys leak to the wire)", () => {
    const h = makeHarness();
    h.service.stepTest({}, YAML, "start");
    h.flush();

    const args = h.calls[0].payload.args;
    expect("playbook" in args).toBe(false);
    expect("input" in args).toBe(false);
  });
});
