"use strict";

// ─── Header usage meter = this turn's totals, counted once ──────────────────
//
// The topbar read "1,748 tok · $0.0518" on a cache-hit turn. Two bugs:
//   • each usage frame REPLACED the meter (last round wins), so a multi-round
//     turn showed one round's tokens next to a turn-wide tool count;
//   • Anthropic's input_tokens excludes cache reads/writes, so a cache-hit round
//     showed ~3 input tokens.
// The meter is now recomputed from the turn's usage frames each time they are
// absorbed (live poll, then the committed transcript), so re-seeing a frame
// cannot add it twice, and a new turn starts from zero.

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

const ANTHROPIC = "claude-haiku-4-5-20251001";
const OPENAI = "gpt-4.1-mini";

// One harness per test. chatTurn parks until the test resolves it (or never),
// chatPoll walks the script.
function makeHarness(pollScript) {
  let pollCall = 0;
  let $q, $timeout, $rootScope, $controller;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when(pollScript[Math.min(pollCall++, pollScript.length - 1)])
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
  return { $scope, $timeout };
}

const usage = (over) => Object.assign({ type: "usage", model: ANTHROPIC, stop_reason: "tool_calls",
  input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, cost_usd: 0 }, over);

// Cache-hit round: Anthropic input_tokens=3 is DISJOINT from the 15,202 read.
const CACHE_HIT = usage({ input_tokens: 3, cache_read: 15202, output_tokens: 1745, cost_usd: 0.0518 });
// Same round as the new connector ships it: total_input/total_tokens included.
const CACHE_HIT_NORMALIZED = Object.assign({}, CACHE_HIT,
  { total_input: 15205, total_tokens: 16950 });
// OpenAI: cached tokens are a SUBSET of input_tokens (11,886 already includes them).
const OPENAI_ROUND = usage({ model: OPENAI, input_tokens: 11886, cache_read: 11776,
  output_tokens: 196, cost_usd: 0.0021 });

const toolCall = (id) => ({ type: "tool_use", id, name: "get_record", input: {} });

describe("fsrAgenticAssistant - header usage is this turn's total, counted once", () => {
  test("(i) an Anthropic cache-hit round reads ~16,950 tokens, not 1,748", () => {
    const h = makeHarness([
      { contract_version: "2.6.0", turn: 1, cursor: 2, done: false,
        frames: [{ type: "turn_start", turn: 1 }, CACHE_HIT] }
    ]);
    h.$scope.form.inputText = "check the host";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    expect(h.$scope.usage.tokensDisplay).toBe("16,950");
    expect(h.$scope.usage.inputDisplay).toBe("15,205");
    expect(h.$scope.usage.outputDisplay).toBe("1,745");
    expect(h.$scope.usage.cost).toBe("0.0518");
  });

  test("(i-b) a connector frame that carries total_input/total_tokens is used as sent", () => {
    const h = makeHarness([
      { contract_version: "2.6.0", turn: 1, cursor: 2, done: false,
        frames: [{ type: "turn_start", turn: 1 }, CACHE_HIT_NORMALIZED] }
    ]);
    h.$scope.form.inputText = "check the host";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    expect(h.$scope.usage.tokens).toBe(16950);
  });

  test("(ii) an OpenAI round is not double counted: cached input is inside input", () => {
    const h = makeHarness([
      { contract_version: "2.6.0", turn: 1, cursor: 2, done: false,
        frames: [{ type: "turn_start", turn: 1 }, OPENAI_ROUND] }
    ]);
    h.$scope.form.inputText = "hi";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    expect(h.$scope.usage.tokens).toBe(11886 + 196);
    expect(h.$scope.usage.inputDisplay).toBe("11,886");
  });

  test("(iii) two rounds in one turn sum", () => {
    const h = makeHarness([
      { contract_version: "2.6.0", turn: 1, cursor: 3, done: false,
        frames: [{ type: "turn_start", turn: 1 }, CACHE_HIT,
                 toolCall("t1"), usage({ input_tokens: 40, output_tokens: 90, cost_usd: 0.0003 })] }
    ]);
    h.$scope.form.inputText = "go";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    expect(h.$scope.usage.tokens).toBe(16950 + 130);
    expect(h.$scope.usage.cost).toBe((0.0518 + 0.0003).toFixed(4));
  });

  test("(iv) live frames then the committed transcript with the same frames do not double count", () => {
    const round2 = usage({ input_tokens: 40, output_tokens: 90, cost_usd: 0.0003 });
    const script = [
      { contract_version: "2.6.0", turn: 1, cursor: 2, done: false,
        frames: [{ type: "turn_start", turn: 1 }, CACHE_HIT] },
      { contract_version: "2.6.0", turn: 1, cursor: 4, done: true, stop_reason: "end_turn",
        frames: [
          { type: "text", text: "done" },
          round2,
          { type: "stream_end", stop_reason: "end_turn", ok: true, turn_id: "t1",
            transcript: [CACHE_HIT, { type: "text", text: "done" }, round2] }
        ] }
    ];
    const h = makeHarness(script);
    h.$scope.form.inputText = "go";
    h.$scope.sendMessage();
    h.$timeout.flush(1);     // poll #1: first round live
    h.$timeout.flush(700);   // poll #2: second round live, then the terminal commits
    expect(h.$scope.usage.tokens).toBe(16950 + 130);
    expect(h.$scope.usage.cost).toBe((0.0518 + 0.0003).toFixed(4));
  });

  test("(v) a new turn starts the meter from zero", () => {
    const script = [
      { contract_version: "2.6.0", turn: 1, cursor: 2, done: true, stop_reason: "end_turn",
        frames: [{ type: "turn_start", turn: 1 }, CACHE_HIT,
                 { type: "stream_end", stop_reason: "end_turn", ok: true, turn_id: "t1",
                   transcript: [CACHE_HIT, { type: "text", text: "first" }] }] },
      { contract_version: "2.6.0", turn: 2, cursor: 4, done: false,
        frames: [{ type: "turn_start", turn: 2 }] },
      { contract_version: "2.6.0", turn: 2, cursor: 6, done: false,
        frames: [{ type: "text", text: "second" }, OPENAI_ROUND] }
    ];
    const h = makeHarness(script);
    h.$scope.form.inputText = "first";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    h.$timeout.flush(700);
    expect(h.$scope.usage.tokens).toBe(16950);

    h.$scope.form.inputText = "second";
    h.$scope.sendMessage();
    expect(h.$scope.usage.tokens).toBe(0);   // reset as soon as the new turn starts
    h.$timeout.flush(1);
    h.$timeout.flush(700);
    expect(h.$scope.usage.tokens).toBe(11886 + 196);
  });

  test("the tooltip states input, cached share, output and cost in plain words", () => {
    const h = makeHarness([
      { contract_version: "2.6.0", turn: 1, cursor: 2, done: false,
        frames: [{ type: "turn_start", turn: 1 }, CACHE_HIT] }
    ]);
    h.$scope.form.inputText = "check";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    expect(h.$scope.usage.tooltip).toBe("15,205 in (15,202 cached) · 1,745 out · $0.0518");
    expect(h.$scope.usage.tooltip).not.toMatch(/tokens_|input_tokens|cache_read|\u2013|\u2014/);
  });
});
