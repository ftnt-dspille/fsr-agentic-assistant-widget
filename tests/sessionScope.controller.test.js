"use strict";

// ─── Record/page-scoped session persistence (ONE thread) ────────────────────
//
// Phase 1 (state-derived-intent): the active session id persists under a
// RECORD/PAGE-scoped localStorage key -- ONE thread per mounted record/page, NOT
// per intent. A triage ask and an authoring ask on the SAME record share one
// continuous conversation (so "triage this alert, then build a playbook for it"
// carries context across the handoff with no page flip). The per-turn connector
// frontier gates tools per turn, so the bleed the old per-intent split guarded
// against is prevented by the frontier, not by separate threads.
//   - on a record (entity.iri): `fsrPbSession:<iri>` -- all intents share it;
//   - the designer with an open playbook: keyed on that workflow record's iri;
//   - off-record (dashboard): the bare `fsrPbSession:triage` bucket (legacy-adopted).

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

// A build mount means ONE thing now: the widget is inside the playbook designer
// (`main.playbookDetail`). `config.defaultIntent='build'` used to force it from a
// dashboard and was retired -- build assumes an open playbook, so a mount without
// one had every assumption false. These tests therefore fake the designer state
// rather than a config flag.
function makeScope(config, opts) {
  opts = opts || {};
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "x", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    listSessions: () => $q.when({ sessions: [] }),
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when({ frames: [] })
  };
  // opts.record = { module, id } mounts the widget over a record-DETAIL page so
  // _detectEntity() resolves the host record from $state at construction -- the
  // channel record-scoping keys off of.
  const stateForMount = opts.record
    ? { current: { name: "viewPanel.modulesDetail" }, params: { module: opts.record.module, id: opts.record.id } }
    : { current: { name: opts.inPlaybookEditor ? "main.playbookDetail" : "main.dashboard" }, params: { id: "wf-9" } };
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", agentStub);
    // seedFromEntity OFF for record mounts so the session-scoping assertion is
    // isolated from the record GET (FormEntityService/$http).
    $provide.value("config", Object.assign({}, config || {}, opts.record ? { seedFromEntity: false } : {}));
    $provide.value("$state", stateForMount);
  });
  let $httpBackend;
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_, _$httpBackend_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $q = _$q_; $timeout = _$timeout_;
    $httpBackend = _$httpBackend_;
  });
  // A designer mount seeds the OPEN PLAYBOOK as its entity, which is a real GET.
  // That request is incidental to session scoping -- answer it so the mount can
  // finish resolving its intent.
  if (opts.inPlaybookEditor) {
    $httpBackend.whenGET(/\/api\/3\/workflows\/wf-9/).respond(200, {
      "@id": "/api/3/workflows/wf-9", uuid: "wf-9", name: "Open PB", steps: []
    });
  }
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  if (opts.inPlaybookEditor) $httpBackend.flush();
  return $scope;
}

function probe() { return window.__agenticAssistant__; }

