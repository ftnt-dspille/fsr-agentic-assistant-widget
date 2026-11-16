"use strict";

// ─── Playbook-editor entityContext seeding ──────────────────────────────────
//
// When the widget is mounted in the real playbook designer (main.playbookDetail,
// /playbooks/:id) it must seed the OPEN PLAYBOOK as its entityContext so the
// authoring quick-actions ("Explain this playbook", "Find issues") fire a build
// turn with a playbook to read. Previously the widget knew THAT it was in the
// editor (inPlaybookEditor) but not WHICH playbook ($state.params.id was unused),
// so those turns had no entity.
//
// It must do this WITHOUT rendering the alert/case auto-seed summary card -- that
// format misfits a playbook and (by pushing a message) would hide the authoring
// quick-actions, which require an empty timeline.

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
const chainable = { then: function () { return chainable; }, catch: function () { return chainable; } };

// Mutable $state stub -- flip current/params to simulate the designer mount.
const $state = { current: { name: "main.modules.list" }, params: {} };

let $controller, $rootScope, $httpBackend;

beforeEach(() => {
  $state.current = { name: "main.modules.list" };
  $state.params = {};

  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", { execute: () => chainable, resume: () => chainable, chatHistory: () => chainable });
    $provide.value("config", { seedFromEntity: true }); // ON -- proves it's still suppressed in the editor
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$httpBackend_) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
    $httpBackend = _$httpBackend_;
  });
  // The playbook-entity resolve does a best-effort GET of the workflow record.
  $httpBackend.whenGET(/\/api\/3\/workflows\//).respond(200, { "@id": "/api/3/workflows/pb-1", name: "My Playbook" });
});

describe(`${viewCtrlName} -- playbook-editor entity seeding`, () => {
  function bootInEditor(id) {
    $state.current = { name: "main.playbookDetail" };
    $state.params = { id: id };
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    return $scope;
  }

  test("mounts the open playbook as entityContext (bare uuid → workflows IRI)", () => {
    const $scope = bootInEditor("pb-1");
    expect($scope.inPlaybookEditor).toBe(true);
    expect($scope.uiIntent).toBe("build");
    expect($scope.entityContext).toBeTruthy();
    expect($scope.entityContext.iri).toBe("/api/3/workflows/pb-1");
    expect($scope.entityContext.module).toBe("workflows");
  });

  test("a full-IRI params.id is used verbatim", () => {
    const $scope = bootInEditor("/api/3/workflows/abc-999");
    expect($scope.entityContext.iri).toBe("/api/3/workflows/abc-999");
  });

  test("does NOT render an auto-seed card, so authoring quick-actions still show", () => {
    const $scope = bootInEditor("pb-1");
    $rootScope.$digest();
    // No summary card was pushed onto the timeline…
    expect($scope.messages.length).toBe(0);
    // …so the playbook quick-actions render (they require an empty timeline).
    expect($scope.showPlaybookQuickActions()).toBe(true);
  });

  test("navigating INTO the designer (state change) seeds the playbook entity", () => {
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope }); // constructed over a list page
    expect($scope.entityContext).toBeNull();

    $state.current = { name: "main.playbookDetail" };
    $state.params = { id: "pb-42" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();

    expect($scope.inPlaybookEditor).toBe(true);
    expect($scope.entityContext.iri).toBe("/api/3/workflows/pb-42");
  });

  test("a stale record entity (keys) carried into the designer is replaced by the open playbook", () => {
    // Repro of the reported bug: the persistent drawer captured a Key Store
    // `keys` entity on a prior page; navigating into the designer used to KEEP
    // it (seed only ran when entityContext was empty), so the editor showed
    // "Triaging key" / "Case context" and leaked module:keys into the playbook.
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope }); // over a list page
    $scope.entityContext = { iri: "/api/3/keys/k-1", module: "keys", record: { name: "some key" } };

    $state.current = { name: "main.playbookDetail" };
    $state.params = { id: "pb-1" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();

    expect($scope.inPlaybookEditor).toBe(true);
    // The open playbook (workflows) wins -- the stale keys entity is gone.
    expect($scope.entityContext.module).toBe("workflows");
    expect($scope.entityContext.iri).toBe("/api/3/workflows/pb-1");
    // Framing is build/authoring, not triage-over-keys.
    expect($scope.heroHeading()).not.toContain("Triaging");
    expect($scope.heroHeading().toLowerCase()).not.toContain("key");
    expect($scope.heroSub().toLowerCase()).not.toContain("containment");
    expect($scope.pageDetailsLabel()).toBe("⊕ Playbook context");
    expect($scope.pageDetailsLabel().toLowerCase()).not.toContain("case");
  });

  test("an in-progress conversation is re-pointed, not kept, when entering the designer", () => {
    // CONTRACT CHANGE (live bug): the old "safety valve" kept a real
    // conversation on screen with a stale entity -- same-tab record ->
    // designer navigation showed the RECORD's cards and approval state over
    // the open playbook. Sessions are record-scoped now, so the record's
    // thread is durable in its own bucket and rehydrates on the way back;
    // the designer must adopt the open playbook and show ITS thread.
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    $scope.entityContext = { iri: "/api/3/keys/k-1", module: "keys" };
    $scope.messages = [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }];

    $state.current = { name: "main.playbookDetail" };
    $state.params = { id: "pb-1" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();

    // The record's conversation left the screen (it lives on in its own
    // session bucket) and the open playbook is the entity now.
    expect($scope.messages.some((m) => m.text === "hi")).toBe(false);
    expect($scope.entityContext.module).toBe("workflows");
    expect($scope.entityContext.iri).toBe("/api/3/workflows/pb-1");
  });

  test("designer empty-hero + pull-context read build framing, not triage", () => {
    const $scope = bootInEditor("pb-1");
    $rootScope.$digest();
    expect($scope.heroHeading()).not.toContain("Triaging");
    expect($scope.heroSub().toLowerCase()).not.toContain("containment");
    expect($scope.heroSub().toLowerCase()).not.toContain("block, isolate, disable");
    expect($scope.pageDetailsLabel()).toBe("⊕ Playbook context");
  });

  test("no id on the designer state → no entity seeded (no throw)", () => {
    $state.current = { name: "main.playbookDetail" };
    $state.params = {};
    const $scope = $rootScope.$new();
    expect(() => $controller(viewCtrlName, { $scope })).not.toThrow();
    expect($scope.inPlaybookEditor).toBe(true);
    expect($scope.entityContext == null || !$scope.entityContext.iri).toBe(true);
  });
});
