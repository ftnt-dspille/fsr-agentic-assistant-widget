"use strict";

// ─── verdict_card evidence chips and recommended-action buttons ─────────────
// Behavior of the surviving $scope.scrollToToolCall / $scope.applyRecommendedAction
// definitions (the other copies were dead). Asserts what the analyst sees:
// the evidence block scrolls into view and flashes, and a recommended action
// fills the composer and focuses the textarea the template actually renders
// (`.composer textarea` in view.html).

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

function resolved(val) {
  return {
    then: function (cb) { return resolved(cb ? cb(val) : val); },
    catch: function () { return resolved(val); },
  };
}

function bootScope() {
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
    $provide.value("config", { seedFromEntity: false });
    $provide.value("$state", $state);
  });
  let $controller, $rootScope, $timeout;
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $timeout = _$timeout_;
  });
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  try { $timeout.flush(); } catch (e) { /* no pending init timers */ }
  return { $scope, $timeout };
}

describe(`${viewCtrlName} -- verdict_card interactions`, () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("scrollToToolCall scrolls the matching tool block into view and flashes it", () => {
    const { $scope, $timeout } = bootScope();
    document.body.innerHTML = '<div data-tool-use-id="tu-42">step</div>';
    const el = document.querySelector('[data-tool-use-id="tu-42"]');
    el.scrollIntoView = jest.fn();

    $scope.scrollToToolCall("tu-42");

    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(el.classList.contains("evidence-highlight")).toBe(true);
    $timeout.flush();
    expect(el.classList.contains("evidence-highlight")).toBe(false);
  });

  test("scrollToToolCall is a no-op for an id with no block in the transcript", () => {
    const { $scope } = bootScope();
    document.body.innerHTML = '<div data-tool-use-id="tu-1">step</div>';
    expect(() => $scope.scrollToToolCall("tu-missing")).not.toThrow();
    expect(document.querySelector(".evidence-highlight")).toBeNull();
  });

  test("applyRecommendedAction fills the composer and focuses the rendered textarea", () => {
    const { $scope, $timeout } = bootScope();
    document.body.innerHTML = '<div class="composer"><textarea></textarea></div>';
    const ta = document.querySelector(".composer textarea");

    $scope.applyRecommendedAction({ label: "Block 198.51.100.12 at the edge" });
    expect($scope.form.inputText).toBe("Block 198.51.100.12 at the edge");
    $timeout.flush();
    expect(document.activeElement).toBe(ta);
  });

  test("applyRecommendedAction ignores an action with no label", () => {
    const { $scope } = bootScope();
    $scope.form.inputText = "draft";
    $scope.applyRecommendedAction({});
    $scope.applyRecommendedAction(null);
    expect($scope.form.inputText).toBe("draft");
  });
});
