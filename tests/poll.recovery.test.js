"use strict";

// ─── Correctness #8/#9/#10 - poll-chain error recovery, stream-ref capture,
//     and consolidated $destroy teardown ─────────────────────────────────────
//
//  #8  A throw inside _absorbPoll/render must settle the detached turn (error
//      state, streaming torn down) instead of falling through to .catch - which
//      classifies a status-0 throw as "transient" and re-polls the same broken
//      frame every interval, re-throwing until the 6-min watchdog while the
//      composer sits in 'sending'.
//  #9  _absorbPoll folds frames into the stream reference captured by the poll
//      that fired it, not a global that _startStreaming may have replaced.
//  #10 $destroy cancels every tracked long-lived timer (init/retry/probe) and
//      sets a _destroyed guard so a late callback can't mutate a torn-down scope.

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

function makeHarness(pollScript, opts) {
  opts = opts || {};
  let pollCall = 0;
  let $q, $timeout, $rootScope, $controller;
  const historyDeferredHolder = {};
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => {
      if (opts.deferHistory) {
        historyDeferredHolder.d = $q.defer();
        return historyDeferredHolder.d.promise;
      }
      return $q.when({ turns: [] });
    },
    chatTurn: () => $q.when({ accepted: true, turn: 1, contract_version: "2.7.0" }),
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
  if (!opts.skipInitFlush) $timeout.flush();
  return { $scope, $timeout, $rootScope, agentStub, historyDeferredHolder };
}

describe("poll-chain error recovery (#8)", () => {
  test("a render throw during absorb settles the detached turn to error and stops streaming", () => {
    const script = [
      { contract_version: "2.7.0", turn: 1, cursor: 2, done: false, frames: [
        { type: "turn_start", turn: 1 },
        { type: "text", text: "working" }
      ] }
    ];
    const h = makeHarness(script);
    // Force the renderer to throw the moment absorb builds the preview.
    const orig = window.FsrPbRender.buildAssistantMessage;
    window.FsrPbRender.buildAssistantMessage = () => { throw new Error("render boom"); };
    try {
      h.$scope.form.inputText = "build it";
      h.$scope.sendMessage();
      h.$timeout.flush(1); // poll #1 → absorb throws
    } finally {
      window.FsrPbRender.buildAssistantMessage = orig;
    }
    // Composer freed with a surfaced error - NOT stuck in 'sending'. The old
    // behaviour left viewState 'sending' and re-polled the broken frame forever.
    expect(h.$scope.viewState).toBe("error");
    expect(h.$scope.errorMessage).toMatch(/could not be rendered/i);
    expect(h.$scope.streamingMessage).toBeNull();
  });
});

describe("consolidated $destroy teardown (#10)", () => {
  test("timers scheduled before init settles are cancelled on $destroy - no late scope mutation", () => {
    // Hold chatHistory open so the init timeout's downstream work is pending,
    // and don't flush init timers. $destroy must cancel them so flushing after
    // teardown neither fires the init callback nor throws on a torn-down scope.
    const h = makeHarness([{}], { deferHistory: true, skipInitFlush: true });
    let historyCalled = 0;
    h.agentStub.chatHistory = () => { historyCalled++; return h.historyDeferredHolder.d.promise; };

    h.$scope.$destroy();
    // Force any surviving timer: the init timeout was tracked+cancelled AND its
    // callback is _destroyed-guarded, so the init work (chatHistory) never runs.
    try { h.$timeout.flush(); } catch (e) { /* nothing left to flush - expected */ }
    expect(historyCalled).toBe(0);
  });

  test("$destroy tears down an active stream (timer + ticker)", () => {
    const script = [
      { contract_version: "2.7.0", turn: 1, cursor: 2, done: false, frames: [
        { type: "turn_start", turn: 1 },
        { type: "text", text: "working" }
      ] }
    ];
    const h = makeHarness(script);
    h.$scope.form.inputText = "build it";
    h.$scope.sendMessage();
    h.$timeout.flush(1);                 // stream alive, next poll + ticker pending
    expect(h.$scope.streamingMessage).toBeTruthy();

    h.$scope.$destroy();
    // _stopStreaming ran: preview cleared, stream torn down (poll timer + ticker
    // cancelled). A subsequent poll resolution can't resurrect the preview.
    expect(h.$scope.streamingMessage).toBeNull();
  });
});
