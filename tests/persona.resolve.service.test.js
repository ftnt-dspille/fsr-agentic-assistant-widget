"use strict";

// ─── resolvePersona: Key Store read → connector fallback → mapping ───────────
//
// A module may declare an assistant persona (Key Store
// `fsr_assistant_profile:<module>`, jSONValue.ui). The widget frames its
// opener from that. Resolution: a direct /api/3/keys read first; on 403 (the
// known in-browser gate) or a miss, fall back to the connector's
// `resolve_persona` action (which also resolves bind_modules). Any failure ⇒
// null = triage default. This asserts each branch + the record→ui mapping.

global.jasmine = global.jasmine || {};
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef
require("../widget/widgetAssets/js/fsrPbAgent.service.js");

const ng = window.angular; // eslint-disable-line no-undef
const CONNECTOR_NAME = "connector-fsr-agentic-assistant";

function makeHarness() {
  const connectorCalls = [];
  const connectorService = {
    executeConnectorAction: function (name, version, action, configId, payload) {
      connectorCalls.push({ action, payload });
      return _$q.when(this._next || { operation: action, status: "Success", message: "", data: { found: false } });
    },
    _next: null,
  };
  const mockConnector = { execute: () => _$q.reject({ message: "no mock" }) };
  let _$q, $httpBackend, service, $rootScope;
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("connectorService", connectorService);
    $provide.value("fsrPbMockConnectorService", mockConnector);
  });
  ng.mock.inject((_fsrPbAgentService_, _$q_, _$httpBackend_, _$rootScope_) => {
    service = _fsrPbAgentService_; _$q = _$q_; $httpBackend = _$httpBackend_; $rootScope = _$rootScope_;
  });
  // The connector-identity lookup used by the connector-fallback path.
  $httpBackend.whenGET(/\/api\/integration\/connectors\/\?search=/).respond(200, {
    data: [{ name: CONNECTOR_NAME, version: "9.9.9",
      configuration: [{ name: "fsrpb-live", config_id: "cfg-live", default: true }] }]
  });
  // Force real mode (skip the mock branch) - resolvePersona checks _activeScenario.
  const cfg = { mockMode: "real" };
  return { service, connectorService, cfg,
    flush: () => { $httpBackend.flush(); $rootScope.$digest(); },
    backend: $httpBackend, digest: () => $rootScope.$digest() };
}

