"use strict";

// ─── Fix 3: build-payload trim - cap re-sent prior tool_results ─────────────
//
// Every prior tool_result is re-sent verbatim on the next turn (full records +
// big searches ≈ 30 KB), bloating the build request and model context (a 300 s
// timeout contributor). _serializeMessagesForServer must cap each prior
// tool_result while leaving small ones untouched. We drive the real controller
// and capture what chatTurn receives.

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

function makeHarness() {
  let $q, $timeout, $rootScope, $controller;
  const sent = [];
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: (cfg, payload) => { sent.push(payload); return $q.defer().promise; },
    chatPoll: () => $q.defer().promise
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
  return { $scope, sent };
}

describe("fsrAgenticAssistant - Fix 3 build payload trim", () => {
  test("a huge prior tool_result is truncated; a small one is left intact", () => {
    const { $scope, sent } = makeHarness();
    const big = "R".repeat(30000);
    $scope.messages.push({
      role: "assistant", ts: Date.now(), text: "",
      events: [
        { type: "tool_call", name: "get_record", _toolUseId: "tu1",
          inputDisplay: '{"iri":"/x"}', resultDisplay: big },
        { type: "tool_call", name: "ping", _toolUseId: "tu2",
          inputDisplay: '{}', resultDisplay: "small ok" }
      ]
    });

    $scope.form.inputText = "build it";
    $scope.sendMessage();

    expect(sent).toHaveLength(1);
    const content = sent[0].messages.find((m) => m.role === "assistant").content;
    const bigResult = content.find((c) => c.type === "tool_result" && c.tool_use_id === "tu1");
    const smallResult = content.find((c) => c.type === "tool_result" && c.tool_use_id === "tu2");

    expect(bigResult.content.length).toBeLessThan(2200);
    expect(bigResult.content).toMatch(/chars truncated/);
    expect(smallResult.content).toBe("small ok");
  });

  test("a live chat_turn opts into detached mode (contract 2.7.0)", () => {
    const { $scope, sent } = makeHarness();
    $scope.form.inputText = "build it";
    $scope.sendMessage();
    expect(sent).toHaveLength(1);
    expect(sent[0].mode).toBe("live");
    expect(sent[0].detached).toBe(true);
  });
});
