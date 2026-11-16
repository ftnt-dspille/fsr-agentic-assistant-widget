"use strict";

// UI-scenario sweep - controller result-handling path. A nullish turn
// resolution (empty 200 body, an unwrapped envelope with no .data, a mock
// action with no fixture → _unwrapEnvelope returns null) flowed straight into
// _handleTurnResult, which is `result &&`-guarded everywhere EXCEPT the
// `result.transcript` deref - so it threw, was caught by .catch(_handleError),
// and surfaced as a spurious 'error' state. The turn should instead settle
// cleanly to 'idle'.

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

function boot(turnResponse) {
  let $q, $rootScope, $controller, $timeout;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when(turnResponse),
    chatResume: () => $q.when(turnResponse),
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
  $timeout.flush(); // construction probes
  return { $scope, $rootScope, $timeout };
}

function flush($rootScope, $timeout) {
  $rootScope.$digest();
  try { $timeout.flush(); } catch (e) { /* no pending timeout */ }
  $rootScope.$digest();
}

describe("a nullish turn result settles to idle, not error", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a bare string", "oops"],
  ])("chatTurn resolving %s does not throw and ends idle", (_label, resp) => {
    const { $scope, $rootScope, $timeout } = boot(resp);
    $scope.form.inputText = "investigate 198.51.100.4";
    expect(() => {
      $scope.sendMessage();
      flush($rootScope, $timeout);
    }).not.toThrow();
    expect($scope.viewState).toBe("idle");
    expect($scope.viewState).not.toBe("error");
  });

  test("a well-formed empty-transcript end_turn still settles idle (no regression)", () => {
    const { $scope, $rootScope, $timeout } = boot({ ok: true, stop_reason: "end_turn", transcript: [] });
    $scope.form.inputText = "hi";
    $scope.sendMessage();
    flush($rootScope, $timeout);
    expect($scope.viewState).toBe("idle");
  });
});
