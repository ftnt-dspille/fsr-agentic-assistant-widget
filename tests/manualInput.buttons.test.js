"use strict";

// A playbook pause offers its own buttons, and a run card can grant the playbook.
//
// Live, the ZTPF metadata-source run paused a second time on "Data Collected"
// with Ok / Save Example and the collected data in its description. The card
// had no way to send anything but the primary button, and printed the data as
// one run of plain text. Now:
//   * two or more buttons render one each and the chosen label rides back as
//     `option` (only the primary one needs the required fields);
//   * the prompt renders as markdown, YAML fences included;
//   * a run_playbook approval its persona would have asked about offers
//     "Approve & always allow", which sends `remember: true`.

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
const R = window.FsrPbRender; // eslint-disable-line no-undef
const CLOCK = { now: () => 1, collapseThreshold: 99, interleaveText: true };

function boot() {
  let $q, $rootScope, $controller, $timeout;
  const mi = [], resume = [];
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "x", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "manual_input_form" }),
    chatHistory: () => $q.when({ turns: [] }),
    listSessions: () => $q.when({ sessions: [] }),
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when({ frames: [] }),
    respondManualInput: (cfg, payload) => {
      mi.push(payload);
      return $q.when({ ok: true, transcript: [], stop_reason: "end_turn" });
    },
    chatResume: (cfg, payload) => {
      resume.push(payload);
      return $q.when({ ok: true, transcript: [], stop_reason: "end_turn" });
    },
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
  return { $scope, mi, resume, digest: () => $rootScope.$digest() };
}

function card(wire) {
  return R.buildAssistantMessage([Object.assign({ type: "manual_input", id: "652",
    workflow_run_iri: "/wf/api/workflows/80929/" }, wire)], CLOCK)
    .events.find((e) => e.type === "manual_input");
}

const RESULTS = {
  question: "Data Collected\n\n**Metadata Results**\n```json\n{\"available\": [\"7.4.3\"]}\n```",
  fields: [],
  buttons: [{ label: "Ok", primary: true }, { label: "Save Example", primary: false }],
};

const PICK = {
  question: "Choose a Manager and a Device",
  fields: [{ name: "note", label: "Note", type: "text", required: true }],
  buttons: [{ label: "Ok", primary: true }, { label: "Cancel", primary: false }],
};

describe("manual_input buttons", () => {
  test("the render model keeps labelled buttons in order and drops junk", () => {
    expect(R.normalizeManualButtons([{ label: "Ok", primary: true }, { label: "" }, null,
      { label: "Save Example" }])).toEqual([
      { label: "Ok", primary: true }, { label: "Save Example", primary: false }]);
    expect(R.normalizeManualButtons(undefined)).toEqual([]);
    expect(card(RESULTS).buttons.map((b) => b.label)).toEqual(["Ok", "Save Example"]);
  });

  test("choosing a button sends its label as the option", () => {
    const { $scope, mi, digest } = boot();
    const ev = card(RESULTS);
    expect($scope.manualInputHasChoice(ev)).toBe(true);
    $scope.submitManualInput(ev, ev.buttons[1]);
    digest();
    expect(mi).toHaveLength(1);
    expect(mi[0].option).toBe("Save Example");
    expect(mi[0].decision).toBe("approve");
    expect(ev._chosen).toBe("Save Example");
    expect($scope.messages.some((m) => m.role === "user" && /chose "Save Example"/.test(m.text))).toBe(true);
  });

  test("the primary button waits for required fields; another button does not", () => {
    const { $scope, mi, digest } = boot();
    const ev = card(PICK);
    expect($scope.manualInputButtonDisabled(ev, ev.buttons[0])).toBe(true);
    expect($scope.manualInputButtonDisabled(ev, ev.buttons[1])).toBe(false);
    $scope.submitManualInput(ev, ev.buttons[0]);
    digest();
    expect(mi).toHaveLength(0);
    $scope.submitManualInput(ev, ev.buttons[1]);
    digest();
    expect(mi).toHaveLength(1);
    expect(mi[0].option).toBe("Cancel");
  });

  test("a card with one button keeps the generic pair and sends no option", () => {
    const { $scope, mi, digest } = boot();
    const ev = card({ question: "q", fields: [{ name: "n", type: "text" }],
      buttons: [{ label: "Ok", primary: true }] });
    expect($scope.manualInputHasChoice(ev)).toBe(false);
    $scope.submitManualInput(ev);
    digest();
    expect(mi).toHaveLength(1);
    expect("option" in mi[0]).toBe(false);
  });
});

