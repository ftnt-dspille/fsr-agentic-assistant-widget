// Offer cards state what starts the playbook.
//
// Live (analyst sim): "runs when an alert is created" was built as a manual
// Execute button twice. The card listed the steps but not the trigger, so the
// analyst approved it. The framework now writes a plain sentence from the
// playbook's trigger step; the card carries it so the analyst approves both.

const R = require("../widget/widgetAssets/js/fsrPbRender");

const CLOCK = { now: () => 1700000000000, collapseThreshold: 600 };

function card(ev) {
  const msgs = R.normalizeTranscript
    ? R.normalizeTranscript([ev], CLOCK)
    : R.buildAssistantMessage([ev], CLOCK);
  for (const m of (Array.isArray(msgs) ? msgs : [msgs])) {
    for (const e of (m.events || [])) {
      if (e.type === ev.type) return e;
    }
  }
  return null;
}

const TRIGGER = { kind: "start", modules: ["alerts"], manual: true,
                  label: 'Runs when an analyst clicks "Check IP" on an alert' };

describe("offer cards carry the trigger", () => {
  test.each(["playbook_offer", "enhancement_offer"])("%s shows the sentence", (type) => {
    const c = card({ type, id: "o1", summary: "s", trigger: TRIGGER });
    expect(c.trigger).toEqual({ label: TRIGGER.label, manual: true });
  });

  test("an automatic trigger is not marked manual", () => {
    const c = card({ type: "playbook_offer", id: "o2", summary: "s",
                     trigger: { kind: "start_on_create", label: "Runs automatically when an alert is created" } });
    expect(c.trigger.manual).toBe(false);
  });

  test("a card from an older framework has no trigger line, not a blank one", () => {
    expect(card({ type: "enhancement_offer", id: "o3", summary: "s" }).trigger).toBeNull();
    expect(R._offerTrigger({ kind: "start" })).toBeNull();
  });
});
