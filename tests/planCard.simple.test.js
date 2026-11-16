"use strict";

// Track U: the playbook offer card's collapsed model. The analyst reads these
// fields first, so none of them may carry a field key, template or id.

const fs = require("fs");
const path = require("path");
const R = require("../widget/widgetAssets/js/fsrPbRender");

const CLOCK = { now: () => 1700000000000, collapseThreshold: 600 };
const FIX = path.join(__dirname, "..", "widget", "widgetAssets", "fixtures");
const LEAK = /\b[a-z0-9]+_[a-z0-9_]+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\{\{|\}\}|\b(?:toolu|call|offer|pb|pbo)_\w+/;

function offerFrom(fixture) {
  const d = JSON.parse(fs.readFileSync(path.join(FIX, fixture + ".json"), "utf8"));
  const ev = d.responses.find((r) => r.action === "chat_turn").response.transcript
    .find((e) => e.type === "playbook_offer");
  const msgs = R.normalizeTranscript ? R.normalizeTranscript([ev], CLOCK) : R.buildAssistantMessage([ev], CLOCK);
  for (const m of (Array.isArray(msgs) ? msgs : [msgs])) {
    for (const e of (m.events || [])) if (e.type === "playbook_offer") return e;
  }
  return null;
}

describe("Track U collapsed offer card", () => {
  test.each(["playbook_offer_block_ip", "playbook_offer_readonly", "playbook_offer_traced", "playbook_offer_student"])(
    "%s: plain summary and steps carry no tech tokens", (fx) => {
      const c = offerFrom(fx);
      expect(c.plainSummary).not.toMatch(LEAK);
      for (const s of c.plainSteps) expect(s.text).not.toMatch(LEAK);
      expect(c.triggerText).not.toMatch(LEAK);
    });

  test("the confirm step reads as a question and is not a fill box", () => {
    const c = offerFrom("playbook_offer_block_ip");
    expect(c.plainSteps.map((s) => s.text)).toContain("Asks you to confirm");
    const confirm = c.opsSummary.find((o) => o.stepType === "manual_input");
    expect(confirm.needsInput).toBe(false);
  });

  test("a write is Changes, a clean read is Read only", () => {
    expect(offerFrom("playbook_offer_block_ip").safetyLine.tone).toBe("warn");
    expect(offerFrom("playbook_offer_block_ip").safetyLine.text).toMatch(/Changes.*confirm/);
    const ro = offerFrom("playbook_offer_readonly");
    expect(ro.safetyLine.tone).toBe("safe");
    expect(ro.safetyLine.text).toMatch(/^Read only/);
  });

  test("trigger line falls back to the default when the payload has none", () => {
    expect(offerFrom("playbook_offer_traced").triggerText).toBe("Runs when you start it");
  });

  test("a sentence with a field key is reworded, not dropped", () => {
    expect(R._plainText("It reads the alert's sourceIp and destinationIp.")).toBe(
      "It reads the alert's source IP and destination IP.");
  });
});
