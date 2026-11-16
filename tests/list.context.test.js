"use strict";

// ─── Module LIST mount: context + its own deck ──────────────────────────────
// Over a module list (main.modules.list, no record open) the drawer used to
// carry NO context: no entity on chat_turn, no persona, no cards -- only a
// record page got any of it. A list page still names a module, so the drawer
// now works in that module: it sends `entity: {module, view: 'list'}`, resolves
// the module's persona, and shows a list deck ("Create new <record>", ...)
// instead of record cards that need a record open.

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
    finally: function (cb) { if (cb) cb(); return resolved(val); },
  };
}

const MODULE = "ztpf_automation_profiles";
const NAMES = { [MODULE]: { singular: "Automation Profile", plural: "Automation Profiles" } };

let $controller, $rootScope, $timeout, chatTurnSpy, resolvePersonaSpy, $state;

function boot({ persona = null, metadata = true, state } = {}) {
  $state = state || { current: { name: "main.modules.list" }, params: { module: MODULE } };
  chatTurnSpy = jest.fn(() => resolved({ accepted: true, stop_reason: "accepted" }));
  resolvePersonaSpy = jest.fn(() => resolved(persona));
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      resolveConnector: () => resolved({ name: "c", version: "1", configId: "c1" }),
      resolvePersona: resolvePersonaSpy,
      chatHistory: () => resolved({ turns: [] }),
      chatTurn: chatTurnSpy,
      chatPoll: () => resolved({ done: true, frames: [] }),
      execute: () => resolved({}),
      resume: () => resolved({}),
      modeInfo: () => ({ mode: "live", mock_scenario: null }),
    });
    $provide.value("config", { seedFromEntity: false });
    $provide.value("$state", $state);
    if (metadata) {
      $provide.value("modelMetadatasService", {
        getModuleNameByType: (types, plural) => types
          .filter((t) => NAMES[t])
          .map((t) => ({ type: t, name: plural ? NAMES[t].plural : NAMES[t].singular })),
      });
    }
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $timeout = _$timeout_;
  });
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  try { $timeout.flush(); } catch (e) { /* no pending init timers */ }
  $scope.$digest();
  return $scope;
}

function lastPayload() {
  return chatTurnSpy.mock.calls[chatTurnSpy.mock.calls.length - 1][1];
}

describe(`${viewCtrlName} -- module LIST mount`, () => {
  test("works in the listed module: listContext, persona lookup, list entity on chat_turn", () => {
    const $scope = boot();
    expect($scope.entityContext).toBeNull();
    expect($scope.listContext).toEqual({ module: MODULE });
    expect(resolvePersonaSpy).toHaveBeenCalledWith(expect.anything(), MODULE);

    $scope.form.inputText = "which of these failed last night?";
    $scope.sendMessage();
    expect(lastPayload().entity).toEqual({ module: MODULE, view: "list" });
    expect(lastPayload().page).toBe("main.modules.list");
  });

  test("shows the list deck (named from module metadata), never the record decks", () => {
    const $scope = boot();
    expect($scope.showListQuickActions()).toBe(true);
    expect($scope.showQuickActions()).toBe(false);
    expect($scope.showPersonaQuickActions()).toBe(false);
    const labels = $scope.listQuickActions().map((q) => q.label);
    expect(labels).toContain("Create new Automation Profile");
    expect(labels).toContain("Summarize Automation Profiles");
    expect($scope.heroHeading()).toBe("Working in Automation Profiles");
  });

  test("the default deck is one stable array (ng-repeat over a fresh array never settles)", () => {
    const $scope = boot();
    expect($scope.listQuickActions()).toBe($scope.listQuickActions());
  });

  test("falls back to the module type when the metadata service is absent", () => {
    const $scope = boot({ metadata: false });
    const labels = $scope.listQuickActions().map((q) => q.label);
    expect(labels).toContain("Create new ztpf automation profile");
  });

  test("a persona's ui.listQuickActions replaces the default deck", () => {
    const own = [{ key: "new_profile", label: "New profile", sub: "s", prompt: "p" }];
    const $scope = boot({ persona: { label: "ZTPF", listQuickActions: own, listLabel: "Profiles" } });
    expect($scope.listQuickActions()).toBe(own);
    expect($scope.listDeckLabel()).toBe("Profiles");
  });

  test("list -> record drops the list context; record -> list restores it", () => {
    const $scope = boot();
    $state.current = { name: "viewPanel.modulesDetail" };
    $state.params = { module: MODULE, id: "p-1" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();
    expect($scope.listContext).toBeNull();
    expect($scope.entityContext.module).toBe(MODULE);
    expect($scope.showListQuickActions()).toBe(false);

    $state.current = { name: "main.modules.list" };
    $state.params = { module: MODULE };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();
    expect($scope.listContext).toEqual({ module: MODULE });
    expect($scope.entityContext).toBeNull();
    expect($scope.showListQuickActions()).toBe(true);
  });

  test("a dashboard mount (not a list) gets no list context", () => {
    const $scope = boot({ state: { current: { name: "main.dashboard" }, params: {} } });
    expect($scope.listContext).toBeNull();
    expect($scope.showListQuickActions()).toBe(false);
  });
});