describe("fsrAgenticAssistant -- record/page-scoped session persistence (one thread)", () => {
  beforeEach(() => { window.localStorage.clear(); });

  const WF_IRI = "/api/3/workflows/wf-9";

  test("a designer mount keys on the open playbook's record, not a build bucket", () => {
    window.localStorage.setItem("fsrPbSession", "triage-legacy-123");
    const $scope = makeScope({}, { inPlaybookEditor: true });
    expect($scope.uiIntent).toBe("build");
    expect(probe().sessionId).not.toBe("triage-legacy-123");
    // ONE thread per record: the designer's open playbook (wf-9) is the record.
    expect(window.localStorage.getItem("fsrPbSession:" + WF_IRI)).toBe(probe().sessionId);
    // The retired per-intent bucket is not used.
    expect(window.localStorage.getItem("fsrPbSession:build")).toBeNull();
  });

  test("a triage mount adopts the legacy un-namespaced session (migration)", () => {
    window.localStorage.setItem("fsrPbSession", "triage-legacy-123");
    makeScope({});
    expect(probe().sessionId).toBe("triage-legacy-123");
  });

  test("a triage mount prefers its own scoped key over the legacy key", () => {
    window.localStorage.setItem("fsrPbSession", "triage-legacy-123");
    window.localStorage.setItem("fsrPbSession:triage", "triage-scoped-456");
    makeScope({});
    expect(probe().sessionId).toBe("triage-scoped-456");
  });

  test("a designer mount rehydrates its open playbook's thread", () => {
    window.localStorage.setItem("fsrPbSession:triage", "T");
    window.localStorage.setItem("fsrPbSession:" + WF_IRI, "B");
    makeScope({}, { inPlaybookEditor: true });
    expect(probe().sessionId).toBe("B"); // the record thread, not the off-record triage bucket
  });

  // ─── Record-scoped sessions, intent-agnostic (ONE thread per record) ──────
  // Opening the widget on a record shows only THAT record's chat. The key is the
  // host record IRI (fsrPbSession:<iri>) with NO intent segment, so triage and
  // authoring on the same record share the thread.
  const IRI_A = "/api/3/alerts/aaa-1";
  const IRI_B = "/api/3/alerts/bbb-2";

  test("a record mount does NOT adopt the un-scoped / legacy triage session", () => {
    window.localStorage.setItem("fsrPbSession", "legacy-123");
    window.localStorage.setItem("fsrPbSession:triage", "dashboard-thread-456");
    makeScope({}, { record: { module: "alerts", id: "aaa-1" } });
    expect(probe().sessionId).not.toBe("legacy-123");
    expect(probe().sessionId).not.toBe("dashboard-thread-456");
    // The minted session persists under the intent-agnostic record-scoped key.
    expect(window.localStorage.getItem("fsrPbSession:" + IRI_A)).toBe(probe().sessionId);
  });

  test("reopening on the SAME record rehydrates that record's own thread", () => {
    window.localStorage.setItem("fsrPbSession:" + IRI_A, "record-A-thread");
    makeScope({}, { record: { module: "alerts", id: "aaa-1" } });
    expect(probe().sessionId).toBe("record-A-thread");
  });

  test("record B does not reuse record A's session", () => {
    window.localStorage.setItem("fsrPbSession:" + IRI_A, "record-A-thread");
    makeScope({}, { record: { module: "alerts", id: "bbb-2" } });
    expect(probe().sessionId).not.toBe("record-A-thread");
    expect(window.localStorage.getItem("fsrPbSession:" + IRI_B)).toBe(probe().sessionId);
  });

  test("the same record thread is shared regardless of uiIntent (one thread)", () => {
    // A triage session on a record; flipping uiIntent to build (the handoff)
    // must resolve the SAME record-scoped key, not a separate build thread.
    window.localStorage.setItem("fsrPbSession:" + IRI_A, "shared-record-thread");
    const $scope = makeScope({}, { record: { module: "alerts", id: "aaa-1" } });
    expect(probe().sessionId).toBe("shared-record-thread");
    $scope.uiIntent = "build";
    // Re-persist under the current key and confirm it is still the record key.
    expect(window.localStorage.getItem("fsrPbSession:" + IRI_A)).toBe("shared-record-thread");
  });

  test("defaultIntent='build' is retired -- a dashboard mount stays in triage", () => {
    // The config field still round-trips for back-compat, but nothing reads it.
    // Build assumes an open playbook; honouring this outside the designer is
    // exactly the mount this decision removed.
    const $scope = makeScope({ defaultIntent: "build" });
    expect($scope.uiIntent).toBe("triage");
  });
  // The Agentic Assistant Monitor writes a one-shot `fsrPbOpenSession` AND
  // broadcasts. When the chat is already alive it switches on the broadcast,
  // so the one-shot must be cleared or the NEXT fresh mount (a page reload
  // days later) silently reopens that old session.
  test("a live chat clears the monitor's one-shot when it handles the broadcast", () => {
    const $scope = makeScope({});
    window.localStorage.setItem("fsrPbOpenSession", "sess-build-1");
    $scope.$root.$broadcast("fsrAgenticAssistant:openSession", { session_id: "sess-build-1" });
    expect(window.localStorage.getItem("fsrPbOpenSession")).toBeNull();
  });

  test("a broadcast for a different session leaves a newer one-shot alone", () => {
    const $scope = makeScope({});
    window.localStorage.setItem("fsrPbOpenSession", "sess-newer");
    $scope.$root.$broadcast("fsrAgenticAssistant:openSession", { session_id: "sess-older" });
    expect(window.localStorage.getItem("fsrPbOpenSession")).toBe("sess-newer");
  });
});