describe("manual_input prompt", () => {
  test("markdown renders, and a YAML fence stays visible", () => {
    const { $scope } = boot();
    const html = String($scope.renderPromptText(
      "**Saved**\n```yaml\nname: CORE\n```").$$unwrapTrustedValue());
    expect(html).toMatch(/<strong>Saved<\/strong>/);
    expect(html).toMatch(/<pre class="md-code">name: CORE/);
  });

  test("a bare <hr> in a markdown description is a rule, not literal text", () => {
    // Live: the ZTPF "Data Collected" pause separates its sections with <hr>.
    const { $scope } = boot();
    const html = String($scope.renderPromptText(
      "Data Collected\n\n<hr>\n\n**Metadata Results**\n```\n{}\n```").$$unwrapTrustedValue());
    expect(html).not.toContain("&lt;hr");
    expect(html).toMatch(/<hr/);
    expect(html).toMatch(/<strong>Metadata Results<\/strong>/);
  });

  test("legacy rich-text HTML is sanitized, not shown as tags", () => {
    const { $scope } = boot();
    const html = String($scope.renderPromptText(
      "<p style=\"color:red\">Pick one</p><script>x()</script>").$$unwrapTrustedValue());
    expect(html).toContain("Pick one");
    expect(html).not.toMatch(/<script|style=/);
  });
});

describe("approval: always allow", () => {
  function approval(extra) {
    return R.buildAssistantMessage([Object.assign({
      type: "approval_request", approval_id: "ap-1", tool_use_id: "tu-1", tool: "run_playbook",
      tier: 3, summary: "Run Render Script - Template",
      preview: { tool: "run_playbook", args: { playbook: "Render Script - Template" } },
    }, extra)], CLOCK).events.find((e) => e.type === "approval_request");
  }
  const OFFER = { always_allow: { persona: "ztpf_templates", playbook: "Render Script - Template" } };

  test("the offer reaches the render model, and is null without one", () => {
    expect(approval(OFFER).alwaysAllow).toEqual(OFFER.always_allow);
    expect(approval({}).alwaysAllow).toBeNull();
  });

  test("Approve & always allow sends remember", () => {
    const t = boot();
    const ev = approval(OFFER);
    t.$scope.approvalRequest = { approvalId: "ap-1", tool: "run_playbook" };
    t.$scope.respondApprovalInline(ev, "approve", true);
    t.digest();
    expect(t.resume[0].remember).toBe(true);
    expect(t.resume[0].approval_id).toBe("ap-1");
  });

  test("plain Approve does not", () => {
    const t = boot();
    const ev = approval(OFFER);
    t.$scope.approvalRequest = { approvalId: "ap-1", tool: "run_playbook" };
    t.$scope.respondApprovalInline(ev, "approve");
    t.digest();
    expect("remember" in t.resume[0]).toBe(false);
  });

  test("remember is never sent for a card that offered nothing", () => {
    const t = boot();
    const ev = approval({});
    t.$scope.approvalRequest = { approvalId: "ap-1", tool: "run_playbook" };
    t.$scope.respondApprovalInline(ev, "approve", true);
    t.digest();
    expect("remember" in t.resume[0]).toBe(false);
  });
});
