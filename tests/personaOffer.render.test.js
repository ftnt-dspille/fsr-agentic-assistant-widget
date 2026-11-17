// persona_offer -- the "remember how to handle this kind of record" card, at
// the render layer. Memory framing; analyst-facing text policy means the card
// shows WHAT the assistant will do in plain words, never tool names / enum
// values / JSON. The one grant the analyst approves is the write scope, so that
// is the line the card must get right.

const R = require("../widget/widgetAssets/js/fsrPbRender");

const CLOCK = { now: () => 1700000000000, collapseThreshold: 600 };

function offerEvent(over) {
  return Object.assign({
    type: "persona_offer",
    id: "persona-1",
    module: "alerts",
    label: "Alert Triage",
    value: "Use get_record to load the alert, then search_module_records...",  // raw prompt: must NOT reach the card
    jSONValue: {
      label: "Alert Triage",
      tools: { allow: ["get_record", "search_module_records", "siem_search"] },
      may_write: [],
      ui: { greeting: "I can triage this alert and recommend a verdict." },
    },
  }, over || {});
}

function findCard(transcript) {
  const msgs = R.normalizeTranscript
    ? R.normalizeTranscript(transcript, CLOCK)
    : R.buildAssistantMessage(transcript, CLOCK);
  const list = Array.isArray(msgs) ? msgs : [msgs];
  for (const m of list) {
    for (const ev of (m.events || [])) {
      if (ev.type === "persona_offer") return ev;
    }
  }
  return null;
}

describe("persona_offer card", () => {
  test("renders as its own card type with a memory-framed headline", () => {
    const card = findCard([offerEvent()]);
    expect(card).toBeTruthy();
    expect(card.type).toBe("persona_offer");
    expect(card.offerId).toBe("persona-1");
    expect(card.headline).toBe("Remember how to handle alerts records");
    expect(card.label).toBe("Alert Triage");
  });

  test("a read-only persona says it never changes records", () => {
    const card = findCard([offerEvent()]);
    expect(card.scopeLine).toMatch(/read and investigate/i);
    expect(card.scopeLine).toMatch(/never change/i);
  });

  test("a writing persona says it can update when approved", () => {
    const card = findCard([offerEvent({ jSONValue: {
      label: "ZTPF Author", tools: { allow: ["create_record"] },
      may_write: ["ztpf_templates"], ui: {} } })]);
    expect(card.scopeLine).toMatch(/can update them when you approve/i);
  });

  test("never leaks tool names / the raw prompt into the card (analyst-facing policy)", () => {
    const card = findCard([offerEvent()]);
    const text = JSON.stringify(card);
    for (const forbidden of ["get_record", "search_module_records", "siem_search", "jSONValue", "may_write"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("carries the analyst-safe greeting through", () => {
    const card = findCard([offerEvent()]);
    expect(card.greeting).toBe("I can triage this alert and recommend a verdict.");
  });
});
