"use strict";

// ─── An approval must report the OUTCOME, not the click ─────────────────────
//
// A 200 from chat_resume means the RESUME was accepted, not that the approved
// tool ran. The card used to stamp `_resolved` and paint a green "Approved" on
// any resolved promise, so when the connector could not execute the action --
// e.g. the native-MCP tool was absent from that worker's REGISTRY and dispatch()
// returned {"error": "unknown tool: mcp_soc__block_indicator"} -- the analyst
// saw "Approved" while the tool chip sat forever on "awaiting result". Claiming
// a containment action succeeded when it never ran is the worst direction to be
// wrong in, so the footer now grades the real result.
//
// Companion fix (framework): tools.dispatch() materializes native-MCP tools on a
// registry miss; see fsr_playbooks/tests/test_materializer.py
// ::test_dispatch_materializes_on_miss_without_a_tool_list_build.

global.jasmine = global.jasmine || {}; // angular-mocks lifecycle gate
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef

require("../widget/widgetAssets/js/fsrPbRender.js");
require("../widget/view.controller.js");
require("../widget/widgetAssets/js/fsrPbCards.service.js");
require("../widget/widgetAssets/js/fsrPbTranscript.service.js");
require("../widget/widgetAssets/js/fsrPbVerdictVocab.js");
require("../widget/widgetAssets/js/fsrPbEntityCards.service.js");
require("../widget/widgetAssets/js/fsrPbHtml.service.js");
require("../widget/widgetAssets/js/fsrPbYaml.service.js");
require("../widget/widgetAssets/js/fsrPbExport.service.js");
require("../widget/widgetAssets/js/fsrPbMarkdown.service.js");

const widgetInfo = require("../widget/info.json");
const viewCtrlName = `${widgetInfo.name}${widgetInfo.version.replace(/\./g, "")}DevCtrl`;
const ng = window.angular; // eslint-disable-line no-undef
const R = window.FsrPbRender; // eslint-disable-line no-undef

const TOOL = "mcp_soc__block_indicator";

function approvalRequiredResponse() {
  return {
    ok: true, session_id: "s", turn: 2, turn_id: "t2",
    stop_reason: "approval_required", contract_version: "2.8.0",
    transcript: [
      { type: "approval_request", approval_id: "ap-1", tool_use_id: "tu-1",
        tool: TOOL, tier: 3, args_hash: "d00d",
        summary: "Block 198.51.100.3 at the perimeter.",
        preview: { tool: TOOL, args: { indicator: "198.51.100.3" } } }
    ]
  };
}

// Boot with a scripted sequence of chat_resume responses: the first raises the
// approval gate, the second is the resume outcome under test.
function boot(resumeResponses) {
  let $q, $rootScope, $controller, $timeout;
  const queue = resumeResponses.slice();
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when(queue[0]),
    chatResume: () => $q.when(queue.length > 1 ? queue.shift() : queue[0])
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
  return { $scope, $rootScope };
}

// Drive the controller into `awaiting_approval` through the proven
// _handleTurnResult path, then return the rendered approval card event.
function raiseApproval($scope, $rootScope) {
  const seed = R.normalizeActionCard(
    { type: "action_card", id: "card-1", tool: "x", summary: "seed", args: {} },
    { now: () => 1 });
  $scope.messages.push({ role: "assistant", text: "", events: [seed], ts: 1 });
  $scope.confirmActionCard(seed);
  $rootScope.$digest();

  const card = R.buildAssistantMessage(approvalRequiredResponse().transcript,
    { now: () => 1, collapseThreshold: 99, interleaveText: true })
    .events.find((e) => e.type === "approval_request");
  $scope.messages.push({ role: "assistant", text: "", events: [card], ts: 2 });
  return card;
}

function resumeOutcome(resumeResponse) {
  const { $scope, $rootScope } = boot([approvalRequiredResponse(), resumeResponse]);
  const card = raiseApproval($scope, $rootScope);
  expect($scope.isPendingApproval(card)).toBe(true);
  $scope.respondApprovalInline(card, "approve");
  $rootScope.$digest();
  return { card, $scope };
}

