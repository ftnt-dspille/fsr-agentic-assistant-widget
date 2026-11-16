"use strict";

// ─── Fix 3 (poll-to-completion): terminal-transcript commit + ack no-op ─────
//
// Two new behaviours from the remote-control changes 3 & 4:
//   • _absorbPoll's stream_end branch commits the authoritative transcript via
//     _handleTurnResult (poll-to-completion) - so a long build lands through the
//     feed even when the blocking POST is a fast {accepted} ack.
//   • _handleTurnResult treats an {accepted, no-transcript} ack as a no-op
//     (latch turn, keep streaming) and is idempotent per turn, so the ack, the
//     poll terminal, and a late POST return can't double-commit.

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

function makeHarness(pollScript, turnMode) {
  let pollCall = 0;
  let turnDeferred;
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => {
      if (turnMode === "ack") return $q.when({ accepted: true, turn: 1, contract_version: "2.6.0" });
      turnDeferred = $q.defer();
      return turnDeferred.promise;
    },
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
  return {
    $scope, $timeout, $rootScope,
    resolveTurn: (r) => { turnDeferred.resolve(r); $rootScope.$digest(); }
  };
}

const TERMINAL_TEXT = "Playbook built: 3 steps.";

describe("fsrAgenticAssistant - poll-to-completion (Fix 3 changes 3 & 4)", () => {
  test("a terminal frame WITH a transcript commits the message; a later POST return is idempotency-blocked", () => {
    const script = [
      { contract_version: "2.6.0", turn: 1, cursor: 2, done: false, frames: [
        { type: "turn_start", turn: 1 },
        { type: "text", text: "working…" }
      ] },
      { contract_version: "2.6.0", turn: 1, cursor: 4, done: true, stop_reason: "end_turn", frames: [
        { type: "stream_end", stop_reason: "end_turn", ok: true, turn_id: "t1",
          transcript: [{ type: "text", text: TERMINAL_TEXT }] }
      ] }
    ];
    const h = makeHarness(script, "pending");
    h.$scope.form.inputText = "build it";
    h.$scope.sendMessage();

    h.$timeout.flush(1);    // poll #1 - live preview
    expect(h.$scope.streamingMessage).toBeTruthy();

    h.$timeout.flush(700);  // poll #2 - terminal commits
    expect(h.$scope.streamingMessage).toBeNull();
    const committed = h.$scope.messages[h.$scope.messages.length - 1];
    expect(committed.role).toBe("assistant");
    expect((committed.events || []).find((e) => e.type === "text").text).toBe(TERMINAL_TEXT);
    const lenAfterTerminal = h.$scope.messages.length;

    // The blocking POST finally returns the SAME turn - must NOT double-commit.
    h.resolveTurn({ ok: true, turn: 1, turn_id: "t1", stop_reason: "end_turn",
      contract_version: "2.6.0", transcript: [{ type: "text", text: TERMINAL_TEXT }] });
    expect(h.$scope.messages.length).toBe(lenAfterTerminal);
  });

  test("an {accepted} ack is a no-op: no commit, streaming keeps running, terminal commits", () => {
    const script = [
      { contract_version: "2.6.0", turn: 1, cursor: 2, done: false, frames: [
        { type: "turn_start", turn: 1 },
        { type: "text", text: "thinking" }
      ] },
      { contract_version: "2.6.0", turn: 1, cursor: 4, done: true, stop_reason: "end_turn", frames: [
        { type: "stream_end", stop_reason: "end_turn", ok: true,
          transcript: [{ type: "text", text: TERMINAL_TEXT }] }
      ] }
    ];
    const h = makeHarness(script, "ack");
    const assistantCount = () => h.$scope.messages.filter((m) => m.role === "assistant").length;
    h.$scope.form.inputText = "build it";
    h.$scope.sendMessage();   // chatTurn resolves an ack synchronously on digest

    // Ack committed no assistant message and didn't flip the turn to idle.
    expect(assistantCount()).toBe(0);
    expect(h.$scope.viewState).not.toBe("idle");

    h.$timeout.flush(1);      // poll #1 - preview appears (stream alive)
    expect(h.$scope.streamingMessage).toBeTruthy();

    h.$timeout.flush(700);    // poll #2 - terminal commits the real transcript
    expect(h.$scope.streamingMessage).toBeNull();
    const committed = h.$scope.messages[h.$scope.messages.length - 1];
    expect((committed.events || []).find((e) => e.type === "text").text).toBe(TERMINAL_TEXT);
  });
});
