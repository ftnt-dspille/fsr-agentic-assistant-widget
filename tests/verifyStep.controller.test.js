"use strict";

// ─── Per-step Verify controller logic (Track C3 - interactive debug UI) ──────
//
// The YAML pane surfaces a per-step "Verify" control that drives
// fsrPbAgentService.stepTest and renders {status, rendered_args,
// output_top_keys, note}. A non-safe op returns needs_confirm and must gate on
// an explicit confirm dialog before re-probing with {confirm:true}. This covers
// the controller side: the YAML step parser, the happy render path, the
// busy/error flags, the needs_confirm gate + confirm re-probe, and stale-result
// clearing when the YAML changes. DOM wiring is covered by the e2e spec.

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

const YAML = [
  "playbooks:",
  "  - name: P",
  "    steps:",
  "      - name: Get Alert",
  "        type: connector",
  "        next: Notify",
  "      - id: notify_step",
  "        name: Notify",
  "        type: connector"
].join("\n");

function makeScope(stepTestImpl) {
  let $q, $timeout, $rootScope, $controller;
  const calls = [];
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "x", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    listSessions: () => $q.when({ sessions: [] }),
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when({ frames: [] }),
    stepTest: (cfg, yaml, stepId, opts) => {
      calls.push({ cfg, yaml, stepId, opts });
      return stepTestImpl($q, stepId, opts);
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
  $scope.currentYaml = YAML;
  $scope.$digest();
  return { $scope, calls, digest: () => $rootScope.$digest() };
}

describe("fsrAgenticAssistant - per-step Verify (C3)", () => {
  test("the Verify panel is OFF unless a config opts in", () => {
    // Parked, not deleted: an authoring aid that isn't on the compile/push path
    // and that the build prompt never calls, hidden while the core build flow is
    // validated (docs/plans/build-persona-validation-plan.md §P3). The template
    // gates on config.enableStepVerify; the controller logic below still works,
    // which is what makes flipping it back a one-line change.
    const { $scope } = makeScope(($q) => $q.when({}));
    expect($scope.config.enableStepVerify).toBe(false);
  });

  test("yamlSteps() parses steps with id/name/type and synthesizes ids", () => {
    const { $scope } = makeScope(($q) => $q.when({}));
    const steps = $scope.yamlSteps();
    expect(steps).toEqual([
      { id: "get_alert", name: "Get Alert", type: "connector" },
      { id: "notify_step", name: "Notify", type: "connector" } // id: wins over name:
    ]);
  });

  test("yamlSteps() is empty when there is no YAML", () => {
    const { $scope } = makeScope(($q) => $q.when({}));
    $scope.currentYaml = "";
    expect($scope.yamlSteps()).toEqual([]);
  });

  test("verifyStep() renders status/args/keys/note on a safe op", () => {
    const { $scope, calls, digest } = makeScope(($q, stepId) => $q.when({
      ok: true, step_id: stepId, status: "executed",
      rendered_args: { ip: "1.2.3.4" },
      output_top_keys: ["result", "status"],
      note: "ran clean"
    }));
    $scope.verifyStep("get_alert");
    expect($scope.verifyBusy["get_alert"]).toBe(true);
    digest();
    expect(calls[0].opts.confirm).toBe(false);
    expect($scope.verifyBusy["get_alert"]).toBe(false);
    const r = $scope.verifyResults["get_alert"];
    expect(r.status).toBe("executed");
    expect(r.renderedArgsDisplay).toContain("1.2.3.4");
    expect(r.output_top_keys).toEqual(["result", "status"]);
    expect(r.note).toBe("ran clean");
    expect($scope.verifyConfirm).toBe(null);
  });

  test("needs_confirm gates: no result rendered until the user confirms", () => {
    let phase = 0;
    const { $scope, calls, digest } = makeScope(($q, stepId, opts) => {
      phase += 1;
      // First probe (confirm:false) → needs_confirm; second (confirm:true) → executed.
      if (!opts.confirm) return $q.when({ status: "needs_confirm", needs_confirm: true, risk: "tier-3", note: "mutating op" });
      return $q.when({ status: "executed", rendered_args: { a: 1 }, output_top_keys: ["x"] });
    });
    $scope.verifyStep("notify_step");
    digest();
    // Gated: dialog is up, no result yet.
    expect($scope.verifyConfirm).toEqual({ stepId: "notify_step", note: "mutating op", risk: "tier-3" });
    expect($scope.verifyResults["notify_step"]).toBeUndefined();

    $scope.confirmVerifyStep();
    digest();
    expect($scope.verifyConfirm).toBe(null);
    expect(calls.length).toBe(2);
    expect(calls[1].opts.confirm).toBe(true);
    expect($scope.verifyResults["notify_step"].status).toBe("executed");
    expect(phase).toBe(2);
  });

  test("cancelVerifyStep() dismisses the gate without probing again", () => {
    const { $scope, calls, digest } = makeScope(($q) =>
      $q.when({ status: "needs_confirm", needs_confirm: true }));
    $scope.verifyStep("notify_step");
    digest();
    expect($scope.verifyConfirm).not.toBe(null);
    $scope.cancelVerifyStep();
    expect($scope.verifyConfirm).toBe(null);
    expect(calls.length).toBe(1); // no re-probe
  });

  test("a rejected probe records an error status and clears the busy flag", () => {
    const { $scope, digest } = makeScope(($q) => $q.reject({ message: "connector down" }));
    $scope.verifyStep("get_alert");
    digest();
    expect($scope.verifyBusy["get_alert"]).toBe(false);
    expect($scope.verifyResults["get_alert"].status).toBe("error");
    expect($scope.verifyResults["get_alert"].note).toBe("connector down");
  });

  test("changing the YAML clears stale verify results/gate", () => {
    const { $scope, digest } = makeScope(($q) => $q.when({ status: "executed", output_top_keys: [] }));
    $scope.verifyStep("get_alert");
    digest();
    expect($scope.verifyResults["get_alert"]).toBeDefined();
    $scope.currentYaml = YAML + "\n      - name: Extra\n        type: end";
    $scope.$digest();
    expect($scope.verifyResults).toEqual({});
    expect($scope.verifyConfirm).toBe(null);
  });

  test("a concurrent Verify on the same step is ignored while busy", () => {
    const { $scope, calls } = makeScope(($q) => $q.defer().promise); // never resolves
    $scope.verifyStep("get_alert");
    $scope.verifyStep("get_alert"); // busy → no-op
    expect(calls.length).toBe(1);
  });
});
