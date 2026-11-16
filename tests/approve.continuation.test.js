"use strict";

// ─── Contract 2.5.1 -- post-approval continuation ────────────────────────────
//
// Approving an action_card no longer terminates the turn. The connector
// executes the op and re-enters the agent loop once, so the chat_resume(approve)
// response is an ordinary turn envelope whose stop_reason may be end_turn OR
// another awaiting_* (e.g. a chained awaiting_action_card). The widget MUST
// route the approve response through normal stop_reason handling and NOT assume
// approve ends the conversation. This locks that in so a refactor can't regress.

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

// The 2.5.1 approve-continuation envelope: real run_op result first, then the
// model's narration, then a CHAINED action_card (still gating).
const CHAINED_APPROVE_RESPONSE = {
  ok: true, session_id: "s", turn: 2, turn_id: "t2",
  stop_reason: "awaiting_action_card", contract_version: "2.5.1",
  transcript: [
    { type: "tool_use", id: "r1", name: "block_ip", input: { ip: "1.1.1.1" } },
    { type: "tool_result", tool_use_id: "r1", tool: "block_ip", content: '{"ok":true,"status":"success"}' },
    { type: "text", text: "Blocked 1.1.1.1. Recommend isolating the host next." },
    { type: "action_card", id: "card-2", tool: "isolate_host", summary: "Isolate HR-WS-04", args: { host: "HR-WS-04" } }
  ]
};

function boot(resumeResponse) {
  let $q, $rootScope, $controller, $timeout;
  const resumeSpy = jest.fn();
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }), // mock → no parallel poll
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

