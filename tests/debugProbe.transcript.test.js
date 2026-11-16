"use strict";

// ─── The debug probe must expose the TRANSCRIPT, not just the UI action log ──
//
// The live sweep's playbook-build row scans `probe().messages[].events` for the
// `playbook_offer` frame, reads its `offerId`, and clicks
// `playbook-offer-accept-<offerId>`. `messages` was never exposed -- only
// `messageCount`, `lastTurn`, and `events` (which is `_eventLog`, the UI-ACTION
// log: quick_action, action_call, patch_applied…, and never a transcript card).
//
// So the scan read `undefined`, `offerId` was always null, the accept branch was
// unreachable, and the row could only ever pass through the `currentYaml` route
// that card #84 proved a `playbook_offer` never takes. A row that cannot pass
// is not a gate -- it is a permanent red that trains everyone to ignore it,
// which is how rows after it stopped being read at all (cards #101/#84).
//
// These pin the probe surface the sweep depends on. They fail if `messages`
// disappears, if it stops carrying `events`, or if someone "simplifies" it by
// pointing it at `_eventLog`.

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

function makeScope() {
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
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", agentStub);
    $provide.value("config", {});
    $provide.value("$state", { current: { name: "main.dashboard" }, params: {} });
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $q = _$q_; $timeout = _$timeout_;
  });
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  return $scope;
}

function probe() { return window.__agenticAssistant__; }

describe("debug probe -- transcript surface the live sweep drives", () => {
  beforeEach(() => { window.localStorage.clear(); });

  test("messages is exposed and is an array", () => {
    makeScope();
    expect(Array.isArray(probe().messages)).toBe(true);
  });

  test("a playbook_offer in the transcript is visible with its offerId", () => {
    const $scope = makeScope();
    $scope.messages.push({
      role: "assistant", text: "",
      events: [{ type: "playbook_offer", offerId: "off-42", summary: "Block an IP" }]
    });
    $scope.$applyAsync();

    // Exactly the scan the sweep's probe() performs.
    let offerId = null;
    for (const m of (probe().messages || [])) {
      for (const ev of (m.events || [])) {
        if (ev.type === "playbook_offer" && !ev._resolved) offerId = ev.offerId || ev.id;
      }
    }
    expect(offerId).toBe("off-42");
  });

  test("a resolved offer is not re-offered", () => {
    const $scope = makeScope();
    $scope.messages.push({
      role: "assistant", text: "",
      events: [{ type: "playbook_offer", offerId: "off-42", _resolved: true }]
    });
    // Assert the surface exists FIRST: without this the scan below finds
    // nothing when `messages` is undefined, and the test passes for the very
    // reason it is meant to catch.
    expect(probe().messages).toHaveLength(1);
    let offerId = null;
    for (const m of (probe().messages || [])) {
      for (const ev of (m.events || [])) {
        if (ev.type === "playbook_offer" && !ev._resolved) offerId = ev.offerId || ev.id;
      }
    }
    expect(offerId).toBeNull();
  });

  test("the push result card is visible on the transcript", () => {
    const $scope = makeScope();
    $scope.messages.push({
      role: "assistant", text: "",
      events: [{ type: "info_card", variant: "playbook_pushed",
                 workflow_uuids: ["wf-1"], collection_uuid: "coll-1" }]
    });
    const found = probe().messages
      .flatMap((m) => m.events || [])
      .find((ev) => ev.type === "info_card" && ev.variant === "playbook_pushed");
    expect(found && found.workflow_uuids).toEqual(["wf-1"]);
  });

  test("messages is NOT the UI action log -- the two must stay distinct", () => {
    const $scope = makeScope();
    $scope.messages.push({ role: "assistant", text: "hi", events: [] });
    // `events` is _eventLog: UI actions, each {type, payload, t}. It never
    // carries a transcript card, which is why scanning it instead would put
    // the sweep right back where it was.
    const uiLog = probe().events;
    expect(Array.isArray(uiLog)).toBe(true);
    expect(uiLog.some((e) => e.type === "playbook_offer")).toBe(false);
    expect(probe().messages.length).toBe(1);
  });

  test("the probe hands out a copy -- a test cannot mutate widget state", () => {
    const $scope = makeScope();
    $scope.messages.push({ role: "assistant", text: "hi", events: [{ type: "info_card" }] });
    const snap = probe().messages;
    snap.push({ role: "bogus" });
    snap[0].events.push({ type: "bogus" });
    expect($scope.messages.length).toBe(1);
    expect($scope.messages[0].events.length).toBe(1);
  });
});
