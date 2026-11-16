"use strict";

// ─── Build intent must not outlive its conversation ─────────────────────────
//
// `uiIntent` decides which system prompt AND which tool slice the connector
// advertises. The build slice drops the entire triage toolset (get_record,
// update_record, run_op, siem_*, faz_* -- see the connector's
// fsr_soc_triage/registry.py, which adds those to TRIAGE_ONLY_TOOLS). So an
// agent left in `build` over an alert literally cannot read or edit the record
// in front of it.
//
// The triage→playbook handoff latches `build`, and there is deliberately no
// manual toggle back. That made every "start a fresh conversation" path the
// only escape -- and they reset `_buildHandoffActive` while leaving `uiIntent`
// latched. LIVE REPRO (session sess-v6uv6x15): after saving a playbook from a
// triage handoff, "change the type of the alert" made ZERO tool calls and was
// answered as playbook authoring ("I need to see your currently open playbook
// YAML..."). A new conversation did not clear it; only navigating to a
// different record did.
//
// A fresh conversation therefore always returns to the MOUNT default: build in
// the playbook designer, triage everywhere else (record, persona mount,
// dashboard).

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

function makeScope(opts) {
  opts = opts || {};
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "x", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    listSessions: () => $q.when({ sessions: [] }),
    // Never resolves: the handoff fires a turn we don't care about here, and
    // leaving it in flight keeps the test focused on the intent latch.
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when({ frames: [] })
  };
  const stateForMount = opts.record
    ? { current: { name: "viewPanel.modulesDetail" }, params: { module: opts.record.module, id: opts.record.id } }
    : { current: { name: opts.inPlaybookEditor ? "main.playbookDetail" : "main.dashboard" }, params: { id: "wf-9" } };
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", agentStub);
    $provide.value("config", opts.record ? { seedFromEntity: false } : {});
    $provide.value("$state", stateForMount);
  });
  let $httpBackend;
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_, _$httpBackend_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $q = _$q_; $timeout = _$timeout_;
    $httpBackend = _$httpBackend_;
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

// Drive the REAL earned handoff rather than assigning uiIntent by hand, so the
// test breaks if the entry path changes shape. canBuildFromTriage() requires a
// conversation at rest that actually used a tool.
function takeBuildHandoff($scope) {
  $scope.messages = [{ role: "assistant", events: [{ type: "tool_call", name: "get_record" }] }];
  $scope.viewState = "idle";
  expect($scope.canBuildFromTriage()).toBe(true);
  $scope.buildPlaybookFromTriage();
  expect($scope.uiIntent).toBe("build");   // latched
  expect($scope._buildHandoffActive).toBe(true);
}

describe("fsrAgenticAssistant -- build intent is per-conversation, not sticky", () => {
  beforeEach(() => { window.localStorage.clear(); });

  test("+ New over an alert drops build back to triage (regression: it did not)", () => {
    const $scope = makeScope({ record: { module: "alerts", id: "aaa-1" } });
    expect($scope.uiIntent).toBe("triage");
    takeBuildHandoff($scope);

    $scope.newConversation();

    expect($scope.uiIntent).toBe("triage");
    expect($scope._buildHandoffActive).toBe(false);
  });

  test("the fresh thread is filed under the record key, intent-agnostic", () => {
    // The session key is record/page-scoped now (one thread per record), so a
    // build handoff then + New files the fresh conversation under the record's
    // own key -- never a separate build bucket.
    const $scope = makeScope({ record: { module: "alerts", id: "aaa-1" } });
    takeBuildHandoff($scope);
    $scope.newConversation();

    const iri = "/api/3/alerts/aaa-1";
    const probe = window.__agenticAssistant__;
    expect(window.localStorage.getItem("fsrPbSession:" + iri)).toBe(probe.sessionId);
    expect(window.localStorage.getItem("fsrPbSession:build")).toBeNull();
  });

  test("switching to a stored session also clears a stale build latch", () => {
    const $scope = makeScope({ record: { module: "alerts", id: "aaa-1" } });
    takeBuildHandoff($scope);

    $scope.loadSession("some-other-thread");

    expect($scope.uiIntent).toBe("triage");
    expect($scope._buildHandoffActive).toBe(false);
  });

  test("in the playbook designer, + New stays in build -- that IS the mount default", () => {
    const $scope = makeScope({ inPlaybookEditor: true });
    expect($scope.uiIntent).toBe("build");

    $scope.newConversation();

    expect($scope.uiIntent).toBe("build");
  });

  test("a dashboard mount that took the handoff resets to triage on + New", () => {
    const $scope = makeScope({});
    takeBuildHandoff($scope);
    $scope.newConversation();
    expect($scope.uiIntent).toBe("triage");
  });
});
