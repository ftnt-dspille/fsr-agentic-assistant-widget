"use strict";

// ─── Opener waits for the entity (no blind opener / missing summary card) ────
//
// Regression for the live drawer bug: the Agentic Assistant drawer can construct
// BEFORE UI-Router settles onto the record-detail state, so _detectEntity() at
// construction returns null. The OLD init fired _seedFromEntity()+_runOpener()
// immediately and relied on a disconnected 300ms re-detect - but by then the
// blind opener had already pushed a message, so _seedFromEntity's
// `messages.length>0` guard bailed (summary card never rendered) and the opener
// chat_turn had gone out with NO entity. Symptom the analyst reported: "the
// triage summary card is missing, and in exactly those cases the chat doesn't
// work."
//
// The fix resolves the entity with a bounded retry (_resolveEntityContextWithRetry)
// and the opener waits on it. These tests assert the opener turn carries the
// record once $state settles during the retry window - never blind.

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

// Mutable $state stub - flip current/params to simulate the transition settling.
const $state = { current: { name: "main.modules.list" }, params: { module: "alerts" } };

let $controller, $rootScope, $timeout, $q;
let turnCalls;

beforeEach(() => {
  $state.current = { name: "main.modules.list" };
  $state.params = { module: "alerts" };
  turnCalls = [];

  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      // Real promise so the .then chain actually runs under $digest.
      chatHistory: () => $q.when({ turns: [] }),
      chatTurn: (cfg, payload) => { turnCalls.push(payload); return $q.when({ accepted: true, turn: 1 }); },
      resume: () => $q.when({}),
      modeInfo: () => ({ mode: "mock" }), // no live streaming poll in the test
    });
    // seedFromEntity OFF so the test is isolated from the record fetch
    // (FormEntityService/$http) - we only assert the opener carries the entity.
    // opener:'on' so _shouldRunOpener() fires the opener turn (the drawer's
    // triage-mount default); seedFromEntity OFF to isolate from the record fetch.
    $provide.value("config", { seedFromEntity: false, maxTurns: 8, opener: "on" });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_, _$q_) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
    $timeout = _$timeout_;
    $q = _$q_;
  });
});

describe(`${viewCtrlName} - opener waits for entity (race)`, () => {
  test("opener fires WITH the entity once $state settles during the retry window", () => {
    // Construct mid-transition (still on the list): entity is null at boot.
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    expect($scope.entityContext).toBeNull();

    // Flush the init $timeout(0): entity detect fails, schedules a retry; the
    // chatHistory promise is pending. The opener must NOT have fired yet.
    $timeout.flush(0);
    $rootScope.$digest();
    expect(turnCalls.length).toBe(0);

    // The case detail settles a beat later (no navigation event broadcast).
    $state.current = { name: "viewPanel.modulesDetail" };
    $state.params = { module: "cases", id: "case-77" };
    // Flush the retry timeout → entity resolves → the chained seed/opener runs.
    $timeout.flush();
    $rootScope.$digest();

    // Entity resolved...
    expect($scope.entityContext).toBeTruthy();
    expect($scope.entityContext.iri).toBe("/api/3/cases/case-77");
    // ...and the opener turn went out exactly once, carrying the record (NOT blind).
    expect(turnCalls.length).toBe(1);
    expect(turnCalls[0].entity).toBeTruthy();
    expect(turnCalls[0].entity.iri).toBe("/api/3/cases/case-77");
    expect(turnCalls[0].messages).toEqual([]); // opener signal
  });

  test("opener carries the entity immediately when $state is already settled at boot", () => {
    $state.current = { name: "viewPanel.modulesDetail" };
    $state.params = { module: "alerts", id: "abc-123" };
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });

    $timeout.flush();
    $rootScope.$digest();

    expect(turnCalls.length).toBe(1);
    expect(turnCalls[0].entity.iri).toBe("/api/3/alerts/abc-123");
  });
});
