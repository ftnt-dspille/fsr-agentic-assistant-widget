"use strict";

// ─── Diagnose & fix controller logic (Track C3 - value-level render patches) ─
//
// analyze_playbook returns render-path `diagnostics[]`; each is resolved via
// suggest_fix_for_diagnostic into a structured {ok, step_id, location, before,
// after, confidence, explanation, kind} patch. diagnoseAndFix() collects the
// ok:true proposals into $scope.valuePatches, marking each `applicable` only
// when its `before` literal is unique in the YAML (a safe one-click swap).
// applyValuePatch() swaps that single occurrence; sendPatchToChat() seeds the
// composer for ambiguous fixes; dismissValuePatches() drops the batch. This
// covers: proposal collection + applicability gating, ok:false diagnostics
// dropped, the "clean" ack when nothing is fixable, a safe apply (keeping the
// panel through the currentYaml $watch), the ambiguous send-to-chat path, and
// dismiss.

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

// `Actve` (the picklist-drift value) is unique → an applicable swap.
const YAML =
  "playbooks:\n  - name: P\n    steps:\n      - name: Enrich\n" +
  "        type: connector\n        arguments:\n          status: Actve\n";

function makeScope(analyzeImpl, suggestImpl) {
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "x", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    listSessions: () => $q.when({ sessions: [] }),
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when({ frames: [] }),
    analyzePlaybook: (cfg, yaml) => analyzeImpl($q, yaml),
    suggestFix: (cfg, diag) => suggestImpl($q, diag)
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
  return { $scope, $timeout, digest: () => $rootScope.$digest() };
}

describe("fsrAgenticAssistant - diagnose & fix (C3 value patches)", () => {
  test("diagnoseAndFix() collects ok proposals and gates applicability by uniqueness", () => {
    const { $scope, digest } = makeScope(
      ($q) => $q.when({ ok: false, diagnostics: [{ kind: "picklist_drift" }, { kind: "unreachable_var_path" }] }),
      ($q, d) => $q.when(d.kind === "picklist_drift"
        ? { ok: true, kind: "picklist_drift", step_id: "Enrich", location: "arguments.status",
            before: "Actve", after: "Active", confidence: "high", explanation: "swap picklist value" }
        // No auto-fix recipe → dropped.
        : { ok: false, kind: "unreachable_var_path", reason: "can't auto-fix" })
    );
    $scope.diagnoseAndFix();
    digest();
    expect($scope.valuePatches).toHaveLength(1);
    const p = $scope.valuePatches[0];
    expect(p.after).toBe("Active");
    expect(p.applicable).toBe(true); // `Actve` is unique in the YAML
    expect($scope.viewState).toBe("idle");
  });

  test("a fix whose `before` is not unique is shown read-only (not applicable)", () => {
    const { $scope, digest } = makeScope(
      ($q) => $q.when({ ok: true, diagnostics: [{ kind: "missing_key" }] }),
      // `name` appears twice in the YAML (playbook + step) → ambiguous.
      ($q) => $q.when({ ok: true, kind: "missing_key", step_id: "Enrich",
        location: "arguments.x", before: "name", after: "title", confidence: "high" })
    );
    $scope.diagnoseAndFix();
    digest();
    expect($scope.valuePatches).toHaveLength(1);
    expect($scope.valuePatches[0].applicable).toBe(false);
  });

  test("applyValuePatch() swaps the unique literal and keeps the panel + marks applied", () => {
    const { $scope, digest } = makeScope(
      ($q) => $q.when({ ok: true, diagnostics: [{ kind: "picklist_drift" }] }),
      ($q) => $q.when({ ok: true, kind: "picklist_drift", step_id: "Enrich",
        location: "arguments.status", before: "Actve", after: "Active", confidence: "high" })
    );
    $scope.diagnoseAndFix();
    digest();
    $scope.applyValuePatch(0);
    $scope.$digest(); // fire the currentYaml watch
    expect($scope.currentYaml).toContain("status: Active");
    expect($scope.currentYaml).not.toContain("Actve");
    expect($scope.valuePatches).not.toBeNull();      // panel survives the self-apply
    expect($scope.valuePatches[0].applied).toBe(true);
  });

  test("diagnoseAndFix() flags clean when no diagnostics come back", () => {
    const { $scope, $timeout, digest } = makeScope(
      ($q) => $q.when({ ok: true, diagnostics: [] }),
      ($q) => $q.when({ ok: false })
    );
    $scope.diagnoseAndFix();
    digest();
    expect($scope.valuePatches).toBeNull();
    expect($scope.valuePatchClean).toBe(true);
    $timeout.flush();
    expect($scope.valuePatchClean).toBe(false);
  });

  test("diagnoseAndFix() does NOT flash clean when the analysis itself failed", () => {
    // A genuine failure (could not analyze) returns ok:false + error and no
    // diagnostics. The button must not say "No issues found" -- nothing was
    // checked; the error must surface instead.
    const { $scope, digest } = makeScope(
      ($q) => $q.when({ ok: false, error: "could not parse YAML", diagnostics: [] }),
      ($q) => $q.when({ ok: false })
    );
    $scope.diagnoseAndFix();
    digest();
    expect($scope.valuePatchClean).toBe(false);
    expect($scope.errorMessage).toBeTruthy();
  });

  test("diagnoseAndFix() flags clean when every diagnostic has no auto-fix recipe", () => {
    const { $scope, digest } = makeScope(
      ($q) => $q.when({ ok: true, diagnostics: [{ kind: "x" }] }),
      ($q) => $q.when({ ok: false, reason: "no recipe" })
    );
    $scope.diagnoseAndFix();
    digest();
    expect($scope.valuePatches).toBeNull();
    expect($scope.valuePatchClean).toBe(true);
  });

  test("sendPatchToChat() seeds the composer without touching the YAML", () => {
    const { $scope, digest } = makeScope(
      ($q) => $q.when({ ok: true, diagnostics: [{ kind: "missing_key" }] }),
      ($q) => $q.when({ ok: true, kind: "missing_key", step_id: "Enrich",
        location: "arguments.x", before: "name", after: "title" })
    );
    $scope.diagnoseAndFix();
    digest();
    $scope.sendPatchToChat(0);
    expect($scope.form.inputText).toMatch(/change `name` to `title`/);
    expect($scope.currentYaml).toBe(YAML); // unchanged
  });

  test("dismissValuePatches() drops the batch without touching the YAML", () => {
    const { $scope, digest } = makeScope(
      ($q) => $q.when({ ok: true, diagnostics: [{ kind: "picklist_drift" }] }),
      ($q) => $q.when({ ok: true, kind: "picklist_drift", step_id: "Enrich",
        location: "arguments.status", before: "Actve", after: "Active" })
    );
    $scope.diagnoseAndFix();
    digest();
    $scope.dismissValuePatches();
    expect($scope.valuePatches).toBeNull();
    expect($scope.currentYaml).toBe(YAML);
  });

  test("an external YAML edit drops a pending value-patch batch", () => {
    const { $scope, digest } = makeScope(
      ($q) => $q.when({ ok: true, diagnostics: [{ kind: "picklist_drift" }] }),
      ($q) => $q.when({ ok: true, kind: "picklist_drift", step_id: "Enrich",
        location: "arguments.status", before: "Actve", after: "Active" })
    );
    $scope.diagnoseAndFix();
    digest();
    expect($scope.valuePatches).toHaveLength(1);
    $scope.currentYaml = YAML + "\n# hand edit\n";
    $scope.$digest();
    expect($scope.valuePatches).toBeNull();
  });
});
