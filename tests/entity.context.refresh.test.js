"use strict";

// ─── Drawer / navigation entity-context refresh ─────────────────────────────
//
// Regression for the live bug (export sess-yq8nhcix): the widget was opened on
// a module LIST page (no record), the analyst then navigated to an alert DETAIL
// page, and "Investigate this alert" was sent with NO `entity` block -- triage
// ran blind. Root cause: entity context was detected ONCE at controller
// construction (when $state had no record) and never re-detected on navigation.
//
// The fix wires popupOpened + $stateChangeSuccess to _refreshEntityContext().
// These tests drive that lifecycle with a mutable $state stub and assert the
// context is (re)derived so the next chat_turn carries the record.

const path = require("path");

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
const chainable = { then: function () { return chainable; }, catch: function () { return chainable; } };

// Mutable $state stub -- the test flips current/params to simulate navigation.
const $state = { current: { name: "main.modules.list" }, params: { module: "alerts" } };

let $controller, $rootScope, $timeout;

beforeEach(() => {
  // Reset to the list page before each test.
  $state.current = { name: "main.modules.list" };
  $state.params = { module: "alerts" };

  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", { execute: () => chainable, resume: () => chainable, chatHistory: () => chainable });
    // seedFromEntity OFF so the refresh path is isolated from the record
    // fetch (FormEntityService/$http) -- we only assert context detection here.
    $provide.value("config", { seedFromEntity: false });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
    $timeout = _$timeout_;
  });
});

