"use strict";

// ─── approval_required gate: the in-chat approval card and approval_id resume ─
//
// A tier-3 op (e.g. push_playbook) that goes through the SuspendedSession gate
// ends the turn with stop_reason `approval_required` and an `approval_request`
// transcript event. The approval is answered inline on its card (there is no
// modal). Two regressions are locked in here:
//
//  1. The event carries `summary` + a MASKED `preview` ({tool, args}) - it has
//     NO top-level `args` field. The card must show the human-readable summary,
//     never an empty `{}` (asserted on the rendered card below).
//  2. The connector pops the SuspendedSession by `approval_id`. Resuming with
//     only `turn_id` left the op unexecuted and the turn dead-ended ("stuck after
//     Approve"). Approve MUST send approval_id.

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

// A tier-3 approval gate: the model called push_playbook (no args echoed), the
// connector suspended and emitted the legacy approval_request event.
const APPROVAL_REQUIRED_RESPONSE = {
  ok: true, session_id: "s", turn: 2, turn_id: "t2",
  stop_reason: "approval_required", contract_version: "2.8.0",
  transcript: [
    { type: "text", text: "Ready to push the playbook." },
    {
      type: "approval_request",
      approval_id: "appr-xyz-123",
      tool_use_id: "tu-1",
      tool: "push_playbook",
      tier: 3,
      preview: { tool: "push_playbook", args: {} },
      args_hash: "deadbeef",
      summary: "Create the 'Phishing triage' playbook in FortiSOAR.",
      requires_step_up: false
    }
  ]
};

function boot(resumeResponse) {
  let $q, $rootScope, $controller, $timeout;
  const resumeSpy = jest.fn();
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when(resumeResponse),
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

describe("approval_required gate and its inline card", () => {
  // Drive a turn result with stop_reason approval_required into the controller
  // by routing it through the normal chat_resume → _handleTurnResult path. We
  // approve a seeded action_card (the proven _handleTurnResult entry); the stub
  // resolves that resume with the approval_required envelope.
  function raiseApproval($scope, $rootScope) {
    const card = R.normalizeActionCard(
      { type: "action_card", id: "card-1", tool: "x", summary: "seed", args: {} },
      { now: () => 1 }
    );
    $scope.messages.push({ role: "assistant", text: "", events: [card], ts: 1 });
    $scope.confirmActionCard(card);
    $rootScope.$digest();
  }

  test("the gate is armed with the tool and approval id, and the view waits on it", () => {
    const { $scope, $rootScope } = boot(APPROVAL_REQUIRED_RESPONSE);
    raiseApproval($scope, $rootScope);

    expect($scope.approvalRequest).toBeTruthy();
    expect($scope.approvalRequest.tool).toBe("push_playbook");
    expect($scope.approvalRequest.approvalId).toBe("appr-xyz-123");
    expect($scope.viewState).toBe("awaiting_approval");
  });

  test("the inline rendered approval_request card shows the summary, not {}", () => {
    // FsrPbRender normalizes the transcript event the same trap lives in: it
    // used to JSON.stringify ev.args (absent) → '{}'. (Regression: export
    // sess-ne8b2gs1 rendered name=push_playbook, display='{}'.)
    const msg = R.buildAssistantMessage(
      APPROVAL_REQUIRED_RESPONSE.transcript, { now: () => 1, collapseThreshold: 99, interleaveText: true });
    const card = (msg.events || []).find((e) => e.type === "approval_request");
    expect(card).toBeTruthy();
    expect(card.name).toBe("push_playbook");
    expect(card.approvalId).toBe("appr-xyz-123");
    expect(card.display).toBe("Create the 'Phishing triage' playbook in FortiSOAR.");
    expect(card.display).not.toBe("{}");
  });

  test("Approve resumes with approval_id so the connector executes the op", () => {
    const { $scope, $rootScope, resumeSpy } = boot(APPROVAL_REQUIRED_RESPONSE);
    raiseApproval($scope, $rootScope);
    resumeSpy.mockClear();

    $scope.form.approvalNote = "looks good";
    $scope.respondApprovalInline({ type: "approval_request", name: "push_playbook",
      approvalId: "appr-xyz-123" }, "approve");

    expect(resumeSpy).toHaveBeenCalledWith($scope.config,
      expect.objectContaining({ decision: "approve", approval_id: "appr-xyz-123", note: "looks good" }));
    // Cleared once the resume lands (don't leave it stuck on screen).
    $rootScope.$digest();
    expect($scope.approvalRequest).toBeNull();
  });

  test("inline card: only THE pending approval is actionable; Approve resolves it once", () => {
    const { $scope, $rootScope, resumeSpy } = boot(APPROVAL_REQUIRED_RESPONSE);
    raiseApproval($scope, $rootScope);
    resumeSpy.mockClear();

    const ev = { type: "approval_request", name: "push_playbook", approvalId: "appr-xyz-123" };
    const stale = { type: "approval_request", name: "push_playbook", approvalId: "other-999" };
    // Live only for the matching, unresolved approval.
    expect($scope.isPendingApproval(ev)).toBe(true);
    expect($scope.isPendingApproval(stale)).toBe(false);

    $scope.respondApprovalInline(ev, "approve");
    // A1: resume fires immediately; the card is in-flight (buttons disabled via
    // cardBusy) but NOT yet resolved - _resolved flips only on success.
    expect(resumeSpy).toHaveBeenCalledWith($scope.config,
      expect.objectContaining({ decision: "approve", approval_id: "appr-xyz-123" }));
    expect(ev._submitting).toBe(true);
    expect(ev._decision).toBe("approve");
    // A second click while in flight is a no-op (cardBusy guard).
    resumeSpy.mockClear();
    $scope.respondApprovalInline(ev, "approve");
    expect(resumeSpy).not.toHaveBeenCalled();
    // On success (digest flushes the resolved resume promise) the card resolves.
    $rootScope.$digest();
    expect(ev._submitting).toBe(false);
    expect(ev._resolved).toBe(true);
    // Card is no longer actionable after resolving, and a further click is a no-op.
    expect($scope.isPendingApproval(ev)).toBe(false);
    resumeSpy.mockClear();
    $scope.respondApprovalInline(ev, "approve");
    expect(resumeSpy).not.toHaveBeenCalled();
  });
});
