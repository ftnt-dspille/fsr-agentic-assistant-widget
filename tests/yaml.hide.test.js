"use strict";

// ─── YAML pane hide/show toggle ─────────────────────────────────────────────
//
// Some analysts just want the chat and don't care to watch the YAML build up,
// so the pane can be hidden. This covers the controller side: the gate
// (hasYamlPane), the toggle, and that the preference persists to localStorage
// and is re-read on construction. The DOM wiring (topbar button, pane ng-if,
// topbar Create shortcut) is covered by the e2e spec.

const path = require("path");

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

function makeScope() {
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    listSessions: () => $q.when({ sessions: [] }),
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when({ frames: [] })
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
  return $scope;
}

describe("fsrAgenticAssistant - YAML pane hide/show toggle", () => {
  beforeEach(() => { window.localStorage.removeItem("fsrPbYamlHidden"); });

  test("hasYamlPane() needs authored YAML in build mode AND an editor/handoff context", () => {
    const $scope = makeScope();
    $scope.inPlaybookEditor = true;                    // designer context
    $scope.uiIntent = "build";
    $scope.currentYaml = "";
    expect($scope.hasYamlPane()).toBe(false);          // no yaml yet
    $scope.currentYaml = "playbooks:\n  - name: x";
    expect($scope.hasYamlPane()).toBe(true);           // yaml + build + editor
    $scope.uiIntent = "triage";
    expect($scope.hasYamlPane()).toBe(false);          // triage hides it regardless
  });

  test("hasYamlPane() is FALSE over a record with no handoff (build is editor-only)", () => {
    const $scope = makeScope();
    $scope.inPlaybookEditor = false;                   // mounted over a module/record
    $scope._buildHandoffActive = false;
    $scope.uiIntent = "build";
    $scope.currentYaml = "playbooks:\n  - name: x";
    expect($scope.hasYamlPane()).toBe(false);          // build UI must not leak onto a record
  });

  test("hasYamlPane() unlocks over a record once the triage→playbook handoff fires", () => {
    const $scope = makeScope();
    $scope.inPlaybookEditor = false;                   // over a record
    $scope._buildHandoffActive = true;                 // analyst clicked "Ready to automate this?"
    $scope.uiIntent = "build";
    $scope.currentYaml = "playbooks:\n  - name: x";
    expect($scope.hasYamlPane()).toBe(true);
  });

  test("defaults to visible, toggles, and persists the preference", () => {
    const $scope = makeScope();
    expect($scope.yamlHidden).toBe(false);

    $scope.toggleYamlHidden();
    expect($scope.yamlHidden).toBe(true);
    expect(window.localStorage.getItem("fsrPbYamlHidden")).toBe("1");

    $scope.toggleYamlHidden();
    expect($scope.yamlHidden).toBe(false);
    expect(window.localStorage.getItem("fsrPbYamlHidden")).toBe("0");
  });

  test("a persisted '1' is re-read as hidden on construction", () => {
    window.localStorage.setItem("fsrPbYamlHidden", "1");
    const $scope = makeScope();
    expect($scope.yamlHidden).toBe(true);
  });
});