describe(`${viewCtrlName} -- entity context on navigation`, () => {
  function boot() {
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    return $scope;
  }

  test("no entity context when mounted over a module LIST page", () => {
    const $scope = boot();
    expect($scope.entityContext).toBeNull();
  });

  test("$stateChangeSuccess to a DETAIL page derives the entity context", () => {
    const $scope = boot();
    expect($scope.entityContext).toBeNull();

    // Analyst navigates list → alert detail while the widget stays mounted.
    $state.current = { name: "viewPanel.modulesDetail" };
    $state.params = { module: "alerts", id: "abc-123" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();

    expect($scope.entityContext).toBeTruthy();
    expect($scope.entityContext.module).toBe("alerts");
    expect($scope.entityContext.iri).toBe("/api/3/alerts/abc-123");
    // Over a record the default intent is triage (the export's bug surface).
    expect($scope.uiIntent).toBe("triage");
  });

  test("popupOpened over a DETAIL page derives the entity context", () => {
    // Drawer can open AFTER the analyst is already on the detail page; the
    // controller constructed before $state settled, so popupOpened re-detects.
    $state.current = { name: "viewPanel.modulesDetail" };
    $state.params = { module: "alerts", id: "/api/3/alerts/xyz-9" };
    const $scope = $rootScope.$new();
    $state.current = { name: "main.modules.list" }; // construct under the stale list state
    $state.params = { module: "alerts" };
    $controller(viewCtrlName, { $scope });
    expect($scope.entityContext).toBeNull();

    // Now the drawer fires popupOpened with the detail state live.
    $state.current = { name: "viewPanel.modulesDetail" };
    $state.params = { module: "alerts", id: "/api/3/alerts/xyz-9" };
    $rootScope.$broadcast("popupOpened");
    $rootScope.$digest();

    expect($scope.entityContext).toBeTruthy();
    expect($scope.entityContext.iri).toBe("/api/3/alerts/xyz-9");
  });

  test("navigating detail → list drops a seed-only summary card (no stale 'Triaging' card over a list)", () => {
    const $scope = boot();
    $state.current = { name: "viewPanel.modulesDetail" };
    $state.params = { module: "alerts", id: "abc-123" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();
    expect($scope.entityContext).toBeTruthy();

    // Simulate the auto-seed summary card (seedFromEntity is off in this suite,
    // so push the seeded message directly -- same shape _renderSeed produces).
    $scope.messages.push({ role: "assistant", text: "", events: [{ type: "info_card" }], ts: 1, _seeded: true });

    // Navigate to a list -- the bare summary card must clear, returning to the
    // no-record state.
    $state.current = { name: "main.modules.list" };
    $state.params = { module: "alerts" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();

    expect($scope.messages.length).toBe(0);
    expect($scope.entityContext).toBeNull();
  });

  test("navigating detail → list KEEPS an in-progress conversation (only the seed card is disposable)", () => {
    const $scope = boot();
    $state.current = { name: "viewPanel.modulesDetail" };
    $state.params = { module: "alerts", id: "abc-123" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();

    // Seed card + a real analyst turn = an investigation in progress.
    $scope.messages.push({ role: "assistant", text: "", events: [{ type: "info_card" }], ts: 1, _seeded: true });
    $scope.messages.push({ role: "user", text: "is this malicious?", events: [], ts: 2 });
    const before = $scope.messages.length;

    $state.current = { name: "main.modules.list" };
    $state.params = { module: "alerts" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();

    // Conversation retained (don't orphan the analyst's work); context preserved.
    expect($scope.messages.length).toBe(before);
    expect($scope.entityContext).toBeTruthy();
    expect($scope.entityContext.iri).toBe("/api/3/alerts/abc-123");
  });

  test("navigating detail → list with NO conversation resets the record context (no phantom record over a list)", () => {
    const $scope = boot();
    $state.current = { name: "viewPanel.modulesDetail" };
    $state.params = { module: "alerts", id: "abc-123" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();
    expect($scope.entityContext).toBeTruthy();

    // Back to a list with nothing on screen (no seed, no chat) -- the widget must
    // not carry a phantom record context onto an unrelated list.
    $state.current = { name: "main.modules.list" };
    $state.params = { module: "alerts" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();
    expect($scope.entityContext).toBeNull();
  });

  // Record-scoped sessions: navigating between records must switch the visible
  // chat to each record's OWN thread, never carry the previous record's chat.
  test("navigating record A → B → A switches to each record's own scoped session", () => {
    window.localStorage.clear();
    const probe = () => window.__agenticAssistant__;
    const $scope = boot();               // mounted on a list -- no record yet
    const s0 = probe().sessionId;        // un-scoped triage bucket

    // → alert A: a fresh, A-scoped session (not the off-record one).
    $state.current = { name: "viewPanel.modulesDetail" };
    $state.params = { module: "alerts", id: "aaa-1" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();
    const sA = probe().sessionId;
    expect(sA).not.toBe(s0);
    expect(window.localStorage.getItem("fsrPbSession:/api/3/alerts/aaa-1")).toBe(sA);

    // → alert B: a different, B-scoped session (A's chat does not follow).
    $state.params = { module: "alerts", id: "bbb-2" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();
    const sB = probe().sessionId;
    expect(sB).not.toBe(sA);
    expect(window.localStorage.getItem("fsrPbSession:/api/3/alerts/bbb-2")).toBe(sB);

    // back to alert A: its own thread is restored (same session id as before).
    $state.params = { module: "alerts", id: "aaa-1" };
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();
    expect(probe().sessionId).toBe(sA);
  });

  // Regression for the live case bug: the drawer constructed BEFORE UI-Router
  // settled onto the case-detail state, so the synchronous construction-time
  // detect saw an empty $state and captured a null entity. The init seed used
  // to trust that null -- leaving the summary card missing until a *navigation*
  // event ($stateChangeSuccess) happened to re-detect. The init block must now
  // RE-DETECT once the digest has run, so the card seeds on first paint with NO
  // navigation event fired.
  test("init re-detect picks up a state that settled after construction (no nav event)", () => {
    // Construct under the stale list state (drawer opened mid-transition).
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    expect($scope.entityContext).toBeNull();

    // $state settles onto the case detail -- but NO popupOpened/$stateChangeSuccess
    // is broadcast. Only the init $timeout flushes.
    $state.current = { name: "viewPanel.modulesDetail" };
    $state.params = { module: "cases", id: "case-77" };
    $timeout.flush();

    expect($scope.entityContext).toBeTruthy();
    expect($scope.entityContext.module).toBe("cases");
    expect($scope.entityContext.iri).toBe("/api/3/cases/case-77");
    expect($scope.uiIntent).toBe("triage");
  });

  test("init delayed retry re-detects when the state is still transitioning at $timeout(0)", () => {
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });

    // Flush the immediate init timeout while still on the list -- detect fails,
    // scheduling the 300ms retry.
    $timeout.flush(0);
    expect($scope.entityContext).toBeNull();

    // The case detail settles just after; the retry must pick it up.
    $state.current = { name: "viewPanel.modulesDetail" };
    $state.params = { module: "cases", id: "case-88" };
    $timeout.flush();

    expect($scope.entityContext).toBeTruthy();
    expect($scope.entityContext.iri).toBe("/api/3/cases/case-88");
  });
});
