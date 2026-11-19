"use strict";

// Save summary to comments + the header model badge: the pure helpers.
// The summary is built from the conversation's own cards (no model call), so
// every card combination is asserted on its content: what the analyst would
// read in the comment, not that "a string came back".

global.jasmine = global.jasmine || {};
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef
require("../widget/widgetAssets/js/fsrPbCards.service.js");

const ng = window.angular; // eslint-disable-line no-undef
let svc;
beforeEach(() => {
  ng.mock.module("cybersponse");
  ng.mock.inject((fsrPbCardsService) => { svc = fsrPbCardsService; });
});

const T0 = Date.UTC(2026, 10, 19, 14, 2); // 2026-11-19 14:02 UTC
const T1 = Date.UTC(2026, 10, 19, 14, 5);

const verdict = (over) => Object.assign({
  type: "verdict_card", disposition: "suspicious", dispositionLabel: "Suspicious",
  severityLabel: "High severity", confidenceLabel: "78% confidence",
  summary: "Beaconing to a known bad address.", findings: [
    { claim: "Host contacted 198.51.100.9 twice", evidence: [] },
    { claim: "Hash matches a malware family", evidence: [] }],
  unknowns: ["Whether data left the network"]
}, over);
const action = (over) => Object.assign({
  type: "action_card", summary: "Block 198.51.100.9 on the edge firewall",
  _resolved: false, _outcome: null
}, over);
const msg = (events, ts) => ({ role: "assistant", ts: ts || T0, events });

describe("buildCommentSummary", () => {
  test("no cards at all is empty (the button stays disabled)", () => {
    expect(svc.buildCommentSummary([]).empty).toBe(true);
    expect(svc.buildCommentSummary([{ role: "user", text: "hi", events: [] },
      msg([{ type: "text", text: "plain chat" }])]).empty).toBe(true);
    expect(svc.buildCommentSummary(null).empty).toBe(true);
  });

  test("verdict only: disposition, severity, confidence, time, summary, findings, unknowns", () => {
    const s = svc.buildCommentSummary([msg([verdict()])], { now: T1 });
    expect(s.empty).toBe(false);
    expect(s.text).toContain("Assistant summary - 2026-11-19 14:05 UTC");
    expect(s.text).toContain("Verdict: Suspicious (High severity, 78% confidence) (2026-11-19 14:02 UTC)");
    expect(s.text).toContain("Beaconing to a known bad address.");
    expect(s.text).toContain("- Host contacted 198.51.100.9 twice");
    expect(s.text).toContain("- Hash matches a malware family");
    expect(s.text).toContain("Could not confirm:\n- Whether data left the network");
    expect(s.text).not.toContain("Actions:");
    expect(s.text).not.toContain("Playbooks:");
  });

  test("a later verdict replaces an earlier one", () => {
    const s = svc.buildCommentSummary([
      msg([verdict({ dispositionLabel: "Suspicious", summary: "first call" })], T0),
      msg([verdict({ dispositionLabel: "Benign", summary: "second call", findings: [], unknowns: [] })], T1)]);
    expect(s.text).toContain("Verdict: Benign");
    expect(s.text).toContain("second call");
    expect(s.text).not.toContain("first call");
  });

  test("every action outcome reads in plain words with its time", () => {
    const cases = [
      [{ _resolved: true, _outcome: "approve", _resolvedAt: T1 }, "Approved: Block 198.51.100.9 on the edge firewall (2026-11-19 14:05 UTC)"],
      [{ _resolved: true, _outcome: "reject", _resolvedAt: T1 }, "Declined: Block 198.51.100.9 on the edge firewall (2026-11-19 14:05 UTC)"],
      [{ _resolved: false }, "Proposed, not yet decided: Block 198.51.100.9 on the edge firewall"],
      [{ _resolved: true, _outcome: "approve", _error: "Device unreachable", _resolvedAt: T1 }, "Failed: Block 198.51.100.9 on the edge firewall (2026-11-19 14:05 UTC) - Device unreachable"],
      [{ _resolved: true, _outcome: "unverified", _resolvedAt: T1 }, "Approved, result not confirmed: Block 198.51.100.9 on the edge firewall"],
      [{ _resolved: true, _outcome: "approve" }, "Approved: Block 198.51.100.9 on the edge firewall"]
    ];
    cases.forEach(([over, line]) => {
      const s = svc.buildCommentSummary([msg([action(over)])]);
      expect(s.text).toContain("Actions:\n- " + line);
    });
  });

  test("approval requests grade by their outcome, and show the card summary, not a tool name", () => {
    const ok = { type: "approval_request", name: "run_playbook", title: "Run playbook",
      summary: "Run Isolate host on workstation-42", _resolved: true, _outcome: "executed", _resolvedAt: T1 };
    const bad = Object.assign({}, ok, { summary: "Run Disable user", _outcome: "failed" });
    const s = svc.buildCommentSummary([msg([ok, bad])]);
    expect(s.text).toContain("- Approved: Run Isolate host on workstation-42 (2026-11-19 14:05 UTC)");
    expect(s.text).toContain("- Did not run: Run Disable user");
    expect(s.text).not.toContain("run_playbook");
  });

  test("playbooks: only accepted offers count, with their title or summary", () => {
    const s = svc.buildCommentSummary([msg([
      { type: "playbook_offer", title: "Block beacon IPs", _outcome: "accept", _resolvedAt: T1 },
      { type: "playbook_offer", title: "Ignored one", _outcome: "decline" },
      { type: "playbook_offer", title: "Not decided yet", _outcome: null },
      { type: "enhancement_offer", summary: "Added an approval step", _outcome: "accept", _resolvedAt: T1 }
    ])]);
    expect(s.text).toContain("Playbooks:");
    expect(s.text).toContain("- Saved as a playbook: Block beacon IPs (2026-11-19 14:05 UTC)");
    expect(s.text).toContain("- Playbook updated: Added an approval step (2026-11-19 14:05 UTC)");
    expect(s.text).not.toContain("Ignored one");
    expect(s.text).not.toContain("Not decided yet");
  });

  test("a declined-only playbook offer with nothing else is still empty", () => {
    expect(svc.buildCommentSummary([msg([{ type: "playbook_offer", title: "x", _outcome: "decline" }])]).empty).toBe(true);
  });

  test("all three sections, in verdict, actions, playbooks order", () => {
    const s = svc.buildCommentSummary([
      msg([verdict()]),
      msg([action({ _resolved: true, _outcome: "approve", _resolvedAt: T1 }),
           { type: "playbook_offer", title: "Block beacon IPs", _outcome: "accept", _resolvedAt: T1 }])]);
    const i = (needle) => s.text.indexOf(needle);
    expect(i("Verdict:")).toBeGreaterThan(-1);
    expect(i("Verdict:")).toBeLessThan(i("Actions:"));
    expect(i("Actions:")).toBeLessThan(i("Playbooks:"));
  });

  test("hygiene: no tool names, ids, json, emoji or dashes beyond a plain hyphen", () => {
    const s = svc.buildCommentSummary([
      msg([verdict(), action({ _resolved: true, _outcome: "approve", _resolvedAt: T1, cardId: "card-123", operation: "block_ip" })])],
      { now: T1 });
    expect(s.text).not.toMatch(/card-123|block_ip|[{}\[\]]|—|–/);
    expect(s.text).not.toMatch(/[\u{1F300}-\u{1FAFF}☀-➿]/u);
  });
});

