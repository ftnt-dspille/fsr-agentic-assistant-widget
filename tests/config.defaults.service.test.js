"use strict";

// ─── The agent service falls back to the same mock scenario as the modal ────
// fsrPbAgentService.modeInfo(cfg) names a scenario when cfg.mockMode is 'mock'
// and cfg.mockScenario is unset. Both controllers always fill mockScenario
// first, so this fallback only answers for a bare config; it must still name
// the scenario the Settings modal defaults to, not a fixture the modal never offers.

global.jasmine = global.jasmine || {};
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef

require("../widget/widgetAssets/js/fsrPbAgent.service.js");
require("../widget/edit.controller.js");

const widgetInfo = require("../widget/info.json");
const versionSlug = widgetInfo.version.replace(/\./g, "");
const editCtrlName = `edit${widgetInfo.name.charAt(0).toUpperCase()}${widgetInfo.name.slice(1)}${versionSlug}DevCtrl`;
const ng = window.angular; // eslint-disable-line no-undef

describe("fsrPbAgentService mock-scenario fallback", () => {
  test("a bare mock config resolves to the scenario the Settings modal defaults to", () => {
    let $controller, $rootScope, service;
    ng.mock.module("cybersponse", ($provide) => {
      $provide.value("fsrPbMockConnectorService", { execute: () => ({}) });
    });
    ng.mock.inject((_$controller_, _$rootScope_, _fsrPbAgentService_) => {
      $controller = _$controller_; $rootScope = _$rootScope_; service = _fsrPbAgentService_;
    });

    const editCfg = {};
    $controller(editCtrlName, {
      $scope: $rootScope.$new(),
      $uibModalInstance: { close: () => {}, dismiss: () => {} },
      config: editCfg,
    });

    expect(editCfg.mockScenario).toBeTruthy();
    expect(service.modeInfo({ mockMode: "mock" }).mock_scenario).toBe(editCfg.mockScenario);
  });
});
