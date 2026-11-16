"use strict";

// ─── Track C1: quick-action chip tags the chat_turn payload ───────────────
//
// The 5 build quick-action chips (Explain / Add a step / Find issues / Add
// error handling / Optimize) must each stamp their `key` onto the chat_turn
// payload as `quick_action`, so the connector's build system prompt can
// branch on it (per-quick-action toolset routing). A free-typed turn must
// NOT carry the tag (absent, not null-string). We drive the real controller
// and capture what chatTurn receives.

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

function makeHarness() {
  let $q, $timeout, $rootScope, $controller;
  const sent = [];
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    // The payload is captured synchronously inside runQuickAction → _runTurn →
    // chatTurn, before the promise settles -- so a never-resolving deferred is
    // fine (we never need the turn to complete). Each test resets the gate
    // state runQuickAction checks so the call doesn't no-op.
    chatTurn: (cfg, payload) => { sent.push(payload); return $q.defer().promise; },
    chatPoll: () => $q.defer().promise
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
  $rootScope.$digest();
  return { $scope, sent };
}

describe("fsrAgenticAssistant -- Track C1 quick-action tag", () => {
  test("each build quick-action chip stamps its key onto the payload", () => {
    const { $scope, sent } = makeHarness();
    const chips = $scope.playbookQuickActions;
    expect(chips.length).toBe(6);
    // With a playbook open, the first thing offered is a NEW playbook.
    expect(chips[0].key).toBe("create");
    expect(chips[0].label).toBe("Create a playbook");

    chips.forEach((chip) => {
      sent.length = 0;
      // runQuickAction gates on viewState==='idle' && connectorReady!==false;
      // reset both per chip (a prior call flips viewState to 'sending').
      $scope.viewState = "idle";
      $scope.connectorReady = true;
      $scope.runQuickAction(chip);
      expect(sent).toHaveLength(1);
      expect(sent[0].quick_action).toBe(chip.key);
    });
  });

  test("a free-typed turn does NOT carry a quick_action tag", () => {
    const { $scope, sent } = makeHarness();
    $scope.viewState = "idle";
    $scope.connectorReady = true;
    $scope.form.inputText = "build me a playbook that blocks IOCs";
    $scope.sendMessage();
    expect(sent).toHaveLength(1);
    expect(sent[0].quick_action).toBeUndefined();
  });

  test("the triage chips also tag their key (observability; connector ignores for triage)", () => {
    const { $scope, sent } = makeHarness();
    $scope.viewState = "idle";
    $scope.connectorReady = true;
    $scope.runQuickAction($scope.quickActions[0]);   // 'timeline'
    expect(sent).toHaveLength(1);
    expect(sent[0].quick_action).toBe("timeline");
  });
});
