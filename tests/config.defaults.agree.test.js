"use strict";

// ─── Config defaults: the Settings modal and the chat controller agree ───────
// Two controllers supply defaults for the same saved config: the Settings modal
// (edit.controller.js) and the chat controller (view.controller.js). They drifted
// once (createStrategy missing from the modal; mock scenario 'happy_path' in the
// service vs 'playbook_soc_demo' in both controllers). Assert the relationship
// between the two, not only literals, so a change to one side fails here until
// the other follows. The service's own fallback is checked in
// config.defaults.service.test.js.

global.jasmine = global.jasmine || {};
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef

require("../widget/widgetAssets/js/fsrPbRender.js");
require("../widget/view.controller.js");
require("../widget/edit.controller.js");
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
const editCtrlName = `edit${widgetInfo.name.charAt(0).toUpperCase()}${widgetInfo.name.slice(1)}${versionSlug}DevCtrl`;
const ng = window.angular; // eslint-disable-line no-undef

// Keys that both the modal and the chat controller default. Each must agree.
const SHARED_KEYS = [
  "maxTurns", "enableStepVerify", "showUsage", "mockMode",
  "mockScenario", "mockSpeed", "opener", "createStrategy",
];

function resolved(val) {
  return {
    then: function (cb) { return resolved(cb ? cb(val) : val); },
    catch: function () { return resolved(val); },
  };
}

// One injector per test (angular-mocks): boot both controllers against the same
// empty saved config and return the defaults each one wrote onto it.
function bootBoth(savedEdit) {
  const $state = { current: { name: "main.modules.list" }, params: { module: "alerts" } };
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      resolveConnector: () => resolved({ name: "fsr-playbook-builder", version: "1", configId: "c1" }),
      chatHistory: () => resolved({ turns: [] }),
      chatTurn: () => resolved({ accepted: true, stop_reason: "accepted" }),
      chatPoll: () => resolved({ done: true, frames: [] }),
      execute: () => resolved({}),
      resume: () => resolved({}),
      modeInfo: () => ({ mode: "live", mock_scenario: null }),
    });
    $provide.value("$state", $state);
  });
  let $controller, $rootScope, $timeout;
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $timeout = _$timeout_;
  });

  const editCfg = Object.assign({}, savedEdit || {});
  $controller(editCtrlName, {
    $scope: $rootScope.$new(),
    $uibModalInstance: { close: () => {}, dismiss: () => {} },
    config: editCfg,
  });

  const viewScope = $rootScope.$new();
  $controller(viewCtrlName, { $scope: viewScope, config: { seedFromEntity: false } });
  try { $timeout.flush(); } catch (e) { /* no pending init timers */ }

  return { editCfg, viewCfg: viewScope.config };
}

describe("config defaults: the Settings modal and the chat controller agree", () => {
  test("every shared key is defaulted in both, to the same value", () => {
    const { editCfg, viewCfg } = bootBoth();
    for (const key of SHARED_KEYS) {
      expect({ key, value: viewCfg[key] }).toEqual({ key, value: editCfg[key] });
      expect(editCfg[key]).not.toBeUndefined();
    }
  });

  test("createStrategy defaults to 'auto' in the modal too (it was missing there)", () => {
    expect(bootBoth().editCfg.createStrategy).toBe("auto");
  });

  test("a saved config carrying the retired defaultIntent round-trips the modal untouched", () => {
    // defaultIntent was removed from the modal and the chat controller. Nothing
    // reads it, and the modal saves the config object as-is, so an old value
    // survives a save. (sessionScope.controller.test.js covers the chat side.)
    const { editCfg } = bootBoth({ defaultIntent: "build" });
    expect(editCfg.defaultIntent).toBe("build");
  });

  test("the mock scenario default is the SOC demo, not happy_path", () => {
    const { editCfg, viewCfg } = bootBoth();
    expect(editCfg.mockScenario).toBe("playbook_soc_demo");
    expect(viewCfg.mockScenario).toBe("playbook_soc_demo");
  });
});
