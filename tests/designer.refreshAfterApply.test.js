"use strict";

// ─── An applied edit shows up in the designer the analyst has open ──────────
//
// Apply writes the playbook server-side, but the designer loaded its copy once
// and never re-reads it: the canvas kept the old steps until a page reload, so
// the analyst saw nothing happen. After a `playbook_updated` card for the OPEN
// playbook, the widget swaps the saved copy into the canvas through the
// designer's own refresh() -- baseline first, so the new steps keep their ids --
// unless the canvas has unsaved edits, which it must not clobber.

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
  return { then: (cb) => resolved(cb ? cb(val) : val), catch: () => resolved(val) };
}
const chainable = { then: () => chainable, catch: () => chainable };

const SAVED = { "@id": "/api/3/workflows/pb-1", name: "My Playbook",
                steps: [{ name: "Start" }, { name: "Block IP" }], routes: [] };

let $controller, $rootScope, $httpBackend, RESUME, designer, container, SENT, detailEl, detail;

function updatedCard(iri) {
  return { stop_reason: "end_turn", transcript: [
    { type: "text", text: "Applied." },
    { type: "info_card", variant: "playbook_updated", title: "Updated", workflow_iri: iri },
  ] };
}

beforeEach(() => {
  RESUME = updatedCard("/api/3/workflows/pb-1");
  SENT = [];
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      execute: () => chainable, chatHistory: () => chainable,
      chatResume: (cfg, payload) => { SENT.push(payload); return resolved(RESUME); },
      modeInfo: () => ({ mode: "live", mock_scenario: null }),
    });
    $provide.value("config", { seedFromEntity: true });
    $provide.value("$state", { current: { name: "main.playbookDetail" }, params: { id: "pb-1" } });
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$httpBackend_) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
    $httpBackend = _$httpBackend_;
  });
  $httpBackend.whenGET(/\/api\/3\/workflows\/pb-1/).respond(200, SAVED);
  $httpBackend.whenGET(/.*/).respond(200, {});

  // A stand-in for PlaybookDesignerCtrl's scope on #designer-container.
  designer = { originalPlaybook: { steps: [{ name: "Start" }] }, refreshed: null,
               refresh(pb) { this.refreshed = pb; } };
  container = document.createElement("div");
  container.id = "designer-container";
  document.body.appendChild(container);
  ng.element(container).data("$scope", designer);
});

afterEach(() => { container.remove(); if (detailEl) { detailEl.remove(); detailEl = null; } });

// The csDesignerDetail directive: isolated scope, owns the `details` form.
function mountDetail() {
  detail = { entity: { "@id": "/api/3/workflows/pb-1", uuid: "pb-1", versions: [1], steps: [] },
             details: { $dirty: false }, previousChanges: [], emitted: [],
             $emit(...args) { this.emitted.push(args); } };
  detailEl = document.createElement("div");
  detailEl.setAttribute("data-cs-designer-detail", "playbook");
  document.body.appendChild(detailEl);
  ng.element(detailEl).data("$isolateScope", detail);
}

const STAGED_PB = { steps: [{ name: "Start", stepType: { name: "Start" } }], routes: [], groups: [] };

function bootAndApply() {
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $scope.viewState = "idle";
  $scope.acceptEnhancementOffer({ offerId: "e1", type: "enhancement_offer" });
  $httpBackend.flush();
  return $scope;
}

describe(`${viewCtrlName} -- designer refresh after Apply`, () => {
  test("the saved playbook replaces the canvas, baseline first", () => {
    bootAndApply();
    expect(designer.refreshed).toEqual(SAVED);
    expect(designer.originalPlaybook).toEqual(SAVED);
    expect(designer.originalPlaybook).not.toBe(SAVED);   // a copy, not the live object
  });

  test("unsaved canvas edits block Apply before anything is written", () => {
    designer.stepForm = { $dirty: true };
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    $scope.viewState = "idle";
    const ev = { offerId: "e1", type: "enhancement_offer" };
    $scope.acceptEnhancementOffer(ev);
    expect(SENT).toHaveLength(0);
    expect(designer.refreshed).toBe(null);
    expect(ev._blockedText).toMatch(/Save or discard/);
  });

  test("an update to a different playbook does not touch this canvas", () => {
    RESUME = updatedCard("/api/3/workflows/other-9");
    bootAndApply();
    expect(designer.refreshed).toBe(null);
  });

  test("a turn with no update card leaves the designer alone", () => {
    RESUME = { stop_reason: "end_turn", transcript: [{ type: "text", text: "Not applied." }] };
    bootAndApply();
    expect(designer.refreshed).toBe(null);
  });
});

