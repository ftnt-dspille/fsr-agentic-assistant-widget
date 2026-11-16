"use strict";

// ─── Tool-call counter (topbar usage meter) ─────────────────────────────────
//
// $scope.toolsUsedCount() reports how many tool calls the agent made this
// conversation, summed across every committed message AND the in-flight
// streaming preview. It backs the " · N tools" segment of the usage meter.

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
const versionSlug = widgetInfo.version.replace(/\./g, "");
const viewCtrlName = `${widgetInfo.name}${versionSlug}DevCtrl`;
const ng = window.angular; // eslint-disable-line no-undef

function resolved(val) {
  return {
    then: function (cb) { return resolved(cb ? cb(val) : val); },
    catch: function () { return resolved(val); },
  };
}

let $controller, $rootScope, $timeout;

beforeEach(() => {
  window.localStorage.clear();
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      resolveConnector: () => resolved({ name: "x", version: "1", configId: "c1" }),
      chatHistory: () => resolved({ turns: [] }),
      listSessions: () => resolved({ sessions: [] }),
      execute: () => resolved({}),
      resume: () => resolved({}),
      modeInfo: () => ({ mode: "live", mock_scenario: null }),
    });
    $provide.value("config", { seedFromEntity: false });
    $provide.value("$state", { current: { name: "main.modules.list" }, params: { module: "alerts" } });
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
    $timeout = _$timeout_;
  });
});

function boot() {
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  return $scope;
}

const toolEv = (name) => ({ type: "tool_call", name });
const textEv = (text) => ({ type: "text", text });

describe(`${viewCtrlName} - toolsUsedCount`, () => {
  test("zero when no tool calls have happened", () => {
    const $scope = boot();
    expect($scope.toolsUsedCount()).toBe(0);
  });

  test("sums tool_call events across all committed messages", () => {
    const $scope = boot();
    $scope.messages = [
      { events: [textEv("hi"), toolEv("get_record")] },
      { events: [toolEv("search_module_records"), textEv("ok"), toolEv("run_op")] },
    ];
    expect($scope.toolsUsedCount()).toBe(3);
  });

  test("includes tool calls in the in-flight streaming preview", () => {
    const $scope = boot();
    $scope.messages = [{ events: [toolEv("get_record")] }];
    $scope.streamingMessage = { events: [toolEv("run_op"), toolEv("emit_action_card")] };
    expect($scope.toolsUsedCount()).toBe(3);
  });

  test("tolerates messages with no events array", () => {
    const $scope = boot();
    $scope.messages = [{ user: "hello" }, { events: [toolEv("get_record")] }];
    expect($scope.toolsUsedCount()).toBe(1);
  });
});
