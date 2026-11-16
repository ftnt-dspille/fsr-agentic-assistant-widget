"use strict";

// ─── A parked approval must survive a refresh ───────────────────────────────
//
// A tier-3 gate parks a SuspendedSession on the CONNECTOR (storage, TTL 10m),
// so after a browser refresh the action is still genuinely waiting on a human.
// The UI did not survive it: `isPendingApproval` gates on the
// `$scope.approvalRequest` singleton, which was only ever set from a LIVE turn
// result. On reload the card replayed from chat_history with no Approve/Reject
// buttons at all -- the analyst could see an action waiting on them and had no
// way to act on it, and the session dead-ended until the gate expired.
//
// `_rehydrateApprovalState()` reconstructs the singleton from the replayed
// transcript, and deliberately does NOT re-arm a gate that already resolved.

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

function resolved(val) {
  return {
    then: function (cb) { return resolved(cb ? cb(val) : val); },
    catch: function () { return resolved(val); },
  };
}

const $state = { current: { name: "main.modules.list" }, params: { module: "alerts" } };
const TOOL = "mcp_soc__block_indicator";

const APPROVAL_EVENT = {
  type: "approval_request", approval_id: "ap-parked-1", tool_use_id: "tu-1",
  tool: TOOL, tier: 3, args_hash: "d00d",
  summary: "Block 198.51.100.3 at the perimeter.",
  preview: { tool: TOOL, args: { indicator: "198.51.100.3" } }
};

let $controller, $rootScope, $timeout, TURNS;

beforeEach(() => {
  TURNS = [];
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      resolveConnector: () => resolved({ name: "fsr-playbook-builder", version: "1", configId: "c1" }),
      chatHistory: () => resolved({ turns: TURNS }),
      execute: () => resolved({}),
      resume: () => resolved({}),
      modeInfo: () => ({ mode: "live", mock_scenario: null }),
    });
    $provide.value("config", { seedFromEntity: false });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $timeout = _$timeout_;
  });
});

function bootWith(turns) {
  TURNS = turns;
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();   // probe + init rehydrate
  return $scope;
}

function approvalCard($scope) {
  for (const m of $scope.messages || []) {
    const hit = (m.events || []).find((e) => e.type === "approval_request");
    if (hit) return hit;
  }
  return null;
}

describe("parked approval survives a refresh", () => {
  test("an unresolved approval is re-armed and its buttons are live again", () => {
    const $scope = bootWith([
      { user: "block that C2 address" },
      { transcript: [{ type: "text", text: "This needs your approval." }, APPROVAL_EVENT] },
    ]);

    expect($scope.approvalRequest).toBeTruthy();
    expect($scope.approvalRequest.approvalId).toBe("ap-parked-1");
    expect($scope.approvalRequest.tool).toBe(TOOL);
    expect($scope.viewState).toBe("awaiting_approval");

    // The replayed card is actionable -- the whole point of the fix.
    const card = approvalCard($scope);
    expect(card).toBeTruthy();
    expect($scope.isPendingApproval(card)).toBe(true);
  });

  test("an approval already followed by a tool_result is NOT re-armed", () => {
    // The gate was resolved in a prior session; re-arming would offer to
    // approve an action that already ran.
    const $scope = bootWith([
      { user: "block that C2 address" },
      { transcript: [
        APPROVAL_EVENT,
        { type: "tool_result", tool_use_id: "tu-1", tool: TOOL,
          content: "{\"ok\":true}" },
        { type: "text", text: "Blocked." },
      ] },
    ]);

    expect($scope.approvalRequest).toBeFalsy();
    expect($scope.viewState).not.toBe("awaiting_approval");
  });

  test("a history with no approval at all leaves the state clean", () => {
    const $scope = bootWith([
      { user: "what is this alert?" },
      { transcript: [{ type: "text", text: "A phishing alert." }] },
    ]);
    expect($scope.approvalRequest).toBeFalsy();
    expect($scope.viewState).not.toBe("awaiting_approval");
  });

  test("only the NEWEST approval is re-armed, not an older resolved one", () => {
    const older = Object.assign({}, APPROVAL_EVENT, { approval_id: "ap-old", tool_use_id: "tu-0" });
    const $scope = bootWith([
      { user: "first" },
      { transcript: [older, { type: "tool_result", tool_use_id: "tu-0", tool: TOOL, content: "{}" }] },
      { user: "second" },
      { transcript: [APPROVAL_EVENT] },
    ]);
    expect($scope.approvalRequest).toBeTruthy();
    expect($scope.approvalRequest.approvalId).toBe("ap-parked-1");
  });
});
