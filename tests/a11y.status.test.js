"use strict";

// B3 (a11y) - the turn-lifecycle announcement, from docs/plans/agentic-assistant-ui-gaps.md.
//
// The widget had no live region at all: a non-sighted analyst got no signal
// that a turn started, needed approval, failed, or finished.
//
// The design decision under test: announce the STATE, not the transcript. The
// streaming preview rebuilds its event list every poll (~700ms), so an
// aria-live region over the transcript would re-announce the whole partial
// answer several times per turn. `a11yStatus()` is therefore a short, low-churn
// string derived from viewState - which is also the thing a screen-reader user
// actually needs ("is it working / did it finish").

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

const fs = require("fs");
const path = require("path");
const widgetInfo = require("../widget/info.json");
const viewCtrlName = `${widgetInfo.name}${widgetInfo.version.replace(/\./g, "")}DevCtrl`;
const ng = window.angular; // eslint-disable-line no-undef

function makeScope() {
  let $q, $rootScope, $controller, $timeout;
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
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $q = _$q_; $timeout = _$timeout_;
  });
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  $scope.$digest();
  return $scope;
}

describe("a11yStatus - turn lifecycle announcements", () => {
  test("silent when idle with an empty transcript", () => {
    const $scope = makeScope();
    $scope.viewState = "idle";
    $scope.messages = [];
    expect($scope.a11yStatus()).toBe("");
  });

  test("announces work in progress while sending", () => {
    const $scope = makeScope();
    $scope.viewState = "sending";
    expect($scope.a11yStatus()).toMatch(/working/i);
  });

  test("announces an approval gate - the one state that needs a human", () => {
    const $scope = makeScope();
    $scope.viewState = "awaiting_approval";
    expect($scope.a11yStatus()).toMatch(/approval/i);
  });

  test("announces failure and carries the reason", () => {
    const $scope = makeScope();
    $scope.viewState = "error";
    $scope.errorMessage = "connector unreachable";
    const said = $scope.a11yStatus();
    expect(said).toMatch(/failed/i);
    expect(said).toContain("connector unreachable");
  });

  test("announces completion once there is a transcript", () => {
    const $scope = makeScope();
    $scope.viewState = "idle";
    $scope.messages = [{ role: "assistant" }];
    expect($scope.a11yStatus()).toMatch(/complete/i);
  });

  test("the announcement stays short - a live region is read aloud verbatim", () => {
    const $scope = makeScope();
    for (const s of ["sending", "awaiting_approval", "idle"]) {
      $scope.viewState = s;
      $scope.messages = [{ role: "assistant" }];
      expect($scope.a11yStatus().length).toBeLessThan(60);
    }
  });
});

// The live region only works if the template wires it correctly, and a wrong
// wiring is silent - nothing renders differently for a sighted user. Assert the
// markup contract here so it can't regress unnoticed.
describe("live-region markup contract", () => {
  const view = fs.readFileSync(
    path.join(__dirname, "../widget/view.html"), "utf8");

  test("a polite status region renders a11yStatus()", () => {
    expect(view).toMatch(/role="status"[^>]*aria-live="polite"/);
    expect(view).toContain("{{a11yStatus()}}");
  });

  test("the region is atomic so partial re-reads don't happen", () => {
    expect(view).toMatch(/role="status"[\s\S]{0,120}aria-atomic="true"/);
  });

  test("the transcript is a log, labelled, and NOT itself a live region", () => {
    const messages = view.match(/<div class="messages"[^>]*>/)[0];
    expect(messages).toContain('role="log"');
    expect(messages).toContain('aria-label="Conversation transcript"');
    // The whole point: no aria-live here, or every poll re-announces the
    // partial answer.
    expect(messages).not.toContain("aria-live");
  });

  test("the transcript reports busy while a turn streams", () => {
    const messages = view.match(/<div class="messages"[^>]*>/)[0];
    expect(messages).toMatch(/aria-busy=.*viewState === 'sending'/);
  });

  test("sr-only hides visually WITHOUT leaving the accessibility tree", () => {
    const rule = view.match(/\.fsr-pb-widget \.sr-only \{[^}]+\}/)[0];
    // display:none / visibility:hidden would remove the node from the a11y
    // tree entirely - the region would never be announced.
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).not.toMatch(/visibility:\s*hidden/);
    expect(rule).toMatch(/clip:\s*rect\(0, 0, 0, 0\)/);
  });
});
