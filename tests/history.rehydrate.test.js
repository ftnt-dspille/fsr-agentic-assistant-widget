"use strict";

// ─── Backend-driven history rehydration (refresh durability) ────────────────
//
// Regression for: "if I refresh the page, I lose the logs." On reload the
// widget keeps only the sessionId (localStorage) and asks the connector's
// chat_history for the prior turns. The connector now returns full-fidelity
// entries -- `{user: str}` or `{transcript: [...wire events...]}` in
// chronological order -- so the widget replays them through its render pipeline
// and the rich timeline (text + tool calls + cards) comes back intact.
//
// These tests drive the init rehydrate path with a stubbed chat_history and
// assert the rendered messages are reconstructed (NOT just plain text).

const path = require("path");

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

// A synchronous thenable so .then/.catch fire during $timeout.flush() without a
// real $q/digest round-trip -- keeps the rehydrate assertions deterministic.
function resolved(val) {
  return {
    then: function (cb) { return resolved(cb ? cb(val) : val); },
    catch: function () { return resolved(val); },
  };
}

// Mounted over a module LIST page so entity-seeding never competes with the
// history rehydrate we're isolating.
const $state = { current: { name: "main.modules.list" }, params: { module: "alerts" } };

let $controller, $rootScope, $timeout, chatHistorySpy, TURNS;

