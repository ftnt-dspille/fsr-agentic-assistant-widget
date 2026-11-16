"use strict";

// ─── Outbound page facts on chat_turn (Phase 1) ─────────────────────────────
// The widget reports raw page facts (the router `page` state name + the
// playbook-editor mount flag); the connector classifies them into a soft
// frontier prior (one affordance taxonomy). `intent` still rides as the soft
// override. These pin that the facts are actually sent.

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

let $controller, $rootScope, $timeout, chatTurnSpy;

function bootWith(stateName) {
  const $state = { current: { name: stateName }, params: { module: "alerts" } };
  chatTurnSpy = jest.fn(() => resolved({ accepted: true, stop_reason: "accepted" }));
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      resolveConnector: () => resolved({ name: "fsr-playbook-builder", version: "1", configId: "c1" }),
      chatHistory: () => resolved({ turns: [] }),
      chatTurn: chatTurnSpy,
      chatPoll: () => resolved({ done: true, frames: [] }),
      execute: () => resolved({}),
      resume: () => resolved({}),
      modeInfo: () => ({ mode: "live", mock_scenario: null }),
    });
    $provide.value("config", { seedFromEntity: false });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $timeout = _$timeout_;
  });
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  try { $timeout.flush(); } catch (e) { /* no pending init timers */ }
  return $scope;
}

function lastPayload() {
  return chatTurnSpy.mock.calls[chatTurnSpy.mock.calls.length - 1][1];
}

describe(`${viewCtrlName} -- outbound page facts`, () => {
  test("a non-editor mount sends the page state name and in_playbook_editor=false", () => {
    const $scope = bootWith("main.modules.list");
    $scope.form.inputText = "triage this alert";
    $scope.sendMessage();

    expect(chatTurnSpy).toHaveBeenCalled();
    const payload = lastPayload();
    expect(payload.page).toBe("main.modules.list");
    expect(payload.in_playbook_editor).toBe(false);
    // intent still rides as the soft override.
    expect(payload.intent).toBe("triage");
  });

  test("a playbook-designer mount reports in_playbook_editor=true and the editor state", () => {
    const $scope = bootWith("main.playbookDetail");
    $scope.form.inputText = "add an error-handling step";
    $scope.sendMessage();

    const payload = lastPayload();
    expect(payload.page).toBe("main.playbookDetail");
    expect(payload.in_playbook_editor).toBe(true);
    expect(payload.intent).toBe("build");
  });
});
