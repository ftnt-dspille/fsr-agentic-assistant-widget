"use strict";

// ─── needs_config help panel - controller state machine ──────────────────────
//
// When the connector resolves but its ACTIVE (starred default) config can't run
// a turn, the widget must NOT crash and must NOT silently fall back: it enters a
// needs_config help state that diagnoses the fault, grades every config, and
// offers a VISIBLE session-only override to a healthy one. This drives the real
// controller through that flow with a stubbed agent service.

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
const $state = { current: { name: "viewPanel.modulesDetail" }, params: { module: "alerts", id: "a-1" } };

// frank = starred default but BROKEN (egress refused); live = healthy non-default.
const CFGS = [
  { config_id: "cfg-frank", name: "fsrpb-frank", default: true },
  { config_id: "cfg-live", name: "fsrpb-live", default: false },
];
const HEALTH = {
  "cfg-frank": { ok: false, llm_key_configured: true, llm_reachable: false,
                 llm_error: "APIConnectionError: Connection refused" },
  "cfg-live": { ok: true, llm_key_configured: true, llm_reachable: true, llm_probe: "12 models" },
};

let $controller, $rootScope, $timeout, $q, override;

function setup() {
  override = null;
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      connectorName: "connector-fsr-agentic-assistant",
      modeInfo: () => ({ mode: "live" }),
      chatHistory: () => $q.when({ turns: [] }),
      chatTurn: () => $q.when({ accepted: true, turn: 1 }),
      chatResume: () => $q.when({}),
      resume: () => $q.when({}),
      listSessions: () => $q.when({ sessions: [] }),
      resolvePersona: () => $q.when(null),
      resolveConnector: () => {
        const chosen = override
          ? CFGS.find((c) => c.config_id === override.config_id)
          : CFGS.find((c) => c.default);
        return $q.when({
          name: "connector-fsr-agentic-assistant", version: "9.9.9",
          configId: chosen.config_id, configName: chosen.name,
          isDefault: !!chosen.default, isOverride: !!override,
        });
      },
      healthCheckConfig: (id) => $q.when(HEALTH[id] || { ok: false }),
      listConfigs: () => $q.when(CFGS.slice()),
      setConfigOverride: (c) => { override = { config_id: c.config_id, name: c.name }; },
      clearConfigOverride: () => { override = null; },
      activeOverride: () => override,
      refresh: () => {},
    });
    $provide.value("config", { seedFromEntity: false, opener: "off", mockMode: "real", maxTurns: 8 });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_, _$q_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $timeout = _$timeout_; $q = _$q_;
  });
}

function boot() {
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush(0);        // the _probeConnector $timeout(…, 0)
  $rootScope.$digest();
  try { $timeout.flush(); } catch (e) { /* no more timers */ }
  $rootScope.$digest();
  return $scope;
}

describe("needs_config help panel (controller)", () => {
  beforeEach(setup);

  test("a broken default config enters needs_config with a specific diagnosis (no crash)", () => {
    const $scope = boot();
    expect($scope.connectorReady).toBe(false);
    expect($scope.connectorHelp).toBeTruthy();
    expect($scope.connectorHelp.fault).toBe("unreachable");
    expect($scope.connectorHelp.activeConfig.name).toBe("fsrpb-frank");
    expect($scope.connectorHelp.activeConfig.isDefault).toBe(true);
    expect($scope.connectorHelp.detail).toMatch(/refused/i);
    expect($scope.connectorHelp.settingsUrl).toContain("/settings/connectors");
  });

  test("it grades every config and surfaces the healthy one as override-able", () => {
    const $scope = boot();
    const byName = {};
    $scope.connectorHelp.grades.forEach((g) => { byName[g.name] = g; });
    expect(byName["fsrpb-frank"].ok).toBe(false);
    expect(byName["fsrpb-live"].ok).toBe(true);
    // Only the healthy, non-active config is offered for a temp override.
    expect($scope.connectorHelp.healthyConfigs.map((g) => g.name)).toEqual(["fsrpb-live"]);
  });

  test("adopting a healthy config for the session clears the panel and shows the override banner", () => {
    const $scope = boot();
    const live = $scope.connectorHelp.grades.find((g) => g.name === "fsrpb-live");
    $scope.useConfigTemporarily(live);
    $timeout.flush(0);
    $rootScope.$digest();
    try { $timeout.flush(); } catch (e) { /* none */ }
    $rootScope.$digest();

    expect($scope.connectorReady).toBe(true);
    expect($scope.connectorHelp).toBe(null);
    expect($scope.connectorOverride).toEqual({ config_id: "cfg-live", name: "fsrpb-live" });
  });

  test("clearing the override re-selects the (still broken) default and re-shows the panel", () => {
    const $scope = boot();
    const live = $scope.connectorHelp.grades.find((g) => g.name === "fsrpb-live");
    $scope.useConfigTemporarily(live);
    $timeout.flush(0); $rootScope.$digest();
    try { $timeout.flush(); } catch (e) { /* none */ } $rootScope.$digest();
    expect($scope.connectorReady).toBe(true);

    $scope.clearConfigOverride();
    $timeout.flush(0); $rootScope.$digest();
    try { $timeout.flush(); } catch (e) { /* none */ } $rootScope.$digest();

    expect($scope.connectorReady).toBe(false);
    expect($scope.connectorHelp).toBeTruthy();
    expect($scope.connectorOverride).toBe(null);
  });
});

// A connector installed without its fsr-playbooks library (the appliance's
// installer could not reach PyPI) reports `fault: framework_missing`. No config
// fixes that, so the widget must not open the config help panel or call it a
// blip to retry: it shows the connector's instruction and keeps chat closed.
describe("connector installed without its library", () => {
  beforeEach(setup);
  const saved = HEALTH["cfg-frank"];
  afterEach(() => { HEALTH["cfg-frank"] = saved; });

  test("framework_missing shows the connector's instruction, not the config panel", () => {
    HEALTH["cfg-frank"] = { ok: false, fault: "framework_missing",
      message: "The Agentic Assistant connector is installed, but its library fsr-playbooks==0.6.62 is not. Allow PyPI ... then reinstall the connector." };
    const $scope = boot();
    expect($scope.connectorReady).toBe(false);
    expect($scope.connectorHelp).toBeNull();
    expect($scope.connectorGateMessage).toContain("fsr-playbooks==0.6.62");
  });

  test("a fault with no message still says what to do", () => {
    HEALTH["cfg-frank"] = { ok: false, fault: "framework_mismatch" };
    const $scope = boot();
    expect($scope.connectorReady).toBe(false);
    expect($scope.connectorHelp).toBeNull();
    expect($scope.connectorGateMessage).toMatch(/Reinstall the connector/);
  });
});
