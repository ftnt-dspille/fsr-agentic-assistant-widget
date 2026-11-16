"use strict";

// ─── Action-based streaming (contract 2.5.0) -- controller poll loop ─────────
//
// Exercises the widget side of the streaming feature: while a blocking
// chat_turn is in flight, the controller polls chat_poll in parallel and
// renders the per-event progress feed into $scope.streamingMessage, then swaps
// to the authoritative transcript on done. We drive the real controller with a
// scripted agent service and step the $timeout poll loop deterministically.

const path = require("path");

global.jasmine = global.jasmine || {};
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef

// Render module attaches $window.FsrPbRender; controller delegates to it.
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

// A scripted chat_poll feed: each entry is one poll response, returned in
// order. Frames are RAW per-event wire shapes bracketed by turn_start /
// stream_end -- exactly what the connector's chat_poll emits.
const POLL_SCRIPT = [
  { contract_version: "2.5.0", turn: 1, cursor: 2, done: false, stop_reason: null,
    frames: [
      { type: "turn_start", turn: 1 },
      { type: "text", text: "I'll help \u2014 " }
    ] },
  { contract_version: "2.5.0", turn: 1, cursor: 4, done: false, stop_reason: null,
    frames: [
      { type: "text", text: "running block_ip." },
      { type: "tool_use", id: "tu1", name: "block_ip", input: { ip: "1.1.1.1" }, tier: 3 }
    ] },
  { contract_version: "2.5.0", turn: 1, cursor: 6, done: true, stop_reason: "end_turn",
    frames: [
      { type: "tool_result", tool_use_id: "tu1", tool: "block_ip", content: "blocked" },
      { type: "stream_end", stop_reason: "end_turn", ok: true, error: null,
        transcript: [{ type: "text", text: "Done. Blocked 1.1.1.1." }] }
    ] }
];

function makeHarness(mode) {
  mode = mode || "live";
  let pollCall = 0;
  let turnDeferred;
  let $q, $timeout, $rootScope, $controller;
  const pollSpy = jest.fn(() => $q.when(POLL_SCRIPT[Math.min(pollCall++, POLL_SCRIPT.length - 1)]));

  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: mode, mock_scenario: mode === "mock" ? "happy_path" : null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => { turnDeferred = $q.defer(); return turnDeferred.promise; },
    chatPoll: pollSpy
  };

  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", agentStub);
    $provide.value("config", {});
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
    $q = _$q_;
    $timeout = _$timeout_;
  });

  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  // Flush the construction-time $timeout(_probeConnector) + history rehydrate.
  $timeout.flush();
  return { $scope, $timeout, $rootScope, pollSpy, q: () => $q, resolveTurn: (r) => turnDeferred.resolve(r) };
}

