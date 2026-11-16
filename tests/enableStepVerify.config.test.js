"use strict";

// The per-step Verify panel (view.html, `ng-if="config.enableStepVerify"`) was
// unreachable: the flag existed but nothing in the settings form set it. The
// edit controller now defaults it OFF and the form exposes a checkbox. Driven
// through the real edit controller, so removing the default fails here.

global.jasmine = global.jasmine || {};
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef

require("../widget/edit.controller.js");

const fs = require("fs");
const path = require("path");
const widgetInfo = require("../widget/info.json");
const editCtrlName =
  `edit${widgetInfo.name.charAt(0).toUpperCase()}${widgetInfo.name.slice(1)}` +
  `${widgetInfo.version.replace(/\./g, "")}DevCtrl`;
const ng = window.angular; // eslint-disable-line no-undef

// Locals only, exactly as the dashboard's $uibModal supplies them. Never
// $provide `config` globally: that made $injector.get('config') resolve here
// while it throws in the real modal, which hid a Save that did nothing.
function editScope(config, modal) {
  let $controller, $rootScope;
  ng.mock.module("cybersponse");
  ng.mock.inject((_$controller_, _$rootScope_) => {
    $controller = _$controller_; $rootScope = _$rootScope_;
  });
  const $scope = $rootScope.$new();
  const $uibModalInstance = modal || { close: jest.fn(), dismiss: jest.fn() };
  $controller(editCtrlName, { $scope, $uibModalInstance, config });
  return $scope;
}

describe("settings modal: Save and Close", () => {
  test("Save closes the modal with the edited config", () => {
    const modal = { close: jest.fn(), dismiss: jest.fn() };
    const $scope = editScope({ maxTurns: 4 }, modal);
    $scope.config.maxTurns = 7;
    $scope.save();
    expect(modal.close).toHaveBeenCalledTimes(1);
    expect(modal.close.mock.calls[0][0]).toMatchObject({ maxTurns: 7, enableStepVerify: false });
  });

  test("Close dismisses without saving", () => {
    const modal = { close: jest.fn(), dismiss: jest.fn() };
    editScope({}, modal).cancel();
    expect(modal.dismiss).toHaveBeenCalledWith("cancel");
    expect(modal.close).not.toHaveBeenCalled();
  });
});

describe("settings: enableStepVerify", () => {
  test("defaults OFF for a config that has never set it", () => {
    expect(editScope({}).config.enableStepVerify).toBe(false);
  });

  test("an analyst's saved ON survives reopening the settings", () => {
    expect(editScope({ enableStepVerify: true }).config.enableStepVerify).toBe(true);
  });

  test("the settings form binds a control to it", () => {
    const html = fs.readFileSync(path.join(__dirname, "../widget/edit.html"), "utf8");
    expect(html).toMatch(/ng-model="config\.enableStepVerify"/);
  });

  test("the retired defaultCollection setting is gone from the form", () => {
    const html = fs.readFileSync(path.join(__dirname, "../widget/edit.html"), "utf8");
    expect(html).not.toMatch(/defaultCollection/);
  });
});
