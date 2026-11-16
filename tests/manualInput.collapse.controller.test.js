"use strict";

// submitManualInput collapses the card's UI-model values into workflow field
// values: a dynamic_list field edited via two helper keys (name__group /
// name__item) becomes a single [group, item] array under `name`; helper keys
// are dropped; other fields pass through. This is the widget half of the
// awaiting-form card loop (connector forwards via pyfsr answer()).

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

function boot() {
  let $q, $rootScope, $controller, $timeout;
  const calls = [];
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "x", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "manual_input_form" }),
    chatHistory: () => $q.when({ turns: [] }),
    listSessions: () => $q.when({ sessions: [] }),
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when({ frames: [] }),
    respondManualInput: (cfg, payload) => {
      calls.push(payload);
      return $q.when({ ok: true, transcript: [], stop_reason: "end_turn" });
    },
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
  return { $scope, calls, digest: () => $rootScope.$digest() };
}

function manualCard() {
  const R = require("../widget/widgetAssets/js/fsrPbRender.js");
  const fields = R.normalizeManualFields([
    { name: "pick", label: "Group and item", type: "dynamic_list",
      groups: [{ value: "Group A", options: ["a-one", "a-two"] },
               { value: "Group B", options: ["b-one"] }] },
    { name: "verbose", label: "Verbose", type: "checkbox" },
    { name: "note", label: "Note", type: "text" },
  ]);
  return {
    type: "manual_input", inputId: "126",
    workflowRunIri: "/wf/api/workflows/2971/",
    fields: fields, values: R.seedFieldValues(fields),
    _resolved: false, _open: true,
  };
}

describe("manual_input submit - value collapse", () => {
  test("dynamic_list pair collapses to [group, item]; helpers dropped", () => {
    const { $scope, calls, digest } = boot();
    const card = manualCard();
    card.values.pick__group = "Group A";
    card.values.pick__item = "a-two";
    card.values.verbose = true;
    card.values.note = "hello";

    $scope.submitManualInput(card);
    digest();

    expect(calls).toHaveLength(1);
    expect(calls[0].input_id).toBe("126");
    expect(calls[0].decision).toBe("approve");
    expect(calls[0].values).toEqual({
      pick: ["Group A", "a-two"], verbose: true, note: "hello",
    });
    // helper keys never leak to the workflow
    expect(calls[0].values.pick__group).toBeUndefined();
    expect(card._resolved).toBe(true);
  });

  test("no selection submits an empty array for the dynamic_list", () => {
    const { $scope, calls, digest } = boot();
    const card = manualCard();  // nothing picked
    $scope.submitManualInput(card);
    digest();
    expect(calls[0].values.pick).toEqual([]);
  });
});
