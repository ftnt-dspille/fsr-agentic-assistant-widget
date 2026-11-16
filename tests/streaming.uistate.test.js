"use strict";

// ─── Fix 1: preserve tool open/collapse state across streaming polls ────────
//
// _absorbPoll rebuilds streamingMessage every poll; the renderer reseeds each
// tool_call to collapsed. _mergeUiState must carry the analyst's expand choice
// forward so a tool they opened doesn't snap shut on the next 700ms poll.

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

// Tool tu1 appears in poll #1 and stays pending through poll #2 (no done yet),
// so the preview is rebuilt with the same tool present - the exact window where
// reseed-to-collapsed used to clobber the analyst's expand.
const POLL_SCRIPT = [
  { contract_version: "2.6.0", turn: 1, cursor: 2, done: false, frames: [
    { type: "turn_start", turn: 1 },
    { type: "tool_use", id: "tu1", name: "get_record", input: { iri: "/x" }, tier: 1 }
  ] },
  { contract_version: "2.6.0", turn: 1, cursor: 4, done: false, frames: [
    { type: "text", text: "still working" }
  ] },
  { contract_version: "2.6.0", turn: 1, cursor: 6, done: true, stop_reason: "end_turn", frames: [
    { type: "tool_result", tool_use_id: "tu1", tool: "get_record", content: "rec" },
    { type: "stream_end", stop_reason: "end_turn", ok: true }
  ] }
];

function makeHarness() {
  let pollCall = 0;
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.defer().promise, // never resolves; we only care about the poll loop
    chatPoll: jest.fn(() => $q.when(POLL_SCRIPT[Math.min(pollCall++, POLL_SCRIPT.length - 1)]))
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
  return { $scope, $timeout };
}

describe("fsrAgenticAssistant - Fix 1 streaming UI-state preservation", () => {
  test("an expanded tool stays open across the next poll rebuild", () => {
    const { $scope, $timeout } = makeHarness();
    $scope.form.inputText = "look it up";
    $scope.sendMessage();

    // Poll #1: the tool_call appears, collapsed by default.
    $timeout.flush(1);
    const tool1 = $scope.streamingMessage.events.find((e) => e.type === "tool_call");
    expect(tool1).toBeTruthy();
    expect(tool1._open).toBe(false);

    // Analyst expands it (template: ng-click="ev._open = !ev._open").
    tool1._open = true;
    tool1._resultOpen = true;

    // Poll #2 rebuilds the preview - the expand must survive.
    $timeout.flush(700);
    const tool2 = $scope.streamingMessage.events.find((e) => e.type === "tool_call");
    expect(tool2._toolUseId).toBe("tu1");
    expect(tool2._open).toBe(true);
    expect(tool2._resultOpen).toBe(true);
  });

  test("a brand-new tool in a later poll still defaults collapsed", () => {
    const { $scope, $timeout } = makeHarness();
    $scope.form.inputText = "go";
    $scope.sendMessage();
    $timeout.flush(1);
    $scope.streamingMessage.events.find((e) => e.type === "tool_call")._open = true;
    $timeout.flush(700);
    // Only tu1 exists; it carried state. No phantom extra tool got opened.
    const tools = $scope.streamingMessage.events.filter((e) => e.type === "tool_call");
    expect(tools).toHaveLength(1);
  });
});
