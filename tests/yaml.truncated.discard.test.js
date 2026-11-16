"use strict";

// ─── Truncated-turn fence guard ─────────────────────────────────────────────
//
// T1 §6g.2 F3. Two build turns against a real model ended MID-WORD with
// stop_reason `max_turns` -- which is the OpenAI provider's mapping of the wire
// `finish_reason: "length"`, i.e. the 4096 output-token cap, not a tool-loop
// cap. The reply still contains an opening ```yaml fence and however much of
// the playbook fit inside the budget.
//
// Save compiles the LAST fence back OVER the open record, so adopting a
// truncated fence deletes every step the model never got to write -- the same
// destructive class as the fragment fence, arriving through the token cap.
// The guard: a turn that did not FINISH never updates `currentYaml`.

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

// A fence that opens and is cut off mid-step -- exactly what the cap produces.
const TRUNCATED = [
  "Adding the Skip branch so it's evaluated before the fallback. Let",
  "```yaml",
  "playbooks:",
  "  - name: Indicator Reputation",
  "    steps:",
  "      - name: Start",
  "        type: start"
].join("\n");

const WHOLE = [
  "Here is the complete playbook.",
  "```yaml",
  "playbooks:",
  "  - name: Indicator Reputation",
  "    steps:",
  "      - name: Start",
  "        type: start",
  "```"
].join("\n");

// The widget latches DETACHED mode on send: the blocking chat_turn return is
// an ack, and the authoritative transcript arrives on the poll terminal. Both
// land in the same `_handleTurnResult`, so driving the poll path is enough.
function makeHarness(terminal) {
  let turnDeferred;
  let pollCall = 0;
  const script = [
    { contract_version: "2.8.0", turn: 1, cursor: 2, done: false, frames: [
      { type: "turn_start", turn: 1 }, { type: "text", text: "working…" }
    ] },
    { contract_version: "2.8.0", turn: 1, cursor: 4, done: true,
      stop_reason: terminal.stop_reason,
      frames: [Object.assign({ type: "stream_end", ok: true, turn_id: "t1" }, terminal)] }
  ];
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => { turnDeferred = $q.defer(); return turnDeferred.promise; },
    chatPoll: () => $q.when(script[Math.min(pollCall++, script.length - 1)])
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
  return {
    $scope,
    send: () => {
      $scope.form.inputText = "add a Skip branch";
      $scope.sendMessage();
      turnDeferred.resolve({ accepted: true, turn: 1, stop_reason: "accepted" });
      $rootScope.$digest();
      $timeout.flush(1);      // poll #1 -- preview
      $timeout.flush(700);    // poll #2 -- terminal commits through _handleTurnResult
    }
  };
}

function turn(stopReason, text) {
  return { stop_reason: stopReason, transcript: [{ type: "text", text: text }] };
}

describe("fsrAgenticAssistant -- truncated turns never load a playbook", () => {
  test.each(["max_turns", "max_tokens", "length", "max_tool_turns"])(
    "stop_reason %s: the half-written fence is discarded, not adopted",
    (stop) => {
      const h = makeHarness(turn(stop, TRUNCATED));
      h.$scope.currentYaml = "";
      h.send();
      expect(h.$scope.currentYaml).toBeFalsy();
      // Not even offered behind the notice: a fragment is not a playbook.
      expect(h.$scope.withheldYaml).toBeFalsy();
      // NOT an error state -- `max_turns` doubles as the benign "tool-loop
      // budget spent, send another message" stop, so the composer stays live.
      expect(h.$scope.viewState).toBe("idle");
    });

  test("a truncated turn leaves the analyst's PREVIOUS draft intact", () => {
    const h = makeHarness(turn("max_turns", TRUNCATED));
    h.$scope.currentYaml = "playbooks:\n  - name: Prior draft\n";
    h.send();
    expect(h.$scope.currentYaml).toContain("Prior draft");
  });

  test("a truncated turn does not adopt last_assistant_yaml either", () => {
    const t = turn("max_turns", "cut off mid-word. Let");
    t.last_assistant_yaml = "playbooks:\n  - name: Half\n";
    const h = makeHarness(t);
    h.send();
    expect(h.$scope.currentYaml).toBeFalsy();
    expect(h.$scope.withheldYaml).toBeFalsy();
  });

  // The analyst must be TOLD why the reply stopped -- a silent stop reads as
  // "the assistant gave up". Driven through the real controller, so this fails
  // if the notice is removed, not just if a copy of its logic changes.
  function lastActivity(h) {
    const msgs = h.$scope.messages;
    const evs = (msgs[msgs.length - 1] || {}).events || [];
    return evs.filter((e) => e.type === "activity").pop();
  }

  test("max_tool_turns: says the tool budget ran out and how to continue", () => {
    const h = makeHarness(turn("max_tool_turns", TRUNCATED));
    h.send();
    const act = lastActivity(h);
    expect(act).toBeTruthy();
    expect(act.lines[0].message).toMatch(/tool budget/i);
    expect(act.lines[0].message).toMatch(/continue/i);
  });

  test.each(["max_tokens", "max_turns", "length"])(
    "stop_reason %s: says the reply was cut off", (stop) => {
      const h = makeHarness(turn(stop, TRUNCATED));
      h.send();
      const act = lastActivity(h);
      expect(act).toBeTruthy();
      expect(act.lines[0].message).toMatch(/cut off/i);
    });

  test("a completed turn carries no truncation notice", () => {
    const h = makeHarness(turn("end_turn", WHOLE));
    h.send();
    const act = lastActivity(h);
    const said = act ? act.lines.map((l) => l.message).join(" ") : "";
    expect(said).not.toMatch(/tool budget|cut off/i);
  });

  test("a COMPLETED turn still loads its verified offer (the guard is not overbroad)", () => {
    const t = turn("end_turn", "Here is the complete playbook.");
    t.transcript.push({ type: "playbook_offer", id: "o1", summary: "Save?",
                        final_yaml: "playbooks:\n  - name: Indicator Reputation\n" });
    const h = makeHarness(t);
    h.send();
    expect(h.$scope.currentYaml).toContain("Indicator Reputation");
    expect(h.$scope.viewState).toBe("idle");
  });

  test("a COMPLETED turn's reply-text playbook is offered behind the notice", () => {
    const h = makeHarness(turn("end_turn", WHOLE));
    h.send();
    expect(h.$scope.currentYaml).toBeFalsy();
    expect(h.$scope.withheldYaml).toContain("Indicator Reputation");
  });
});
