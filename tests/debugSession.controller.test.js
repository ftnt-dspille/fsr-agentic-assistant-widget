"use strict";

// ─── Interactive debug-session controller logic (Track C3 debug drawer) ──────
//
// A stateful walker on the connector: startDebug → step/continue → stop, driven
// by the status snapshot {session_id, paused_at, steps_advanced, done, trace[],
// first_error, breakpoints[]}. This covers: open/close, start capturing the
// session id, step/continue applying status, breakpoint toggling + wiring onto
// start/continue, the done gate, error handling, and stale-session teardown on
// a YAML change.

global.jasmine = global.jasmine || {};
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef

require("../widget/widgetAssets/js/fsrPbRender.js");
require("../widget/view.controller.js");
require("../widget/widgetAssets/js/fsrPbCards.service.js");
require("../widget/widgetAssets/js/fsrPbTranscript.service.js");
require("../widget/widgetAssets/js/fsrPbEntityCards.service.js");
require("../widget/widgetAssets/js/fsrPbHtml.service.js");
require("../widget/widgetAssets/js/fsrPbYaml.service.js");
require("../widget/widgetAssets/js/fsrPbExport.service.js");
require("../widget/widgetAssets/js/fsrPbMarkdown.service.js");

const widgetInfo = require("../widget/info.json");
const viewCtrlName = `${widgetInfo.name}${widgetInfo.version.replace(/\./g, "")}DevCtrl`;
const ng = window.angular; // eslint-disable-line no-undef

const YAML = "playbooks:\n  - name: P\n    steps:\n      - name: Start\n        type: start\n        next: End\n      - name: End\n        type: end\n";

function status(over) {
  return Object.assign({
    session_id: "dbg-1", playbook: "P", done: false, paused_at: "start",
    steps_advanced: 0, trace_len: 0, first_error: null, breakpoints: [], trace: []
  }, over || {});
}

function makeScope(impls) {
  let $q, $timeout, $rootScope, $controller;
  const calls = [];
  const rec = (name) => (cfg, sessionId, opts) => {
    calls.push({ name, sessionId, opts });
    return (impls[name] || (($q2) => $q2.when({ ok: true, status: status() })))($q, opts);
  };
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "x", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    listSessions: () => $q.when({ sessions: [] }),
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when({ frames: [] }),
    startDebugSession: (cfg, yaml, opts) => { calls.push({ name: "start", opts }); return (impls.start || (($q2) => $q2.when({ ok: true, status: status() })))($q, opts); },
    stepDebugSession: rec("step"),
    continueDebugSession: rec("continue"),
    stopDebugSession: (cfg, sid) => { calls.push({ name: "stop", sessionId: sid }); return (impls.stop || (($q2) => $q2.when({ ok: true, status: status({ done: true }) })))($q); }
  };
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", agentStub);
    $provide.value("config", {});
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $q = _$q_; $timeout = _$timeout_;
  });
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  $scope.currentYaml = YAML;
  $scope.$digest();
  return { $scope, calls, digest: () => $rootScope.$digest() };
}

describe("fsrAgenticAssistant - interactive debug session (C3)", () => {
  test("openDebug activates the panel; startDebug captures the session id + status", () => {
    const { $scope, calls, digest } = makeScope({
      start: ($q) => $q.when({ ok: true, status: status({ session_id: "dbg-abc", paused_at: "start" }) })
    });
    $scope.openDebug();
    expect($scope.debug.active).toBe(true);
    $scope.startDebug();
    expect($scope.debug.busy).toBe(true);
    digest();
    expect($scope.debug.busy).toBe(false);
    expect($scope.debug.sessionId).toBe("dbg-abc");
    expect($scope.debug.status.paused_at).toBe("start");
    expect(calls[0].name).toBe("start");
  });

  test("startDebug passes the toggled breakpoints; continue re-sends them", () => {
    const { $scope, calls, digest } = makeScope({});
    $scope.openDebug();
    $scope.toggleBreakpoint("end");
    $scope.startDebug();
    digest();
    expect(calls.find((c) => c.name === "start").opts.breakpoints).toEqual(["end"]);
    $scope.debugContinue();
    digest();
    expect(calls.find((c) => c.name === "continue").opts.addBreakpoints).toEqual(["end"]);
  });

  test("debugStep applies the returned status and exposes the trace", () => {
    const { $scope, digest } = makeScope({
      start: ($q) => $q.when({ ok: true, status: status() }),
      step: ($q) => $q.when({ ok: true, status: status({
        steps_advanced: 1, paused_at: "end",
        trace: [{ step_id: "start", name: "Start", type: "start", status: "simulated", output_top_keys: [] }]
      }) })
    });
    $scope.openDebug(); $scope.startDebug(); digest();
    $scope.debugStep(); digest();
    expect($scope.debug.status.steps_advanced).toBe(1);
    expect($scope.debugTrace()).toHaveLength(1);
    expect($scope.debugTrace()[0].step_id).toBe("start");
  });

  test("debugDone() reflects the terminal status", () => {
    const { $scope, digest } = makeScope({
      start: ($q) => $q.when({ ok: true, status: status() }),
      continue: ($q) => $q.when({ ok: true, status: status({ done: true, paused_at: null, steps_advanced: 2 }) })
    });
    $scope.openDebug(); $scope.startDebug(); digest();
    expect($scope.debugDone()).toBe(false);
    $scope.debugContinue(); digest();
    expect($scope.debugDone()).toBe(true);
  });

  test("an ok:false response surfaces the error and does not crash", () => {
    const { $scope, digest } = makeScope({
      start: ($q) => $q.when({ ok: false, error: "yaml parse failed" })
    });
    $scope.openDebug(); $scope.startDebug(); digest();
    expect($scope.debug.error).toBe("yaml parse failed");
    expect($scope.debug.sessionId).toBeNull();
  });

  test("a rejected op records the error and clears busy", () => {
    const { $scope, digest } = makeScope({
      start: ($q) => $q.reject({ message: "connector down" })
    });
    $scope.openDebug(); $scope.startDebug(); digest();
    expect($scope.debug.busy).toBe(false);
    expect($scope.debug.error).toBe("connector down");
  });

  test("stopDebug drops the session id and calls the connector", () => {
    const { $scope, calls, digest } = makeScope({});
    $scope.openDebug(); $scope.startDebug(); digest();
    const sid = $scope.debug.sessionId;
    $scope.stopDebug(); digest();
    expect($scope.debug.sessionId).toBeNull();
    expect(calls.some((c) => c.name === "stop" && c.sessionId === sid)).toBe(true);
  });

  test("changing the YAML tears down a live session and resets the snapshot", () => {
    const { $scope, calls, digest } = makeScope({});
    $scope.openDebug(); $scope.startDebug(); digest();
    expect($scope.debug.sessionId).not.toBeNull();
    $scope.currentYaml = YAML + "\n# edit";
    $scope.$digest(); // fire the currentYaml watch
    expect($scope.debug.sessionId).toBeNull();
    expect($scope.debug.status).toBeNull();
    expect(calls.some((c) => c.name === "stop")).toBe(true);
  });

  test("debugStep is a no-op without a live session", () => {
    const { $scope, calls } = makeScope({});
    $scope.openDebug();
    $scope.debugStep(); // no session yet
    expect(calls.some((c) => c.name === "step")).toBe(false);
  });
});
