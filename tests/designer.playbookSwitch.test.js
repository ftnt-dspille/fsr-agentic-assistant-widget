"use strict";

// --- Playbook A -> playbook B in the designer ---------------------------------
//
// Live bug: the analyst worked on playbook A in the designer, created a new
// playbook B, opened it, clicked "+ New" and asked for a playbook. The widget
// kept A as its entity (it only checked "is the entity a workflows record?"),
// so every turn sent A's YAML -- with A's staged, unsaved step -- as the open
// playbook. The assistant built onto A, and Apply merged A's name, uuid and
// steps onto B's canvas. Saving B would have written that over A.
//
// The open playbook is the one in $state.params.id. Switching must re-point the
// entity, the grounding YAML and the session, and staging must refuse a
// workflow built for a different playbook than the canvas holds.

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

const YAML_A = "playbooks:\n- name: Playbook A\n  steps:\n  - name: Start\n  - name: Post Triage Comment\n";
const YAML_B = "playbooks:\n- name: Playbook B\n  steps:\n  - name: Start\n";
const IRI_A = "/api/3/workflows/pb-a";
const IRI_B = "/api/3/workflows/pb-b";

const $state = { current: { name: "main.playbookDetail" }, params: { id: "pb-a" } };

let $controller, $rootScope, $httpBackend, $q, $timeout;
let agentService, turnCalls, historyCalls, decompileResults;

