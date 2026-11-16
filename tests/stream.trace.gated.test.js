"use strict";

// The poll-loop tracer (_streamTrace, #98) is a diagnostic and must be OFF by
// default: left on it emitted two blocks per turn and swamped the test tiers
// (~1.9k of a ship-verify run's 2.7k lines). It logs only when
// window.__FSRPB_STREAM_DEBUG is set.

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

// One real turn: a start trace fires on send, a stop trace on stream end.
const POLL_SCRIPT = [
  { contract_version: "2.6.0", turn: 1, cursor: 2, done: true, stop_reason: "end_turn", frames: [
    { type: "turn_start", turn: 1 },
    { type: "text", text: "done" },
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
    chatTurn: () => $q.defer().promise,
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

// Count console.log calls carrying the tracer prefix.
function driveTurnAndCountTraceLogs() {
  const spy = jest.spyOn(console, "log").mockImplementation(() => {});
  try {
    const { $scope, $timeout } = makeHarness();
    $scope.form.inputText = "look it up";
    $scope.sendMessage();
    $timeout.flush();
    return spy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].indexOf("[fsr-pb-stream]") === 0
    ).length;
  } finally {
    spy.mockRestore();
  }
}

describe("stream tracer is gated off by default", () => {
  afterEach(() => { delete window.__FSRPB_STREAM_DEBUG; });

  test("no [fsr-pb-stream] log is emitted by default", () => {
    delete window.__FSRPB_STREAM_DEBUG;
    expect(driveTurnAndCountTraceLogs()).toBe(0);
  });

  test("the tracer logs when window.__FSRPB_STREAM_DEBUG is set", () => {
    window.__FSRPB_STREAM_DEBUG = true;
    expect(driveTurnAndCountTraceLogs()).toBeGreaterThan(0);
  });
});
