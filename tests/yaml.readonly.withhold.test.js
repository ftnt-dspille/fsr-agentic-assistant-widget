"use strict";

// ─── Read-only ask never adopts a fence ─────────────────────────────────────
//
// T1 §6g.2 F2. Two read-only scenarios ("Just explain it, change nothing" /
// "…Don't change anything") came back with a FULL playbook. A ```yaml fence is
// a WRITE -- Save compiles the last fence back over the open record -- so a
// fence on a turn the analyst scoped read-only is an unrequested write on a
// question.
//
// The connector's build prompt now carries the rule and moved both scenarios a
// long way, but `explain_loop_semantics` still authors ~half the time on BOTH
// models tested. A prompt is a disposition lever and disposition is exactly
// what a prompt cannot guarantee, so the write is refused where it lands.
//
// THE SIGNAL IS THE CHIP, NOT THE SENTENCE (widget d94b121). This file used to
// drive eight English phrasings, and it went red the day that changed --
// blocking the widget ship gate ever since, which is worse than the bug it
// guards. The regexes were dropped for a good reason: they matched none of the
// prompt the Explain chip actually sends ("Explain what this playbook does,
// step by step, in plain language") -- no "don't change", no "just explain".
// The one reliable read-only signal in the product is `quick_action`, and only
// a chip sends it. So the cases below fire chips, and the free-typed phrasings
// are kept as the SILENCING half: they must NOT withhold, because English was
// never the signal.
//
// The withheld playbook is offered back behind one click: a chip scopes the
// turn, but the analyst may still want the draft it produced, and refusing
// silently would lose real work.

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

const AUTHORED = [
  "The Update SLA Status step runs once per item. Here is the playbook:",
  "```yaml",
  "playbooks:",
  "  - name: Indicator Reputation",
  "    steps:",
  "      - name: Start",
  "        type: start",
  "```"
].join("\n");

const PROSE_ONLY =
  "`for_each` makes the Update SLA Status step run once per matched record -- " +
  "three violations means three executions. Nothing else changes.";

// The widget latches DETACHED mode on send: the blocking chat_turn return is
// an ack and the authoritative transcript arrives on the poll terminal. Both
// funnel through `_handleTurnResult`, so driving the poll path is enough.
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
  const drive = () => {
    turnDeferred.resolve({ accepted: true, turn: 1, stop_reason: "accepted" });
    $rootScope.$digest();
    $timeout.flush(1);      // poll #1 -- preview
    $timeout.flush(700);    // poll #2 -- terminal commits
  };
  return {
    $scope,
    // A free-typed turn: no quick_action on the payload, so not read-only.
    send: (text) => {
      $scope.form.inputText = text;
      $scope.sendMessage();
      drive();
    },
    // A chip: the real read-only path. `runQuickAction` is what the template
    // calls, so this drives the same code the analyst does rather than poking
    // the latch directly -- a test that set `_readOnlyTurn` by hand would pass
    // even if no chip could ever reach it.
    chip: (key, prompt) => {
      $scope.runQuickAction({ key: key, prompt: prompt || "Explain this playbook." });
      drive();
    }
  };
}

function turn(text, extra) {
  return Object.assign(
    { stop_reason: "end_turn", transcript: [{ type: "text", text: text }] },
    extra || {});
}

// The chips that scope a turn read-only, with the prompt each actually sends.
// Note that neither prompt contains any of the phrases the old regex list
// looked for -- which is exactly why the list could not do this job.
const READ_ONLY_CHIPS = [
  ["explain", "Explain what this playbook does, step by step, in plain language."],
  ["find_issues", "Find issues in this playbook."]
];

