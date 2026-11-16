"use strict";

// ─── A1/A2 - interactive-card in-flight feedback + error recovery ────────────
//
// Before this, accept/reject/apply/submit stamped `_resolved` synchronously and
// fired the resume; on failure the card stayed resolved with its buttons gone,
// so the analyst could only see the global banner and could not retry in place.
//
// New behavior (locked in here):
//   A1 - the handler flags `_submitting` (→ disabled buttons + spinner) and only
//        flips `_resolved`/`_outcome` on SUCCESS.
//   A2 - on failure it clears `_submitting`, stamps a secret-scrubbed `_error`
//        on the card, and leaves it unresolved so the same buttons retry it.
//   A4 - cardBusy() disables a card while its own resume is in flight OR any turn
//        is streaming (viewState 'sending'); a card stays retryable on 'error'.

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

const OK_TURN = { ok: true, session_id: "s", turn: 2, turn_id: "t2", stop_reason: "end_turn", transcript: [] };

// resumeImpl(resolve, reject, deferred) lets a test control when/how the resume
// settles - resolve immediately, reject, or hand back a deferred to settle late.
function boot(resumeImpl) {
  let $q, $rootScope, $controller, $timeout;
  const resumeSpy = jest.fn();
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "happy_path" }), // mock → no parallel poll
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when(OK_TURN),
    chatResume: (...a) => { resumeSpy(...a); return resumeImpl($q); },
    respondManualInput: (...a) => { resumeSpy(...a); return resumeImpl($q); }
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

function seedActionCard($scope) {
  const card = R.normalizeActionCard(
    { type: "action_card", id: "card-1", tool: "block_ip", summary: "Block 1.1.1.1", args: { ip: "1.1.1.1" } },
    { now: () => 1 }
  );
  $scope.messages.push({ role: "assistant", text: "", events: [card], ts: 1 });
  return card;
}

describe("A1/A2 - action_card in-flight + error recovery", () => {
  test("A1: in-flight state - _submitting set, not resolved, buttons busy; resolves on success", () => {
    const deferred = {};
    const { $scope, $rootScope } = boot(($q) => { const d = $q.defer(); deferred.d = d; return d.promise; });
    const card = seedActionCard($scope);

    $scope.confirmActionCard(card);
    // In flight: submitting, cardBusy, NOT resolved.
    expect(card._submitting).toBe(true);
    expect(card._resolved).toBeFalsy();
    expect($scope.cardBusy(card)).toBe(true);

    // A second click while in flight is a no-op.
    const wasResolved = card._resolved;
    $scope.confirmActionCard(card);
    expect(card._resolved).toBe(wasResolved);

    // Settle successfully → resolved, outcome stamped, submitting cleared.
    deferred.d.resolve(OK_TURN);
    $rootScope.$digest();
    expect(card._submitting).toBe(false);
    expect(card._resolved).toBe(true);
    expect(card._outcome).toBe("approve");
    expect(card._resolutionText).toContain("Confirmed");
  });

  test("A2: failure keeps the card actionable with an inline error; retry then succeeds", () => {
    let mode = "reject";
    const { $scope, $rootScope, resumeSpy } = boot(($q) =>
      mode === "reject" ? $q.reject({ message: "boom" }) : $q.when(OK_TURN));
    const card = seedActionCard($scope);

    $scope.confirmActionCard(card);
    $rootScope.$digest();
    // Card is NOT resolved; error surfaced inline; buttons live again.
    expect(card._resolved).toBeFalsy();
    expect(card._submitting).toBe(false);
    expect(card._error).toBe("boom");
    expect($scope.cardBusy(card)).toBe(false); // 'error' viewState is not busy

    // Retry from the same card now succeeds.
    resumeSpy.mockClear();
    mode = "ok";
    $scope.confirmActionCard(card);
    expect(resumeSpy).toHaveBeenCalled();
    $rootScope.$digest();
    expect(card._resolved).toBe(true);
    expect(card._outcome).toBe("approve");
    expect(card._error).toBeNull();
  });

  test("A2: inline error is secret-scrubbed (no bearer token leaks onto the card)", () => {
    const { $scope, $rootScope } = boot(($q) =>
      $q.reject({ message: "500 Authorization: Bearer eyJabc.def.ghi failed" }));
    const card = seedActionCard($scope);
    $scope.confirmActionCard(card);
    $rootScope.$digest();
    expect(card._error).toContain("[REDACTED]");
    expect(card._error).not.toContain("eyJabc.def.ghi");
  });

  test("A4: a card is busy while another turn is streaming (viewState 'sending')", () => {
    const { $scope } = boot(($q) => $q.when(OK_TURN));
    const card = seedActionCard($scope);
    $scope.viewState = "sending";
    expect($scope.cardBusy(card)).toBe(true);
    // A click is refused while a turn is in flight.
    $scope.confirmActionCard(card);
    expect(card._submitting).toBeFalsy();
    expect(card._resolved).toBeFalsy();
  });

  test("manual_input: reject path also goes through in-flight → resolved on success", () => {
    const { $scope, $rootScope } = boot(($q) => $q.when(OK_TURN));
    const ev = { type: "manual_input", inputId: "in-1", workflowRunIri: "/w/1", fields: [], values: {} };
    $scope.messages.push({ role: "assistant", text: "", events: [ev], ts: 1 });
    $scope.rejectManualInput(ev);
    $rootScope.$digest();
    expect(ev._resolved).toBe(true);
    expect(ev._outcome).toBe("reject");
    expect(ev._resolutionText).toContain("rejected");
  });
});
