"use strict";

// ─── The designer reads the open playbook ───────────────────────────────────
//
// Seeding the playbook's IDENTITY (playbook.editor.entity.test.js) is not enough
// to make an authoring turn work: the agent's build tool slice has NO way to
// fetch a live playbook - get_record/search_module_records are scoped out of
// build, search_playbooks queries an offline pattern corpus, and analyze_playbook
// takes yaml_text only. So the assistant was being asked to edit a playbook it
// could not see, and live it dead-ended asking the analyst to paste in what was
// already on their screen (0/4 runs). Handed the YAML, it edited correctly first
// try - the blocker was the read path, not the model and not the prompt.
//
// So the widget reads it: decompile_playbook at designer mount → currentYaml +
// entity.playbook_yaml on every build turn.

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
const chainable = { then: function () { return chainable; }, catch: function () { return chainable; } };

const YAML = "collection: C\nplaybooks:\n- name: Stamp Marker\n  steps:\n  - name: Emit\n";

const $state = { current: { name: "main.modules.list" }, params: {} };

let $controller, $rootScope, $httpBackend, $q, $timeout;
let agentService, decompileCalls, turnCalls;

beforeEach(() => {
  $state.current = { name: "main.modules.list" };
  $state.params = {};
  decompileCalls = [];
  turnCalls = [];

  ng.mock.module("cybersponse", ($provide) => {
    agentService = {
      execute: () => chainable,
      resume: () => chainable,
      chatHistory: () => chainable,
      chatTurn: function (cfg, payload) { turnCalls.push(payload); return chainable; },
      // Mock mode: _startStreaming asks the service which mode it's in and only
      // polls the progress feed when live.
      modeInfo: () => ({ mode: "mock" }),
      decompilePlaybook: function (cfg, iri) {
        decompileCalls.push(iri);
        return $q.when({ ok: true, yaml: YAML, workflow_uuid: "pb-1", name: "Stamp Marker" });
      },
    };
    $provide.value("fsrPbAgentService", agentService);
    $provide.value("config", { seedFromEntity: true });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$httpBackend_, _$q_, _$timeout_) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
    $httpBackend = _$httpBackend_;
    $q = _$q_;
    $timeout = _$timeout_;
  });
  $httpBackend.whenGET(/\/api\/3\/workflows\//).respond(200, {
    "@id": "/api/3/workflows/pb-1", uuid: "pb-1", name: "My Playbook",
  });
  // A triage mount resolves its own record (FormEntityService → HTTP).
  $httpBackend.whenGET(/\/api\/3\/alerts\//).respond(200, {
    "@id": "/api/3/alerts/a-1", uuid: "a-1", name: "An alert",
  });
});

function bootInEditor(id) {
  $state.current = { name: "main.playbookDetail" };
  $state.params = { id: id || "pb-1" };
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  try { $timeout.flush(0); } catch (e) { /* no pending timeout */ }
  $scope.$digest();
  return $scope;
}

// The wire payload of a real turn - what the connector actually receives.
function sendTurn($scope, text) {
  $scope.form.inputText = text || "change ALPHA to BRAVO";
  $scope.sendMessage();
  $scope.$digest();
  return turnCalls[turnCalls.length - 1];
}

