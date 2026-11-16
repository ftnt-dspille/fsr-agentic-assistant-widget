"use strict";

// ─── Record-aware empty state (C7) ──────────────────────────────────────────
// Over a record the opening state is about THAT record. Triage records
// (alerts, incidents, war rooms) keep the SOC investigation deck and the
// "Triaging" framing. Every other record module (device, indicator, task,
// custom module) used to open as "Triaging <name>" with the SOC summary line
// and nothing to click. It now gets "Working on <name>", a neutral line and a
// three-start deck named for the record's own module. Generic copy is only for
// the no-record case.
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
const TRIAGE = ["alerts", "incidents", "warrooms"];
// Every record module type the widget distinguishes: triage modules, common
// platform modules, and a custom-module type.
const NON_TRIAGE = ["indicators", "assets", "tasks", "keys", "ztpf_automation_profiles", "vulnerabilities"];

let $controller, $rootScope, $httpBackend, sent;

beforeEach(() => {
  sent = [];
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      execute: () => chainable,
      chatTurn: (cfg, p) => { sent.push(p); return { then: () => chainable, catch: () => chainable }; },
      chatPoll: () => chainable,
      resume: () => chainable, chatHistory: () => chainable,
      isTriageModule: (m) => TRIAGE.indexOf(m) !== -1,
      modeInfo: () => ({ mode: "live", mock_scenario: null }),
    });
    $provide.value("config", { seedFromEntity: false });
    $provide.value("$state", { current: { name: "main.modules.view" }, params: {} });
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$httpBackend_) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
    $httpBackend = _$httpBackend_;
  });
});

function boot(module, name) {
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $scope.connectorReady = true;
  $scope.viewState = "idle";
  $scope.messages = [];
  $scope.inPlaybookEditor = false;
  $scope.personaUi = null;
  $scope.listContext = null;
  $scope.uiIntent = "triage";
  $scope.entityContext = { iri: "/api/3/" + module + "/r-1", module, displayName: name };
  return $scope;
}

const leaks = (text) => [/\/api\/3\//, /\bIRI\b/i, /run_op|get_record|search_records/, /\{\{|\}\}/, /—|–/, /containment|block, isolate/i];

describe(`${viewCtrlName} -- record-aware empty state`, () => {
  NON_TRIAGE.forEach((module) => {
    test(`${module}: heading names the record, a three-start deck is offered, no SOC clothing`, () => {
      const $scope = boot(module, "Rec One");
      expect($scope.heroHeading()).toMatch(/^Working on .+: Rec One$/);
      expect($scope.heroHeading()).not.toContain("Triaging");
      expect($scope.heroSub()).toMatch(/what this .+ is, what is related to it, or what to do next/);
      expect($scope.heroSub().toLowerCase()).not.toContain("containment");
      expect($scope.showRecordQuickActions()).toBe(true);
      expect($scope.showQuickActions()).toBe(false);
      const deck = $scope.recordQuickActions();
      expect(deck.map((q) => q.key)).toEqual(["record_summary", "record_related", "record_next"]);
      deck.forEach((q) => {
        [q.label, q.sub, q.prompt].forEach((t) => leaks(t).forEach((re) => expect(t).not.toMatch(re)));
      });
      // Named for the record's own module, not a hard-coded noun.
      const noun = $scope.heroSub().match(/this (.+?) is,/)[1];
      expect(deck[0].label.toLowerCase()).toBe("summarize this " + noun);
      expect($scope.recordDeckLabel().toLowerCase()).toBe("start with this " + noun);
    });

    test(`${module}: a start runs a turn carrying its prompt and key`, () => {
      const $scope = boot(module, "Rec One");
      const q = $scope.recordQuickActions()[1];
      $scope.runQuickAction(q);
      expect(sent).toHaveLength(1);
      expect(sent[0].quick_action).toBe("record_related");
      expect($scope.messages.some((m) => m.role === "user" && m.text === q.prompt)).toBe(true);
      // After the first user turn the deck collapses.
      $scope.viewState = "idle";
      expect($scope.showRecordQuickActions()).toBe(false);
    });
  });

  TRIAGE.forEach((module) => {
    test(`${module}: keeps the SOC investigation deck and framing, no record deck`, () => {
      const $scope = boot(module, "Case One");
      expect($scope.heroHeading()).toMatch(/^Triaging .+: Case One$/);
      expect($scope.showQuickActions()).toBe(true);
      expect($scope.showRecordQuickActions()).toBe(false);
    });
  });

  test("the seed card title and summary line say Working on over a non-triage record, Triaging over an alert", () => {
    const keys = boot("keys", "Key A");
    const alert = boot("alerts", "Alert A");
    let svc;
    ng.mock.inject((fsrPbEntityCardsService) => { svc = fsrPbEntityCardsService; });
    const rec = { name: "Key A" };
    expect(svc.entityHeadline(null, "Key", "Key A", true)).toBe("Working on Key: Key A");
    expect(svc.entityHeadline(null, "Alert", "Alert A", false)).toBe("Triaging Alert: Alert A");
    expect(svc.entityHeadline(null, "Alert", "Alert A")).toBe("Triaging Alert: Alert A");
    expect(svc.composeEntitySummary({ module: "keys" }, rec, null, true)).toMatch(/^\*\*Working on /);
    expect(svc.composeEntitySummary({ module: "alerts" }, { name: "Alert A" }, null, false)).toMatch(/^\*\*Triaging /);
    expect(svc.composeEntityCard({ module: "keys" }, rec, null, true).title).toMatch(/^Working on /);
    expect(keys.heroHeading()).toContain("Working on");
    expect(alert.heroHeading()).toContain("Triaging");
  });

  test("no record: generic copy, no record deck", () => {
    const $scope = boot("keys", "x");
    $scope.entityContext = null;
    expect($scope.heroHeading()).toBe("Paste the FortiSOC summary to begin");
    expect($scope.showRecordQuickActions()).toBe(false);
  });

  test("a persona deck, the playbook editor, a running turn and an offline connector suppress the record deck", () => {
    let $scope = boot("keys", "K");
    $scope.personaUi = { quickActions: [{ key: "x", label: "X", prompt: "x" }] };
    expect($scope.showRecordQuickActions()).toBe(false);
    $scope = boot("keys", "K");
    $scope.inPlaybookEditor = true;
    expect($scope.showRecordQuickActions()).toBe(false);
    $scope = boot("keys", "K");
    $scope.viewState = "sending";
    expect($scope.showRecordQuickActions()).toBe(false);
    $scope = boot("keys", "K");
    $scope.connectorReady = false;
    expect($scope.showRecordQuickActions()).toBe(false);
  });

  test("the record deck is one stable array (ng-repeat over a fresh array never settles)", () => {
    const $scope = boot("tasks", "T");
    expect($scope.recordQuickActions()).toBe($scope.recordQuickActions());
  });
});