describe("fsrAgenticAssistant -- only a verified offer loads a playbook", () => {
  test.each(READ_ONLY_CHIPS)("%s chip → the fence is withheld, not adopted", (key, prompt) => {
    const h = makeHarness(turn(AUTHORED));
    h.$scope.currentYaml = "";
    h.chip(key, prompt);
    expect(h.$scope.currentYaml).toBeFalsy();
    expect(h.$scope.withheldYaml).toContain("Indicator Reputation");
    expect(h.$scope.withheldReason).toBe("readonly");
    expect(h.$scope.viewState).toBe("idle");
  });

  test("a read-only chip leaves the analyst's PREVIOUS draft byte-intact", () => {
    const h = makeHarness(turn(AUTHORED));
    h.$scope.currentYaml = "playbooks:\n  - name: Prior draft\n";
    h.chip("explain");
    expect(h.$scope.currentYaml).toBe("playbooks:\n  - name: Prior draft\n");
    expect(h.$scope.withheldYaml).toContain("Indicator Reputation");
  });

  test("last_assistant_yaml is withheld too, not just the transcript fence", () => {
    const h = makeHarness(turn(PROSE_ONLY, {
      last_assistant_yaml: "playbooks:\n  - name: Sneaked in\n"
    }));
    h.chip("explain");
    expect(h.$scope.currentYaml).toBeFalsy();
    expect(h.$scope.withheldYaml).toContain("Sneaked in");
  });

  test("no notice when a read-only turn correctly answers in prose", () => {
    const h = makeHarness(turn(PROSE_ONLY));
    h.chip("explain");
    expect(h.$scope.withheldYaml).toBeFalsy();
    expect(h.$scope.currentYaml).toBeFalsy();
  });

  // Free-typed asks are not read-only (English was never the signal), but
  // a reply-text playbook still never loads on them: only a verified offer
  // card does. Live: "what's the impact of removing this step?" was answered
  // with a whole playbook, and the fence became the open playbook.
  const TYPED_ASKS = [
    "Add a Skip branch before the fallback.",
    "How many times does this loop run?",
    "Can you change the severity mapping to use High?",
    "Explain the loop and then fix the SLA step.",
    "How many times does the Update SLA Status step run? Don't change anything.",
    "Walk me through the decision branches. Just explain it, change nothing.",
    "Read-only: what happens when the condition is false?"
  ];

  test.each(TYPED_ASKS)("%s → a reply-text playbook is withheld as unverified", (ask) => {
    const h = makeHarness(turn(AUTHORED));
    h.$scope.currentYaml = "playbooks:\n  - name: Prior draft\n";
    h.send(ask);
    expect(h.$scope.currentYaml).toBe("playbooks:\n  - name: Prior draft\n");
    expect(h.$scope.withheldYaml).toContain("Indicator Reputation");
    expect(h.$scope.withheldReason).toBe("unverified");
  });

  test.each(TYPED_ASKS)("%s → a verified offer still loads (guard is not overbroad)", (ask) => {
    const h = makeHarness({ stop_reason: "awaiting_enhancement_offer", transcript: [
      { type: "text", text: "Here is the change." },
      { type: "enhancement_offer", id: "e1", summary: "Apply?",
        final_yaml: "playbooks:\n  - name: Indicator Reputation\n" }
    ] });
    h.send(ask);
    expect(h.$scope.currentYaml).toContain("Indicator Reputation");
    expect(h.$scope.withheldYaml).toBeFalsy();
  });

  test("a read-only chip withholds even a verified offer", () => {
    const h = makeHarness({ stop_reason: "awaiting_playbook_offer", transcript: [
      { type: "playbook_offer", id: "o1", summary: "Save?",
        final_yaml: "playbooks:\n  - name: Offered anyway\n" }
    ] });
    h.chip("explain");
    expect(h.$scope.currentYaml).toBeFalsy();
    expect(h.$scope.withheldYaml).toContain("Offered anyway");
    expect(h.$scope.withheldReason).toBe("readonly");
  });

  test("'Load it anyway' adopts the withheld playbook and clears the notice", () => {
    const h = makeHarness(turn(AUTHORED));
    h.chip("explain");
    expect(h.$scope.currentYaml).toBeFalsy();
    h.$scope.applyWithheldYaml();
    expect(h.$scope.currentYaml).toContain("Indicator Reputation");
    expect(h.$scope.withheldYaml).toBeNull();
  });

  test("'Dismiss' drops the withheld playbook without touching currentYaml", () => {
    const h = makeHarness(turn(AUTHORED));
    h.$scope.currentYaml = "playbooks:\n  - name: Prior draft\n";
    h.chip("explain");
    h.$scope.dismissWithheldYaml();
    expect(h.$scope.withheldYaml).toBeNull();
    expect(h.$scope.currentYaml).toContain("Prior draft");
  });
});
