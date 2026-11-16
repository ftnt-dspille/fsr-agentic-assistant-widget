"use strict";

// ─── Assistant-message dedup keyed on tool_use id (Phase 1.2) ───────────────
//
// HIGH / audit integrity: the turn-level idempotency guard (_committedTurns)
// only fires when result.turn != null. A null-turn transcript - or a poll
// terminal racing a late chat_turn return - slips past it and re-renders the
// whole turn, DOUBLE-COUNTING every tool call in export & audit. A tool_use id
// is globally unique, so committing a transcript whose id is already on the
// timeline is provably a re-commit and must be dropped.

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

// A transcript with a tool call carrying a stable, globally-unique id, and
// turn:null so the turn-level idempotency guard cannot catch the re-commit.
const TOOL_ID = "toolu_dedup_1";
function turnResult() {
  return {
    turn: null, contract_version: "2.7.0", stop_reason: "end_turn",
    transcript: [
      { type: "text", text: "Looking that up." },
      { type: "tool_use", id: TOOL_ID, name: "get_record", display: "{}" },
      { type: "tool_result", tool_use_id: TOOL_ID, name: "get_record", display: "{\"ok\":true}" }
    ]
  };
}

function makeHarness() {
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when(turnResult())
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

function send($scope, $timeout, $rootScope) {
  $scope.form.inputText = "look it up";
  $scope.sendMessage();
  $rootScope.$apply();
  try { $timeout.flush(); } catch (e) { /* none pending is fine */ }
}

test("a re-committed transcript (same tool_use id, null turn) renders only once", () => {
  const { $scope, $timeout, $rootScope } = makeHarness();
  send($scope, $timeout, $rootScope);
  send($scope, $timeout, $rootScope);

  const assistantWithTool = $scope.messages.filter((m) =>
    m.role === "assistant" && JSON.stringify(m).includes(TOOL_ID));
  expect(assistantWithTool.length).toBe(1); // not 2 - the second commit was deduped
});
