"use strict";

// ─── Chat responsiveness (Track C1 + C3): long-poll cadence and status frames ──
//
//   C1  The poll asks the connector to hold it open (long_poll_ms). A poll that
//       brought frames re-polls at once; one that came straight back empty (an
//       older connector that does not hold it) keeps the 700 ms cadence.
//   C3  `activity` frames are status, not rows: they drive the live status line
//       under the typing dots and never enter the streamed preview. The status
//       reads "Thinking" from send, and a finished tool no longer keeps its
//       label as the current work.

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
  const pollArgs = [];
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.defer().promise,   // a blocking turn that never returns here
    chatPoll: (...args) => {
      pollArgs.push(args);
      return $q.when(pollScript[Math.min(pollCall++, pollScript.length - 1)]);
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
  return { $scope, $timeout, pollArgs, polls: () => pollCall };
}

const LIVE_TURN = (frames, cursor) => ({
  contract_version: "2.6.0", turn: 1, cursor, done: false, frames, long_poll: true
});

describe("chat poll - long-poll cadence (C1)", () => {
  test("every poll asks the connector to hold it for a long-poll window", () => {
    const h = makeHarness([
      LIVE_TURN([{ type: "turn_start", turn: 1 }], 1),
      LIVE_TURN([], 1)   // a quiet answer ends the short re-poll chain; repeats after
    ]);
    h.$scope.form.inputText = "hunt it";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    expect(h.pollArgs.length).toBeGreaterThan(0);
    const longPollMs = h.pollArgs[0][4];
    expect(longPollMs).toBeGreaterThanOrEqual(5000);
    expect(longPollMs).toBeLessThanOrEqual(8000);
  });

  test("a poll that brought frames re-polls at once, not after 700 ms", () => {
    const h = makeHarness([
      LIVE_TURN([{ type: "turn_start", turn: 1 }, { type: "text", text: "a" }], 2),
      LIVE_TURN([], 2)   // the immediate re-poll comes back quiet; repeats after
    ]);
    h.$scope.form.inputText = "hunt it";
    h.$scope.sendMessage();
    // Poll #1 brings frames; poll #2 is due after the short re-poll gap.
    // Without it (old 700 ms cadence) flush(50) would stop after poll #1.
    h.$timeout.flush(50);
    expect(h.polls()).toBe(2);
  });

  test("a poll the connector did not hold keeps the 700 ms cadence", () => {
    const h = makeHarness([
      { ...LIVE_TURN([{ type: "turn_start", turn: 1 }, { type: "text", text: "a" }], 2), long_poll: undefined },
      { ...LIVE_TURN([], 2), long_poll: undefined }
    ]);
    h.$scope.form.inputText = "hunt it";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    const before = h.polls();
    h.$timeout.flush(50);
    expect(h.polls()).toBe(before);
    h.$timeout.flush(700);
    expect(h.polls()).toBe(before + 1);
  });

  test("an empty answer that came straight back keeps the 700 ms cadence", () => {
    const h = makeHarness([LIVE_TURN([], 1)]);   // quiet answer repeats
    h.$scope.form.inputText = "hunt it";
    h.$scope.sendMessage();
    h.$timeout.flush(1);          // poll #1 is empty and immediate
    const before = h.polls();
    h.$timeout.flush(0);
    expect(h.polls()).toBe(before);   // no spin on an old connector
    h.$timeout.flush(700);
    expect(h.polls()).toBe(before + 1);
  });
});

describe("chat poll - status frames (C3)", () => {
  test("an activity frame sets the status line and adds no row to the preview", () => {
    const h = makeHarness([
      LIVE_TURN([{ type: "turn_start", turn: 1 },
                 { type: "activity", phase: "thinking", message: "Reading the record" }], 2),
      LIVE_TURN([], 2)
    ]);
    h.$scope.form.inputText = "hunt it";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    expect(h.$scope.streamStatus).toBe("Reading the record");
    expect(h.$scope.streamingMessage).toBeFalsy();
  });

  test("the status reads Thinking from send, before any frame", () => {
    const h = makeHarness([LIVE_TURN([], 0)]);
    h.$scope.form.inputText = "hunt it";
    h.$scope.sendMessage();
    expect(h.$scope.streamStatus).toBe("Thinking");
  });

  test("a finished tool does not keep its label as the current work", () => {
    const h = makeHarness([
      LIVE_TURN([
        { type: "turn_start", turn: 1 },
        { type: "tool_use", id: "c1", name: "get_record", input: { module: "alerts" } },
        { type: "tool_result", tool_use_id: "c1", content: "{\"ok\":true}" }
      ], 4),
      LIVE_TURN([], 4)
    ]);
    h.$scope.form.inputText = "hunt it";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    expect(h.$scope.streamStatus).toBe("Thinking");
  });
});
