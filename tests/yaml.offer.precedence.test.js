"use strict";

// ─── A verified playbook_offer outranks a prose ```yaml fence ─────────────────
//
// The turn's YAML loader already let an enhancement_offer's `final_yaml` outrank the
// model's prose fences, but not a playbook_offer's. Found on deepseek (sweep row
// build_plain_request_no_record): the model verified and offered a complete
// playbook, then closed with an illustrative ```yaml snippet -- a bare step
// list. The scrape put the SNIPPET in `currentYaml`, which is what Save
// compiles, so the analyst would save the snippet over the verified draft.

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

function makeHarness(transcript, stopReason) {
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    // MOCK mode → blocking chat_turn return path (_loadTurnYaml runs on it).
    modeInfo: () => ({ mode: "mock", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when({
      turn: 1, contract_version: "2.8.0", stop_reason: stopReason || "end_turn",
      transcript: transcript || []
    }),
    pushPlaybook: () => $q.when({ ok: true, workflow_uuids: ["wf-1"] }),
    updatePlaybook: () => $q.when({ ok: true, workflow_uuid: "wf-1" })
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
  return { $scope, $timeout, $rootScope };
}

function drive({ $scope, $timeout, $rootScope }) {
  $scope.form.inputText = "build it";
  $scope.sendMessage();
  $rootScope.$apply();
  try { $timeout.flush(); } catch (e) { /* no pending timeout is fine */ }
  return $scope;
}

const VERIFIED = [
  "collection: 00 - FSR Studio",
  "playbooks:",
  "- name: Email Open Incidents",
  "  steps:",
  "  - {type: start, name: Start, next: Find Incidents}",
  "  - {type: find_record, name: Find Incidents, module: incidents}",
].join("\n");

const SNIPPET = [
  "- name: Send Summary",
  "  type: connector",
  "  next: '...'",
].join("\n");

const text = (t) => ({ type: "text", text: t });
const offer = (over) => Object.assign(
  { type: "playbook_offer", id: "offer-1", summary: "Save it?", final_yaml: VERIFIED }, over);

describe("YAML precedence: verified playbook_offer vs prose fences", () => {
  test("a snippet fence AFTER the offer does not replace the verified draft", () => {
    const $scope = drive(makeHarness([
      text("Verified. Here is the offer."),
      offer(),
      text("For reference, the email step looks like:\n\n```yaml\n" + SNIPPET + "\n```\n"),
    ], "awaiting_playbook_offer"));
    expect($scope.currentYaml).toBe(VERIFIED);
    expect($scope.currentYaml).not.toContain("'...'");
  });

  // Only a verified offer loads a playbook. A fence is text the model typed;
  // Save compiles `currentYaml` over the open record, so a fence that loaded
  // itself let a question ("what's the impact of removing this step?",
  // answered with a whole playbook) replace the analyst's open playbook.
  test("a fence-only turn loads nothing; the fence is held behind the notice", () => {
    const h = makeHarness([text("```yaml\n" + VERIFIED + "\n```\n")]);
    h.$scope.currentYaml = "playbooks:\n- name: Open playbook\n";
    const $scope = drive(h);
    expect($scope.currentYaml).toBe("playbooks:\n- name: Open playbook\n");
    expect($scope.withheldYaml).toBe(VERIFIED);
    expect($scope.withheldReason).toBe("unverified");
  });

  test("a fence that matches the open playbook raises no notice", () => {
    const h = makeHarness([text("```yaml\n" + VERIFIED + "\n```\n")]);
    h.$scope.currentYaml = VERIFIED;
    const $scope = drive(h);
    expect($scope.currentYaml).toBe(VERIFIED);
    expect($scope.withheldYaml).toBeFalsy();
  });

  test("a trace-built offer (no final_yaml) loads nothing from the fence", () => {
    // Its accept compiles the recorded trace, so the pane has nothing to load.
    const $scope = drive(makeHarness([
      text("```yaml\n" + VERIFIED + "\n```\n"),
      offer({ final_yaml: undefined, ops_summary: [{ label: "Find", verified: true }] }),
    ], "awaiting_playbook_offer"));
    expect($scope.currentYaml).toBeFalsy();
    expect($scope.withheldYaml).toBe(VERIFIED);
  });

  test("a verified enhancement_offer loads its bytes and clears a stale notice", () => {
    const h = makeHarness([
      text("```yaml\n" + SNIPPET + "\n```\n"),
      { type: "enhancement_offer", id: "e1", summary: "Apply?", final_yaml: VERIFIED },
    ], "awaiting_enhancement_offer");
    h.$scope.withheldYaml = "playbooks: []\n";
    const $scope = drive(h);
    expect($scope.currentYaml).toBe(VERIFIED);
    expect($scope.withheldYaml).toBeNull();
  });
});
