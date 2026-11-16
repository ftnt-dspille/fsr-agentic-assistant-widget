"use strict";

// ─── Config-health surface + visible session override (needs_config help) ────
//
// The widget honors the connector's DEFAULT (starred) config — no hidden
// PREFERRED_CONFIG hardcode. When that default is broken (bad key / unreachable
// egress) the help panel needs to (a) enumerate every config, (b) health-probe
// each one against its own config_id, and (c) let the user adopt a healthy one
// for THIS session only (visible, non-persisted). These tests pin that service
// contract so the panel logic can't silently drift back to a hidden override.

global.jasmine = global.jasmine || {};
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef
require("../widget/widgetAssets/js/fsrPbAgent.service.js");

const ng = window.angular; // eslint-disable-line no-undef
const CONNECTOR_NAME = "connector-fsr-agentic-assistant";

// Two configs: the starred default (frank) is intentionally the BROKEN one, and
// a non-default (live) is healthy — the exact shape on the real box.
const CONFIGS = [
  { name: "fsrpb-frank", config_id: "cfg-frank", default: true },
  { name: "fsrpb-live", config_id: "cfg-live", default: false },
];
const HEALTH = {
  "cfg-frank": { ok: false, llm_key_configured: true, llm_reachable: false,
                 llm_error: "APIConnectionError: Connection refused", llm_provider: "openai" },
  "cfg-live": { ok: true, llm_key_configured: true, llm_reachable: true,
                llm_probe: "12 models", llm_error: null, llm_provider: "openai" },
};

function makeHarness() {
  const execCalls = [];
  const connectorService = {
    executeConnectorAction: function (name, version, action, configId, payload) {
      execCalls.push({ name, version, action, configId, payload });
      if (action === "health_check") {
        return _$q.when({ status: "Success", data: HEALTH[configId] || { ok: false } });
      }
      return _$q.when({ status: "Success", data: { ok: true } });
    },
  };
  const mockConnector = { execute: () => _$q.reject({ message: "no mock" }) };
  let _$q, $httpBackend, service, $rootScope, resolveCount = 0;
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("connectorService", connectorService);
    $provide.value("fsrPbMockConnectorService", mockConnector);
  });
  ng.mock.inject((_fsrPbAgentService_, _$q_, _$httpBackend_, _$rootScope_) => {
    service = _fsrPbAgentService_; _$q = _$q_; $httpBackend = _$httpBackend_; $rootScope = _$rootScope_;
  });
  $httpBackend.whenGET(/\/api\/integration\/connectors\/\?search=/).respond(() => {
    resolveCount += 1;
    return [200, { data: [{ name: CONNECTOR_NAME, version: "9.9.9", configuration: CONFIGS }] }];
  });
  return {
    service, execCalls,
    resolves: () => resolveCount,
    flush: () => { try { $httpBackend.flush(); } catch (e) { /* none pending */ } $rootScope.$digest(); },
  };
}

describe("config-health + session override", () => {
  test("resolveConnector honors the connector DEFAULT (fsrpb-frank), not a hardcoded name", () => {
    const h = makeHarness();
    let res;
    h.service.resolveConnector().then((r) => { res = r; });
    h.flush();
    expect(res.configName).toBe("fsrpb-frank");
    expect(res.isDefault).toBe(true);
    expect(res.isOverride).toBe(false);
  });

  test("listConfigs returns every config with its default flag", () => {
    const h = makeHarness();
    let cfgs;
    h.service.listConfigs().then((c) => { cfgs = c; });
    h.flush();
    expect(cfgs.map((c) => c.name)).toEqual(["fsrpb-frank", "fsrpb-live"]);
    expect(cfgs.find((c) => c.name === "fsrpb-frank").default).toBe(true);
  });

  test("healthCheckConfig probes the GIVEN config_id and unwraps the payload", () => {
    const h = makeHarness();
    let frank, live;
    h.service.healthCheckConfig("cfg-frank").then((r) => { frank = r; });
    h.service.healthCheckConfig("cfg-live").then((r) => { live = r; });
    h.flush();
    expect(frank.ok).toBe(false);
    expect(frank.llm_reachable).toBe(false);
    expect(live.ok).toBe(true);
    // The op must be executed against each config_id explicitly.
    const hc = h.execCalls.filter((c) => c.action === "health_check");
    expect(hc.map((c) => c.configId).sort()).toEqual(["cfg-frank", "cfg-live"]);
  });

  test("setConfigOverride makes resolveConnector select the override; clear reverts to default", () => {
    const h = makeHarness();
    h.service.setConfigOverride({ config_id: "cfg-live", name: "fsrpb-live" });
    let res;
    h.service.resolveConnector().then((r) => { res = r; });
    h.flush();
    expect(res.configName).toBe("fsrpb-live");
    expect(res.isOverride).toBe(true);
    expect(h.service.activeOverride()).toEqual({ config_id: "cfg-live", name: "fsrpb-live" });

    h.service.clearConfigOverride();
    let res2;
    h.service.resolveConnector().then((r) => { res2 = r; });
    h.flush();
    expect(res2.configName).toBe("fsrpb-frank");
    expect(h.service.activeOverride()).toBe(null);
  });

  test("a stale override (config no longer present) falls back to the default", () => {
    const h = makeHarness();
    h.service.setConfigOverride({ config_id: "cfg-gone", name: "deleted" });
    let res;
    h.service.resolveConnector().then((r) => { res = r; });
    h.flush();
    expect(res.configName).toBe("fsrpb-frank");
    expect(h.service.activeOverride()).toBe(null); // dropped
  });

  test("refresh busts the record cache so a Re-check re-fetches configs", () => {
    const h = makeHarness();
    h.service.resolveConnector().then(() => {});
    h.flush();
    expect(h.resolves()).toBe(1);
    // Without refresh the record is cached — no new GET.
    h.service.resolveConnector().then(() => {});
    h.flush();
    expect(h.resolves()).toBe(1);
    // Re-check busts it.
    h.service.refresh();
    h.service.resolveConnector().then(() => {});
    h.flush();
    expect(h.resolves()).toBe(2);
  });
});