describe("approval footer grades the real outcome", () => {
  test("a tool_result that never ran is NOT reported as executed", () => {
    // The exact production shape: dispatch() could not resolve the tool.
    const { card } = resumeOutcome({
      ok: true, session_id: "s", turn_id: "t3", stop_reason: "end_turn",
      contract_version: "2.8.0",
      transcript: [
        { type: "tool_result", call_id: "tu-1", name: TOOL,
          result: { error: `unknown tool: ${TOOL}` } }
      ]
    });

    expect(card._resolved).toBe(true);
    expect(card._outcome).toBe("failed");
    expect(card._outcome).not.toBe("executed");
    expect(card._error).toMatch(/unknown tool/);
  });

  test("a successful tool_result reports executed", () => {
    const { card } = resumeOutcome({
      ok: true, session_id: "s", turn_id: "t3", stop_reason: "end_turn",
      contract_version: "2.8.0",
      transcript: [
        { type: "tool_result", call_id: "tu-1", name: TOOL,
          result: { ok: true, blocked: "198.51.100.3" } }
      ]
    });
    expect(card._outcome).toBe("executed");
    expect(card._error).toBeFalsy();
  });

  // ─── the LIVE frame shape ────────────────────────────────────────────────
  //
  // Every test above uses `result:`. The connector emits `content:` (the
  // ToolResultFrame the resume path appends), so on a real box the payload was
  // always undefined here and EVERY approved action fell through to
  // 'executed' -- refusals included. Live on 8.0: an approved run_playbook
  // returned {ok:false, code:"run_not_permitted"} and the card painted a green
  // "Approved" with no error shown anywhere. These pin the shipped shape.

  test("content:{ok:false} is a failure -- the run_not_permitted regression", () => {
    const { card } = resumeOutcome({
      ok: true, session_id: "s", turn_id: "t3", stop_reason: "end_turn",
      contract_version: "2.8.0",
      transcript: [
        { type: "tool_result", tool_use_id: "cardexec_0b4c907f", duration_ms: 0,
          content: { ok: false, code: "run_not_permitted",
                     message: "running a playbook requires an active assistant "
                              + "persona; none is bound for this session" } }
      ]
    });
    expect(card._outcome).toBe("failed");
    expect(card._outcome).not.toBe("executed");
    expect(card._error).toMatch(/run_not_permitted|persona/i);
  });

  test("content:{ok:true} reports executed", () => {
    const { card } = resumeOutcome({
      ok: true, session_id: "s", turn_id: "t3", stop_reason: "end_turn",
      contract_version: "2.8.0",
      transcript: [
        { type: "tool_result", tool_use_id: "cardexec_1", duration_ms: 12,
          content: { ok: true, triggered: true } }
      ]
    });
    expect(card._outcome).toBe("executed");
    expect(card._error).toBeFalsy();
  });

  test("content:{ok:false, code:awaiting_input} is PARKED, not failed", () => {
    // An approved run_playbook that reaches a manual_input step: the run
    // happened and waits on a human. The code list comes from the generated
    // vocabulary asset, so this test needs that asset loaded.
    const { card } = resumeOutcome({
      ok: true, session_id: "s", turn_id: "t3", stop_reason: "end_turn",
      contract_version: "2.8.0",
      transcript: [
        { type: "tool_result", tool_use_id: "cardexec_p", duration_ms: 3,
          content: { ok: false, code: "awaiting_input", triggered: true,
                     run_pk: "9247", message: "waiting on analyst input" } }
      ]
    });
    expect(card._outcome).toBe("parked");
    expect(card._outcome).not.toBe("failed");
  });

  test("a JSON-string content is parsed, not treated as success", () => {
    const { card } = resumeOutcome({
      ok: true, session_id: "s", turn_id: "t3", stop_reason: "end_turn",
      contract_version: "2.8.0",
      transcript: [
        { type: "tool_result", tool_use_id: "cardexec_2", duration_ms: 0,
          content: JSON.stringify({ ok: false, code: "run_not_permitted" }) }
      ]
    });
    expect(card._outcome).toBe("failed");
  });

  test("a payload-less tool_result stays neutral, never 'executed'", () => {
    // Proves nothing ran; claiming success here is what made the bug invisible.
    const { card } = resumeOutcome({
      ok: true, session_id: "s", turn_id: "t3", stop_reason: "end_turn",
      contract_version: "2.8.0",
      transcript: [{ type: "tool_result", tool_use_id: "cardexec_3" }]
    });
    expect(card._outcome).toBe("unknown");
    expect(card._outcome).not.toBe("executed");
  });

  test("an {ok:false} envelope is a failure, not a success", () => {
    const { card } = resumeOutcome({
      ok: true, session_id: "s", turn_id: "t3", stop_reason: "end_turn",
      contract_version: "2.8.0",
      transcript: [
        { type: "tool_result", call_id: "tu-1", name: TOOL,
          result: { ok: false, error: "FortiGate: Unauthorized" } }
      ]
    });
    expect(card._outcome).toBe("failed");
    expect(card._error).toMatch(/Unauthorized/);
  });

  test("a turn-level error envelope fails the card", () => {
    const { card } = resumeOutcome({
      ok: false, session_id: "s", turn_id: "t3", stop_reason: "error",
      contract_version: "2.8.0", error: "resume blew up", transcript: []
    });
    expect(card._outcome).toBe("failed");
  });

  test("approval_unverified fails closed -- the action was NOT executed", () => {
    const { card } = resumeOutcome({
      ok: true, session_id: "s", turn_id: "t3",
      stop_reason: "approval_unverified", contract_version: "2.8.0",
      transcript: [{ type: "error", message: "binding check failed" }]
    });
    expect(card._outcome).toBe("failed");
    expect(card._error).toMatch(/NOT executed/i);
  });

  test("no tool_result yet → neutral 'unknown', never a claimed success", () => {
    // Some providers stream the result on a later poll. Absence of evidence
    // must not become evidence of success.
    const { card } = resumeOutcome({
      ok: true, session_id: "s", turn_id: "t3", stop_reason: "end_turn",
      contract_version: "2.8.0",
      transcript: [{ type: "text", text: "Working on it." }]
    });
    expect(card._outcome).toBe("unknown");
    expect(card._outcome).not.toBe("executed");
    expect(card._error).toBeFalsy();
  });

  test("a user_denied result reads as denied, not failed", () => {
    const { card } = resumeOutcome({
      ok: true, session_id: "s", turn_id: "t3", stop_reason: "end_turn",
      contract_version: "2.8.0",
      transcript: [
        { type: "tool_result", call_id: "tu-1", name: TOOL,
          result: { ok: false, code: "user_denied", reason: "User denied." } }
      ]
    });
    expect(card._outcome).toBe("denied");
  });
});
