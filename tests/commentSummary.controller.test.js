"use strict";

// Controller wiring for the header model badge and "Save summary to comments".
// The pure helpers are covered in commentSummary.service.test.js; here the
// property is that the controller feeds them the right things: the model from
// the turn's usage frames, the record's comments capability, and a POST to
// /api/3/comments whose body carries the analyst's EDITED text and the link
// to the record on screen.

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

function makeHarness(pollScript, mode) {
  let pollCall = 0;
  let $q, $timeout, $rootScope, $controller, $httpBackend;
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: mode || "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when(pollScript[Math.min(pollCall++, pollScript.length - 1)])
  };
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", agentStub);
    $provide.value("config", {});
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_, _$httpBackend_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $q = _$q_; $timeout = _$timeout_;
    $httpBackend = _$httpBackend_;
  });
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  return { $scope, $timeout, $httpBackend };
}

const turn = (...frames) => ({ contract_version: "2.6.0", turn: 1, cursor: 2, done: false,
  frames: [{ type: "turn_start", turn: 1 }].concat(frames) });
const usage = (model) => ({ type: "usage", model, input_tokens: 10, output_tokens: 5, cost_usd: 0 });

describe("header model badge", () => {
  test("hidden with no model and no configuration", () => {
    const h = makeHarness([turn()]);
    h.$scope.connectorInfo = null;
    expect(h.$scope.modelBadge()).toBeNull();
  });

  test("before the first reply it names the connector configuration, not a guessed model", () => {
    const h = makeHarness([turn()]);
    h.$scope.connectorInfo = { configName: "Lab LLM" };
    expect(h.$scope.modelBadge().label).toBe("Configuration: Lab LLM");
  });

  test("a turn's usage frame replaces it with the model and provider", () => {
    const h = makeHarness([turn(usage("anthropic/claude-haiku-5-5"))]);
    h.$scope.connectorInfo = { configName: "Lab LLM" };
    h.$scope.form.inputText = "hi";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    expect(h.$scope.modelBadge().label).toBe("Model: claude-haiku-5-5 via Anthropic");
  });

  test("a template binding settles: the same object comes back until the label changes", () => {
    const h = makeHarness([turn(usage("claude-haiku-4-5"))]);
    h.$scope.connectorInfo = { configName: "Lab LLM" };
    expect(h.$scope.modelBadge()).toBe(h.$scope.modelBadge());
    h.$scope.form.inputText = "hi";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    expect(h.$scope.modelBadge()).toBe(h.$scope.modelBadge());
  });

  test("it follows the latest turn when the model changes", () => {
    const h = makeHarness([turn(usage("claude-haiku-4-5"), usage("gpt-4.1-mini"))]);
    h.$scope.form.inputText = "hi";
    h.$scope.sendMessage();
    h.$timeout.flush(1);
    expect(h.$scope.modelBadge().label).toBe("Model: gpt-4.1-mini via OpenAI");
  });
});

