"use strict";

// A card the connector flags config_required (several configurations, none the
// one) cannot be approved until the analyst picks one; a refused approval
// re-shows the picker with the connector's choices instead of failing.

global.jasmine = global.jasmine || {}; // angular-mocks lifecycle gate (before requires)
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
const R = window.FsrPbRender; // eslint-disable-line no-undef
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };

const LOCAL = { id: "loc-1", name: "fortigate-lab", default: true, runs_on_agent: false };
const OTHER = { id: "oth-1", name: "fortigate-dr", default: false, runs_on_agent: false };

function card(extra) {
  return R.buildAssistantMessage([Object.assign({
    type: "action_card", id: "card-1", connector: "fortigate-firewall", operation: "block_ip_new",
    summary: "Block 203.0.113.9", args: { ip_addresses: "203.0.113.9" },
  }, extra)], OPTS).events.find((e) => e.type === "action_card");
}

function boot(resume) {
  let $q, $rootScope, $controller, $timeout;
  const resumeSpy = jest.fn();
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when({ ok: true, stop_reason: "end_turn", transcript: [] }),
    chatResume: (...a) => { resumeSpy(...a); return $q.when(resume(a[1])); }
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
  return { $scope, $rootScope, resumeSpy };
}

const OK = () => ({ ok: true, stop_reason: "end_turn", transcript: [{ type: "text", text: "Done." }] });

describe("a config_required card waits for a configuration pick", () => {
  test("no pick: needs a config, approve does nothing", () => {
    const { $scope, resumeSpy } = boot(OK);
    const c = card({ config_required: true, config_options: [LOCAL, OTHER] });
    $scope.messages.push({ role: "assistant", text: "", events: [c], ts: 1 });
    expect(c.configRequired).toBe(true);
    expect($scope.actionCardNeedsConfig(c)).toBe(true);
    $scope.confirmActionCard(c);
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  test("a pick enables approve and is what gets sent", () => {
    const { $scope, resumeSpy } = boot(OK);
    const c = card({ config_required: true, config_options: [LOCAL, OTHER] });
    $scope.messages.push({ role: "assistant", text: "", events: [c], ts: 1 });
    c.configId = "oth-1";
    expect($scope.actionCardNeedsConfig(c)).toBe(false);
    $scope.confirmActionCard(c);
    expect(resumeSpy.mock.calls[0][1].config).toBe("oth-1");
  });

  test("a card without the flag is unchanged", () => {
    const c = card({ config_options: [LOCAL, OTHER] });
    expect(c.configRequired).toBe(false);
    expect(R.actionCardNeedsConfig(c)).toBe(false);
  });

  test("the reason is analyst-facing text", () => {
    const { $scope } = boot(OK);
    expect($scope.CONFIG_REQUIRED_TEXT).toBe("Choose which configuration to run this on before approving.");
  });
});

describe("a config_required refusal re-shows the picker", () => {
  const REFUSE = { ok: false, error: { code: "config_required",
    message: "Pick a configuration.", card_id: "card-1",
    config_options: [LOCAL, OTHER], choices: ["fortigate-lab", "fortigate-dr"] } };

  test("the card stays open with the choices, needs a pick, and shows no failure", () => {
    const { $scope, $rootScope } = boot(() => REFUSE);
    const c = card({});
    $scope.messages.push({ role: "assistant", text: "", events: [c], ts: 1 });
    $scope.confirmActionCard(c);
    $rootScope.$digest();
    expect(c._resolved).toBe(false);
    expect(c._error).toBeFalsy();
    expect(c.configOptions.map((o) => o.id)).toEqual(["loc-1", "oth-1"]);
    expect(c.configId).toBe("");
    expect($scope.actionCardNeedsConfig(c)).toBe(true);
    expect($scope.viewState).not.toBe("error");
  });

  test("with no config_options the choice names fill the picker", () => {
    const names = { ok: false, error: { code: "config_required", message: "x", choices: ["fortigate-lab", "fortigate-dr"] } };
    const { $scope, $rootScope, resumeSpy } = boot(() => names);
    const c = card({});
    $scope.messages.push({ role: "assistant", text: "", events: [c], ts: 1 });
    $scope.confirmActionCard(c);
    $rootScope.$digest();
    expect(c.configOptions.map((o) => o.label)).toEqual(["fortigate-lab", "fortigate-dr"]);
    c.configId = "fortigate-dr";
    $scope.confirmActionCard(c);
    expect(resumeSpy.mock.calls[1][1].config).toBe("fortigate-dr");
  });

  test("picking one then approving sends it", () => {
    let n = 0;
    const { $scope, $rootScope, resumeSpy } = boot(() => (n++ === 0 ? REFUSE : OK()));
    const c = card({});
    $scope.messages.push({ role: "assistant", text: "", events: [c], ts: 1 });
    $scope.confirmActionCard(c);
    $rootScope.$digest();
    c.configId = "loc-1";
    $scope.confirmActionCard(c);
    $rootScope.$digest();
    expect(resumeSpy.mock.calls[1][1].config).toBe("loc-1");
    expect(c._resolved).toBe(true);
  });
});
