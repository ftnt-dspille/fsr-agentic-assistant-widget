"use strict";

// ─── A card someone else already answered ───────────────────────────────────
//
// The connector decides each card once (a central reviewer in the Monitor
// queue, or a second tab, may answer first) and refuses a later answer with
// {ok:false, error:{code:"already_decided", message, decided}}. The action
// card used to stamp "Confirmed by <me>" on any resolved promise, so the chat
// would have shown an approval this analyst never made, for a card the
// reviewer had REJECTED. It now shows the earlier decision and who made it.

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
const R = window.FsrPbRender; // eslint-disable-line no-undef

const TAKEN = {
  ok: false,
  error: { code: "already_decided",
           message: "This card was already rejected by Lead Analyst; it runs at most once.",
           decided: { decision: "reject", actor: "Lead Analyst", decided_at: 1790000000 } }
};

function boot(resume) {
  let $q, $rootScope, $controller, $timeout;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when({}),
    chatResume: () => $q.when(resume)
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
  return { $scope, $rootScope };
}

test("an action card rejected in the queue shows that rejection, not my approval", () => {
  const { $scope, $rootScope } = boot(TAKEN);
  const card = R.normalizeActionCard(
    { type: "action_card", id: "card-1", tool: "update_record", summary: "Change description", args: {} },
    { now: () => 1 });
  $scope.messages.push({ role: "assistant", text: "", events: [card], ts: 1 });
  $scope.confirmActionCard(card);
  $rootScope.$digest();
  expect(card._resolved).toBe(true);
  expect(card._outcome).toBe("reject");
  expect(card._resolvedBy).toBe("Lead Analyst");
  expect(card._resolutionText).toBe("Already rejected");
  expect(card._decidedElsewhere).toBe(true);
});

test("an action card that resumes normally is still stamped with this analyst's decision", () => {
  const { $scope, $rootScope } = boot({ ok: true, stop_reason: "end_turn", transcript: [] });
  const card = R.normalizeActionCard(
    { type: "action_card", id: "card-2", tool: "update_record", summary: "Change description", args: {} },
    { now: () => 1 });
  $scope.messages.push({ role: "assistant", text: "", events: [card], ts: 1 });
  $scope.confirmActionCard(card);
  $rootScope.$digest();
  expect(card._outcome).toBe("approve");
  expect(card._decidedElsewhere).toBeUndefined();
});
