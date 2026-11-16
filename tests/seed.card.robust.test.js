"use strict";

// ─── Seed summary card is robust to late entity + bad record fetch ───────────
//
// Live symptom (analyst): over a real Case the widget shows the entity-aware
// hero ("Triaging incident…") but NO summary card, and the chat is dead. Three
// conditions caused it:
//   1. The entity settled onto $state AFTER the bounded init retry gave up, and
//      no popupOpened/$stateChangeSuccess fired afterwards → nothing reseeded.
//   2. The record HTTP fetch returned a non-record body (proxy error / HTML),
//      which clobbered the {@id} stub so the card render bailed.
//   3. Concurrent seed triggers could double-push.
//
// The fix: a $watch backstop seeds whenever an entity is present and the
// timeline is empty; _resolveEntityRecord refuses to adopt a non-record body;
// _seedFromEntity always renders a card when an IRI is known and is idempotent.

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

const $state = { current: { name: "main.modules.list" }, params: { module: "alerts" } };

let $controller, $rootScope, $timeout, $q, $httpBackend;

function setup(httpResponder) {
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      chatHistory: () => $q.when({ turns: [] }),
      chatTurn: () => $q.when({ accepted: true, turn: 1 }),
      resume: () => $q.when({}),
      modeInfo: () => ({ mode: "mock" }),
    });
    // seedFromEntity ON (the real drawer default); opener OFF so we isolate the
    // seed card from any opener turn.
    $provide.value("config", { seedFromEntity: true, maxTurns: 8, opener: "off" });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_, _$q_, _$httpBackend_) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
    $timeout = _$timeout_;
    $q = _$q_;
    $httpBackend = _$httpBackend_;
  });
  if (httpResponder) httpResponder($httpBackend);
}

function seedCards($scope) {
  return $scope.messages.filter(
    (m) => m._seeded && (m.events || []).some((e) => e.type === "info_card")
  );
}

beforeEach(() => {
  $state.current = { name: "main.modules.list" };
  $state.params = { module: "alerts" };
});

describe(`${viewCtrlName} -- seed card robustness`, () => {
  test("late entity (after init retry, no state event) still seeds via the watch backstop", () => {
    setup((be) => {
      // Full record once the case settles.
      be.whenGET(/\/api\/3\/cases\/case-99/).respond(200, {
        "@id": "/api/3/cases/case-99",
        name: "Detected intrusion traffic attempts",
        severity: "Medium",
        status: "Open",
      });
    });

    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    $timeout.flush(0);
    $rootScope.$digest();
    // Exhaust the bounded init retry while still on the list -- entity never
    // resolves, init seeds nothing.
    $timeout.flush();
    $rootScope.$digest();
    expect($scope.entityContext).toBeNull();
    expect(seedCards($scope).length).toBe(0);

    // Case detail settles now -- NO popupOpened / $stateChangeSuccess fired.
    $state.current = { name: "viewPanel.modulesDetail" };
    $state.params = { module: "cases", id: "case-99" };
    // The watch backstop must re-detect on the next digest and seed.
    // (Simulate the detection that a digest tick would observe.)
    $scope.entityContext = { iri: "/api/3/cases/case-99", module: "cases", record: { "@id": "/api/3/cases/case-99", module: "cases" }, summary_seed: "" };
    $rootScope.$digest();
    $httpBackend.flush();
    $rootScope.$digest();

    const cards = seedCards($scope);
    expect(cards.length).toBe(1);
    expect(cards[0].events[0].title).toContain("Detected intrusion");
  });

  test("a non-record HTTP body does NOT block the card -- falls back to the IRI stub", () => {
    setup((be) => {
      // Proxy error page / 200 with a junk body (no @id, no fields).
      be.whenGET(/\/api\/3\/cases\/case-err/).respond(200, "<html>error</html>");
    });

    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    $scope.entityContext = { iri: "/api/3/cases/case-err", module: "cases", record: { "@id": "/api/3/cases/case-err", module: "cases" }, summary_seed: "" };
    $timeout.flush(0);
    $rootScope.$digest();
    $httpBackend.flush();
    $rootScope.$digest();

    const cards = seedCards($scope);
    expect(cards.length).toBe(1); // card still rendered (name falls back to IRI)
    // The stub @id must survive the bad fetch for later reseeds.
    expect($scope.entityContext.record["@id"]).toBe("/api/3/cases/case-err");
  });

  test("concurrent seed triggers push exactly one card", () => {
    setup((be) => {
      be.whenGET(/\/api\/3\/cases\/case-1x/).respond(200, {
        "@id": "/api/3/cases/case-1x", name: "Case one", severity: "Low",
      });
    });
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    $scope.entityContext = { iri: "/api/3/cases/case-1x", module: "cases", record: { "@id": "/api/3/cases/case-1x", module: "cases" }, summary_seed: "" };
    $timeout.flush(0);
    // Multiple digests (watch + init + a state event) while the fetch is in flight.
    $rootScope.$digest();
    $rootScope.$digest();
    $httpBackend.flush();
    $rootScope.$digest();
    expect(seedCards($scope).length).toBe(1);
  });

  test("+ New on the same record re-seeds the summary card (no page reload needed)", () => {
    setup();
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    // Drawer hands us an already-populated record -- seeds synchronously.
    $scope.entityContext = {
      iri: "/api/3/alerts/alert-7", module: "alerts",
      record: { "@id": "/api/3/alerts/alert-7", name: "High log receiving delay", severity: "Medium", status: "Open" },
      summary_seed: "",
    };
    $timeout.flush(0);
    $rootScope.$digest();
    expect(seedCards($scope).length).toBe(1);

    // Analyst starts a fresh conversation over the SAME record. The entity IRI
    // does not change, so the watch backstop never fires -- newConversation
    // itself must re-seed or the analyst is left with a bare hero until a full
    // page reload (live bug, widget 1.2.63).
    $scope.newConversation();
    $rootScope.$digest();

    const cards = seedCards($scope);
    expect(cards.length).toBe(1);
    expect(cards[0].events[0].title).toContain("High log receiving delay");
  });
});
