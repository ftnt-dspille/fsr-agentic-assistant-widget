// ─── Quick-action decks are mutually exclusive per surface ──────────────────
//
// The widget has four opening decks -- SOC investigation (showQuickActions),
// persona (showPersonaQuickActions), module-list (showListQuickActions) and
// playbook-editor (showPlaybookQuickActions). Each is a DIFFERENT surface, so at
// most one may render in any state. They used to hand-roll their own exclusions,
// and the investigation deck forgot two of them:
//   A. It rendered in the playbook editor on top of the designer deck
//      (the double-stack the analyst reported), because it never checked
//      inPlaybookEditor.
//   B. It rendered over ANY record with an IRI -- a device, a template, a custom
//      module -- not just alerts/incidents, because it never checked the module.
// Both are fixed by routing showQuickActions through onTriageRecordPage(), the
// single surface predicate the "Ready to automate" handoff already uses.
//
// This test asserts the INVARIANT (at most one deck true) across surfaces, so a
// future deck or a regressed guard fails here instead of stacking in the UI.
global.jasmine = global.jasmine || {}; // angular-mocks lifecycle gate (before requires)
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
const chainable = { then: function () { return chainable; }, catch: function () { return chainable; } };

const $state = { current: { name: "main.modules.list" }, params: {} };
let $controller, $rootScope, $httpBackend;

beforeEach(() => {
  $state.current = { name: "main.modules.list" };
  $state.params = {};
  ng.mock.module("cybersponse", ($provide) => {
    // Real triage-module predicate: only alerts/incidents are triage records.
    $provide.value("fsrPbAgentService", {
      execute: () => chainable, resume: () => chainable, chatHistory: () => chainable,
      isTriageModule: (m) => m === "alerts" || m === "incidents",
    });
    $provide.value("config", { seedFromEntity: false });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$httpBackend_) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
    $httpBackend = _$httpBackend_;
  });
  $httpBackend.whenGET(/\/api\/3\/workflows\//).respond(200, { "@id": "/api/3/workflows/pb-1", name: "My Playbook" });
});

function boot() {
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $scope.connectorReady = true;
  $scope.viewState = "idle";
  $scope.messages = [];
  return $scope;
}

function decks($scope) {
  return {
    investigation: !!$scope.showQuickActions(),
    persona: !!$scope.showPersonaQuickActions(),
    list: !!$scope.showListQuickActions(),
    playbook: !!$scope.showPlaybookQuickActions(),
    record: !!$scope.showRecordQuickActions(),
  };
}
const countTrue = (s) => Object.values(s).filter(Boolean).length;

describe(`${viewCtrlName} -- quick-action decks are surface-exclusive`, () => {
  test("a triage record (alerts) shows ONLY the investigation deck", () => {
    const $scope = boot();
    $scope.inPlaybookEditor = false;
    $scope.personaUi = null;
    $scope.listContext = null;
    $scope.entityContext = { iri: "/api/3/alerts/a-1", module: "alerts" };
    $scope.uiIntent = "triage";
    const d = decks($scope);
    expect(d.investigation).toBe(true);
    expect(countTrue(d)).toBe(1);
  });

  test("BUG A: the playbook editor with a triage draft shows ONLY the playbook deck", () => {
    // inPlaybookEditor + uiIntent 'triage' + currentYaml == hasTriageDraft(), the
    // exact state behind the "drafted from this triage" banner and the double-stack.
    const $scope = boot();
    $scope.inPlaybookEditor = true;
    $scope.personaUi = null;
    $scope.listContext = null;
    $scope.entityContext = { iri: "/api/3/workflows/pb-1", module: "workflows" };
    $scope.uiIntent = "triage";
    $scope.currentYaml = "playbooks:\n  - name: Suspend AI Access";
    const d = decks($scope);
    expect(d.investigation).toBe(false); // was true -> the double-stack
    expect(d.playbook).toBe(true);
    expect(countTrue(d)).toBe(1);
  });

  test("BUG B: a non-triage record (device/keys module) shows NO investigation deck (only the neutral record deck)", () => {
    const $scope = boot();
    $scope.inPlaybookEditor = false;
    $scope.personaUi = null;
    $scope.listContext = null;
    $scope.entityContext = { iri: "/api/3/keys/k-1", module: "keys" };
    $scope.uiIntent = "triage";
    const d = decks($scope);
    expect(d.investigation).toBe(false); // was true -> "Build an attack timeline" on a key
    expect(d.record).toBe(true);
    expect(countTrue(d)).toBe(1);
  });

  test("invariant: at most one deck renders in every sampled surface", () => {
    const surfaces = [
      { inPlaybookEditor: false, personaUi: null, listContext: null, entityContext: { iri: "/api/3/alerts/a-1", module: "alerts" }, uiIntent: "triage" },
      { inPlaybookEditor: false, personaUi: null, listContext: null, entityContext: { iri: "/api/3/keys/k-1", module: "keys" }, uiIntent: "triage" },
      { inPlaybookEditor: true, personaUi: null, listContext: null, entityContext: { iri: "/api/3/workflows/pb-1", module: "workflows" }, uiIntent: "triage", currentYaml: "playbooks: []" },
      { inPlaybookEditor: true, personaUi: null, listContext: null, entityContext: { iri: "/api/3/workflows/pb-1", module: "workflows" }, uiIntent: "build" },
      { inPlaybookEditor: false, personaUi: { quickActions: [{ key: "x", label: "X", prompt: "x" }] }, listContext: null, entityContext: { iri: "/api/3/incidents/i-1", module: "incidents" }, uiIntent: "triage" },
      { inPlaybookEditor: false, personaUi: null, listContext: { module: "alerts" }, entityContext: null, uiIntent: "triage" },
    ];
    surfaces.forEach((s, i) => {
      const $scope = boot();
      Object.assign($scope, s);
      const d = decks($scope);
      expect([i, countTrue(d), d]).toEqual([i, expect.any(Number), d]); // keep context on failure
      expect(countTrue(d)).toBeLessThanOrEqual(1);
    });
  });
});
