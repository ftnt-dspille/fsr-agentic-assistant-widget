"use strict";

// ─── Robust YAML-fence extraction + fail-closed save guard (Phase 1.1) ──────
//
// HIGH / data corruption: the old extractor `/```ya?ml\s*\n([\s\S]*?)```/`
// used a NON-GREEDY body that stopped at the FIRST ``` anywhere in the text.
// A ``` that appears INSIDE the playbook YAML - mid-line in a quoted string, a
// description field, an embedded example block - clipped the fence. Save then
// compiled the clipped copy OVER the real record and every step past the clip
// was silently DELETED.
//
// Fix: the closing fence must be LINE-ANCHORED (its own line), so an inline ```
// can't end the block; plus a stateless save-time guard refuses to persist YAML
// that still contains a standalone ``` marker.

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

function makeHarness(transcript) {
  let $q, $timeout, $rootScope, $controller;
  const pushSpy = jest.fn();
  const updateSpy = jest.fn();
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    // MOCK mode → blocking chat_turn return path (_handleTurnResult runs
    // _loadTurnYaml on the transcript; no detached/poll indirection).
    modeInfo: () => ({ mode: "mock", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when({
      turn: 1, contract_version: "2.7.0", stop_reason: "end_turn",
      transcript: transcript || []
    }),
    pushPlaybook: (...a) => { pushSpy(...a); return $q.when({ ok: true, workflow_uuids: ["wf-1"] }); },
    updatePlaybook: (...a) => { updateSpy(...a); return $q.when({ ok: true, workflow_uuid: "wf-1" }); }
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
  return { $scope, $timeout, $rootScope, pushSpy, updateSpy };
}

function textEvent(text) { return { type: "text", text: text }; }

function drive($scope, $timeout, $rootScope) {
  $scope.form.inputText = "build it";
  $scope.sendMessage();
  $rootScope.$apply();
  try { $timeout.flush(); } catch (e) { /* no pending timeout is fine */ }
}

// A reply-text fence never loads into currentYaml (only a verified offer
// does), but it is still extracted for the "Load it anyway" notice, so a
// clipped extraction would hand the analyst half a playbook there.
describe("robust YAML-fence extraction", () => {
  test("an inline ``` inside a YAML string does NOT clip the playbook", () => {
    // The description value contains a ``` mid-line; the OLD extractor clipped
    // here and dropped the second step.
    const yaml = [
      "playbooks:",
      "  - name: Enrich and block",
      "    steps:",
      '      - name: Note',
      '        description: "see the ``` example in the runbook"',
      "      - name: Block IP",
      "        connector: fortigate"
    ].join("\n");
    const { $scope, $timeout, $rootScope } = makeHarness([
      textEvent("Here is the playbook:\n\n```yaml\n" + yaml + "\n```\n")
    ]);
    drive($scope, $timeout, $rootScope);
    expect($scope.withheldYaml).toContain("Block IP");       // step past the inline ``` survived
    expect($scope.withheldYaml).toContain("connector: fortigate");
    expect($scope.withheldYaml).toContain("Enrich and block");
  });

  test("the LAST line-anchored fence wins across multiple blocks", () => {
    const { $scope, $timeout, $rootScope } = makeHarness([
      textEvent("draft one:\n```yaml\nplaybooks:\n  - name: OLD\n```\n" +
                "revised:\n```yaml\nplaybooks:\n  - name: NEW\n```\n")
    ]);
    drive($scope, $timeout, $rootScope);
    expect($scope.withheldYaml).toContain("name: NEW");
    expect($scope.withheldYaml).not.toContain("name: OLD");
  });
});

describe("fail-closed save guard", () => {
  test("pushPlaybook REFUSES YAML that still holds a standalone ``` fence line", () => {
    const { $scope, pushSpy, updateSpy } = makeHarness([]);
    // A truncation artifact: a stray closing fence left in the buffer.
    $scope.currentYaml = "playbooks:\n  - name: Partial\n```\nleftover";
    $scope.viewState = "idle";
    $scope.pushPlaybook();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    const blocked = $scope.messages.some((m) =>
      /Save blocked/i.test(JSON.stringify(m)));
    expect(blocked).toBe(true);
  });

  test("clean YAML saves normally", () => {
    const { $scope, pushSpy } = makeHarness([]);
    $scope.currentYaml = "playbooks:\n  - name: Clean\n    steps: []";
    $scope.viewState = "idle";
    $scope.pushPlaybook();
    expect(pushSpy).toHaveBeenCalled();
  });
});
