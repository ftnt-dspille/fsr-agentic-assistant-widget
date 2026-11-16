"use strict";

// ─── C6: real cancel and reattach after reload ──────────────────────────────
//
// Stop ends the server turn: the widget calls chat_cancel for the session, and
// stops its own wait. Reload mid-turn reattaches: on init the widget asks
// chat_poll for the session's running turn (fenced past the last committed
// turn) and, if that turn is not done, resumes the live view on it.

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

// history: the rehydrate payload for chatHistory. polls: scripted chat_poll
// replies in call order (the last one repeats). Records every call.
function makeHarness({ history, polls, inFlight = false, session = "sess-reload" }) {
  // A reload: the page remembers a turn was in flight for this session. A
  // fresh load has no such memory.
  window.sessionStorage.clear();
  window.history.replaceState({}, "", inFlight ? `/?session=${session}` : "/");
  if (inFlight) window.sessionStorage.setItem("fsrPbInFlightSession", session);
  let pollCall = 0;
  const calls = { poll: [], cancel: [] };
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when(history),
    chatTurn: () => $q.defer().promise,
    chatPoll: (cfg, sid, cursor, sinceTurn) => {
      calls.poll.push({ sid, cursor, sinceTurn });
      return $q.when(polls[Math.min(pollCall++, polls.length - 1)]);
    },
    chatCancel: (cfg, sid) => {
      calls.cancel.push({ sid });
      return $q.when({ ok: true, session_id: sid, turn: 2, cancelled: true });
    }
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
  return { $scope, $timeout, $rootScope, calls };
}

const PRIOR = {
  turns: [
    { user: "enrich 1.1.1.1" },
    { transcript: [{ type: "text", text: "Done: 1.1.1.1 is clean." }] }
  ]
};

describe("fsrAgenticAssistant - C6 real cancel and reattach", () => {
  test("Stop calls chat_cancel for the session and stops the local wait", () => {
    const h = makeHarness({
      history: PRIOR,
      inFlight: true,   // a reload into a session with a turn in flight: the probe names the session
      polls: [{ contract_version: "2.8.0", turn: null, cursor: 0, done: true, frames: [] }]
    });
    h.$scope.viewState = "sending";        // a turn the analyst is waiting on
    h.$scope.stopTurn();
    expect(h.calls.cancel.length).toBe(1);
    expect(h.calls.cancel[0].sid).toBe(h.calls.poll[0].sid);   // the session the analyst is in
    expect(h.$scope.viewState).toBe("idle");
    const pollsBefore = h.calls.poll.length;
    h.$timeout.flush(5000);
    expect(h.calls.poll.length).toBe(pollsBefore);   // no polling after Stop
  });

  test("on init, a running turn is reattached: the live view resumes and commits the terminal", () => {
    const polls = [
      // reattach probe: turn 2 is running, fenced past the committed turn 1
      { contract_version: "2.8.0", turn: 2, cursor: 0, done: false, frames: [] },
      // the resumed stream replays from cursor 0
      { contract_version: "2.8.0", turn: 2, cursor: 2, done: false, long_poll: false, frames: [
        { type: "turn_start", turn: 2 },
        { type: "text", text: "still working on it" }
      ] },
      { contract_version: "2.8.0", turn: 2, cursor: 4, done: true, stop_reason: "end_turn", frames: [
        { type: "stream_end", stop_reason: "end_turn", ok: true, turn_id: "t2",
          transcript: [{ type: "text", text: "Reattached answer." }] }
      ] }
    ];
    const h = makeHarness({ history: PRIOR, polls, inFlight: true });
    // the first poll is the reattach probe: from cursor 0, fenced past turn 1.
    // (The stream it starts polls again on the next tick, which the flush below runs.)
    expect(h.calls.poll[0].cursor).toBe(0);
    expect(h.calls.poll[0].sinceTurn).toBe(1);       // fenced past the last committed turn
    expect(h.$scope.viewState).toBe("sending");       // live view resumed, not an empty screen

    h.$timeout.flush(1);
    expect(h.$scope.streamingMessage).toBeTruthy();   // the running turn is visible

    h.$timeout.flush(700);
    expect(h.$scope.viewState).toBe("idle");
    const last = h.$scope.messages[h.$scope.messages.length - 1];
    expect((last.events || []).find((e) => e.type === "text").text).toBe("Reattached answer.");
  });

  test("a fresh load with no turn in flight does not probe the connector", () => {
    const h = makeHarness({
      history: PRIOR,
      polls: [{ contract_version: "2.8.0", turn: 1, cursor: 4, done: true, frames: [] }]
    });
    expect(h.calls.poll.length).toBe(0);
    expect(h.$scope.viewState).toBe("idle");
    expect(h.$scope.streamingMessage).toBeFalsy();
  });
});