beforeEach(() => {
  TURNS = [];
  chatHistorySpy = jest.fn(() => resolved({ turns: TURNS }));

  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      resolveConnector: () => resolved({ name: "fsr-playbook-builder", version: "1", configId: "c1" }),
      chatHistory: chatHistorySpy,
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
  return $scope;
}

describe(`${viewCtrlName} -- chat_history rehydration`, () => {
  test("replays a rich transcript (user + assistant with tool-call events) on load", () => {
    TURNS = [
      { user: "is 198.51.100.4 malicious?" },
      { transcript: [
        { type: "text", text: "Checking the endpoint…" },
        { type: "tool_use", id: "t1", name: "get_record", input: { iri: "/api/3/alerts/abc" } },
        { type: "tool_result", tool_use_id: "t1", tool: "get_record", content: "{\"severity\":\"high\"}" },
        { type: "text", text: "It's high severity." },
      ] },
    ];
    chatHistorySpy.mockImplementation(() => resolved({ turns: TURNS }));

    const $scope = boot();
    $timeout.flush(); // runs probe (connectorReady=true) then the init rehydrate

    expect(chatHistorySpy).toHaveBeenCalled();
    expect($scope.messages.length).toBe(2);

    const [userMsg, asstMsg] = $scope.messages;
    expect(userMsg.role).toBe("user");
    expect(userMsg.text).toBe("is 198.51.100.4 malicious?");

    expect(asstMsg.role).toBe("assistant");
    // The rich event timeline is reconstructed -- not collapsed to plain text.
    expect(Array.isArray(asstMsg.events)).toBe(true);
    expect(asstMsg.events.length).toBeGreaterThan(0);
    // A tool interaction survived the round-trip (the thing chat_history used
    // to drop entirely).
    const hasTool = asstMsg.events.some((e) => e.type === "tool_call" || e.type === "tool_use" || e.name === "get_record");
    expect(hasTool).toBe(true);
  });

  test("preserves chronological order across multiple turns", () => {
    TURNS = [
      { user: "first question" },
      { transcript: [{ type: "text", text: "first answer" }] },
      { user: "second question" },
      { transcript: [{ type: "text", text: "second answer" }] },
    ];
    chatHistorySpy.mockImplementation(() => resolved({ turns: TURNS }));

    const $scope = boot();
    $timeout.flush();

    expect($scope.messages.length).toBe(4);
    expect($scope.messages[0].text).toBe("first question");
    expect($scope.messages[2].text).toBe("second question");
    expect($scope.messages[1].role).toBe("assistant");
    expect($scope.messages[3].role).toBe("assistant");
  });

  test("renders the REAL author + original time on replay (not the viewer/now)", () => {
    const past = 1700000000; // epoch SECONDS (connector created_at)
    const wendy = { name: "Wendy Smith", iri: "/api/3/people/w" };
    TURNS = [
      { user: "who started this?", author: wendy, ts: past },
      { transcript: [{ type: "text", text: "answer" }], ts: past + 5 },
    ];
    chatHistorySpy.mockImplementation(() =>
      resolved({ turns: TURNS, initiator: wendy }));

    const $scope = boot();
    $timeout.flush();

    const userMsg = $scope.messages[0];
    // author is the stored sender, NOT the current viewer ("Harness user" here)
    expect(userMsg.author).toBe("Wendy Smith");
    expect(userMsg.author).not.toBe($scope.initiator.name);
    // original time (seconds → ms), NOT Date.now()
    expect(userMsg.ts).toBe(past * 1000);
    expect($scope.messages[1].ts).toBe((past + 5) * 1000);
    // session initiator captured → owner badge shows for a chat someone else started
    expect($scope.sessionInitiator).toEqual(wendy);
    expect($scope.chatOwnerLabel()).toBe("Wendy Smith");
  });

  test("pre-actor rows fall back to the viewer but keep the stored time", () => {
    const past = 1699999999;
    TURNS = [{ user: "legacy message", ts: past }];  // no author, no initiator
    chatHistorySpy.mockImplementation(() => resolved({ turns: TURNS }));

    const $scope = boot();
    $timeout.flush();

    const m = $scope.messages[0];
    expect(m.author).toBe($scope.initiator.name);  // graceful fallback
    expect(m.ts).toBe(past * 1000);                 // time still correct
    expect($scope.sessionInitiator).toBe(null);
    expect($scope.chatOwnerLabel()).toBe("");        // no badge when unknown/self
  });

  // ─── Build-state reconstruction on refresh (export sess-rur4yvdd) ─────────
  // After a refresh the timeline is rebuilt from the transcript, but the
  // build-vs-triage UI state isn't on the wire. A session that already authored
  // a playbook must come back in build mode with the YAML restored -- otherwise
  // the YAML toggle is hidden and a confusing "Build playbook" CTA re-appears
  // over work that's already done.
  test("restores the offered YAML and flips to build mode on rehydrate", () => {
    const yaml = "workflows:\n  - name: Blast Radius\n    steps: []";
    TURNS = [
      { user: "build a blast radius playbook" },
      { transcript: [
        { type: "text", text: "Here's the playbook. Ready to push?" },
        { type: "playbook_offer", id: "o1", summary: "Save?", final_yaml: yaml },
      ] },
      // A later push-confirm turn that carries NO yaml -- the old
      // last-transcript-only scan missed the earlier draft entirely.
      { user: "create it" },
      { transcript: [{ type: "text", text: "Done -- the playbook is saved." }] },
    ];
    chatHistorySpy.mockImplementation(() => resolved({ turns: TURNS }));

    const $scope = boot();
    $timeout.flush();

    expect($scope.currentYaml).toBe(yaml);
    expect($scope.uiIntent).toBe("build");
    // The YAML toggle + pane are gated on hasYamlPane(); both now show.
    expect($scope.hasYamlPane()).toBe(true);
    // The redundant build-from-triage CTA is gated on triage mode -- suppressed.
    expect($scope.canBuildFromTriage()).toBe(false);
  });

  test("restores the created-playbook link from a persisted playbook_pushed card", () => {
    TURNS = [
      { user: "save this as a playbook" },
      { transcript: [
        { type: "info_card", variant: "playbook_pushed", title: "Triage Playbook",
          blocks: [
            { kind: "text", text: "Saved this investigation (5 steps)." },
            { kind: "link", label: "Open in Playbook Designer", url: "/playbooks/abc-123" },
          ] },
        { type: "text", text: "Done -- I saved this investigation." },
      ] },
    ];
    chatHistorySpy.mockImplementation(() => resolved({ turns: TURNS }));

    const $scope = boot();
    $timeout.flush();

    expect($scope.playbookLink).toBe("/playbooks/abc-123");
    expect($scope.playbookName).toBe("Triage Playbook");
    expect($scope.uiIntent).toBe("build");
  });

  test("a plain triage session (no YAML, no push) stays in triage mode", () => {
    TURNS = [
      { user: "is 198.51.100.4 malicious?" },
      { transcript: [{ type: "text", text: "It's high severity, no playbook authored." }] },
    ];
    chatHistorySpy.mockImplementation(() => resolved({ turns: TURNS }));

    const $scope = boot();
    $timeout.flush();

    expect($scope.currentYaml).toBe("");
    expect($scope.uiIntent).toBe("triage");
    expect($scope.hasYamlPane()).toBe(false);
  });

  test("empty history falls through to seeding (no phantom messages)", () => {
    TURNS = [];
    chatHistorySpy.mockImplementation(() => resolved({ turns: [] }));

    const $scope = boot();
    $timeout.flush();

    expect(chatHistorySpy).toHaveBeenCalled();
    // No record (list page) + seedFromEntity off ⇒ nothing to show, but no crash.
    expect($scope.messages.length).toBe(0);
  });
});

// A verified offer's final_yaml must survive a refresh over a later prose
// snippet in the same turn -- the live _loadTurnYaml rule, applied on rehydrate.
describe(`${viewCtrlName} -- rehydrate YAML precedence`, () => {
  const VERIFIED = "collection: 00 - FSR Studio\nplaybooks:\n- name: Verified\n  steps: []";
  const SNIPPET = "- name: Send Summary\n  next: '...'";

  test("a verified playbook_offer outranks a closing snippet fence after reload", () => {
    TURNS = [
      { user: "build it" },
      { transcript: [
        { type: "text", text: "Verified." },
        { type: "playbook_offer", id: "o1", summary: "Save?", final_yaml: VERIFIED },
        { type: "text", text: "The email step:\n```yaml\n" + SNIPPET + "\n```\n" },
      ] },
    ];
    chatHistorySpy.mockImplementation(() => resolved({ turns: TURNS }));
    const $scope = boot();
    $timeout.flush();
    expect($scope.currentYaml).toBe(VERIFIED);
  });

  // A reply-text playbook never loaded live, so a refresh must not load it.
  test("a later turn's fence does NOT replace an earlier turn's offer", () => {
    const LATER = "collection: 00 - FSR Studio\nplaybooks:\n- name: Typed\n  steps: []";
    TURNS = [
      { user: "build it" },
      { transcript: [{ type: "playbook_offer", id: "o1", final_yaml: VERIFIED }] },
      { user: "what happens if I remove the find step?" },
      { transcript: [{ type: "text", text: "```yaml\n" + LATER + "\n```\n" }] },
    ];
    chatHistorySpy.mockImplementation(() => resolved({ turns: TURNS }));
    const $scope = boot();
    $timeout.flush();
    expect($scope.currentYaml).toBe(VERIFIED);
  });

  test("a later turn's offer supersedes an earlier turn's offer", () => {
    const LATER = "collection: 00 - FSR Studio\nplaybooks:\n- name: Refined\n  steps: []";
    TURNS = [
      { user: "build it" },
      { transcript: [{ type: "playbook_offer", id: "o1", final_yaml: VERIFIED }] },
      { user: "refine it" },
      { transcript: [{ type: "enhancement_offer", id: "e1", final_yaml: LATER }] },
    ];
    chatHistorySpy.mockImplementation(() => resolved({ turns: TURNS }));
    const $scope = boot();
    $timeout.flush();
    expect($scope.currentYaml).toBe(LATER);
  });
});