describe("fsrAgenticAssistant \u2014 action-based streaming poll loop", () => {
  test("renders incremental frames into a live preview, then swaps to the authoritative transcript on done", () => {
    const h = makeHarness();
    const { $scope, $timeout } = h;

    // Dispatch a turn. chat_turn stays pending; the poll loop should start.
    $scope.form.inputText = "Block ip 1.1.1.1";
    $scope.sendMessage();
    expect($scope.viewState).toBe("sending");

    // Poll #1 (delay 0): turn_start + first text chunk → one ordered text event.
    $timeout.flush(1);
    expect($scope.streamingMessage).toBeTruthy();
    expect($scope.streamingMessage._streaming).toBe(true);
    expect($scope.streamingMessage.events).toHaveLength(1);
    expect($scope.streamingMessage.events[0]).toMatchObject({ type: "text", text: "I'll help, " });
    // The preview rides chatMessages() (same renderer as committed messages).
    const list1 = $scope.chatMessages();
    expect(list1[list1.length - 1]).toBe($scope.streamingMessage);

    // Poll #2 (+700ms): consecutive text coalesces into the same line; the
    // tool_use starts a new pending tool step after it -- an interleaved timeline.
    $timeout.flush(700);
    const evs = $scope.streamingMessage.events;
    expect(evs.map((e) => e.type)).toEqual(["text", "tool_call"]);
    expect(evs[0]).toMatchObject({ type: "text", text: "I'll help, running block_ip." });
    expect(evs[1]).toMatchObject({ type: "tool_call", name: "block_ip", resultStatus: "pending", resultDisplay: null });

    // Poll #3 (+700ms): tool_result completes the tool step in place;
    // stream_end(done) stops the loop and clears the preview.
    $timeout.flush(700);
    expect($scope.streamingMessage).toBeNull();

    // The authoritative chat_turn response now lands and renders the final
    // transcript (this is the only place cards/coalesced text appear).
    h.resolveTurn({
      ok: true, session_id: "s", turn: 1, turn_id: "t1",
      stop_reason: "end_turn", contract_version: "2.5.0",
      transcript: [{ type: "text", text: "Done. Blocked 1.1.1.1." }]
    });
    h.$rootScope.$digest();

    expect($scope.streamingMessage).toBeNull();
    const last = $scope.messages[$scope.messages.length - 1];
    expect(last.role).toBe("assistant");
    // Committed message uses the same interleaveText timeline (text in events).
    const lastText = (last.events || []).find((e) => e.type === "text");
    expect(lastText.text).toBe("Done. Blocked 1.1.1.1.");
    // The loop stopped on the done frame -- exactly three polls, no reschedule.
    expect(h.pollSpy).toHaveBeenCalledTimes(3);
  });

  test("ignores a stale prior turn's done frames when the first poll outraces chat_turn", () => {
    // Regression: on a multi-turn session the first poll (delay 0) can land
    // before chat_turn has written the NEW turn's turn_start, so the feed
    // still shows the PREVIOUS, already-done turn. Latching that turn's
    // turn_start + honouring its done tore the stream down before the new
    // turn ever streamed -- the analyst saw dead air until chat_turn returned.
    const h = makeHarness("live");
    const { $scope, $timeout, pollSpy } = h;
    const $q = h.q();

    // Commit turn 1 first so _lastTurn === 1 and the next turn is turn 2.
    $scope.form.inputText = "first";
    $scope.sendMessage();
    // Drain the turn-1 poll loop and commit it.
    pollSpy.mockImplementation(() => $q.when(
      { contract_version: "2.5.0", turn: 1, cursor: 6, done: true, stop_reason: "end_turn",
        frames: [{ type: "turn_start", turn: 1 }, { type: "text", text: "one" },
                 { type: "stream_end", stop_reason: "end_turn", ok: true, transcript: [] }] }));
    $timeout.flush();   // run + stop the turn-1 stream
    h.resolveTurn({ ok: true, session_id: "s", turn: 1, turn_id: "t1",
      stop_reason: "end_turn", contract_version: "2.5.0",
      transcript: [{ type: "text", text: "one" }] });
    h.$rootScope.$digest();

    // Now dispatch turn 2. The FIRST poll returns the STALE turn-1 feed
    // (done:true). It must be ignored -- no preview, loop keeps polling.
    let pollN = 0;
    pollSpy.mockImplementation(() => {
      pollN++;
      if (pollN === 1) {
        return $q.when({ contract_version: "2.5.0", turn: 1, cursor: 6, done: true,
          stop_reason: "end_turn",
          frames: [{ type: "turn_start", turn: 1 }, { type: "text", text: "STALE" },
                   { type: "stream_end", stop_reason: "end_turn", ok: true, transcript: [] }] });
      }
      // Poll #2+: the new turn (turn 2) finally appears in the feed.
      return $q.when({ contract_version: "2.5.0", turn: 2, cursor: 8, done: false,
        stop_reason: null,
        frames: [{ type: "turn_start", turn: 2 }, { type: "text", text: "live turn-2" }] });
    });

    $scope.form.inputText = "second";
    $scope.sendMessage();

    // Poll #1: stale done turn-1 → ignored, NO preview, loop reschedules.
    $timeout.flush(1);
    expect($scope.streamingMessage).toBeNull();

    // Poll #2: the real turn-2 frame renders a live preview.
    $timeout.flush(700);
    expect($scope.streamingMessage).toBeTruthy();
    expect($scope.streamingMessage.events[0]).toMatchObject({ type: "text", text: "live turn-2" });
  });

  test("does not poll when the chat track is mocked (no live feed)", () => {
    const h = makeHarness("mock");
    const { $scope, $timeout, pollSpy } = h;
    $scope.form.inputText = "Block ip 1.1.1.1";
    $scope.sendMessage();
    expect($scope.viewState).toBe("sending");
    // _startStreaming early-returns on mode !== 'live': no poll is scheduled and
    // chat_poll is never invoked. (Flushing any unrelated pending timer -- e.g.
    // the init entity-context retry -- must not trigger a poll.)
    try { $timeout.flush(); } catch (e) { /* "no deferred tasks" is fine too */ }
    expect(pollSpy).not.toHaveBeenCalled();
    expect($scope.streamingMessage).toBeNull();
  });

  test("stands down quietly against a pre-2.5.0 connector (capability gate)", () => {
    const h = makeHarness("live");
    const { $scope, $timeout, pollSpy } = h;
    const $q = h.q();
    // The (old) connector answers without the streaming contract.
    pollSpy.mockImplementation(() => $q.when({
      contract_version: "2.4.0", turn: 1, cursor: 0, done: false, frames: []
    }));

    $scope.form.inputText = "Block ip 1.1.1.1";
    $scope.sendMessage();
    $timeout.flush(1);   // poll #1 → version gate trips → streaming stops

    expect(pollSpy).toHaveBeenCalledTimes(1);
    expect($scope.streamingMessage).toBeNull();
    // No reschedule -- the loop stood down after one probe (a second flush
    // would have nothing to run / the spy would not be called again).
    expect(pollSpy).toHaveBeenCalledTimes(1);
  });

  test("a transient transport reject (blob echoes 'chat_poll') retries instead of stranding", () => {
    // Regression: an intermittent upstream 502 / ERR_EMPTY_RESPONSE on the poll
    // request rejects with the $http error whose `config.data` still carries
    // operation:'chat_poll'. The old classifier matched that bare token and
    // wrongly stood the loop down with "Streaming this build is unavailable" --
    // the exact inconsistency seen on the live forticloud hunt chain. A
    // transient error must keep polling.
    const h = makeHarness("live");
    const { $scope, $timeout, pollSpy } = h;
    const $q = h.q();
    let n = 0;
    pollSpy.mockImplementation(() => {
      n++;
      if (n === 1) {
        return $q.reject({ status: 502, statusText: "Bad Gateway",
          config: { url: "/api/integration/execute/", data: { operation: "chat_poll", session_id: "s" } } });
      }
      return $q.when({ contract_version: "2.5.0", turn: 1, cursor: 2, done: false,
        frames: [{ type: "turn_start", turn: 1 }, { type: "text", text: "recovered" }] });
    });

    $scope.form.inputText = "investigate this alert end to end";
    $scope.sendMessage();
    $timeout.flush(1);     // poll #1 → transient 502 → MUST reschedule, not strand
    expect($scope.viewState).not.toBe("error");
    expect($scope.streamingMessage).toBeNull();   // nothing rendered yet, loop alive
    $timeout.flush(700);   // poll #2 → recovers and streams
    expect(pollSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect($scope.streamingMessage).toBeTruthy();
    expect($scope.streamingMessage.events[0]).toMatchObject({ type: "text", text: "recovered" });
  });

  test("a genuine 'unknown operation' rejection still stands the loop down", () => {
    // The other side of the fix: a real capability rejection (HTTP 400 with a
    // structured "unknown operation" message) must still degrade -- even though
    // its blob also contains 'chat_poll'.
    const h = makeHarness("live");
    const { $scope, $timeout, pollSpy } = h;
    const $q = h.q();
    pollSpy.mockImplementation(() => $q.reject({
      status: 400, data: { message: "unknown operation: chat_poll" }
    }));

    $scope.form.inputText = "Block ip 1.1.1.1";
    $scope.sendMessage();
    $timeout.flush(1);     // poll #1 → unsupported → stand down
    expect(pollSpy).toHaveBeenCalledTimes(1);
    expect($scope.streamingMessage).toBeNull();
  });
});

describe("FsrPbRender.buildAssistantMessage \u2014 interleaveText timeline", () => {
  const R = window.FsrPbRender; // eslint-disable-line no-undef

  test("interleaves text → tool → text → tool as ordered events (text NOT hoisted to msg.text)", () => {
    const events = [
      { type: "text", text: "Looking into " },
      { type: "text", text: "1.1.1.1.\n" },           // coalesces with prior text
      { type: "tool_use", id: "a", name: "geo_lookup", input: { ip: "1.1.1.1" } },
      { type: "tool_result", tool_use_id: "a", tool: "geo_lookup", content: '{"ok":true,"status":"success"}' },
      { type: "text", text: "It's malicious \u2014 blocking now." },
      { type: "tool_use", id: "b", name: "block_ip", input: { ip: "1.1.1.1" } }
    ];
    const msg = R.buildAssistantMessage(events, { now: () => 1, interleaveText: true });

    expect(msg.text).toBe("");   // timeline mode: nothing hoisted
    expect(msg.events.map((e) => e.type)).toEqual(["text", "tool_call", "text", "tool_call"]);
    expect(msg.events[0].text).toBe("Looking into 1.1.1.1.\n");
    expect(msg.events[1]).toMatchObject({ name: "geo_lookup", resultStatus: "success", resultDisplay: expect.any(String) });
    expect(msg.events[2].text).toBe("It's malicious, blocking now."); // spaced em dash renders as a comma
    expect(msg.events[3]).toMatchObject({ name: "block_ip", resultStatus: "pending", resultDisplay: null });
  });

  test("default (interleaveText off) still coalesces text into msg.text \u2014 committed-message legacy shape", () => {
    const msg = R.buildAssistantMessage([
      { type: "text", text: "a " }, { type: "text", text: "b" }
    ], { now: () => 1 });
    expect(msg.text).toBe("a b");
    expect(msg.events).toHaveLength(0);
  });

  test("cards still render as their own events, interleaved in order", () => {
    const msg = R.buildAssistantMessage([
      { type: "text", text: "Recommend blocking." },
      { type: "action_card", id: "card-1", tool: "block_ip", summary: "Block 1.1.1.1", args: { ip: "1.1.1.1" } }
    ], { now: () => 1, interleaveText: true });
    expect(msg.events.map((e) => e.type)).toEqual(["text", "action_card"]);
    expect(msg.events[1].cardId).toBe("card-1");
  });
});
