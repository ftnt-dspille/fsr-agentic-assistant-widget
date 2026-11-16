"use strict";

// ─── Detached-mode stale-transcript guard ───────────────────────────────────
//
// Regression: export sess-ei6esw96. A detached "build" turn's synchronous
// chat_turn return carried the PREVIOUS turn's transcript inline (same toolu_*
// ids) with stop_reason end_turn. The ack short-circuit only fires on an EMPTY
// transcript, so the stale inline transcript bypassed it and got committed -
// the widget rendered the same enrichment twice and built no playbook.
//
// Guard: while a detached turn is in flight, the synchronous chat_turn return
// is treated as an ack and its transcript is NEVER committed - the authoritative
// transcript must arrive via the chat_poll terminal. A second, mode-agnostic
// stale-replay check drops any transcript whose tool calls are all already on
// screen.

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
  let turnDeferred;
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => { turnDeferred = $q.defer(); return turnDeferred.promise; },
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

const BUILT_TEXT = "Playbook built: 4 steps.";

describe("fsrAgenticAssistant - detached stale-transcript guard", () => {
  test("a detached chat_turn return that echoes a transcript inline is ignored; the poll terminal commits the real build", () => {
    const script = [
      { contract_version: "2.8.0", turn: 1, cursor: 2, done: false, frames: [
        { type: "turn_start", turn: 1 },
        { type: "text", text: "designing…" }
      ] },
      { contract_version: "2.8.0", turn: 1, cursor: 4, done: true, stop_reason: "end_turn", frames: [
        { type: "stream_end", stop_reason: "end_turn", ok: true, turn_id: "t1",
          transcript: [{ type: "text", text: BUILT_TEXT }] }
      ] }
    ];
    const h = makeHarness(script);
    const assistantCount = () => h.$scope.messages.filter((m) => m.role === "assistant").length;
    h.$scope.form.inputText = "build it";
    h.$scope.sendMessage();   // chatTurn returns a pending promise; detached latched

    // The buggy connector echoes the prior turn's transcript inline with a real
    // stop_reason (NOT {accepted}). This MUST be ignored - not committed.
    h.resolveTurn({ ok: true, turn: 1, turn_id: "t1", stop_reason: "end_turn",
      contract_version: "2.8.0",
      transcript: [
        { type: "tool_use", id: "stale-1", name: "run_op" },
        { type: "text", text: "IOC: 1.1.1.1 - Clean (stale echo)" }
      ] });
    expect(assistantCount()).toBe(0);              // nothing committed
    expect(h.$scope.viewState).not.toBe("idle");   // still streaming

    h.$timeout.flush(1);     // poll #1 - preview
    expect(h.$scope.streamingMessage).toBeTruthy();

    h.$timeout.flush(700);   // poll #2 - terminal commits the authoritative build
    expect(h.$scope.streamingMessage).toBeNull();
    expect(assistantCount()).toBe(1);
    const committed = h.$scope.messages[h.$scope.messages.length - 1];
    expect((committed.events || []).find((e) => e.type === "text").text).toBe(BUILT_TEXT);
  });

  test("the poll terminal drops a transcript whose tool calls are all already on screen (stale replay)", () => {
    const script = [
      { contract_version: "2.8.0", turn: 1, cursor: 2, done: false, frames: [
        { type: "turn_start", turn: 1 },
        { type: "text", text: "working…" }
      ] },
      { contract_version: "2.8.0", turn: 1, cursor: 4, done: true, stop_reason: "end_turn", frames: [
        { type: "stream_end", stop_reason: "end_turn", ok: true,
          // Every tool call here already exists in the committed timeline below.
          transcript: [{ type: "tool_use", id: "enr-1", name: "run_op" }] }
      ] }
    ];
    const h = makeHarness(script);
    // Seed a prior assistant turn that already used tool_use id "enr-1".
    h.$scope.messages.push({ role: "assistant", events: [
      { type: "tool_call", name: "run_op", _toolUseId: "enr-1" }
    ] });
    const assistantCount = () => h.$scope.messages.filter((m) => m.role === "assistant").length;
    const before = assistantCount();

    h.$scope.form.inputText = "build it";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    h.$timeout.flush(700);   // terminal arrives - but it's an all-known replay

    expect(assistantCount()).toBe(before);        // no duplicate committed
    expect(h.$scope.viewState).toBe("idle");       // turn still resolves cleanly
  });
});
