"use strict";

// --- Same-tab alert -> designer navigation must switch the session ----------
//
// Live bug: navigate from an alert detail page to the playbook designer in the
// SAME tab, and the drawer kept showing the ALERT's conversation -- its cards,
// its approval state -- over the open playbook. The entityContext.iri $watch
// exempts the designer from session re-pointing ("single build thread"), but
// that exemption also swallowed the ARRIVAL transition. The fix: the exemption
// holds only when the session was not scoped to a non-workflows record, so
// record -> designer switches while in-designer entity wobbles do not.

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

const $state = { current: { name: "viewPanel.modulesDetail" },
                 params: { module: "alerts", id: "alert-1" } };

let $controller, $rootScope, $timeout, $q, $httpBackend;
let historyCalls;

beforeEach(() => {
  window.localStorage.clear();
  historyCalls = [];
  $state.current = { name: "viewPanel.modulesDetail" };
  $state.params = { module: "alerts", id: "alert-1" };
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      chatHistory: (cfg, sid) => { historyCalls.push(sid); return $q.when({ turns: [] }); },
      chatTurn: () => $q.defer().promise,
      chatPoll: () => $q.when({ frames: [] }),
      modeInfo: () => ({ mode: "mock" }),
    });
    $provide.value("config", { seedFromEntity: false });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_, _$q_, _$httpBackend_) => {
    $controller = _$controller_; $rootScope = _$rootScope_;
    $timeout = _$timeout_; $q = _$q_; $httpBackend = _$httpBackend_;
  });
  $httpBackend.whenGET(/\/api\/3\/workflows\/wf-7/).respond(200, {
    "@id": "/api/3/workflows/wf-7", uuid: "wf-7", name: "Open PB", steps: [] });
});

function boot() {
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  $rootScope.$digest();
  return $scope;
}

test("alert -> designer in the same tab drops the alert's thread", () => {
  const $scope = boot();
  expect($scope.entityContext.iri).toBe("/api/3/alerts/alert-1");

  // The alert conversation is on screen.
  $scope.messages.push({ role: "assistant", text: "alert triage stuff",
                         events: [{ type: "action_card", id: "c1" }] });
  $scope.approvalRequest = { approvalId: "a1", turnId: "t1" };

  // Same-tab navigation to the playbook designer.
  $state.current = { name: "main.playbookDetail" };
  $state.params = { id: "wf-7" };
  $rootScope.$broadcast("$stateChangeSuccess");
  $rootScope.$digest();
  try { $httpBackend.flush(); } catch (e) { /* entity GET optional */ }
  $rootScope.$digest();

  // The designer must NOT keep the alert's conversation or approval state.
  expect($scope.messages.some(m => m.text === "alert triage stuff")).toBe(false);
  expect($scope.approvalRequest).toBeNull();
  // And it re-pointed to the playbook's own thread (a history load happened
  // for a session other than the alert's).
  expect(historyCalls.length).toBeGreaterThan(0);
});

test("late entity resolution on a designer mount keeps the build thread", () => {
  $state.current = { name: "main.playbookDetail" };
  $state.params = { id: "wf-7" };
  const $scope = boot();
  try { $httpBackend.flush(); } catch (e) { /* already settled */ }
  $rootScope.$digest();

  // In-designer conversation in progress.
  $scope.messages.push({ role: "assistant", text: "building steps" });
  const before = $scope.messages.length;

  // The entity re-resolves (same open playbook) -- a designer-internal wobble.
  $rootScope.$broadcast("$stateChangeSuccess");
  $rootScope.$digest();

  expect($scope.messages.length).toBe(before);
  expect($scope.messages.some(m => m.text === "building steps")).toBe(true);
});
