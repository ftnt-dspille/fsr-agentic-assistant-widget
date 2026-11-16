// Connector param help is authored for the playbook designer and routinely
// carries record IRIs, bare /api/3/ paths and Jinja expressions. The action
// card renders description/tooltip/placeholder to the analyst (view.html
// 3160-3192), so the house rule (no ids / paths in analyst-facing text) applies.
// _cleanParamHelp keeps the readable sentence and strips the machine bits.

const R = require("../widget/widgetAssets/js/fsrPbRender");

const CLOCK = { now: () => 1700000000000, collapseThreshold: 600 };

function field(paramSchema) {
  const card = R.normalizeActionCard(
    { type: "action_card", card_id: "c1", connector: "fw", operation: "block",
      param_schema: paramSchema },
    CLOCK
  );
  return card.paramSchema[0];
}

describe("action-card param help never leaks paths/ids", () => {
  test("record IRI, bare api path and Jinja expression are stripped; prose survives", () => {
    const f = field([{
      name: "target",
      title: "Target",
      description: "The host to block, e.g. /api/3/hosts/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee or {{ vars.input.records }} from /api/3/alerts.",
    }]);
    expect(f.description).not.toMatch(/\/api\/3\//);
    expect(f.description).not.toMatch(/\{\{/);
    expect(f.description).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    // the readable sentence remains
    expect(f.description).toContain("The host to block");
    expect(f.description).toContain("the host record");
  });

  test("tooltip and placeholder are scrubbed the same way", () => {
    const f = field([{
      name: "ttl",
      title: "Time to live",
      tooltip: "See /api/3/picklists/ttl",
      placeholder: "{{ vars.ttl }}",
    }]);
    expect(f.tooltip).not.toMatch(/\/api\/3\//);
    expect(f.placeholder).not.toMatch(/\{\{/);
  });

  test("clean help is left untouched", () => {
    const f = field([{ name: "ttl", title: "Time to live",
      description: "How long the block lasts." }]);
    expect(f.description).toBe("How long the block lasts.");
  });
});