describe(`${viewCtrlName} - reading the open playbook`, () => {
  test("the designer mount reads the open playbook by IRI", () => {
    bootInEditor("pb-1");
    expect(decompileCalls).toEqual(["/api/3/workflows/pb-1"]);
  });

  test("the YAML rides the build turn as entity.playbook_yaml", () => {
    // The whole point: the assistant has no tool of its own that can read a live
    // playbook, so if this isn't on the wire the turn is blind.
    const $scope = bootInEditor("pb-1");
    const payload = sendTurn($scope);
    expect(payload.entity.playbook_yaml).toBe(YAML);
  });

  test("it seeds currentYaml, so Save has a base to push", () => {
    // A partial edit from the assistant would otherwise have nothing to apply to.
    const $scope = bootInEditor("pb-1");
    expect($scope.currentYaml).toBe(YAML);
  });

  test("a slow read never clobbers YAML already in hand", () => {
    // The real race: the seed is async, so it can land AFTER the analyst (or a
    // turn) has produced YAML. Overwriting there would silently discard work.
    const d = $q.defer();
    agentService.decompilePlaybook = function (cfg, iri) {
      decompileCalls.push(iri);
      return d.promise;
    };
    const $scope = bootInEditor("pb-1");
    $scope.currentYaml = "collection: mine\n";
    d.resolve({ ok: true, yaml: YAML });
    $scope.$digest();
    expect($scope.currentYaml).toBe("collection: mine\n");
  });

  test("a playbook that cannot be read leaves the widget usable", () => {
    // Degraded, not broken: the analyst can still paste YAML by hand, and a red
    // banner on mount for something they did not ask for is worse than the
    // assistant asking them for the playbook.
    agentService.decompilePlaybook = () => $q.reject(new Error("403"));
    const $scope = bootInEditor("pb-1");
    expect($scope.currentYaml).toBeFalsy();
    expect(sendTurn($scope).entity.playbook_yaml).toBeUndefined();
    expect($scope.viewState).not.toBe("error");
  });

  test("an ok:false response is not seeded as YAML", () => {
    // Fail-closed: the connector reports rather than half-renders a playbook, and
    // a truncated seed that got edited and pushed would delete the analyst's steps.
    agentService.decompilePlaybook = () =>
      $q.when({ ok: false, error: { code: "decompile_failed" } });
    const $scope = bootInEditor("pb-1");
    expect($scope.currentYaml).toBeFalsy();
  });

  test("a triage mount neither reads a playbook nor sends one", () => {
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope });
    $scope.entityContext = { iri: "/api/3/alerts/a-1", module: "alerts" };
    $scope.$digest();
    expect(decompileCalls).toEqual([]);
    const payload = sendTurn($scope);
    expect(payload.entity && payload.entity.playbook_yaml).toBeUndefined();
  });

  // ─── The mount race ────────────────────────────────────────────────────────
  // The seed is async, so a fast analyst can fire the FIRST build turn before the
  // decompile lands. Without gating, that turn ships without entity.playbook_yaml
  // and the assistant is blind to the very playbook it is editing - then flails at
  // read-by-IRI tools it does not have. The first turn must wait for the seed.
  test("the first build turn waits for a slow seed, then ships grounded", () => {
    const d = $q.defer();
    agentService.decompilePlaybook = function (cfg, iri) {
      decompileCalls.push(iri);
      return d.promise;
    };
    const $scope = bootInEditor("pb-1");
    // seed still in flight - fire a turn now
    $scope.form.inputText = "change ALPHA to BRAVO";
    $scope.sendMessage();
    $scope.$digest();
    expect(turnCalls.length).toBe(0);          // held back, not sent blind
    expect($scope.viewState).toBe("sending");  // UI already shows work in progress
    // the seed lands
    d.resolve({ ok: true, yaml: YAML });
    $scope.$digest();
    expect(turnCalls.length).toBe(1);          // now it fires
    expect(turnCalls[0].entity.playbook_yaml).toBe(YAML); // grounded
  });

  test("the first build turn still sends if the seed fails - no hang", () => {
    // Fail-closed must not become fail-open-into-a-hang: if the decompile errors,
    // the turn proceeds (blind, and the assistant should say so) rather than
    // wedging on a promise that never settles.
    const d = $q.defer();
    agentService.decompilePlaybook = function (cfg, iri) {
      decompileCalls.push(iri);
      return d.promise;
    };
    const $scope = bootInEditor("pb-1");
    $scope.form.inputText = "hi";
    $scope.sendMessage();
    $scope.$digest();
    expect(turnCalls.length).toBe(0);
    d.reject(new Error("403"));
    $scope.$digest();
    expect(turnCalls.length).toBe(1);          // proceeded, did not hang
    expect(turnCalls[0].entity && turnCalls[0].entity.playbook_yaml).toBeUndefined();
  });

  test("later turns don't re-wait once the seed has settled", () => {
    // The gate is for the first turn only - once the seed is done the promise is
    // cleared, so steady-state turns run synchronously with no deferral.
    const $scope = bootInEditor("pb-1"); // default decompile resolves during boot
    expect(sendTurn($scope).entity.playbook_yaml).toBe(YAML);
    expect(turnCalls.length).toBe(1);
    $scope.viewState = "idle";           // simulate the prior turn finishing
    sendTurn($scope);
    expect(turnCalls.length).toBe(2);    // fired without a re-wait…
    expect(turnCalls[1].entity.playbook_yaml).toBe(YAML); // …and still grounded
  });
});
