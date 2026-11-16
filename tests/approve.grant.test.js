"use strict";

// ─── Grant parameter for action_card approval ──────────────────────────────
//
// Per-session grant recording (contract 2.5.2+): when approving an action_card,
// the widget can optionally include grant: "always" to record a per-session
// grant so future matching calls to the same tool/connector-op auto-run
// without prompting again. Omitting grant behaves exactly as before (one-shot
// approval only). The UI provides a checkbox "Always allow this action" that,
// when checked, sends grant: "always" in the resume payload.

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

function boot(resumeResponse) {
  let $q, $rootScope, $controller, $timeout;
  const resumeSpy = jest.fn();
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when({ ok: true, stop_reason: "end_turn", transcript: [] }),
    chatResume: (...a) => { resumeSpy(...a); return $q.when(resumeResponse); }
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
  $timeout.flush(); // construction probes
  return { $scope, $rootScope, resumeSpy };
}

describe("action_card approval with grant parameter", () => {
  const resumeResponse = {
    ok: true, session_id: "s", turn: 2, turn_id: "t2",
    stop_reason: "end_turn", contract_version: "2.5.2",
    transcript: [
      { type: "text", text: "Done." }
    ]
  };

  test("approving without grant checkbox sends no grant parameter (one-shot approval)", () => {
    const { $scope, $rootScope, resumeSpy } = boot(resumeResponse);

    const card = R.normalizeActionCard(
      { type: "action_card", id: "card-1", tool: "block_ip", summary: "Block 1.1.1.1", args: { ip: "1.1.1.1" } },
      { now: () => 1 }
    );
    $scope.messages.push({ role: "assistant", text: "", events: [card], ts: 1 });

    // Confirm without checking "Always allow"
    card._grantAlways = false;
    $scope.confirmActionCard(card);

    expect(resumeSpy).toHaveBeenCalledWith($scope.config,
      expect.objectContaining({ decision: "approve", card_id: "card-1", args: { ip: "1.1.1.1" } }));
    // Verify grant is NOT in the payload when checkbox is unchecked
    const payload = resumeSpy.mock.calls[0][1];
    expect(payload.grant).toBeUndefined();
  });

  test("approving with grant checkbox sends grant: 'always' (per-session grant)", () => {
    const { $scope, $rootScope, resumeSpy } = boot(resumeResponse);

    const card = R.normalizeActionCard(
      { type: "action_card", id: "card-1", tool: "block_ip", summary: "Block 1.1.1.1", args: { ip: "1.1.1.1" } },
      { now: () => 1 }
    );
    $scope.messages.push({ role: "assistant", text: "", events: [card], ts: 1 });

    // Confirm with "Always allow" checkbox checked
    card._grantAlways = true;
    $scope.confirmActionCard(card);

    expect(resumeSpy).toHaveBeenCalledWith($scope.config,
      expect.objectContaining({ decision: "approve", card_id: "card-1", args: { ip: "1.1.1.1" }, grant: "always" }));
    // Verify grant is in the payload when checkbox is checked
    const payload = resumeSpy.mock.calls[0][1];
    expect(payload.grant).toBe("always");
  });

  test("cancel always sends no grant parameter", () => {
    const { $scope, $rootScope, resumeSpy } = boot(resumeResponse);

    const card = R.normalizeActionCard(
      { type: "action_card", id: "card-1", tool: "block_ip", summary: "Block 1.1.1.1", args: { ip: "1.1.1.1" } },
      { now: () => 1 }
    );
    $scope.messages.push({ role: "assistant", text: "", events: [card], ts: 1 });

    // Cancel the action
    $scope.cancelActionCard(card);
    $rootScope.$digest();

    // Cancel should not include grant parameter (it's for approve only)
    expect(resumeSpy).toHaveBeenCalledWith($scope.config,
      expect.objectContaining({ decision: "reject", card_id: "card-1" }));
    const payload = resumeSpy.mock.calls[0][1];
    expect(payload.grant).toBeUndefined();
  });
});
