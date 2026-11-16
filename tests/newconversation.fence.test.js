"use strict";

// ─── newConversation resets the detached stream fence ───────────────────────
//
// Regression: newConversation() mints a fresh session_id - which restarts the
// connector's turn numbering at 1 - but used to leave _lastTurn untouched. A
// prior/rehydrated session that had advanced _lastTurn then left
// minTurn = _lastTurn + 1 > 1, so the new session's first turn_start (turn:1)
// was dropped as "stale", sawStart never latched, the `done` terminal was
// ignored, and the detached turn polled until the 6-min watchdog failed it with
// "The build is taking too long and lost contact with the connector."
//
// This reproduces it end-to-end: complete one turn (advances _lastTurn to 1),
// start a new conversation, then a SECOND turn whose stream also numbers itself
// turn:1 (fresh session) must still commit. Without the fence reset the second
// terminal is ignored and no second assistant message ever commits.

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

function makeHarness(pollScript) {
  let pollCall = 0;
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    // Fast {accepted} ack (detached): the authoritative transcript arrives via
    // the chat_poll terminal, so the fence gating is what's under test.
    chatTurn: () => $q.when({ accepted: true, turn: 1, contract_version: "2.6.0" }),
    chatPoll: () => $q.when(pollScript[Math.min(pollCall++, pollScript.length - 1)])
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

// Every turn (each on its own fresh session) numbers itself turn:1.
function previewFrame() {
  return { contract_version: "2.6.0", turn: 1, cursor: 2, done: false, frames: [
    { type: "turn_start", turn: 1 },
    { type: "text", text: "working…" }
  ] };
}
function terminalFrame(text) {
  return { contract_version: "2.6.0", turn: 1, cursor: 4, done: true, stop_reason: "end_turn", frames: [
    { type: "stream_end", stop_reason: "end_turn", ok: true, turn_id: "t",
      transcript: [{ type: "text", text }] }
  ] };
}

describe("fsrAgenticAssistant - newConversation resets the stream fence", () => {
  test("a second turn after '+ New' still commits even though it re-uses turn:1", () => {
    const script = [
      previewFrame(),              // turn 1 preview
      terminalFrame("First done"), // turn 1 terminal → _lastTurn advances to 1
      previewFrame(),              // turn 2 preview (fresh session, turn:1 again)
      terminalFrame("Second done") // turn 2 terminal
    ];
    const h = makeHarness(script);
    const assistantMsgs = () => h.$scope.messages.filter((m) => m.role === "assistant");

    // ── Turn 1 ──
    h.$scope.form.inputText = "build it";
    h.$scope.sendMessage();
    h.$timeout.flush(1);    // poll #1 preview
    h.$timeout.flush(700);  // poll #2 terminal commits
    expect(assistantMsgs().length).toBe(1);
    expect(assistantMsgs()[0].events.find((e) => e.type === "text").text).toBe("First done");

    // ── New conversation (fresh session; connector turn numbering restarts) ──
    h.$scope.newConversation();
    expect(h.$scope.messages.length).toBe(0);

    // ── Turn 2 ── its stream is turn:1 again; the fence must accept it.
    h.$scope.form.inputText = "build another";
    h.$scope.sendMessage();
    h.$timeout.flush(1);    // poll #3 preview
    h.$timeout.flush(700);  // poll #4 terminal commits

    // Without the fence reset in newConversation, minTurn would be 2 here, the
    // turn:1 turn_start would be dropped, and this commit would never happen.
    expect(h.$scope.streamingMessage).toBeNull();
    expect(assistantMsgs().length).toBe(1);
    expect(assistantMsgs()[0].events.find((e) => e.type === "text").text).toBe("Second done");
    expect(h.$scope.viewState).not.toBe("sending");
  });
});
