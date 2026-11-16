"use strict";

// A resume transcript is cumulative: the connector replays the pre-approval
// tool_use and appends the fresh tool_result. The replay filter drops the
// tool_use (already committed) and with it the tool NAME, so the surviving
// result rendered through the unpaired fallback as "Used tool tool". The
// filter must carry the trimmed tool_use's name onto the fresh result.

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

const TOOL_ID = "toolu_resume_name_1";
const TOOL_NAME = "mcp_soc__block_indicator";

// First commit: the suspended turn -- the tool_use is on screen, no result yet.
const FIRST = {
  turn: null, contract_version: "2.7.0", stop_reason: "end_turn",
  transcript: [
    { type: "text", text: "Staging the block for approval." },
    { type: "tool_use", id: TOOL_ID, name: TOOL_NAME, display: "{}" }
  ]
};
// Second commit: the cumulative resume -- same tool_use replayed, result fresh.
const SECOND = {
  turn: null, contract_version: "2.7.0", stop_reason: "end_turn",
  transcript: [
    { type: "tool_use", id: TOOL_ID, name: TOOL_NAME, display: "{}" },
    { type: "tool_result", tool_use_id: TOOL_ID, display: "{\"ok\":true}" },
    { type: "text", text: "Approved and executed." }
  ]
};

function makeHarness() {
  let $q, $timeout, $rootScope, $controller;
  let calls = 0;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when(++calls === 1 ? FIRST : SECOND)
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

function send($scope, $timeout, $rootScope, text) {
  $scope.form.inputText = text;
  $scope.sendMessage();
  $rootScope.$apply();
  try { $timeout.flush(); } catch (e) { /* none pending is fine */ }
}

test("the resume's fresh tool_result keeps the trimmed tool_use's name", () => {
  const { $scope, $timeout, $rootScope } = makeHarness();
  send($scope, $timeout, $rootScope, "block it");
  send($scope, $timeout, $rootScope, "approve");

  // The second bubble's surviving tool_result renders as a NAMED chip, not
  // the "Used tool tool" fallback.
  const chips = [];
  $scope.messages.forEach((m) => {
    if (m.role !== "assistant") return;
    (m.events || []).forEach((ev) => {
      if (ev.type === "tool_call") chips.push(ev);
    });
  });
  const resumed = chips.filter((ev) => ev.resultDisplay !== null);
  expect(resumed.length).toBe(1);
  expect(resumed[0].name).toBe(TOOL_NAME);
});