describe("contract 2.5.1 \u2014 approve continuation routes like any turn", () => {
  test("a chained awaiting_action_card approve response renders the executed result + next card and stays interactive", () => {
    const { $scope, $rootScope, resumeSpy } = boot(CHAINED_APPROVE_RESPONSE);

    // Seed an open action_card (as a prior turn would have produced).
    const card = R.normalizeActionCard(
      { type: "action_card", id: "card-1", tool: "block_ip", summary: "Block 1.1.1.1", args: { ip: "1.1.1.1" } },
      { now: () => 1 }
    );
    $scope.messages.push({ role: "assistant", text: "", events: [card], ts: 1 });
    const before = $scope.messages.length;

    // Analyst approves.
    $scope.confirmActionCard(card);
    expect(resumeSpy).toHaveBeenCalledWith($scope.config,
      expect.objectContaining({ decision: "approve", card_id: "card-1" }));
    // A1: in-flight until the resume resolves -- outcome stamps on success only.
    expect(card._submitting).toBe(true);

    $rootScope.$digest(); // resolve the chat_resume promise → _handleTurnResult
    expect(card._outcome).toBe("approve");
    expect(card._submitting).toBe(false);

    // The approve did NOT terminate: a new assistant turn was appended.
    expect($scope.messages.length).toBe(before + 1);
    const turn = $scope.messages[$scope.messages.length - 1];

    // Executed result renders (paired run_op tool_call) ...
    const tool = (turn.events || []).find((e) => e.type === "tool_call" && e.name === "block_ip");
    expect(tool).toBeTruthy();
    expect(tool.resultDisplay).toContain("success");
    // ... the narration (timeline text event, interleaved after the tool) ...
    const narration = (turn.events || []).find((e) => e.type === "text");
    expect(narration.text).toContain("Recommend isolating the host next.");
    // ... and the CHAINED, still-interactive action_card.
    const chained = (turn.events || []).find((e) => e.type === "action_card");
    expect(chained).toBeTruthy();
    expect(chained.cardId).toBe("card-2");
    expect(chained._resolved).toBeFalsy();

    // The widget treats this as an ordinary continuing turn -- not an error,
    // not a terminal lock. Composer is usable for the next approval.
    expect($scope.viewState).toBe("idle");
    expect($scope.errorMessage).toBe("");
  });

  test("the 'Ready to automate' handoff is hidden while an action_card is still pending", () => {
    // A turn that stops on awaiting_action_card leaves viewState 'idle' with an
    // unresolved card showing. The handoff must NOT appear next to that card --
    // only once the conversation has truly come to rest.
    const { $scope, $rootScope } = boot({
      ok: true, session_id: "s", turn: 2, turn_id: "t2",
      stop_reason: "end_turn", contract_version: "2.5.1",
      transcript: [
        { type: "tool_use", id: "r1", name: "block_ip", input: { ip: "1.1.1.1" } },
        { type: "tool_result", tool_use_id: "r1", tool: "block_ip", content: '{"ok":true,"status":"success"}' },
        { type: "text", text: "Done \u2014 1.1.1.1 is blocked." }
      ]
    });
    $scope.uiIntent = "triage";
    $scope.connectorReady = true;
    // An analyst user turn → there's substantive triage worth automating.
    $scope.messages.push({ role: "user", text: "block 1.1.1.1", events: [], ts: 1 });

    const card = R.normalizeActionCard(
      { type: "action_card", id: "card-1", tool: "block_ip", summary: "Block 1.1.1.1", args: { ip: "1.1.1.1" } },
      { now: () => 1 }
    );
    $scope.messages.push({ role: "assistant", text: "", events: [card], ts: 1 });

    // Card still pending → no handoff even though state is idle.
    expect($scope.viewState).toBe("idle");
    expect($scope.hasPendingInteractiveCard()).toBe(true);
    expect($scope.canBuildFromTriage()).toBe(false);

    // Analyst acts on the card; the turn resolves to end_turn.
    $scope.confirmActionCard(card);
    $rootScope.$digest();

    // Now the conversation is at rest → the handoff is allowed.
    expect($scope.viewState).toBe("idle");
    expect($scope.hasPendingInteractiveCard()).toBe(false);
    expect($scope.canBuildFromTriage()).toBe(true);
  });

  test("the handoff does NOT appear after a user turn with NO investigation (export sess-yq8nhcix regression)", () => {
    // The live bug: "Investigate this alert" went out with no entity context,
    // the agent did nothing useful, yet the "Ready to automate this?" CTA showed
    // -- solely because a user message existed. A single user message is NOT a
    // completed triage; the agent must have actually run an investigation op.
    const { $scope } = boot(CHAINED_APPROVE_RESPONSE);
    $scope.uiIntent = "triage";
    $scope.connectorReady = true;

    // One user turn + an assistant reply that called NO tools.
    $scope.messages.push({ role: "user", text: "Investigate this alert", events: [], ts: 1 });
    $scope.messages.push({ role: "assistant", text: "I need more context.", events: [{ type: "text", text: "I need more context." }], ts: 1 });

    expect($scope.viewState).toBe("idle");
    expect($scope.toolsUsedInTriage().length).toBe(0);
    expect($scope.canBuildFromTriage()).toBe(false); // no investigation → no CTA

    // Once the agent actually runs an investigation op, the triage qualifies.
    $scope.messages.push({ role: "assistant", text: "", events: [
      { type: "tool_call", name: "get_reputation" }
    ], ts: 2 });
    expect($scope.toolsUsedInTriage().length).toBe(1);
    expect($scope.canBuildFromTriage()).toBe(true);
  });

  test("an end_turn approve response simply ends the turn (idle)", () => {
    const { $scope, $rootScope } = boot({
      ok: true, session_id: "s", turn: 2, turn_id: "t2",
      stop_reason: "end_turn", contract_version: "2.5.1",
      transcript: [
        { type: "tool_use", id: "r1", name: "block_ip", input: { ip: "1.1.1.1" } },
        { type: "tool_result", tool_use_id: "r1", tool: "block_ip", content: '{"ok":true,"status":"success"}' },
        { type: "text", text: "Done \u2014 1.1.1.1 is blocked." }
      ]
    });
    const card = R.normalizeActionCard(
      { type: "action_card", id: "card-1", tool: "block_ip", summary: "Block 1.1.1.1", args: { ip: "1.1.1.1" } },
      { now: () => 1 }
    );
    $scope.messages.push({ role: "assistant", text: "", events: [card], ts: 1 });
    $scope.confirmActionCard(card);
    $rootScope.$digest();
    expect($scope.viewState).toBe("idle");
    const turn = $scope.messages[$scope.messages.length - 1];
    const narration = (turn.events || []).find((e) => e.type === "text");
    expect(narration.text).toContain("Done, 1.1.1.1 is blocked.");
  });
});
