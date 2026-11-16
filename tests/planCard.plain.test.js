"use strict";

// U5: the offer card shows the framework's `plain` block when present (what it
// does, changes, asks to confirm, capped summary). Without it, the card falls
// back to its own humanized step list; a decision reads as words, not a label.

const fs = require("fs");
const path = require("path");
const R = require("../widget/widgetAssets/js/fsrPbRender");

const CLOCK = { now: () => 1700000000000, collapseThreshold: 600 };
const FIX = path.join(__dirname, "..", "widget", "widgetAssets", "fixtures");

function offerEvent(fixture, extra) {
  const d = JSON.parse(fs.readFileSync(path.join(FIX, fixture + ".json"), "utf8"));
  const ev = d.responses.find((r) => r.action === "chat_turn").response.transcript
    .find((e) => e.type === "playbook_offer");
  return Object.assign({}, ev, extra || {});
}

function card(ev) {
  const msgs = R.buildAssistantMessage([ev], CLOCK);
  for (const m of (Array.isArray(msgs) ? msgs : [msgs])) {
    for (const e of (m.events || [])) if (e.type === "playbook_offer") return e;
  }
  return null;
}

const PLAIN = {
  steps: [
    "Checks whether the alert has a destination IP.",
    "Asks you to confirm before it goes on.",
    "Block IP on FortiGate.",
  ],
  changes: true,
  asks_confirm: true,
  summary: "Blocks the destination IP on FortiGate.",
};

describe("U5 offer card reads the plain block", () => {
  test("plain steps, summary and safety come from the plain block", () => {
    const c = card(offerEvent("playbook_offer_block_ip", { plain: PLAIN }));
    expect(c.plainSteps.map((s) => s.text)).toEqual(PLAIN.steps);
    expect(c.plainSummary).toBe(PLAIN.summary);
    expect(c.safetyLine.tone).toBe("warn");
    expect(c.safetyLine.text).toMatch(/^Changes things\. It waits for you to confirm/);
  });

  test("a read-only plain block says Read only, whatever the steps", () => {
    const c = card(offerEvent("playbook_offer_block_ip", {
      plain: { steps: ["Looks up the source IP."], changes: false, asks_confirm: false, summary: "Looks up the source." },
    }));
    expect(c.safetyLine.tone).toBe("safe");
    expect(c.safetyLine.text).toMatch(/^Read only/);
  });

  test("a plain sentence that carries a tool name is dropped from the steps", () => {
    const c = card(offerEvent("playbook_offer_block_ip", {
      plain: { steps: ["Runs block_ip_new on the target.", "Blocks the IP."], changes: true, asks_confirm: false, summary: "Blocks it." },
    }));
    expect(c.plainSteps.map((s) => s.text)).toEqual(["Blocks the IP."]);
  });
});

describe("U5 fallback step text humanizes decision labels", () => {
  test("a decision reads as a check in words, not a raw field label", () => {
    const c = card(offerEvent("playbook_offer_block_ip"));
    const texts = c.plainSteps.map((s) => s.text);
    expect(texts).toContain("Checks whether containment target present.");
    expect(texts.join(" ")).not.toMatch(/Checks: containment Target/);
  });
});
