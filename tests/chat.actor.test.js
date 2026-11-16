"use strict";

// ─── Outbound actor identity on chat_turn ───────────────────────────────────
// The connector runs under the service account and can't tell who is chatting,
// so the widget stamps the current SOAR user onto every user-originated call.
// The connector persists it as the message author + session initiator, which is
// what lets history rehydration show the REAL sender instead of the viewer.

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

const $state = { current: { name: "main.modules.list" }, params: { module: "alerts" } };

let $controller, $rootScope, $timeout, chatTurnSpy;

beforeEach(() => {
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
    $controller = _$controller_;
    $rootScope = _$rootScope_;
    $timeout = _$timeout_;
  });
});

function boot() {
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  try { $timeout.flush(); } catch (e) { /* no pending init timers */ }
  return $scope;
}

describe(`${viewCtrlName} - outbound actor`, () => {
  test("stamps the current SOAR user as actor on chat_turn", () => {
    const $scope = boot();
    $scope.initiator = { name: "Dana Lee", iri: "/api/3/people/dana" };
    $scope.form.inputText = "triage this alert";
    $scope.sendMessage();

    expect(chatTurnSpy).toHaveBeenCalled();
    const payload = chatTurnSpy.mock.calls[chatTurnSpy.mock.calls.length - 1][1];
    expect(payload.actor).toEqual({ name: "Dana Lee", iri: "/api/3/people/dana" });
  });

  test("omits actor for the harness placeholder user (no fake initiator persisted)", () => {
    const $scope = boot();
    // leave the default 'Harness user' placeholder in place
    $scope.form.inputText = "hello";
    $scope.sendMessage();

    expect(chatTurnSpy).toHaveBeenCalled();
    const payload = chatTurnSpy.mock.calls[chatTurnSpy.mock.calls.length - 1][1];
    expect(payload.actor).toBeUndefined();
  });
});
