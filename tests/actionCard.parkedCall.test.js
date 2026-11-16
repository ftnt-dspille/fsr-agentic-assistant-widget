"use strict";

// A record write parks its tool call on an action card. That call never gets a
// result of its own: on approve the write runs as a separate call. Live, the
// parked row read "Updated the record / running" before the decision and went
// back to it after, forever. And the approved card's receipt printed the raw
// args: "Severity /api/3/picklists/<uuid>" under the "High -> Low" row.

global.jasmine = global.jasmine || {}; // angular-mocks lifecycle gate (before requires)
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
const R = window.FsrPbRender; // eslint-disable-line no-undef
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };
const PICK = "/api/3/picklists/58d0753f-f7e4-403b-953c-b0f521eab759";

function boot() {
  let $q, $rootScope, $controller, $timeout;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when({ ok: true, stop_reason: "end_turn", transcript: [] }),
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

function parked() {
  const msg = R.buildAssistantMessage([
    { type: "tool_use", id: "tu-1", name: "update_record", input: {} },
    { type: "action_card", id: "card-1", connector: "", operation: "", preceding_tool_use_id: "tu-1",
      summary: "Update alert: Beacon", args: { severity: PICK, note: PICK },
      editable_fields: ["severity", "note"],
      target: { module: "alerts", module_label: "Alert", name: "Beacon" },
      changes: [{ field: "severity", before: "High", after: "Low" }] },
  ], OPTS);
  return { msg, call: msg.events.find((e) => e.type === "tool_call"),
           card: msg.events.find((e) => e.type === "action_card") };
}

describe("a parked call follows its card's decision", () => {
  test("undecided -> 'awaiting', approved -> 'approve', cancelled -> 'reject'", () => {
    const $scope = boot();
    const { msg, call, card } = parked();
    expect($scope.toolCardDecision(call, msg)).toBe("awaiting");
    expect($scope.toolDecisionChip("awaiting")).toBe("needs approval");
    card._resolved = true; card._outcome = "approve";
    expect($scope.toolCardDecision(call, msg)).toBe("approve");
    expect($scope.toolDecisionChip("approve")).toBe("approved");
    card._outcome = "reject";
    expect($scope.toolCardDecision(call, msg)).toBe("reject");
    expect($scope.toolDecisionChip("reject")).toBe("cancelled");
  });

  test("a call with a real result, or with no card, renders as before", () => {
    const $scope = boot();
    const { msg, call } = parked();
    call.resultStatus = "success";
    expect($scope.toolCardDecision(call, msg)).toBe("");
    const loose = { type: "tool_call", resultStatus: "pending" };
    expect($scope.toolCardDecision(loose, msg)).toBe("");
  });
});

describe("the approved card's receipt prints no IRI", () => {
  test("a field shown as a change is not repeated; any other IRI says what it is", () => {
    const { card } = parked();
    const rows = R.actionCardArgSummary(card, card.args);
    expect(rows.map((r) => r.name)).toEqual(["note"]);
    expect(rows[0].value).toBe("an unknown picklist option");
    expect(JSON.stringify(rows)).not.toContain("/api/3/");
  });
});