describe("save summary to comments", () => {
  const IRI = "/api/3/alerts/11111111-2222-3333-4444-555555555555";
  const verdictMsg = () => ({
    role: "assistant", ts: Date.UTC(2026, 10, 19, 14, 2), events: [{
      type: "verdict_card", dispositionLabel: "Benign", severityLabel: "Informational",
      confidenceLabel: "90% confidence", summary: "Scheduled backup traffic.", findings: [], unknowns: []
    }]
  });
  function over(h, record, extra) {
    // The controller re-reads the open record on its own; serve it the same one.
    h.$httpBackend.whenGET(/\/api\/3\/alerts\/11111111/).respond(record || {});
    h.$scope.entityContext = { iri: IRI, module: "alerts", record: record || {} };
    h.$scope.messages = [{ role: "user", text: "triage", events: [] }].concat(extra || []);
  }

  test("shown over a record that carries comments", () => {
    const yes = makeHarness([turn()], "mock");
    over(yes, { "@id": IRI, comments: [] });
    expect(yes.$scope.showCommentSummary()).toBe(true);
  });

  test("hidden over a record whose module has no comments", () => {
    const no = makeHarness([turn()], "mock");
    over(no, { "@id": IRI, name: "x" });
    expect(no.$scope.showCommentSummary()).toBe(false);
  });

  test("hidden before the conversation starts, and in the playbook editor", () => {
    const h = makeHarness([turn()], "mock");
    over(h, { comments: [] });
    h.$scope.messages = [];
    expect(h.$scope.showCommentSummary()).toBe(false);
    over(h, { comments: [] });
    h.$scope.inPlaybookEditor = true;
    expect(h.$scope.showCommentSummary()).toBe(false);
  });

  test("live mode asks the module metadata once and trusts only a comments relationship", () => {
    const h = makeHarness([turn()], "live");
    over(h, { "@id": IRI });
    h.$httpBackend.expectGET(/\/api\/3\/model_metadatas\?.*type=alerts/).respond({
      "hydra:member": [{ type: "alerts", attributes: [{ name: "comments", type: "comments" }] }]
    });
    expect(h.$scope.commentsSupported()).toBe(false);   // pending
    expect(h.$scope.commentsSupported()).toBe(false);   // no second request
    h.$httpBackend.flush();
    expect(h.$scope.commentsSupported()).toBe(true);
    h.$httpBackend.verifyNoOutstandingRequest();
  });

  test("a metadata failure leaves the action hidden", () => {
    const h = makeHarness([turn()], "live");
    over(h, { "@id": IRI });
    h.$httpBackend.expectGET(/model_metadatas/).respond(500, "");
    h.$scope.commentsSupported();
    h.$httpBackend.flush();
    expect(h.$scope.commentsSupported()).toBe(false);
  });

  test("disabled with nothing to summarize, enabled once there is a verdict", () => {
    const h = makeHarness([turn()], "mock");
    over(h, { comments: [] });
    expect(h.$scope.canSaveCommentSummary()).toBe(false);
    h.$scope.openCommentSummary();
    expect(h.$scope.commentSummary.open).toBe(false);
    over(h, { comments: [] }, [verdictMsg()]);
    expect(h.$scope.canSaveCommentSummary()).toBe(true);
  });

  test("preview is editable and Save posts the EDITED text linked to this record", () => {
    const h = makeHarness([turn()], "mock");
    over(h, { comments: [] }, [verdictMsg()]);
    h.$scope.openCommentSummary();
    expect(h.$scope.commentSummary.text).toContain("Verdict: Benign (Informational, 90% confidence)");
    h.$scope.commentSummary.text = "Closing: backup job, confirmed with the owner.";
    let body;
    h.$httpBackend.expectPOST("/api/3/comments", (b) => { body = JSON.parse(b); return true; })
      .respond(201, { "@id": "/api/3/comments/c-1" });
    h.$scope.saveCommentSummary();
    expect(h.$scope.commentSummary.saving).toBe(true);
    h.$httpBackend.flush();
    expect(body).toEqual({
      content: "<p>Closing: backup job, confirmed with the owner.</p>",
      alerts: [IRI]
    });
    expect(h.$scope.commentSummary.saved).toBe(true);
    expect(h.$scope.commentSummary.open).toBe(false);
  });

  test("a failed save keeps the text and says so", () => {
    const h = makeHarness([turn()], "mock");
    over(h, { comments: [] }, [verdictMsg()]);
    h.$scope.openCommentSummary();
    const text = h.$scope.commentSummary.text;
    h.$httpBackend.expectPOST("/api/3/comments").respond(403, { message: "forbidden" });
    h.$scope.saveCommentSummary();
    h.$httpBackend.flush();
    expect(h.$scope.commentSummary.open).toBe(true);
    expect(h.$scope.commentSummary.saved).toBe(false);
    expect(h.$scope.commentSummary.text).toBe(text);
    expect(h.$scope.commentSummary.error).toMatch(/Could not save the comment/);
  });

  test("an emptied preview is not posted", () => {
    const h = makeHarness([turn()], "mock");
    over(h, { comments: [] }, [verdictMsg()]);
    h.$scope.openCommentSummary();
    h.$scope.commentSummary.text = "   ";
    h.$scope.saveCommentSummary();
    h.$httpBackend.flush();   // only the record re-read; a POST would be unexpected
    h.$httpBackend.verifyNoOutstandingRequest();
    expect(h.$scope.commentSummary.error).toBeTruthy();
  });
});