describe("fsrPbAgentService.resolvePersona", () => {
  test("direct Key Store hit maps jSONValue.ui → framing", () => {
    const h = makeHarness();
    h.backend.expectGET(/\/api\/3\/keys\?key=fsr_assistant_profile%3Aztpf_templates/).respond(200, {
      "hydra:member": [{
        key: "fsr_assistant_profile:ztpf_templates",
        jSONValue: { version: 1, ui: {
          label: "ZTPF Template Author",
          greeting: "Authoring {module}: {name}",
          subtitle: "Ask me to render, check, or edit this template.",
          placeholder: "Describe the template…",
          pullLabel: "This template",
          pullHint: "Pull in this template's fields",
          buildHint: "Describe the template you want and I'll write it.",
          quickActions: [{ key: "explain", label: "Explain", sub: "…", prompt: "Explain this template." }],
        } }
      }]
    });
    let out;
    h.service.resolvePersona(h.cfg, "ztpf_templates").then((p) => { out = p; });
    h.flush();
    expect(out).toBeTruthy();
    expect(out.found).toBe(true);
    expect(out.label).toBe("ZTPF Template Author");
    expect(out.greeting).toBe("Authoring {module}: {name}");
    expect(out.placeholder).toBe("Describe the template…");
    expect(out.quickActions.length).toBe(1);
    // All framing fields survive the whitelist (pullLabel/pullHint were being
    // silently dropped before, so their controller overrides never fired).
    expect(out.subtitle).toBe("Ask me to render, check, or edit this template.");
    expect(out.pullLabel).toBe("This template");
    expect(out.pullHint).toBe("Pull in this template's fields");
    expect(out.buildHint).toBe("Describe the template you want and I'll write it.");
  });

  test("list-page framing keys survive the whitelist", () => {
    // Over a module LIST the widget reads ui.listQuickActions / listLabel /
    // listSubtitle / listNoun / recordNoun; a key the whitelist omits is
    // silently dropped (pullLabel had exactly that bug).
    const h = makeHarness();
    h.backend.expectGET(/\/api\/3\/keys/).respond(200, {
      "hydra:member": [{
        key: "fsr_assistant_profile:ztpf_automation_profiles",
        jSONValue: { version: 1, ui: {
          listQuickActions: [{ key: "new_profile", label: "Create new profile", sub: "…", prompt: "I want a new profile." }],
          listLabel: "Automation profiles",
          listSubtitle: "Ask about these profiles or create one.",
          listNoun: "profiles",
          recordNoun: "profile",
        } }
      }]
    });
    let out;
    h.service.resolvePersona(h.cfg, "ztpf_automation_profiles").then((p) => { out = p; });
    h.flush();
    expect(out.listQuickActions.map((q) => q.key)).toEqual(["new_profile"]);
    expect(out.listLabel).toBe("Automation profiles");
    expect(out.listSubtitle).toBe("Ask about these profiles or create one.");
    expect(out.listNoun).toBe("profiles");
    expect(out.recordNoun).toBe("profile");
  });

  test("Key Store record with NO ui block still returns a found persona (neutral framing)", () => {
    const h = makeHarness();
    h.backend.expectGET(/\/api\/3\/keys/).respond(200, {
      "hydra:member": [{ key: "fsr_assistant_profile:widgets", jSONValue: { version: 1 } }]
    });
    let out;
    h.service.resolvePersona(h.cfg, "widgets").then((p) => { out = p; });
    h.flush();
    expect(out.found).toBe(true);
    expect(out.greeting).toBeNull();
    expect(out.quickActions).toBeNull();
  });

  test("empty direct read falls back to the connector (bind_modules), maps its response", () => {
    const h = makeHarness();
    h.backend.expectGET(/\/api\/3\/keys/).respond(200, { "hydra:member": [] });
    h.connectorService._next = { operation: "resolve_persona", status: "Success", message: "",
      data: { found: true, label: "Bound Persona", ui: { greeting: "Hi {name}" } } };
    let out;
    h.service.resolvePersona(h.cfg, "ztpf_actions").then((p) => { out = p; });
    h.flush();
    expect(out.found).toBe(true);
    expect(out.label).toBe("Bound Persona");
    expect(out.greeting).toBe("Hi {name}");
    expect(h.connectorService._next === null).toBe(false); // connector fallback path exercised
  });

  test("403 on the direct read falls through to the connector", () => {
    const h = makeHarness();
    h.backend.expectGET(/\/api\/3\/keys/).respond(403, { message: "forbidden" });
    h.connectorService._next = { operation: "resolve_persona", status: "Success", message: "",
      data: { found: true, greeting: "Fallback greeting" } };
    let out;
    h.service.resolvePersona(h.cfg, "cases").then((p) => { out = p; });
    h.flush();
    expect(out).toBeTruthy();
    expect(out.greeting).toBe("Fallback greeting");
  });

  test("connector reports found:false ⇒ null (triage default)", () => {
    const h = makeHarness();
    h.backend.expectGET(/\/api\/3\/keys/).respond(200, { "hydra:member": [] });
    h.connectorService._next = { operation: "resolve_persona", status: "Success", message: "",
      data: { found: false } };
    let out = "unset";
    h.service.resolvePersona(h.cfg, "alerts").then((p) => { out = p; });
    h.flush();
    expect(out).toBeNull();
  });

  test("no module ⇒ resolves null without any HTTP", () => {
    const h = makeHarness();
    let out = "unset";
    h.service.resolvePersona(h.cfg, "").then((p) => { out = p; });
    h.digest();
    expect(out).toBeNull();
  });
});
