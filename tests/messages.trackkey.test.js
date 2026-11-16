"use strict";

// ─── Stable per-message track-by key (Phase 1.4) ────────────────────────────
//
// HIGH / state bleed: the messages ng-repeat used `track by $index`, so a full
// array rebuild (history reload / rehydrate) re-bound each row BY POSITION and
// one message's per-event card state (_open/_picked/_resolved) bled onto the
// message now at that index. chatMessages() now stamps a stable, monotonic
// `_key` on each message (persisted on the object), so track-by follows the
// object across rebuilds.

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
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when({ turn: 1, transcript: [] })
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
  return { $scope };
}

test("each message gets a unique, stable _key that survives an array rebuild", () => {
  const { $scope } = makeHarness();
  const a = { role: "user", text: "one", events: [] };
  const b = { role: "assistant", text: "two", events: [] };
  const c = { role: "user", text: "three", events: [] };
  $scope.messages = [a, b, c];

  $scope.chatMessages();                       // stamps keys
  const keys = [a._key, b._key, c._key];
  expect(new Set(keys).size).toBe(3);          // unique
  expect(keys.every((k) => typeof k === "string")).toBe(true);

  // Rebuild the array (rehydrate): same objects, new array + reordered.
  $scope.messages = [c, a, b];
  $scope.chatMessages();
  expect([a._key, b._key, c._key]).toEqual(keys); // each object kept its key

  // A brand-new message at a previously-used index gets its OWN key (no reuse).
  const d = { role: "assistant", text: "four", events: [] };
  $scope.messages = [d];
  $scope.chatMessages();
  expect(keys).not.toContain(d._key);
});
