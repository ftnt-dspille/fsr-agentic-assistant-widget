"use strict";

// ─── enhancement_offer Apply/Decline wiring (controller logic) ───────────────
//
// Rendering is covered by enhancementOffer.render.test.js. This covers the
// analyst's CLICK: Apply must send chat_resume(accept) carrying the offer_id
// AND the open playbook's workflow_iri - chat_resume has no entity block, so
// without the iri the connector has no write target and refuses. The verified
// bytes are NOT re-pushed from the YAML pane (no stale-YAML risk): the connector
// applies the content-addressed bytes the offer stashed. Decline must resume
// WITHOUT an iri, and both must no-op unless the card is open and the widget idle.

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

const OPEN_IRI = "/api/3/workflows/11111111-2222-3333-4444-555555555555";

function makeScope() {
  let $q, $timeout, $rootScope, $controller;
  const resumeCalls = [];
  const agentStub = {
    connectorName: "connector-fsr-agentic-assistant",
    resolveConnector: () => $q.when({ name: "x", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    listSessions: () => $q.when({ sessions: [] }),
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when({ frames: [] }),
    chatResume: (cfg, payload) => { resumeCalls.push(payload); return $q.when({}); },
  };
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", agentStub);
    $provide.value("config", {});
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $q = _$q_; $timeout = _$timeout_;
  });
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  // Mount over an OPEN playbook so _openPlaybookIri() resolves.
  $scope.inPlaybookEditor = true;
  $scope.entityContext = { iri: OPEN_IRI, module: "workflows" };
  $scope.initiator = $scope.initiator || { name: "analyst" };
  $scope.$digest();
  $scope.viewState = "idle";
  return { $scope, resumeCalls };
}

function offerEvent() {
  return { type: "enhancement_offer", offerId: "enh-1", _resolved: false, _open: true };
}

describe("fsrAgenticAssistant - enhancement_offer Apply/Decline", () => {
  test("Apply resumes with accept + offer_id + the open workflow_iri", () => {
    const { $scope, resumeCalls } = makeScope();
    const ev = offerEvent();
    $scope.acceptEnhancementOffer(ev);
    expect(resumeCalls).toHaveLength(1);
    const p = resumeCalls[0];
    expect(p.decision).toBe("accept");
    expect(p.offer_id).toBe("enh-1");
    // The whole reason acceptEnhancementOffer passes the iri: without it the
    // connector has no target and refuses to write.
    expect(p.workflow_iri).toBe(OPEN_IRI);
    expect(ev._resolved).toBe(true);
    expect(ev._outcome).toBe("accept");
    expect(ev._open).toBe(false);
  });

  test("Decline resumes with decline and NO workflow_iri", () => {
    const { $scope, resumeCalls } = makeScope();
    const ev = offerEvent();
    $scope.declineEnhancementOffer(ev);
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0].decision).toBe("decline");
    expect(resumeCalls[0].offer_id).toBe("enh-1");
    expect(resumeCalls[0].workflow_iri).toBeUndefined();
    expect(ev._outcome).toBe("decline");
  });

  test("Apply is a no-op on an already-resolved card (no double-write)", () => {
    const { $scope, resumeCalls } = makeScope();
    const ev = offerEvent();
    ev._resolved = true;
    $scope.acceptEnhancementOffer(ev);
    expect(resumeCalls).toHaveLength(0);
  });

  test("Apply is a no-op while the widget is mid-turn (viewState !== idle)", () => {
    const { $scope, resumeCalls } = makeScope();
    $scope.viewState = "sending";
    $scope.acceptEnhancementOffer(offerEvent());
    expect(resumeCalls).toHaveLength(0);
  });
});
