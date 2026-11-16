"use strict";

// ─── Outbound create-method strategy on chat_turn ───────────────────────────
// The Settings "Playbook build method" toggle (config.createStrategy) rides the
// chat_turn payload so the connector can narrow the build tool slice. Default is
// 'auto' when no config value is saved; an explicit choice is sent verbatim.

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

function bootWith(cfg) {
  const $state = { current: { name: "main.modules.list" }, params: { module: "alerts" } };
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
    $provide.value("config", cfg || { seedFromEntity: false });
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

describe(`${viewCtrlName} -- create-method strategy`, () => {
  test("defaults to 'auto' and sends it when no config value is saved", () => {
    const $scope = bootWith({ seedFromEntity: false });
    expect($scope.config.createStrategy).toBe("auto");
    $scope.form.inputText = "build a block-ip playbook";
    $scope.sendMessage();
    expect(lastPayload().create_strategy).toBe("auto");
  });

  test("an explicit guided choice rides the payload verbatim", () => {
    const $scope = bootWith({ seedFromEntity: false, createStrategy: "guided" });
    $scope.form.inputText = "build a block-ip playbook";
    $scope.sendMessage();
    expect(lastPayload().create_strategy).toBe("guided");
  });

  test("an explicit freeform choice rides the payload verbatim", () => {
    const $scope = bootWith({ seedFromEntity: false, createStrategy: "freeform" });
    $scope.form.inputText = "build a block-ip playbook";
    $scope.sendMessage();
    expect(lastPayload().create_strategy).toBe("freeform");
  });
});
