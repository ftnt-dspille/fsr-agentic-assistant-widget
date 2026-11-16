"use strict";

// An action card says which connector configuration it runs on, and when the
// connector has more than one the analyst can switch before approving. Asked
// live to block an address through the agent-bound FortiGate config, the chat
// once staged a card without any config and the block ran on the master's
// default instead -- the analyst had no way to see or change that.

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
const AGENT = { id: "agt-1", name: "Lab FortiGate", default: false,
                runs_on_agent: true, agent_id: "a80", agent_name: "fsr-agent-80" };

function card(extra) {
  return R.buildAssistantMessage([Object.assign({
    type: "action_card", id: "card-1", connector: "fortigate-firewall", operation: "block_ip_new",
    summary: "Block 203.0.113.9", args: { ip_addresses: "203.0.113.9" },
  }, extra)], OPTS).events.find((e) => e.type === "action_card");
}

describe("the run-on config reaches the render model", () => {
  test("an agent config is labelled with its agent and preselected", () => {
    const c = card({ config: AGENT, config_options: [LOCAL, AGENT] });
    expect(c.runsOn).toMatchObject({ id: "agt-1", runsOnAgent: true, agentName: "fsr-agent-80" });
    expect(c.runsOn.label).toBe("Lab FortiGate (on agent fsr-agent-80)");
    expect(c.configId).toBe("agt-1");
    expect(c.configOptions.map((o) => o.id)).toEqual(["loc-1", "agt-1"]);
  });

  test("a local config is its plain name, not marked as an agent", () => {
    const c = card({ config: LOCAL, config_options: [LOCAL, AGENT] });
    expect(c.runsOn).toMatchObject({ id: "loc-1", runsOnAgent: false, label: "fortigate-lab", isDefault: true });
  });

  test("a name that already names its agent is not doubled", () => {
    const c = card({ config: Object.assign({}, AGENT, { name: "Lab FortiGate (fsr-agent-80)" }) });
    expect(c.runsOn.label).toBe("Lab FortiGate (fsr-agent-80) (FortiSOAR agent)");
  });

  test("a single option offers no picker", () => {
    const c = card({ config: LOCAL, config_options: [LOCAL] });
    expect(c.configOptions).toEqual([]);
    expect(c.configId).toBe("loc-1");
  });

  test("a card with no config is unchanged (older connector)", () => {
    const c = card({});
    expect(c.runsOn).toBeNull();
    expect(c.configOptions).toEqual([]);
    expect(c.configId).toBe("");
  });

  test("a config without an id is dropped, not rendered as blank", () => {
    expect(card({ config: { name: "x" } }).runsOn).toBeNull();
  });
});

function boot() {
  let $q, $rootScope, $controller, $timeout;
  const resumeSpy = jest.fn();
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when({ ok: true, stop_reason: "end_turn", transcript: [] }),
    chatResume: (...a) => {
      resumeSpy(...a);
      return $q.when({ ok: true, session_id: "s", turn: 2, turn_id: "t2", stop_reason: "end_turn",
                       contract_version: "2.8.0", transcript: [{ type: "text", text: "Done." }] });
    }
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
  return { $scope, resumeSpy };
}

describe("approving sends the chosen config", () => {
  test("the preselected config goes on the resume payload", () => {
    const { $scope, resumeSpy } = boot();
    const c = card({ config: AGENT, config_options: [LOCAL, AGENT] });
    $scope.messages.push({ role: "assistant", text: "", events: [c], ts: 1 });
    $scope.confirmActionCard(c);
    expect(resumeSpy.mock.calls[0][1].config).toBe("agt-1");
  });

  test("an analyst switch is what gets sent, and what the line shows", () => {
    const { $scope, resumeSpy } = boot();
    const c = card({ config: AGENT, config_options: [LOCAL, AGENT] });
    $scope.messages.push({ role: "assistant", text: "", events: [c], ts: 1 });
    c.configId = "loc-1";
    expect($scope.actionCardRunsOn(c).id).toBe("loc-1");
    $scope.confirmActionCard(c);
    expect(resumeSpy.mock.calls[0][1].config).toBe("loc-1");
  });

  test("no config on the card means no config key on the payload", () => {
    const { $scope, resumeSpy } = boot();
    const c = card({});
    $scope.messages.push({ role: "assistant", text: "", events: [c], ts: 1 });
    expect($scope.actionCardRunsOn(c)).toBeFalsy();
    $scope.confirmActionCard(c);
    expect(resumeSpy.mock.calls[0][1]).not.toHaveProperty("config");
  });
});