describe("commentPayload", () => {
  test("links the record through its module's relationship field and escapes the text", () => {
    const p = svc.commentPayload("Line one <b>\nline two\n\nSecond & last", "/api/3/alerts/abc-1", "alerts");
    expect(p).toEqual({
      content: "<p>Line one &lt;b&gt;<br>line two</p><p>Second &amp; last</p>",
      alerts: ["/api/3/alerts/abc-1"]
    });
  });
  test("uses the record's own module as the key (incidents, custom modules)", () => {
    ["incidents", "warrooms", "z_custom_things"].forEach((m) => {
      const p = svc.commentPayload("x", "/api/3/" + m + "/u", m);
      expect(Object.keys(p).sort()).toEqual(["content", m].sort());
      expect(p[m]).toEqual(["/api/3/" + m + "/u"]);
    });
  });
});

describe("moduleSupportsComments", () => {
  const withComments = { type: "alerts", attributes: [
    { name: "name", type: "text" },
    { name: "comments", type: "comments", formType: "manyToMany", dataSource: { model: "comments" } }] };
  const without = { type: "keys", attributes: [{ name: "name", type: "text" }] };

  test("a module with a comments relationship attribute supports them", () => {
    expect(svc.moduleSupportsComments(withComments, "alerts")).toBe(true);
  });
  test("a relationship to the comments model counts even when the type label differs", () => {
    expect(svc.moduleSupportsComments({ attributes: [{ name: "notes", type: "relationship", dataSource: { model: "comments" } }] })).toBe(true);
  });
  test("a module without one does not", () => {
    expect(svc.moduleSupportsComments(without, "keys")).toBe(false);
  });
  test("a hydra list is matched on the module type, not the first row", () => {
    const list = { "hydra:member": [without, withComments] };
    expect(svc.moduleSupportsComments(list, "alerts")).toBe(true);
    expect(svc.moduleSupportsComments(list, "keys")).toBe(false);
    expect(svc.moduleSupportsComments([without, withComments], "incidents")).toBe(false);
  });
  test("unreadable metadata fails closed", () => {
    [null, undefined, {}, [], "x", { attributes: "nope" }, { "hydra:member": [] }].forEach((m) => {
      expect(svc.moduleSupportsComments(m, "alerts")).toBe(false);
    });
  });
});

describe("describeModel / latestModel", () => {
  test.each([
    ["anthropic/claude-haiku-5-5", "Model: claude-haiku-5-5 via Anthropic"],
    ["claude-sonnet-4-5", "Model: claude-sonnet-4-5 via Anthropic"],
    ["gpt-4.1-mini", "Model: gpt-4.1-mini via OpenAI"],
    ["openai/gpt-4.1", "Model: gpt-4.1 via OpenAI"],
    ["fortiai-proxy", "Model: fortiai-proxy"],
    ["acme/llama-9", "Model: llama-9 via Acme"],
    ["some-local-model", "Model: some-local-model"]
  ])("%s -> %s", (raw, label) => {
    expect(svc.describeModel(raw).label).toBe(label);
  });
  test("nothing usable is null", () => {
    [null, undefined, "", "   "].forEach((x) => expect(svc.describeModel(x)).toBeNull());
  });
  test("the newest usage frame wins; other frames are ignored", () => {
    expect(svc.latestModel([
      { type: "usage", model: "claude-haiku-4-5" }, { type: "text", text: "x" },
      { type: "usage", model: "anthropic/claude-haiku-5-5" }, { type: "usage" }])).toBe("anthropic/claude-haiku-5-5");
    expect(svc.latestModel([{ type: "text" }])).toBe("");
    expect(svc.latestModel(null)).toBe("");
  });
});
