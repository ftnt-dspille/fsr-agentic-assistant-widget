"use strict";

// ─── Apply-patch controller logic (Track C3 - one-click compiler auto-fixes) ─
//
// validate_yaml/compile_yaml return `corrected_yaml` + `auto_fixes[]` when the
// compiler can mechanically repair known foot-guns. checkAndFix() surfaces that
// as a reviewable before→after patch; applyPatch() swaps it into the YAML pane.
// This covers: the proposal on a fixable YAML, the "clean" acknowledgement when
// there's nothing to fix, hard-error routing to chat, apply swapping currentYaml
// (and clearing stale state via the $watch), and dismiss.

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

const YAML = "playbooks:\n  - name: P\n    steps:\n      - name: Start\n        type: start\n";
const FIXED = "playbooks:\n  - name: P\n    steps:\n      - name: Start\n        type: start\n        next: End\n";

function makeScope(validateImpl) {
  let $q, $timeout, $rootScope, $controller;
  const calls = [];
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "x", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    listSessions: () => $q.when({ sessions: [] }),
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when({ frames: [] }),
    validateYamlLive: (cfg, yaml) => { calls.push(yaml); return validateImpl($q, yaml); }
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
  return { $scope, calls, $timeout, digest: () => $rootScope.$digest() };
}

describe("fsrAgenticAssistant - apply-patch (C3)", () => {
  test("checkAndFix() stages a patch proposal when the compiler returns corrected_yaml", () => {
    const { $scope, digest } = makeScope(($q) => $q.when({
      ok: true, corrected_yaml: FIXED,
      auto_fixes: [{ code: "stop_to_end", line: 5, message: "`stop` → `end`" }],
      auto_fix_note: "adopt corrected_yaml"
    }));
    $scope.checkAndFix();
    digest();
    expect($scope.patchProposal).not.toBeNull();
    expect($scope.patchProposal.correctedYaml).toBe(FIXED);
    expect($scope.patchProposal.autoFixes).toHaveLength(1);
    expect($scope.patchProposal.autoFixes[0].code).toBe("stop_to_end");
    expect($scope.viewState).toBe("idle");
  });

  test("applyPatch() swaps currentYaml to the corrected text and clears the proposal", () => {
    const { $scope, digest } = makeScope(($q) => $q.when({
      ok: true, corrected_yaml: FIXED, auto_fixes: [{ code: "x", message: "m" }]
    }));
    $scope.checkAndFix();
    digest();
    $scope.applyPatch();
    $scope.$digest(); // fire the currentYaml watch
    expect($scope.currentYaml).toBe(FIXED);
    expect($scope.patchProposal).toBeNull();
  });

  test("checkAndFix() flags clean (no proposal) when there is nothing to fix", () => {
    const { $scope, $timeout, digest } = makeScope(($q) => $q.when({ ok: true }));
    $scope.checkAndFix();
    digest();
    expect($scope.patchProposal).toBeNull();
    expect($scope.patchClean).toBe(true);
    $timeout.flush(); // the transient flag auto-clears
    expect($scope.patchClean).toBe(false);
  });

  test("checkAndFix() ignores a corrected_yaml identical to the current text", () => {
    const { $scope, digest } = makeScope(($q) => $q.when({ ok: true, corrected_yaml: YAML, auto_fixes: [] }));
    $scope.checkAndFix();
    digest();
    expect($scope.patchProposal).toBeNull();
    expect($scope.patchClean).toBe(true);
  });

  test("checkAndFix() routes hard validation errors to chat, not a patch", () => {
    const { $scope, digest } = makeScope(($q) => $q.when({ ok: false, errors: [{ code: "bad" }] }));
    $scope.checkAndFix();
    digest();
    expect($scope.patchProposal).toBeNull();
    expect($scope.patchClean).toBe(false);
    const sys = $scope.messages.filter((m) => m.role === "system");
    expect(sys.some((m) => /Validation errors/.test(m.text))).toBe(true);
  });

  test("dismissPatch() drops the proposal without touching the YAML", () => {
    const { $scope, digest } = makeScope(($q) => $q.when({ ok: true, corrected_yaml: FIXED, auto_fixes: [] }));
    $scope.checkAndFix();
    digest();
    $scope.dismissPatch();
    expect($scope.patchProposal).toBeNull();
    expect($scope.currentYaml).toBe(YAML); // unchanged
  });
});
