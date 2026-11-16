"use strict";

// ─── Connector-resolution cache self-heals on a stale-resolution error (1.3) ──
//
// HIGH: the widget caches the SUCCESSFUL connector resolution (version +
// config_id). If the connector is uninstalled/renamed/reconfigured mid-session,
// every later executeConnectorAction 404s against the frozen resolution and
// nothing invalidates the cache — the whole widget is dead until a page reload.
// Fix: a stale-resolution error (404 / unknown-connector / bad-config) drops the
// cache and re-resolves ONCE so the widget recovers against a redeploy.

global.jasmine = global.jasmine || {};
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef
require("../widget/widgetAssets/js/fsrPbAgent.service.js");

const ng = window.angular; // eslint-disable-line no-undef
const CONNECTOR_NAME = "connector-fsr-agentic-assistant";

function makeHarness() {
  const execCalls = [];
  let execImpl;
  const connectorService = {
    executeConnectorAction: function (name, version, action, configId, payload) {
      execCalls.push({ name, version, action, configId, payload });
      return execImpl(execCalls.length);
    },
  };
  const mockConnector = { execute: () => _$q.reject({ message: "no mock" }) };
  let _$q, $httpBackend, service, $rootScope;
  let resolveCount = 0;
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("connectorService", connectorService);
    $provide.value("fsrPbMockConnectorService", mockConnector);
  });
  ng.mock.inject((_fsrPbAgentService_, _$q_, _$httpBackend_, _$rootScope_) => {
    service = _fsrPbAgentService_; _$q = _$q_; $httpBackend = _$httpBackend_; $rootScope = _$rootScope_;
  });
  $httpBackend.whenGET(/\/api\/integration\/connectors\/\?search=/).respond(() => {
    resolveCount += 1;
    return [200, { data: [{ name: CONNECTOR_NAME, version: "9.9.9",
      configuration: [{ name: "fsrpb-live", config_id: "cfg-live", default: true }] }] }];
  });
  const cfg = { mockMode: "real" };
  return {
    service, cfg, execCalls,
    setExec: (fn) => { execImpl = fn; },
    resolves: () => resolveCount,
    $q: () => _$q,
    flush: () => { try { $httpBackend.flush(); } catch (e) { /* no pending GET */ } $rootScope.$digest(); },
  };
}

describe("connector-resolution cache invalidation", () => {
  test("a 404 execute drops the cache, re-resolves, and retries once", () => {
    const h = makeHarness();
    // First execute 404s (stale resolution); the retry succeeds.
    h.setExec((n) => n === 1
      ? h.$q().reject({ status: 404, data: { message: "unknown connector" } })
      : h.$q().when({ status: "Success", data: { ok: true, turn: 1 } }));

    let result;
    h.service.chatTurn(h.cfg, { messages: [] }).then((r) => { result = r; });
    h.flush();

    expect(h.execCalls.length).toBe(2);          // original + one retry
    expect(h.resolves()).toBe(2);                // re-resolved after invalidation
    expect(result && result.ok).toBe(true);      // recovered transparently
  });

  test("a non-resolution error does NOT retry or re-resolve", () => {
    const h = makeHarness();
    h.setExec(() => h.$q().reject({ status: 500, data: { message: "internal error" } }));

    let rejected = false;
    h.service.chatTurn(h.cfg, { messages: [] }).catch(() => { rejected = true; });
    h.flush();

    expect(rejected).toBe(true);
    expect(h.execCalls.length).toBe(1);          // no retry on a server-side 500
    expect(h.resolves()).toBe(1);
  });
});