describe(`${viewCtrlName} -- Apply from the designer stages unsaved changes`, () => {
  beforeEach(() => {
    mountDetail();
    RESUME = { stop_reason: "end_turn", transcript: [
      { type: "text", text: "Review and click Save." },
      { type: "info_card", variant: "playbook_staged", workflow_iri: "/api/3/workflows/pb-1",
        version_uuid: "v-1", workflow: STAGED_PB },
    ] };
  });

  test("asks the connector to stage, then loads the playbook into the canvas unsaved", () => {
    bootAndApply();
    expect(SENT[0].apply_to).toBe("canvas");
    expect(SENT[0].workflow_iri).toBe("/api/3/workflows/pb-1");
    expect(detail.emitted).toHaveLength(1);
    const [evt, pb, keepIds, ...rest] = detail.emitted[0];
    expect(evt).toBe("designerDetail:entityUpdated");
    expect(rest).toEqual([]);                       // never "snapshot"
    expect(keepIds).toBe(true);
    expect(pb.steps).toEqual(STAGED_PB.steps);      // the agent's playbook...
    expect(pb.versions).toEqual([1]);               // ...over the designer's own entity
    expect(detail.details.$dirty).toBe(true);       // Save is the analyst's
  });

  test("unsaved canvas edits block Apply -- nothing is sent", () => {
    detail.details.$dirty = true;
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    $scope.viewState = "idle";
    const ev = { offerId: "e1", type: "enhancement_offer" };
    $scope.acceptEnhancementOffer(ev);
    expect(SENT).toHaveLength(0);
    expect(ev._resolved).not.toBe(true);
    expect(ev._blockedText).toMatch(/Save or discard/);
  });
});

// Live: Apply #1 staged a draft into the canvas (unsaved, by design); the
// analyst asked for changes and Apply #2 was blocked by "Save or discard" --
// the only unsaved edits were the assistant's own Apply #1. And turn 2 edited
// the SAVED (empty) playbook, not the canvas, so every edit_playbook failed
// with "the open playbook has no steps yet".
describe(`${viewCtrlName} -- a second Apply over the assistant's own staged draft`, () => {
  beforeEach(() => {
    mountDetail();
    RESUME = { stop_reason: "end_turn", transcript: [
      { type: "info_card", variant: "playbook_staged", workflow_iri: "/api/3/workflows/pb-1",
        version_uuid: "v-1", workflow: STAGED_PB, yaml: "collection: C\nplaybooks: [draft1]\n" },
    ] };
  });

  test("the staged draft becomes the open playbook the next turn edits", () => {
    const $scope = bootAndApply();
    expect($scope.playbookYaml).toBe("collection: C\nplaybooks: [draft1]\n");
  });

  test("Apply #2 replaces the assistant's own unsaved draft", () => {
    const $scope = bootAndApply();
    $scope.viewState = "idle";
    const ev = { offerId: "e2", type: "enhancement_offer" };
    $scope.acceptEnhancementOffer(ev);
    expect(ev._blockedText).toBeFalsy();
    expect(SENT.map((p) => p.offer_id)).toEqual(["e1", "e2"]);
  });

  test("an analyst edit on top of the staged draft still blocks Apply #2", () => {
    const $scope = bootAndApply();
    detail.previousChanges.push({ by: "analyst" });
    $scope.viewState = "idle";
    const ev = { offerId: "e2", type: "enhancement_offer" };
    $scope.acceptEnhancementOffer(ev);
    expect(ev._blockedText).toMatch(/Save or discard/);
    expect(SENT).toHaveLength(1);
  });
});

// Live: the designer's Save marks the form pristine but keeps previousChanges
// (its undo history). Apply after a Save was blocked on a clean canvas.
describe(`${viewCtrlName} -- Apply after the analyst saved in the designer`, () => {
  beforeEach(() => { mountDetail(); RESUME = { stop_reason: "end_turn", transcript: [] }; });

  test("a saved canvas with undo history does not block Apply", () => {
    detail.previousChanges.push({ by: "analyst" }, { by: "analyst" });
    detail.details.$dirty = false;                  // what the designer's Save leaves
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    $scope.viewState = "idle";
    const ev = { offerId: "e1", type: "enhancement_offer" };
    $scope.acceptEnhancementOffer(ev);
    expect(ev._blockedText).toBeFalsy();
    expect(SENT.map((p) => p.offer_id)).toEqual(["e1"]);
  });

  test("an unsaved parent-form edit still blocks Apply", () => {
    detail.parentForm = { $dirty: true };
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    $scope.viewState = "idle";
    const ev = { offerId: "e1", type: "enhancement_offer" };
    $scope.acceptEnhancementOffer(ev);
    expect(ev._blockedText).toMatch(/Save or discard/);
    expect(SENT).toHaveLength(0);
  });
});

describe(`${viewCtrlName} -- Apply outside the designer`, () => {
  test("with no designer on the page, Apply writes (no apply_to)", () => {
    container.remove();
    bootAndApply();
    expect(SENT[0].apply_to).toBeUndefined();
  });
});
