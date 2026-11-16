"use strict";

// ─── Staging into the REAL designer: the contract, on captured payloads ─────
//
// The other staging tests use a hand-built designer stand-in, and that is how
// the blank-canvas crash shipped: the stand-in had no `playbookOrigin`, so a
// staged `playbookOrigin: null` merged over the real one passed every test and
// then threw `null reading '@id'` in the designer's init on a box.
//
// fixtures/designerStage.real.json is the real thing, captured from a live 8.0
// designer: the entity as init left it (`before`), the connector's staged
// workflow (`staged`, YAML Start -> Note A -> Note B) and the entity after the
// widget staged it (`after`). This drives the widget's real code path with
// `before` as the designer and checks what init needs from the merged body:
//   - no designer key that had a value comes back null (the crash class);
//   - every route endpoint and the trigger resolve to a step the way init's
//     route lookup does -- by `@id`, or `workflow_steps/<uuid>` for a NEW step
//     that has no `@id` yet (Note B here);
//   - the chain that resolves is the chain the real designer drew (`after`).
//
// Regenerate the fixture: run `make test-designer-stage-live` -- it drives the
// same flow on a scratch playbook and writes a fresh capture next to its
// report (tests/live/captures/designerStage.capture.json); copy it here after
// scrubbing users/versions.

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

const REAL = require("./fixtures/designerStage.real.json");
const widgetInfo = require("../widget/info.json");
const viewCtrlName = `${widgetInfo.name}${widgetInfo.version.replace(/\./g, "")}DevCtrl`;
const ng = window.angular; // eslint-disable-line no-undef
const clone = (o) => JSON.parse(JSON.stringify(o));

// The designer entity is cyclic (routes hold the step objects); the capture
// stored those as {$ref: <step @id>}. Put the object references back.
function rehydrate(entity) {
  const e = clone(entity);
  const byId = {};
  Object.values(e.steps).forEach((s) => { byId[s["@id"]] = s; });
  e.routes = e.routes.map((r) => Object.assign(r, {
    sourceStep: byId[r.sourceStep.$ref], targetStep: byId[r.targetStep.$ref] }));
  return e;
}

// How the designer's init finds a route's step: by `@id`, else by the
// `workflow_steps/<uuid>` tail for a step created in this edit (KB §18.9).
function resolveStep(ref, steps) {
  const iri = typeof ref === "string" ? ref : ref && ref["@id"];
  return steps.find((s) => (s["@id"] && s["@id"] === iri)
    || (iri && iri.endsWith("workflow_steps/" + (s._oldUuid || s.uuid))));
}

function stage(stagedWorkflow) {
  let $q, $rootScope, $controller, $timeout;
  const detail = { entity: rehydrate(REAL.before), details: { $dirty: false }, emitted: [],
                   $emit(...args) { this.emitted.push(args); } };
  const el = document.createElement("div");
  el.setAttribute("data-cs-designer-detail", "playbook");
  document.body.appendChild(el);
  ng.element(el).data("$isolateScope", detail);
  const calls = [];
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      resolveConnector: () => $q.when({ name: "c", version: "1", configId: "c" }),
      modeInfo: () => ({ mode: "live", mock_scenario: null }),
      chatHistory: () => $q.when({ turns: [] }),
      pushPlaybook: () => $q.reject(new Error("must not create")),
      updatePlaybook: (cfg, yaml, iri, sid, opts) => {
        calls.push(opts);
        return $q.when({ ok: true, staged: true, workflow: stagedWorkflow,
                         workflow_iri: REAL.before["@id"], workflow_uuid: REAL.before.uuid });
      },
    });
    $provide.value("config", {});
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $q = _$q_; $timeout = _$timeout_;
  });
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  $scope.inPlaybookEditor = true;
  $scope.entityContext = { iri: REAL.before["@id"], module: "workflows" };
  $scope.currentYaml = "collection: x\nplaybooks: []\n";
  $scope.pushPlaybook();
  $rootScope.$apply();
  el.remove();
  expect(calls).toEqual([{ stage: true }]);
  expect(detail.emitted).toHaveLength(1);
  return { merged: detail.emitted[0][1], detail };
}

const chain = (routes, steps) => routes.map((r) =>
  `${resolveStep(r.sourceStep, steps).name}->${resolveStep(r.targetStep, steps).name}`);

describe("staging a real connector payload into the real designer entity", () => {
  test("no designer key that had a value is replaced by null", () => {
    const { merged } = stage(clone(REAL.staged));
    for (const [k, v] of Object.entries(REAL.before)) {
      if (v !== null && v !== undefined) expect([k, merged[k]]).not.toEqual([k, null]);
    }
    expect(typeof merged.playbookOrigin).toBe("object");
    expect(merged["@id"]).toBe(REAL.before["@id"]);
    expect(merged.collection).toBe(REAL.before.collection);
  });

  test("every route and the trigger resolve the way the designer's init looks them up", () => {
    const { merged } = stage(clone(REAL.staged));
    const steps = merged.steps;
    for (const r of merged.routes) {
      expect(resolveStep(r.sourceStep, steps)).toBeTruthy();
      expect(resolveStep(r.targetStep, steps)).toBeTruthy();
    }
    expect(resolveStep(merged.triggerStep, steps)).toBeTruthy();
    // The new step has no @id yet -- only the workflow_steps/<uuid> path finds it.
    const noteB = steps.find((s) => s.name === "Note B");
    expect(noteB["@id"]).toBeFalsy();
  });

  test("the chain that resolves is the chain the real designer drew", () => {
    const { merged, detail } = stage(clone(REAL.staged));
    const after = rehydrate(REAL.after);
    const drawn = after.routes.map((r) => `${r.sourceStep.name}->${r.targetStep.name}`);
    expect(drawn).toEqual(["Start->Note A", "Note A->Note B"]);
    expect(chain(merged.routes, merged.steps)).toEqual(drawn);
    expect(detail.details.$dirty).toBe(true);           // the analyst's Save is armed
  });

  test("a top-level null from the producer cannot blank the canvas", () => {
    // The live crash, replayed: the connector used to send playbookOrigin: null.
    const bad = Object.assign(clone(REAL.staged), { playbookOrigin: null, collection: undefined });
    const { merged } = stage(bad);
    expect(merged.playbookOrigin).toEqual(REAL.before.playbookOrigin);
    expect(merged.collection).toBe(REAL.before.collection);
  });
});