beforeEach(() => {
  window.localStorage.clear();
  $state.current = { name: "main.playbookDetail" };
  $state.params = { id: "pb-a" };
  turnCalls = [];
  historyCalls = [];
  decompileResults = {};
  ng.mock.module("cybersponse", ($provide) => {
    agentService = {
      chatHistory: (cfg, sid) => { historyCalls.push(sid); return $q.when({ turns: [] }); },
      chatTurn: (cfg, payload) => { turnCalls.push(payload); return $q.defer().promise; },
      chatPoll: () => $q.when({ frames: [] }),
      modeInfo: () => ({ mode: "mock" }),
      decompilePlaybook: (cfg, iri) => (iri in decompileResults
        ? decompileResults[iri]
        : $q.when({ ok: true, yaml: iri === IRI_A ? YAML_A : YAML_B })),
    };
    $provide.value("fsrPbAgentService", agentService);
    $provide.value("config", { seedFromEntity: false });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$httpBackend_, _$q_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_;
    $httpBackend = _$httpBackend_; $q = _$q_; $timeout = _$timeout_;
  });
  $httpBackend.whenGET(/\/api\/3\/workflows\//).respond(200, { steps: [] });
});

function bootOnA() {
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  try { $timeout.flush(0); } catch (e) { /* no pending timeout */ }
  $scope.$digest();
  return $scope;
}

function openB() {
  $state.params = { id: "pb-b" };
  $rootScope.$broadcast("$stateChangeSuccess");
  $rootScope.$digest();
}

function sendTurn($scope, text) {
  $scope.viewState = "idle";
  $scope.form.inputText = text || "I want to create a new playbook.";
  $scope.sendMessage();
  $scope.$digest();
  return turnCalls[turnCalls.length - 1];
}

describe("switching playbooks in the designer", () => {
  test("the entity and the grounding YAML follow the open playbook", () => {
    const $scope = bootOnA();
    expect($scope.entityContext.iri).toBe(IRI_A);
    expect($scope.playbookYaml).toBe(YAML_A);

    openB();

    expect($scope.entityContext.iri).toBe(IRI_B);
    expect($scope.playbookYaml).toBe(YAML_B);
    const payload = sendTurn($scope);
    expect(payload.entity.iri).toBe(IRI_B);
    expect(payload.entity.playbook_yaml).toBe(YAML_B);
  });

  test("A's staged draft does not ride B's turns, even through + New", () => {
    const $scope = bootOnA();
    // A turn on A staged a draft; the canvas (and the grounding copy) hold it.
    $scope.playbookYaml = YAML_A + "  - name: Staged Only On A\n";
    $scope.currentYaml = $scope.playbookYaml;

    openB();
    $scope.newConversation();
    $scope.$digest();

    const payload = sendTurn($scope);
    expect(payload.entity.iri).toBe(IRI_B);
    expect(payload.entity.playbook_yaml).toBe(YAML_B);
    expect(payload.entity.playbook_yaml).not.toContain("Staged Only On A");
    expect($scope.currentYaml).not.toContain("Playbook A");
  });

  test("when B cannot be read, A's YAML is not sent in its place", () => {
    decompileResults[IRI_B] = $q.when({ ok: false, error: { code: "decompile_failed" } });
    const $scope = bootOnA();
    openB();
    const payload = sendTurn($scope);
    expect(payload.entity.iri).toBe(IRI_B);
    expect(payload.entity.playbook_yaml).toBeUndefined();
  });

  test("a slow read of A that lands after the switch is dropped", () => {
    const slowA = $q.defer();
    decompileResults[IRI_A] = slowA.promise;
    const $scope = bootOnA();
    openB();
    expect($scope.playbookYaml).toBe(YAML_B);
    slowA.resolve({ ok: true, yaml: YAML_A });
    $scope.$digest();
    expect($scope.playbookYaml).toBe(YAML_B);
  });

  test("B gets its own thread, not A's session", () => {
    const $scope = bootOnA();
    const sessionKeyA = window.localStorage.getItem("fsrPbSession:" + IRI_A);
    const firstA = sendTurn($scope, "on A");
    expect(firstA.session_id || firstA.sessionId).toBeTruthy();
    const sidA = firstA.session_id || firstA.sessionId;

    openB();

    const onB = sendTurn($scope, "on B");
    const sidB = onB.session_id || onB.sessionId;
    expect(sidB).toBeTruthy();
    expect(sidB).not.toBe(sidA);
    expect(historyCalls).toContain(sidB);
    if (sessionKeyA) expect(window.localStorage.getItem("fsrPbSession:" + IRI_A)).toBe(sessionKeyA);
  });

  test("the same playbook re-resolving keeps its conversation", () => {
    const $scope = bootOnA();
    $scope.messages.push({ role: "assistant", text: "building steps" });
    $rootScope.$broadcast("$stateChangeSuccess");
    $rootScope.$digest();
    expect($scope.entityContext.iri).toBe(IRI_A);
    expect($scope.messages.some((m) => m.text === "building steps")).toBe(true);
    expect($scope.playbookYaml).toBe(YAML_A);
  });
});

describe("staging into the designer", () => {
  function mountDesigner(entity) {
    const detail = { entity, details: { $dirty: false }, emitted: [],
                     $emit(...args) { this.emitted.push(args); } };
    const el = document.createElement("div");
    el.setAttribute("data-cs-designer-detail", "playbook");
    document.body.appendChild(el);
    ng.element(el).data("$isolateScope", detail);
    return { detail, el };
  }

  test("a workflow built for another playbook is refused, the canvas untouched", () => {
    const $scope = bootOnA();
    openB();
    const { detail, el } = mountDesigner({ "@id": IRI_B, uuid: "pb-b", name: "Playbook B", steps: [] });
    agentService.updatePlaybook = () => $q.when({
      ok: true, staged: true,
      workflow: { uuid: "pb-a", name: "Playbook A", steps: [{ name: "Start" }, { name: "Post Triage Comment" }] },
    });
    $scope.viewState = "idle";
    $scope.currentYaml = YAML_A;
    $scope.pushPlaybook();
    $rootScope.$apply();
    el.remove();

    expect(detail.emitted).toHaveLength(0);
    expect(detail.details.$dirty).toBe(false);
    const note = $scope.messages.filter((m) => m.role === "system").map((m) => m.text).join("\n");
    expect(note).toContain("Playbook A");
    expect(note).toContain("nothing was changed");
    expect(note).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
  });

  test("a workflow for the open playbook still stages", () => {
    const $scope = bootOnA();
    const { detail, el } = mountDesigner({ "@id": IRI_A, uuid: "pb-a", name: "Playbook A", steps: [] });
    agentService.updatePlaybook = () => $q.when({
      ok: true, staged: true,
      workflow: { uuid: "pb-a", name: "Playbook A", steps: [{ name: "Start" }, { name: "New Step" }] },
    });
    $scope.viewState = "idle";
    $scope.currentYaml = YAML_A;
    $scope.pushPlaybook();
    $rootScope.$apply();
    el.remove();

    expect(detail.emitted).toHaveLength(1);
    expect(detail.emitted[0][1].steps.map((s) => s.name)).toEqual(["Start", "New Step"]);
    expect(detail.details.$dirty).toBe(true);
  });
});
