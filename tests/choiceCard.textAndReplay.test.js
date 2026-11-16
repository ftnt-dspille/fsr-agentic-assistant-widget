"use strict";

// ─── Choice card: typed answers + answers that survive a reload ─────────────
//
// Two analyst-reported gaps on "what should this playbook start from / do?":
//   1. The pick was never saved -- it lived only on the card object in this
//      browser, so after a reload the card came back open, as if unanswered.
//      The connector now stores the answer as a chat_history `resume` row and
//      replay marks the matching card answered.
//   2. There was no way to answer in your own words. A card emitted with
//      `allow_text` shows a text box; the typed text resumes like a chip.

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
const versionSlug = widgetInfo.version.replace(/\./g, "");
const viewCtrlName = `${widgetInfo.name}${versionSlug}DevCtrl`;
const ng = window.angular; // eslint-disable-line no-undef

function resolved(val) {
  return {
    then: function (cb) { return resolved(cb ? cb(val) : val); },
    catch: function () { return resolved(val); },
  };
}

const $state = { current: { name: "main.modules.list" }, params: { module: "alerts" } };

let $controller, $rootScope, $timeout, chatHistorySpy, chatResumeSpy, TURNS;

const CARD = {
  type: "choice_card", id: "create_playbook_scope",
  prompt: "What should the new playbook start from, and what should it do?",
  options: [{ label: "Start from an alert", value: "alert_start" },
            { label: "Start from an incident", value: "incident_start" }],
  allow_text: true,
};

beforeEach(() => {
  TURNS = [];
  chatHistorySpy = jest.fn(() => resolved({ turns: TURNS }));
  chatResumeSpy = jest.fn(() => resolved({ transcript: [], stop_reason: "end_turn" }));
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      resolveConnector: () => resolved({ name: "c", version: "1", configId: "c1" }),
      chatHistory: chatHistorySpy,
      chatResume: chatResumeSpy,
      execute: () => resolved({}),
      resume: () => resolved({}),
      modeInfo: () => ({ mode: "live", mock_scenario: null }),
    });
    $provide.value("config", { seedFromEntity: false });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
    $timeout = _$timeout_;
  });
});

function boot() {
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  return $scope;
}

function cardIn($scope) {
  for (const m of $scope.messages) {
    const ev = (m.events || []).find((e) => e.type === "choice_card");
    if (ev) return ev;
  }
  return null;
}

describe("choice card -- free text", () => {
  test("allow_text maps to allowText on single-pick cards only", () => {
    TURNS = [{ transcript: [CARD] }];
    expect(cardIn(boot()).allowText).toBe(true);
  });

  test("a multi-pick card never gets the text box", () => {
    TURNS = [{ transcript: [Object.assign({}, CARD, { multi: true })] }];
    expect(cardIn(boot()).allowText).toBe(false);
  });

  test("a card without allow_text has no text box", () => {
    const plain = Object.assign({}, CARD);
    delete plain.allow_text;
    TURNS = [{ transcript: [plain] }];
    expect(cardIn(boot()).allowText).toBe(false);
  });

  test("typed text resumes the card with the text as its value", () => {
    TURNS = [{ transcript: [CARD] }];
    const $scope = boot();
    const ev = cardIn($scope);
    expect($scope.canSubmitChoiceText(ev)).toBe(false);          // empty
    ev._typed = "   ";
    expect($scope.canSubmitChoiceText(ev)).toBe(false);          // whitespace
    ev._typed = "  enrich alert IPs on VirusTotal  ";
    $scope.submitChoiceText(ev);
    expect(chatResumeSpy).toHaveBeenCalledTimes(1);
    const payload = chatResumeSpy.mock.calls[0][1];
    expect(payload).toMatchObject({ decision: "choice", choice_id: "create_playbook_scope",
                                    value: "enrich alert IPs on VirusTotal" });
    expect(ev._resolved).toBe(true);
    expect(ev._resolutionText).toBe("enrich alert IPs on VirusTotal");
    $scope.submitChoiceText(ev);                                 // no double send
    expect(chatResumeSpy).toHaveBeenCalledTimes(1);
  });

  test("Enter sends, Shift+Enter does not", () => {
    TURNS = [{ transcript: [CARD] }];
    const $scope = boot();
    const ev = cardIn($scope);
    ev._typed = "block the IP";
    const prevent = jest.fn();
    $scope.choiceTextKeydown({ key: "Enter", shiftKey: true, preventDefault: prevent }, ev);
    expect(chatResumeSpy).not.toHaveBeenCalled();
    $scope.choiceTextKeydown({ key: "Enter", shiftKey: false, preventDefault: prevent }, ev);
    expect(prevent).toHaveBeenCalled();
    expect(chatResumeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("choice card -- answers survive a reload", () => {
  test("a stored chip answer marks the card answered with its label", () => {
    TURNS = [
      { user: "I want to create a new playbook." },
      { transcript: [CARD] },
      { resume: { choice_id: "create_playbook_scope", value: "alert_start",
                  label: "Start from an alert" },
        author: { name: "CS Admin" }, ts: 1790613030 },
      { transcript: [{ type: "text", text: "What should it do?" }] },
    ];
    const $scope = boot();
    const ev = cardIn($scope);
    expect(ev._resolved).toBe(true);
    expect(ev._picked).toBe("alert_start");
    expect(ev._resolutionText).toBe("Start from an alert");
    expect(ev._resolvedBy).toBe("CS Admin");
    expect(ev._resolvedAt).toBe(1790613030000);
    // The resume row is not a chat message of its own.
    expect($scope.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
  });

  test("a stored typed answer shows the text itself", () => {
    TURNS = [
      { transcript: [CARD] },
      { resume: { choice_id: "create_playbook_scope", value: "enrich alert IPs" } },
    ];
    const ev = cardIn(boot());
    expect(ev._resolved).toBe(true);
    expect(ev._resolutionText).toBe("enrich alert IPs");
  });

  test("with no stored answer the card stays open", () => {
    TURNS = [{ transcript: [CARD] }];
    expect(cardIn(boot())._resolved).toBe(false);
  });
});
