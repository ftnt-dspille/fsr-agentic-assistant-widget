"use strict";

// ─── The "Ready to automate this?" handoff belongs on a SOC record ──────────
//
// `uiIntent` defaults to 'triage' on EVERY non-editor mount, so intent alone
// never distinguished "triaging an alert" from "looking at a device record":
// the ⚒ Build playbook CTA appeared on ANY module as soon as the agent ran one
// tool. On a ztpf device / template / custom module the analyst asked to list
// steps, not to author automation - two thumbs-down .206 sessions were exactly
// that shape.
//
// Gate: the mounted module must be an alert / case / war room. FortiSOAR 8.0
// renames the `incidents` module's DISPLAY label to "Cases" (same module type,
// verified live), so 'incidents' covers "case".

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

// The REAL predicate from the service, so this test and production share one
// definition (a hand-written copy here would pass while the widget shipped
// broken).
const TRIAGE_MODULES = ["alerts", "incidents", "warrooms"];
function isTriageModule(module) {
  if (!module || typeof module !== "string") return false;
  return TRIAGE_MODULES.indexOf(module.trim()) !== -1;
}

function makeScope(opts) {
  opts = opts || {};
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "connector-fsr-agentic-assistant",
    resolveConnector: () => $q.when({ name: "x", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    listSessions: () => $q.when({ sessions: [] }),
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when({ frames: [] }),
    resolvePersona: () => $q.when(null),
    isTriageModule: opts.omitPredicate ? undefined : isTriageModule
  };
  const stateForMount = opts.record
    ? { current: { name: "viewPanel.modulesDetail" },
        params: { module: opts.record.module, id: opts.record.id } }
    : { current: { name: opts.inPlaybookEditor ? "main.playbookDetail" : "main.dashboard" },
        params: { id: "wf-9" } };
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", agentStub);
    $provide.value("config", opts.record ? { seedFromEntity: false } : {});
    $provide.value("$state", stateForMount);
  });
  let $httpBackend;
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_, _$httpBackend_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $q = _$q_;
    $timeout = _$timeout_; $httpBackend = _$httpBackend_;
  });
  if (opts.inPlaybookEditor) {
    $httpBackend.whenGET(/\/api\/3\/workflows\/wf-9/).respond(200, {
      "@id": "/api/3/workflows/wf-9", uuid: "wf-9", name: "Open PB", steps: []
    });
  }
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  if (opts.inPlaybookEditor) $httpBackend.flush();
  return $scope;
}

// A conversation at rest that actually used a tool - every other precondition
// canBuildFromTriage() checks, so the module is the only variable.
function atRestAfterATool($scope) {
  $scope.messages = [{ role: "assistant", events: [{ type: "tool_call", name: "get_record" }] }];
  $scope.viewState = "idle";
}

describe("fsrAgenticAssistant - build handoff only on alert/case/war-room records", () => {
  beforeEach(() => { window.localStorage.clear(); });

  test.each(["alerts", "incidents", "warrooms"])(
    "offers the handoff on a %s record", (module) => {
      const $scope = makeScope({ record: { module, id: "rec-1" } });
      atRestAfterATool($scope);
      expect($scope.onTriageRecordPage()).toBe(true);
      expect($scope.canBuildFromTriage()).toBe(true);
    });

  test.each([
    "ztpf_devices",
    "ztpf_device_automation_steps",
    "ztpf_templates",
    "assets",
    "indicators"
  ])("stays silent on a %s record (the live defect)", (module) => {
    const $scope = makeScope({ record: { module, id: "rec-1" } });
    atRestAfterATool($scope);
    expect($scope.onTriageRecordPage()).toBe(false);
    expect($scope.canBuildFromTriage()).toBe(false);
  });

  test("8.0 'Cases' is the incidents module, so it is covered", () => {
    // Nothing to special-case: the rename is display-only. This pins the
    // reasoning so nobody adds a dead 'cases' key later.
    expect(isTriageModule("cases")).toBe(false);
    const $scope = makeScope({ record: { module: "incidents", id: "c-1" } });
    atRestAfterATool($scope);
    expect($scope.canBuildFromTriage()).toBe(true);
  });

  test("a dashboard mount (no record) gets no handoff", () => {
    const $scope = makeScope({});
    atRestAfterATool($scope);
    expect($scope.onTriageRecordPage()).toBe(false);
    expect($scope.canBuildFromTriage()).toBe(false);
  });

  test("the playbook designer gets no record handoff - it owns build framing", () => {
    const $scope = makeScope({ inPlaybookEditor: true });
    expect($scope.onTriageRecordPage()).toBe(false);
  });

  test("the module gate does not override the other preconditions", () => {
    // On an alert, but nothing ran yet: still no CTA. Guards against the gate
    // being read as "on an alert, always offer".
    const $scope = makeScope({ record: { module: "alerts", id: "a-1" } });
    $scope.messages = [{ role: "user", events: [] }];
    $scope.viewState = "idle";
    expect($scope.onTriageRecordPage()).toBe(true);
    expect($scope.canBuildFromTriage()).toBe(false);
  });

  test("a persona mount on an alert still suppresses the SOC handoff", () => {
    const $scope = makeScope({ record: { module: "alerts", id: "a-1" } });
    atRestAfterATool($scope);
    $scope.personaUi = { label: "Custom" };
    expect($scope.canBuildFromTriage()).toBe(false);
  });

  test("a service without the predicate keeps the previous behavior", () => {
    // Fail-open on purpose: an older/mocked service must not silently hide the
    // handoff on every page. Production ships both halves together.
    const $scope = makeScope({ record: { module: "ztpf_devices", id: "d-1" },
                               omitPredicate: true });
    atRestAfterATool($scope);
    expect($scope.onTriageRecordPage()).toBe(true);
  });
});

describe("the real service exposes the predicate the controller calls", () => {
  test("isTriageModule + triageRecordModules are on the service API", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../widget/widgetAssets/js/fsrPbAgent.service.js"),
      "utf8");
    // The controller's fallback branch means a missing export would NOT fail any
    // behavioral test - it would just silently restore the old noisy CTA. Assert
    // the export directly.
    expect(src).toMatch(/isTriageModule:\s*isTriageModule/);
    expect(src).toMatch(/triageRecordModules:\s*TRIAGE_RECORD_MODULES/);
    // …and that the list itself is what the connector considers triage.
    const m = src.match(/var TRIAGE_RECORD_MODULES = \[([^\]]*)\]/);
    expect(m).toBeTruthy();
    const listed = m[1].split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean);
    expect(listed.sort()).toEqual(TRIAGE_MODULES.slice().sort());
  });
});
