"use strict";

// ─── Closing the designer's "Steps" palette after a staged Apply ────────────
//
// On a NEW playbook the designer seeds a `placeholderStep` and auto-opens its
// left "Steps" palette so the analyst picks a start step. When the assistant
// stages a build (Apply to designer), it supplies its own Start step, so the
// placeholder is dead weight and its panel just sits over the canvas. The
// widget closes it the way the palette's own Cancel does -- the designer's
// `clearPlaceholderStep()` (id="close-selected-pb-step-btn" in
// app/playbooks/designer/designer.html); dropping `placeholderStep` removes the
// `open` class on #step-collections so the panel closes.
//
// Without that call the palette stays open after Apply (the reported bug), so
// these tests assert clearPlaceholderStep is invoked on a staged Apply and is
// NOT invoked when there is no placeholder or the analyst is mid-edit.

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

const OPEN_IRI = "/api/3/workflows/wf-open-uuid";

// A real designer entity is cyclic and large; staging only needs a few keys
// present (its init reads playbookOrigin['@id'] first), and the merge keeps
// whatever the staged workflow omits.
const BEFORE = {
  "@id": OPEN_IRI,
  uuid: "wf-open-uuid",
  name: "Suspend AI Access",
  collection: "/api/3/workflow_collections/coll-uuid",
  playbookOrigin: { "@id": "/api/3/playbook_origin/custom" },
  steps: {},
  routes: [],
  triggerStep: null,
};

// Minimal staged workflow the connector would return: a Start step for the
// same open playbook.
const STAGED = {
  "@id": OPEN_IRI,
  uuid: "wf-open-uuid",
  name: "Suspend AI Access",
  steps: { s1: { uuid: "s1", name: "Start", "@id": OPEN_IRI + "/workflow_steps/s1" } },
  routes: [],
  triggerStep: { "@id": OPEN_IRI + "/workflow_steps/s1" },
};

// Drive pushPlaybook through the staged-Apply path with a designer present.
// `designer` is the #designer-container scope (what _designerScope resolves);
// callers seed its placeholderStep / stepSelected to pick the branch.
function apply(designerProps) {
  let $q, $rootScope, $controller, $timeout;

  // The designer-detail isolate scope _stageIntoDesigner emits onto.
  const detail = {
    entity: JSON.parse(JSON.stringify(BEFORE)),
    details: { $dirty: false },
    emitted: [],
    $emit(...args) { this.emitted.push(args); },
  };
  const detailEl = document.createElement("div");
  detailEl.setAttribute("data-cs-designer-detail", "playbook");
  document.body.appendChild(detailEl);
  ng.element(detailEl).data("$isolateScope", detail);

  const calls = [];
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      resolveConnector: () => $q.when({ name: "c", version: "1", configId: "c" }),
      modeInfo: () => ({ mode: "live", mock_scenario: null }),
      chatHistory: () => $q.when({ turns: [] }),
      pushPlaybook: () => $q.reject(new Error("must not create")),
      updatePlaybook: (cfg, yaml, iri, sid, opts) => {
        calls.push(opts);
        return $q.when({ ok: true, staged: true, workflow: JSON.parse(JSON.stringify(STAGED)),
                         workflow_iri: OPEN_IRI, workflow_uuid: BEFORE.uuid });
      },
    });
    $provide.value("config", {});
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $q = _$q_; $timeout = _$timeout_;
  });

  // #designer-container with a PlaybookDesignerCtrl-shaped scope: _designerScope
  // walks up looking for a scope with refresh() + originalPlaybook.
  const designer = $rootScope.$new();
  designer.refresh = function () {};
  designer.originalPlaybook = JSON.parse(JSON.stringify(BEFORE));
  designer.playbook = { placeholderStep: null };
  designer.stepSelected = null;
  designer.clearPlaceholderStep = jest.fn(function () { designer.playbook.placeholderStep = null; });
  Object.assign(designer, designerProps, {
    playbook: Object.assign({ placeholderStep: null }, (designerProps || {}).playbook),
  });
  const designerEl = document.createElement("div");
  designerEl.id = "designer-container";
  document.body.appendChild(designerEl);
  ng.element(designerEl).data("$scope", designer);

  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  $scope.inPlaybookEditor = true;
  $scope.entityContext = { iri: OPEN_IRI, module: "workflows" };
  $scope.currentYaml = "collection: x\nplaybooks: []\n";
  $scope.pushPlaybook();
  $rootScope.$apply();

  const staged = detail.emitted.length === 1;
  detailEl.remove();
  designerEl.remove();
  expect(calls).toEqual([{ stage: true }]);  // the stage path ran
  expect(staged).toBe(true);
  return designer;
}

describe("closing the step palette after a staged Apply", () => {
  test("clears the placeholder (closes the palette) when one is open", () => {
    const designer = apply({ playbook: { placeholderStep: { uuid: "ph" } } });
    expect(designer.clearPlaceholderStep).toHaveBeenCalledTimes(1);
    expect(designer.playbook.placeholderStep).toBeNull();
  });

  test("leaves the palette alone when the analyst is mid-edit in a step form", () => {
    const designer = apply({
      playbook: { placeholderStep: { uuid: "ph" } },
      stepSelected: { uuid: "s9" },
    });
    expect(designer.clearPlaceholderStep).not.toHaveBeenCalled();
  });

  test("does nothing when there is no placeholder open", () => {
    const designer = apply({ playbook: { placeholderStep: null } });
    expect(designer.clearPlaceholderStep).not.toHaveBeenCalled();
  });
});
