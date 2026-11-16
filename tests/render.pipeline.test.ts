// ─── Layer 1: pure render-pipeline replay (SOAR_TEST_KIT_DESIGN.md §3/§5) ───
//
// The render module (widgetAssets/js/fsrPbRender.js) is framework-free, so we
// replay EVERY fixture transcript through it in node -- no browser, ms/test.
// This absorbs the bulk of what the e2e suite used to assert through Chromium:
// transcript→render-model mapping, tool_use/result pairing, info-card block
// normalization, choice/action/manual cards, severity buckets, status colour.
//
// One fixture set, every layer: the same JSON the mock connector serves to the
// browser is the source of truth here (principle §2).

import fs = require("fs");
import path = require("path");
import R = require("../widget/widgetAssets/js/fsrPbRender");

const FIXTURES_DIR = path.resolve(__dirname, "../widget/widgetAssets/fixtures");

// Fixed clock → deterministic default ids/timestamps (no Date.now in assertions).
const CLOCK = { now: () => 1700000000000, collapseThreshold: 600 };

// The render vocabulary lives in tools/render_contract.json, shared with
// tools/render_check.cjs so the node bridge and this replay cannot drift apart.
// Render-model event types the template knows how to draw (`activity` is a
// first-class type: consecutive frames coalesce, see "activity frames coalesce").
// A transcript event that maps to anything outside this set is a contract drift.
const CONTRACT = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../tools/render_contract.json"), "utf8")) as {
  renderEventTypes: string[]; blockKinds: string[]; severities: string[]; toolStatuses: string[];
};
const RENDER_EVENT_TYPES = new Set(CONTRACT.renderEventTypes);
const BLOCK_KINDS = new Set(CONTRACT.blockKinds);
const SEVERITIES = new Set(CONTRACT.severities);
const TOOL_STATUSES = CONTRACT.toolStatuses;

interface Fixture {
  name: string;
  data: Record<string, any>;
}

function loadFixtures(): Fixture[] {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f, data: JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf8")) }));
}

function eachTranscript(fixtureData: Record<string, any>, label: string, cb: (t: any[], where: string) => void) {
  (fixtureData.responses || []).forEach((r: any, i: number) => {
    const t = r.response && r.response.transcript;
    if (Array.isArray(t)) cb(t, `${label}#responses[${i}](${r.action})`);
  });
}

// ─── Replay: every fixture, every transcript, asserting the WHOLE set ────────
// (memory: integration tests must iterate all inputs and assert failures===[],
//  never bail at the first success.)

describe("render pipeline -- replays every fixture transcript", () => {
  const fixtures = loadFixtures();

  test("loaded the full fixture set (incl. c2_hunt)", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    expect(fixtures.map((f) => f.name)).toContain("c2_hunt.json");
  });

  test("every transcript produces a well-formed assistant render model", () => {
    const failures: string[] = [];
    for (const fx of fixtures) {
      eachTranscript(fx.data, fx.name, (transcript, where) => {
        let msg: any;
        try {
          msg = R.buildAssistantMessage(transcript, CLOCK);
        } catch (e: any) {
          failures.push(`${where}: threw ${e.message}`);
          return;
        }
        if (msg.role !== "assistant") failures.push(`${where}: role=${msg.role}`);
        if (typeof msg.text !== "string") failures.push(`${where}: text not string`);
        if (!Array.isArray(msg.events)) { failures.push(`${where}: events not array`); return; }
        msg.events.forEach((ev: any, j: number) => {
          if (!RENDER_EVENT_TYPES.has(ev.type)) {
            failures.push(`${where} ev[${j}]: unknown render type "${ev.type}"`);
          }
          if (ev.type === "info_card") {
            if (!SEVERITIES.has(ev.severity)) failures.push(`${where} ev[${j}]: bad severity ${ev.severity}`);
            (ev.blocks || []).forEach((b: any, k: number) => {
              if (!BLOCK_KINDS.has(b.kind)) failures.push(`${where} ev[${j}].blocks[${k}]: bad kind ${b.kind}`);
            });
            if (!ev.cardId) failures.push(`${where} ev[${j}]: info_card missing cardId`);
          }
          if (ev.type === "action_card") {
            if (!ev.cardId) failures.push(`${where} ev[${j}]: action_card missing cardId`);
            if (typeof ev.args !== "object") failures.push(`${where} ev[${j}]: action_card args not object`);
            if (!Array.isArray(ev.editableFields)) failures.push(`${where} ev[${j}]: editableFields not array`);
          }
          if (ev.type === "choice_card") {
            if (!ev.choiceId) failures.push(`${where} ev[${j}]: choice_card missing choiceId`);
            if (!Array.isArray(ev.options)) failures.push(`${where} ev[${j}]: choice options not array`);
          }
          if (ev.type === "manual_input") {
            if (!ev.inputId) failures.push(`${where} ev[${j}]: manual_input missing inputId`);
            if (typeof ev.values !== "object") failures.push(`${where} ev[${j}]: manual_input values not object`);
          }
          if (ev.type === "capability_gap") {
            if (!ev.choiceId) failures.push(`${where} ev[${j}]: capability_gap missing choiceId`);
            if (!ev.missing) failures.push(`${where} ev[${j}]: capability_gap missing 'missing'`);
            if (!Array.isArray(ev.fixSteps)) failures.push(`${where} ev[${j}]: capability_gap fixSteps not array`);
            if (!ev.resume || !ev.resume.value) failures.push(`${where} ev[${j}]: capability_gap missing resume.value`);
          }
          if (ev.type === "playbook_offer") {
            if (!ev.offerId) failures.push(`${where} ev[${j}]: playbook_offer missing offerId`);
            if (!ev.summary) failures.push(`${where} ev[${j}]: playbook_offer missing summary`);
            if (!Array.isArray(ev.opsSummary)) failures.push(`${where} ev[${j}]: playbook_offer opsSummary not array`);
          }
          if (ev.type === "tool_call") {
            if (!TOOL_STATUSES.includes(ev.resultStatus)) {
              failures.push(`${where} ev[${j}]: bad resultStatus ${ev.resultStatus}`);
            }
          }
        });
      });
    }
    expect(failures).toEqual([]);
  });

  test("replay is deterministic under a fixed clock (same input → same output)", () => {
    const mismatches: string[] = [];
    for (const fx of fixtures) {
      eachTranscript(fx.data, fx.name, (transcript, where) => {
        const a = JSON.stringify(R.buildAssistantMessage(transcript, CLOCK));
        const b = JSON.stringify(R.buildAssistantMessage(transcript, CLOCK));
        if (a !== b) mismatches.push(where);
      });
    }
    expect(mismatches).toEqual([]);
  });
});

// ─── Targeted unit assertions (ported from e2e DOM checks) ───────────────────

describe("noc_device_down fixture -- NOC device-down hunt renders", () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, "noc_device_down.json"), "utf8")
  );
  const turn = fixture.responses.find((r: any) => r.action === "chat_turn");
  const msg = R.buildAssistantMessage(turn.response.transcript, CLOCK);

  test("renders the FMG + FAZ tool chips for the device-down hunt", () => {
    const toolNames = msg.events
      .filter((e: any) => e.type === "tool_call")
      .map((e: any) => e.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "fmg_get_device_status",
        "fmg_get_ha_status",
        "faz_search_device_events",
        "faz_event_summary",
        "fmg_get_policy_package_status",
      ])
    );
    // every tool resolved (no pending/error in a canned transcript)
    msg.events
      .filter((e: any) => e.type === "tool_call")
      .forEach((e: any) => expect(["success", "ok"]).toContain(e.resultStatus));
  });

  test("emits a warning-severity diagnosis info_card with the WAN1 timeline", () => {
    const cards = msg.events.filter((e: any) => e.type === "info_card");
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.severity).toBe("warning");
    expect(card.cardId).toBe("noc-findings-fgt-branch-04");
    const table = card.blocks.find((b: any) => b.kind === "table");
    expect(table).toBeTruthy();
    const flat = JSON.stringify(table.rows);
    expect(flat).toContain("WAN1");
    expect(flat).toContain("Stopped reporting to FMG");
  });

  test("read-only: no action_card (remediation is field dispatch)", () => {
    expect(msg.events.some((e: any) => e.type === "action_card")).toBe(false);
  });
});

describe("normalizeBlocks -- table rows are padded/clipped to columns.length", () => {
  test("short rows are right-padded with '' so cells stay under their header", () => {
    const [t] = R.normalizeBlocks([
      { kind: "table", columns: ["A", "B", "C"], rows: [["1"], ["1", "2"]] },
    ]);
    expect(t.rows).toEqual([
      ["1", "", ""],
      ["1", "2", ""],
    ]);
  });

  test("long rows are clipped so no stray <td> renders past the last header", () => {
    const [t] = R.normalizeBlocks([
      { kind: "table", columns: ["A", "B"], rows: [["1", "2", "3", "4"]] },
    ]);
    expect(t.rows).toEqual([["1", "2"]]);
  });

  test("non-array / missing rows and non-array cells degrade to empty rows", () => {
    const [t] = R.normalizeBlocks([
      { kind: "table", columns: ["A", "B"], rows: ["oops", null, {}] },
    ]);
    expect(t.rows).toEqual([["", ""], ["", ""], ["", ""]]);
  });
});

describe("buildAssistantMessage -- text + tool pairing", () => {
  test("concatenates streamed text deltas verbatim (no separators)", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "text", text: "Hel" }, { type: "text", text: "lo " }, { type: "text", text: "world" }],
      CLOCK
    );
    expect(msg.text).toBe("Hello world");
    expect(msg.events).toHaveLength(0);
  });

  test("pairs tool_result onto its tool_use by id (one grouped card)", () => {
    const msg = R.buildAssistantMessage(
      [
        { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
        { type: "tool_result", tool_use_id: "tu_1", content: '{"status":"success"}' },
      ],
      CLOCK
    );
    expect(msg.events).toHaveLength(1);
    expect(msg.events[0].type).toBe("tool_call");
    expect(msg.events[0].name).toBe("search");
    expect(msg.events[0].resultDisplay).toBe('{"status":"success"}');
    expect(msg.events[0].resultStatus).toBe("success");
  });

  test("falls back to name match when ids are absent (legacy fixtures)", () => {
    const msg = R.buildAssistantMessage(
      [
        { type: "tool_use", name: "lookup", input: {} },
        { type: "tool_result", tool: "lookup", content: '{"ok":false}' },
      ],
      CLOCK
    );
    expect(msg.events).toHaveLength(1);
    expect(msg.events[0].resultStatus).toBe("error");
  });

  test("orphan tool_result (no preceding tool_use) renders standalone", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "tool_result", tool: "ghost", content: "raw output" }],
      CLOCK
    );
    expect(msg.events).toHaveLength(1);
    expect(msg.events[0].inputDisplay).toBeNull();
    expect(msg.events[0].resultDisplay).toBe("raw output");
  });

  test("long tool output collapses, short output stays open (threshold)", () => {
    const longTxt = "x".repeat(700);
    const msg = R.buildAssistantMessage(
      [
        { type: "tool_use", id: "a", name: "t", input: {} },
        { type: "tool_result", tool_use_id: "a", content: longTxt },
        { type: "tool_use", id: "b", name: "t", input: {} },
        { type: "tool_result", tool_use_id: "b", content: "short" },
      ],
      CLOCK
    );
    expect(msg.events[0]._resultOpen).toBe(false); // > 600
    expect(msg.events[1]._resultOpen).toBe(true); // < 600
  });

  test("activity frames coalesce into one timeline event (phase trail)", () => {
    const msg = R.buildAssistantMessage(
      [
        { type: "activity", phase: "normalize", message: "Normalizing record" },
        { type: "activity", phase: "classify", message: "Classified as C2/exfil" },
        { type: "activity", phase: "ground", message: "Grounded on 2 IP(s)" },
      ],
      CLOCK
    );
    expect(msg.events).toHaveLength(1);
    expect(msg.events[0].type).toBe("activity");
    expect(msg.events[0].lines.map((l: any) => l.message)).toEqual([
      "Normalizing record",
      "Classified as C2/exfil",
      "Grounded on 2 IP(s)",
    ]);
  });

  test("activity does not coalesce across an interleaved text/tool event", () => {
    const msg = R.buildAssistantMessage(
      [
        { type: "activity", phase: "normalize", message: "Normalizing record" },
        { type: "tool_use", id: "t1", name: "search", input: {} },
        { type: "activity", phase: "ground", message: "Grounded" },
      ],
      { ...CLOCK, interleaveText: true }
    );
    const acts = msg.events.filter((e: any) => e.type === "activity");
    expect(acts).toHaveLength(2);
  });

  test("activity with no message/phase is dropped", () => {
    const msg = R.buildAssistantMessage([{ type: "activity" }], CLOCK);
    expect(msg.events).toHaveLength(0);
  });
});

describe("buildAssistantMessage -- interactive cards", () => {
  test("choice_card maps options + multi + default id from clock", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "choice_card", prompt: "Pick", options: ["a", "b"], multi: true }],
      CLOCK
    );
    const c = msg.events[0];
    expect(c.type).toBe("choice_card");
    expect(c.options).toEqual(["a", "b"]);
    expect(c.multi).toBe(true);
    expect(c._picked).toEqual([]);
    expect(c.choiceId).toBe("choice-1700000000000");
  });

  test("action_card deep-copies args and defaults editableFields to arg keys", () => {
    const args = { ip: "1.2.3.4", note: "blocked" };
    const msg = R.buildAssistantMessage(
      [{ type: "action_card", connector: "fw", operation: "block_ip", args: args }],
      CLOCK
    );
    const a = msg.events[0];
    // No model summary -> humanized op, never the raw connector.operation id.
    expect(a.summary).toBe("Block IP");
    expect(a.args).toEqual(args);
    expect(a.args).not.toBe(args); // deep-copied, not referenced
    expect(a.editableFields).toEqual(["ip", "note"]);
    expect(a.cardId).toBe("action-1700000000000");
  });

  test("legacy action_card with no schema resolves flat text fields", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "action_card", connector: "fw", operation: "block_ip",
         args: { ip: "1.2.3.4", note: "x" }, editable_fields: ["ip", "note"] }],
      CLOCK
    );
    const card = msg.events[0];
    const fields = R.resolveActionFields(card, card.args);
    expect(fields.map((f: any) => f.name)).toEqual(["ip", "note"]);
    expect(fields.every((f: any) => f.type === "text")).toBe(true);
    expect(R.actionCardComplete(card, card.args)).toBe(true);
  });

  describe("action_card -- 2.4.0 conditional parameters (FortiGate block_ip_new)", () => {
    const EV = {
      type: "action_card",
      id: "act-block",
      connector: "fortigate-firewall",
      operation: "block_ip_new",
      summary: "Block 1.2.3.4",
      args: { method: "Quarantine Based", ip_addresses: '["1.2.3.4"]' },
      editable_fields: ["method", "ip_addresses", "time_to_live", "vdom",
        "ip_block_policy", "ip_type", "ngfw_mode", "is_new", "duration", "ip", "ip_group_name"],
      param_schema: [
        { name: "method", title: "Block Method", type: "select", required: true,
          "default": "Quarantine Based", options: ["Quarantine Based", "Policy Based"] },
        { name: "ip_addresses", title: "IP Addresses", type: "text", required: true },
        { name: "time_to_live", title: "Time to Live", type: "select", required: true,
          "default": "12 Hour", options: ["12 Hour", "Custom Time"] },
        { name: "duration", title: "Time to Live (s)", type: "integer", required: true, "default": 21600 },
        { name: "vdom", title: "VDOM", type: "text", required: false },
        { name: "ip_block_policy", title: "Policy Name", type: "text", required: true },
        { name: "ip_type", title: "IP Type", type: "select", required: true, "default": "IPv4",
          options: ["IPv4", "IPv6"] },
        { name: "ip_group_name", title: "Address Group", type: "text", required: true },
        { name: "ip", title: "IP Address", type: "text", required: true },
        { name: "ngfw_mode", title: "NGFW Mode", type: "select", required: false,
          "default": "Profile Based", options: ["Profile Based", "Policy Based"] },
        { name: "is_new", title: "Use Members API", type: "checkbox", required: false,
          "default": true, visible: false },
      ],
      visibility: {
        always: ["method"],
        when: {
          "method=Quarantine Based": ["ip_addresses", "time_to_live", "vdom"],
          "time_to_live=Custom Time": ["duration"],
          "method=Policy Based": ["ip_block_policy", "ip_type", "ngfw_mode", "is_new", "vdom"],
          "ip_type=IPv4": ["ip_group_name", "ip"],
          "ip_type=IPv6": ["ip_group_name", "ip"],
        },
      },
    };

    const card = () => R.buildAssistantMessage([JSON.parse(JSON.stringify(EV))], CLOCK).events[0];

    test("Quarantine branch shows its fields, hides Policy fields", () => {
      const c = card();
      const names = R.resolveActionFields(c, c.args).map((f: any) => f.name);
      expect(names).toEqual(["method", "ip_addresses", "time_to_live", "vdom"]);
      expect(names).not.toContain("ip_block_policy");
      expect(names).not.toContain("duration"); // time_to_live=12 Hour, not Custom
    });

    test("nested branch: time_to_live=Custom Time reveals duration", () => {
      const c = card();
      c.args.time_to_live = "Custom Time";
      const names = R.resolveActionFields(c, c.args).map((f: any) => f.name);
      expect(names).toContain("duration");
    });

    test("switching to Policy Based swaps the whole branch + recurses into ip_type", () => {
      const c = card();
      c.args.method = "Policy Based";
      const fields = R.resolveActionFields(c, c.args);
      const names = fields.map((f: any) => f.name);
      // param_schema order, filtered to the visible Policy-branch set (contract §5).
      expect(names).toEqual([
        "method", "vdom", "ip_block_policy", "ip_type", "ip_group_name", "ip", "ngfw_mode",
      ]);
      expect(names).not.toContain("ip_addresses");
      // is_new has schema visible:false -> never rendered, but default still seeded
      expect(names).not.toContain("is_new");
      expect(c.args.is_new).toBe(true);
      // ip_type default IPv4 seeded -> its children appear
      expect(c.args.ip_type).toBe("IPv4");
    });

    test("defaults seed only on first visibility, never clobber edits", () => {
      const c = card();
      c.args.method = "Policy Based";
      R.resolveActionFields(c, c.args);
      expect(c.args.ngfw_mode).toBe("Profile Based"); // seeded
      c.args.ngfw_mode = "Policy Based"; // user edit
      R.resolveActionFields(c, c.args);
      expect(c.args.ngfw_mode).toBe("Policy Based"); // not clobbered
    });

    test("Approve gating ignores hidden-branch required fields", () => {
      const c = card();
      // Quarantine branch: ip_addresses required + present, time_to_live seeded
      expect(R.actionCardComplete(c, c.args)).toBe(true);
      // Policy branch: ip_block_policy required + empty -> blocked
      c.args.method = "Policy Based";
      R.resolveActionFields(c, c.args);
      expect(R.actionCardComplete(c, c.args)).toBe(false);
      c.args.ip_block_policy = "FortiSOAR_Blocked_Policy";
      c.args.ip_group_name = "Blocked_IPs";
      c.args.ip = '["1.2.3.4"]';
      expect(R.actionCardComplete(c, c.args)).toBe(true);
    });

    test("branch label reflects the gating select", () => {
      const c = card();
      expect(R.actionCardBranchLabel(c, c.args)).toBe("Block Method: Quarantine Based");
    });
  });

  test("capability_gap maps all fields + choiceId from clock", () => {
    const msg = R.buildAssistantMessage(
      [{
        type: "capability_gap",
        id: "capgap_ip",
        missing: "ip containment",
        why: "no containment connector configured",
        fix_steps: ["Configure fortigate", "Save configuration"],
        resume: { label: "Re-check & continue", value: "recheck_containment" },
        tips: [{ text: "Keep a response connector healthy", hint: "Intel-only instances can enrich but never contain." }],
        alternatives: [{ label: "Escalate to T2", value: "escalate_t2" }],
      }],
      CLOCK
    );
    const c = msg.events[0];
    expect(c.type).toBe("capability_gap");
    expect(c.choiceId).toBe("capgap_ip");
    expect(c.missing).toBe("ip containment");
    expect(c.why).toBe("no containment connector configured");
    expect(c.fixSteps).toEqual(["Configure fortigate", "Save configuration"]);
    expect(c.resume).toEqual({ label: "Re-check & continue", value: "recheck_containment" });
    expect(c.tips).toHaveLength(1);
    expect(c.alternatives).toHaveLength(1);
    expect(c._resolved).toBe(false);
    expect(c._picked).toBeNull();
  });

  test("capability_gap uses clock-based id when no id provided", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "capability_gap", missing: "containment", fix_steps: ["step1"], resume: { label: "Re-check", value: "rv" } }],
      CLOCK
    );
    expect(msg.events[0].choiceId).toBe("capgap-1700000000000");
  });

  // C2 -- the connector may send tips/alternatives/fix_steps/resume as bare
  // strings; the template assumes object shapes, so an un-normalized value used
  // to render blank (tips/alt) or resume with `undefined` (alt with no value).
  test("C2: capability_gap normalizes bare-string tips/alternatives/fix_steps/resume", () => {
    const msg = R.buildAssistantMessage(
      [{
        type: "capability_gap",
        missing: "containment",
        fix_steps: ["Configure fortigate", { text: "Save config" }, { label: "Restart worker" }],
        resume: "recheck_now",                       // bare string
        tips: ["Keep a response connector healthy", { text: "Use T2", hint: "when unsure" }],
        alternatives: [
          "escalate_t2",                             // bare string → label+value
          { value: "notify_only" },                  // value only → label falls back to value
          { hint: "no value or label" },             // nothing usable → dropped
        ],
      }],
      CLOCK
    );
    const c: any = msg.events[0];
    // fix_steps: every entry a non-empty string
    expect(c.fixSteps).toEqual(["Configure fortigate", "Save config", "Restart worker"]);
    // resume: bare string → {label,value}
    expect(c.resume).toEqual({ label: "recheck_now", value: "recheck_now" });
    // tips: strings → {text, hint:''}; objects preserved
    expect(c.tips).toEqual([
      { text: "Keep a response connector healthy", hint: "" },
      { text: "Use T2", hint: "when unsure" },
    ]);
    // alternatives: string → label+value; value-only → label falls back; no-value dropped
    expect(c.alternatives).toEqual([
      { label: "escalate_t2", value: "escalate_t2", hint: "" },
      { label: "notify_only", value: "notify_only", hint: "" },
    ]);
  });

  test("C2: capability_gap resume defaults when missing/empty", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "capability_gap", missing: "x", resume: {} }], CLOCK);
    expect(msg.events[0].resume).toEqual({ label: "Re-check & continue", value: "recheck" });
  });

  // C1 -- an unknown info_card block kind used to collapse to an empty rows block
  // and render blank. It must now surface its content (or a raw dump) as text.
  test("C1: unknown info_card block kind with text renders as a text block, not blank", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "info_card", title: "Notice", blocks: [
        { kind: "callout", text: "heads up" },       // unknown kind, has text
        { kind: "rows", rows: [{ label: "K", value: "v" }] }, // known kind still works
      ] }],
      CLOCK
    );
    const card: any = msg.events[0];
    expect(card.blocks[0]).toEqual({ kind: "text", text: "heads up" });
    expect(card.blocks[1].kind).toBe("rows");
    expect(card.blocks[1].rows[0]).toMatchObject({ label: "K", value: "v" });
  });

  test("C1: unknown info_card block with no text is dumped, never blank", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "info_card", blocks: [{ kind: "widget", foo: 42 }] }], CLOCK);
    const blk: any = msg.events[0].blocks[0];
    expect(blk.kind).toBe("text");
    expect(blk.text).toContain("42");   // raw dump surfaces the content
    expect(blk.text).not.toBe("");
  });

  test("C1: a kind-less block that carries rows[] still renders as rows (regression)", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "info_card", blocks: [{ rows: [{ label: "A", value: "b" }] }] }], CLOCK);
    const blk: any = msg.events[0].blocks[0];
    expect(blk.kind).toBe("rows");
    expect(blk.rows[0]).toMatchObject({ label: "A", value: "b" });
  });

  test("playbook_offer maps summary + ops + seeds editable title from suggestion", () => {
    const msg = R.buildAssistantMessage(
      [{
        type: "playbook_offer",
        id: "pb-offer-1",
        summary: "Save this investigation?",
        title_suggestion: "C2 Containment",
        ops_summary: [
          { connector: "fortigate-firewall", operation: "block_ip_new", label: "Block 1.2.3.4" },
          { connector: "fortiedr", operation: "isolate_endpoint", label: "Quarantine host" },
        ],
        editable_title: true,
      }],
      CLOCK
    );
    const o = msg.events[0];
    expect(o.type).toBe("playbook_offer");
    expect(o.offerId).toBe("pb-offer-1");
    expect(o.summary).toBe("Save this investigation?");
    expect(o.opsSummary).toHaveLength(2);
    expect(o.opsSummary[0].label).toBe("Block 1.2.3.4");
    expect(o.titleSuggestion).toBe("C2 Containment");
    expect(o.title).toBe("C2 Containment"); // pre-filled so accept works untouched
    expect(o.editableTitle).toBe(true);
    expect(o._resolved).toBe(false);
  });

  test("playbook_offer humanizes an op label when none is given + defaults id from clock", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "playbook_offer", summary: "s", ops_summary: [{ connector: "fw", operation: "block" }] }],
      CLOCK
    );
    const o = msg.events[0];
    expect(o.offerId).toBe("pb-offer-1700000000000");
    // Analyst-facing: the humanized operation, never the raw "fw.block" id.
    expect(o.opsSummary[0].label).toBe("Block");
  });

  test("playbook_offer honors editable_title:false", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "playbook_offer", summary: "s", ops_summary: [], editable_title: false }],
      CLOCK
    );
    expect(msg.events[0].editableTitle).toBe(false);
  });

  test("playbook_offer 2.6.0: no enrichment => hasDraft false (flat fallback)", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "playbook_offer", summary: "s",
         ops_summary: [{ connector: "fw", operation: "block", label: "Block" }] }],
      CLOCK
    );
    const o = msg.events[0];
    expect(o.hasDraft).toBe(false);
    expect(o.draftSteps).toEqual([]);
    // per-entry 2.6.0 fields default safely on a pre-2.6.0 entry
    expect(o.opsSummary[0].verified).toBe(false);
    expect(o.opsSummary[0].hasVerified).toBe(false);
    expect(o.opsSummary[0].needsInput).toBe(false);
    expect(o.opsSummary[0].wiringLabel).toBe("");
  });

  test("playbook_offer 2.6.0: enriches ops_summary entries (skill/step/wiring/verified/branch)", () => {
    const msg = R.buildAssistantMessage(
      [{
        type: "playbook_offer", summary: "s",
        ops_summary: [{
          connector: "fortigate-firewall", operation: "block_ip_new", label: "Block",
          skill_id: "block_ip", step_type: "connector",
          wiring_label: "uses the IP from Enrich Indicator", verified: true, branch: "if malicious",
        }],
      }],
      CLOCK
    );
    const op = msg.events[0].opsSummary[0];
    expect(op.skillId).toBe("block_ip");
    expect(op.stepType).toBe("connector");
    expect(op.wiringLabel).toBe("uses the IP from Enrich Indicator");
    expect(op.verified).toBe(true);
    expect(op.hasVerified).toBe(true);
    expect(op.needsInput).toBe(false);
    expect(op.branch).toBe("if malicious");
    expect(op.icon).toBeTruthy();
    // enriched ops with no draft_steps still produce a flat node list
    expect(msg.events[0].hasDraft).toBe(true);
    expect(msg.events[0].draftSteps[0]).toEqual({ kind: "node", node: "Block", row: op });
  });

  test("playbook_offer 2.6.0: verified:false => needsInput gap (manual_input prompt)", () => {
    const msg = R.buildAssistantMessage(
      [{
        type: "playbook_offer", summary: "s",
        ops_summary: [{
          connector: "fortiedr", operation: "isolate_endpoint", label: "Quarantine smithDesktop",
          skill_id: "isolate_host", step_type: "connector",
          wiring_label: "host could not be auto-wired", verified: false,
        }],
      }],
      CLOCK
    );
    const op = msg.events[0].opsSummary[0];
    expect(op.verified).toBe(false);
    expect(op.needsInput).toBe(true);
    expect(op.promptDraft).toBe("");
  });

  test("playbook_offer 2.6.0: joins draft_steps tree (node + branches) to ops rows", () => {
    const msg = R.buildAssistantMessage(
      [{
        type: "playbook_offer", summary: "s",
        ops_summary: [
          { connector: "vt", operation: "rep", label: "Enrich", step_type: "connector", verified: true, wiring_label: "uses the IP" },
          { connector: "fw", operation: "block", label: "Block", step_type: "connector", verified: true, branch: "if malicious" },
          { connector: "edr", operation: "iso", label: "Quarantine", step_type: "connector", verified: false, branch: "if malicious" },
          { connector: "fsr", operation: "tkt", label: "Ticket", step_type: "connector", verified: true, branch: "else" },
        ],
        draft_steps: [
          { node: "Enrich", step_type: "connector", verified: true },
          { node: "Malicious?", step_type: "decision", verified: true, branches: {
            "if malicious": ["Block", "Quarantine"],
            "else": ["Ticket"],
          } },
        ],
      }],
      CLOCK
    );
    const o = msg.events[0];
    expect(o.hasDraft).toBe(true);
    expect(o.draftSteps).toHaveLength(2);

    const [enrich, fork] = o.draftSteps;
    expect(enrich.kind).toBe("node");
    expect(enrich.row.label).toBe("Enrich");
    expect(enrich.row.wiringLabel).toBe("uses the IP"); // joined from ops_summary
    expect(enrich.row.icon).toBeTruthy();

    expect(fork.kind).toBe("fork");
    expect(fork.node).toBe("Malicious?");
    expect(fork.branches).toHaveLength(2);
    expect(fork.branches[0].key).toBe("if malicious");
    expect(fork.branches[0].keyDraft).toBe("if malicious"); // editable mirror
    expect(fork.branches[0].rows.map((r: any) => r.label)).toEqual(["Block", "Quarantine"]);
    // the fork child row is the SAME object as the ops_summary entry (shared ref)
    expect(fork.branches[0].rows[1]).toBe(o.opsSummary[2]);
    expect(fork.branches[0].rows[1].needsInput).toBe(true); // verified:false gap
    expect(fork.branches[1].rows.map((r: any) => r.label)).toEqual(["Ticket"]);
  });

  test("emit_* tool_use/result pairs are suppressed (card event renders instead)", () => {
    const msg = R.buildAssistantMessage(
      [
        { type: "tool_use", id: "tu_em1", name: "emit_capability_gap_card", input: {} },
        { type: "tool_result", tool_use_id: "tu_em1", content: '{"ok":true}' },
        { type: "capability_gap", id: "capgap_ip", missing: "containment",
          fix_steps: ["step"], resume: { label: "Re-check", value: "rv" } },
      ],
      CLOCK
    );
    expect(msg.events).toHaveLength(1);
    expect(msg.events[0].type).toBe("capability_gap");
  });

  test("suggested_card and message are stripped from tool result display", () => {
    const result = {
      ok: true, target_type: "ip", actions: [], count: 0,
      suggested_card: { id: "capgap_ip", missing: "ip containment" },
      message: "Don't dead-end the analyst: call emit_capability_gap_card",
    };
    const msg = R.buildAssistantMessage(
      [
        { type: "tool_use", id: "tu1", name: "find_containment_actions", input: {} },
        { type: "tool_result", tool_use_id: "tu1", content: JSON.stringify(result) },
      ],
      CLOCK
    );
    const display = JSON.parse(msg.events[0].resultDisplay);
    expect(display.suggested_card).toBeUndefined();
    expect(display.message).toBeUndefined();
    expect(display.ok).toBe(true);
    expect(display.count).toBe(0);
  });

  test("emit_choice_card tool_use/result is suppressed alongside its card", () => {
    const msg = R.buildAssistantMessage(
      [
        { type: "tool_use", id: "tu_ch1", name: "emit_choice_card", input: {} },
        { type: "tool_result", tool_use_id: "tu_ch1", content: '{"ok":true}' },
        { type: "choice_card", id: "c1", prompt: "Pick", options: [] },
      ],
      CLOCK
    );
    expect(msg.events).toHaveLength(1);
    expect(msg.events[0].type).toBe("choice_card");
  });

  test("manual_input seeds field values from defaults", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "manual_input", question: "q", fields: [{ name: "a", default: "x" }, { name: "b" }] }],
      CLOCK
    );
    expect(msg.events[0].values).toEqual({ a: "x", b: "" });
  });

  test("error event renders the clean message, not the raw JSON envelope", () => {
    const msg = R.buildAssistantMessage([{ type: "error", message: "boom" }], CLOCK);
    expect(msg.events[0].type).toBe("error");
    // The analyst sees the human message, shown (not hidden behind a JSON blob).
    expect(msg.events[0].display).toContain("boom");
    expect(msg.events[0].display).not.toContain("{");
    expect(msg.events[0]._open).toBe(true);
  });

  test("usage events are absorbed, never rendered inline", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "text", text: "hi" }, { type: "usage", input_tokens: 5, output_tokens: 7 }],
      CLOCK
    );
    expect(msg.events).toHaveLength(0);
  });
});

describe("buildAssistantMessage -- card attribution (preceding_tool_use_id)", () => {
  test("action_card ties to the matching tool_call (both flagged, order unchanged)", () => {
    const msg = R.buildAssistantMessage(
      [
        { type: "tool_use", id: "tu1", name: "find_containment_actions", input: {} },
        { type: "tool_result", tool_use_id: "tu1", content: '{"ok":true}' },
        { type: "action_card", connector: "fw", operation: "block_ip",
          args: { ip: "1.2.3.4" }, preceding_tool_use_id: "tu1" },
      ],
      CLOCK
    );
    expect(msg.events).toHaveLength(2); // tool_call + card, flat order preserved
    expect(msg.events[0].type).toBe("tool_call");
    expect((msg.events[0] as any)._hasAttachedCard).toBe(true);
    expect(msg.events[1].type).toBe("action_card");
    expect((msg.events[1] as any)._attachedToToolCall).toBe(true);
  });

  test("capability_gap with no preceding_tool_use_id renders standalone (no flags set)", () => {
    const msg = R.buildAssistantMessage(
      [
        { type: "tool_use", id: "tu1", name: "find_containment_actions", input: {} },
        { type: "tool_result", tool_use_id: "tu1", content: '{"ok":true}' },
        { type: "capability_gap", missing: "ip containment",
          fix_steps: ["step"], resume: { label: "Re-check", value: "rv" } },
      ],
      CLOCK
    );
    expect((msg.events[0] as any)._hasAttachedCard).toBeUndefined();
    expect((msg.events[1] as any)._attachedToToolCall).toBeUndefined();
  });

  test("preceding_tool_use_id with no matching tool_call is a silent no-op (older/legacy transcript)", () => {
    const msg = R.buildAssistantMessage(
      [
        { type: "playbook_offer", summary: "s", ops_summary: [],
          preceding_tool_use_id: "does-not-exist" },
      ],
      CLOCK
    );
    expect(msg.events).toHaveLength(1);
    expect(msg.events[0].type).toBe("playbook_offer");
    expect((msg.events[0] as any)._attachedToToolCall).toBeUndefined();
  });

  test("choice_card, manual_input, and info_card all attach via the same mechanism", () => {
    const base = [
      { type: "tool_use", id: "tu1", name: "search_module_records", input: {} },
      { type: "tool_result", tool_use_id: "tu1", content: '{"ok":true}' },
    ];
    const cases: Array<[string, any]> = [
      ["choice_card", { type: "choice_card", prompt: "Pick", options: [], preceding_tool_use_id: "tu1" }],
      ["manual_input", { type: "manual_input", question: "q", fields: [], preceding_tool_use_id: "tu1" }],
      ["info_card", { type: "info_card", title: "T", blocks: [], preceding_tool_use_id: "tu1" }],
    ];
    for (const [type, cardEv] of cases) {
      const msg = R.buildAssistantMessage([...base, cardEv], CLOCK);
      expect((msg.events[0] as any)._hasAttachedCard).toBe(true);
      expect(msg.events[1].type).toBe(type === "info_card" ? "info_card" : type);
      expect((msg.events[1] as any)._attachedToToolCall).toBe(true);
    }
  });
});

describe("normalizeInfoCard / normalizeBlocks / normalizeSeverity", () => {
  test("status_card summary+details collapse into text + rows blocks", () => {
    const card = R.normalizeInfoCard(
      { type: "status_card", summary: "done", details: [{ label: "K", value: "v" }] },
      CLOCK
    );
    expect(card.type).toBe("info_card");
    expect(card.blocks.map((b: any) => b.kind)).toEqual(["text", "rows"]);
    expect(card.blocks[1].rows[0]).toEqual({ label: "K", value: "v", severity: null });
  });

  test("info_card passes blocks through normalized, defaulting severity to info", () => {
    const card = R.normalizeInfoCard(
      { type: "info_card", title: "T", blocks: [{ kind: "tags", tags: ["a", { label: "b", severity: "error" }] }] },
      CLOCK
    );
    expect(card.severity).toBe("info");
    expect(card.blocks[0].tags).toEqual([
      { label: "a", severity: null },
      { label: "b", severity: "error" },
    ]);
  });

  test("score block clamps pct into 0..100", () => {
    const [block] = R.normalizeBlocks([{ kind: "score", label: "risk", value: 200, max: 100 }]);
    expect(block.pct).toBe(100);
  });

  test("unknown block kind defaults to rows", () => {
    const [block] = R.normalizeBlocks([{ kind: "frobnicate", rows: [{ label: "x", value: "y" }] }]);
    expect(block.kind).toBe("rows");
  });

  test("link block keeps root-relative + http(s) urls (e.g. saved playbook designer link)", () => {
    const [rel] = R.normalizeBlocks([{ kind: "link", label: "Open in Playbook Designer", url: "/playbooks/abc-123" }]);
    expect(rel).toEqual({ kind: "link", label: "Open in Playbook Designer", url: "/playbooks/abc-123" });
    const [abs] = R.normalizeBlocks([{ kind: "link", label: "Docs", url: "https://x/y" }]);
    expect(abs.url).toBe("https://x/y");
  });

  test("link block drops unsafe/protocol-relative urls to a plain label", () => {
    const [js] = R.normalizeBlocks([{ kind: "link", label: "x", url: "javascript:alert(1)" }]);
    expect(js.url).toBe("");
    const [proto] = R.normalizeBlocks([{ kind: "link", label: "x", url: "//evil.example" }]);
    expect(proto.url).toBe("");
  });

  test("normalizeSeverity allowlists known buckets only", () => {
    expect(R.normalizeSeverity("error")).toBe("error");
    expect(R.normalizeSeverity("critical")).toBeNull();
    expect(R.normalizeSeverity(undefined)).toBeNull();
  });

  test("severity_label is surfaced for the badge", () => {
    const card = R.normalizeInfoCard(
      { type: "info_card", severity: "error", severity_label: "Critical", title: "x" },
      CLOCK
    );
    expect(card.severity).toBe("error");
    expect(card.severityLabel).toBe("Critical");
  });
});

describe("inferToolStatus + seedFieldValues", () => {
  test.each([
    ['{"status":"success"}', "success"],
    ['{"ok":true}', "success"],
    ['{"status":"failed"}', "error"],
    ['{"ok":false}', "error"],
    ['{"error":"x"}', "error"],
    ['{"data":[]}', "ok"],
    ["", "unknown"],
    [null, "unknown"],
  ])("inferToolStatus(%p) === %p", (input, expected) => {
    expect(R.inferToolStatus(input)).toBe(expected);
  });

  // A guard is the framework REFUSING a pointless call, not a failed one. It
  // ships `ok:false` + `error` so the model treats it as terminal, which made
  // it indistinguishable from a real error to the renderer: a live GA session
  // showed 7 red ERROR badges of which 2 were guards working as designed.
  // These must classify as `guard` even though they match the error patterns.
  test.each([
    ['{"ok":false,"repeated_call_guard":true,"error":"already failed"}'],
    ['{"ok":false,"call_once_guard":true,"error":"STOP calling"}'],
    ['{"ok":false,"kind":"guard_redirect","error":"STOP calling"}'],
    ['{"ok":false,"forbidden_pivot_guard":true,"error":"no"}'],
    ['{"ok":false,"hunt_floor_guard":true,"error":"hunt first"}'],
  ])("guard result %p classifies as guard, not error", (input) => {
    expect(R.inferToolStatus(input)).toBe("guard");
  });

  // A playbook paused on a manual-input step returns `ok:false` + a benign
  // `code:"awaiting_input"` -- a resumable WAIT, not a failure. It must read as
  // `awaiting` (amber "waiting" chip), not a red ERROR, even though `ok:false`
  // matches the error pattern. Same rationale as the guard branch above.
  test.each([
    ['{"ok":false,"code":"awaiting_input","run_pk":"2971"}'],
    ['{"ok":false,"status":"awaiting","run_pk":"2971"}'],
  ])("awaiting-input pause %p classifies as awaiting, not error", (input) => {
    expect(R.inferToolStatus(input)).toBe("awaiting");
  });

  test("a real failure is still an error, not a guard", () => {
    expect(
      R.inferToolStatus('{"ok":false,"code":"op_request_rejected","message":"HTTP 400"}')
    ).toBe("error");
    // A guard KEY that is not actually set must not launder a real error.
    expect(
      R.inferToolStatus('{"ok":false,"repeated_call_guard":false,"error":"real"}')
    ).toBe("error");
  });

  test("seedFieldValues uses default when present, else empty string", () => {
    expect(R.seedFieldValues([{ name: "a", default: 0 }, { name: "b" }])).toEqual({ a: 0, b: "" });
    expect(R.seedFieldValues(null)).toEqual({});
  });
});

// B0 (docs/plans/agentic-assistant-ui-gaps.md): every timeline event gets a STABLE,
// unique `_key` so the ng-repeat can `track by ev._key` instead of the old
// `(ev._toolUseId || $index)` -- positional keys let a card's DOM node get reused
// for a different event as the streaming preview rebuilds each ~700ms poll, so an
// info_card visually overwrote another tool/slot.
describe("buildAssistantMessage -- stable per-event keys (B0)", () => {
  const STREAM = { now: () => 1700000000000, collapseThreshold: 600, interleaveText: true };

  test("every event has a unique _key; tool_calls key on their id", () => {
    const msg = R.buildAssistantMessage(
      [
        { type: "tool_use", id: "tu_1", name: "search", input: {} },
        { type: "tool_result", tool_use_id: "tu_1", content: '{"ok":true}' },
        { type: "info_card", title: "Enrichment", blocks: [{ kind: "text", text: "hi" }] },
        { type: "tool_use", id: "tu_2", name: "lookup", input: {} },
      ],
      STREAM
    );
    const keys = msg.events.map((e: any) => e._key);
    expect(new Set(keys).size).toBe(keys.length); // all unique
    expect(msg.events.find((e: any) => e._toolUseId === "tu_1")._key).toBe("tu:tu_1");
    expect(msg.events.find((e: any) => e.type === "info_card")._key).toBe("info_card:1");
  });

  test("an info_card's _key is STABLE when a later frame is appended (the overwrite fix)", () => {
    const base = [
      { type: "tool_use", id: "tu_1", name: "search", input: {} },
      { type: "tool_result", tool_use_id: "tu_1", content: '{"ok":true}' },
      { type: "info_card", id: "ic-x", title: "Enrichment", blocks: [] },
    ];
    const firstPoll = R.buildAssistantMessage(base, STREAM);
    // Next ~700ms poll rebuilds from the SAME frames plus a newly-streamed tool.
    const secondPoll = R.buildAssistantMessage(
      base.concat([{ type: "tool_use", id: "tu_2", name: "lookup", input: {} } as any]),
      STREAM
    );
    const k1 = firstPoll.events.find((e: any) => e.type === "info_card")._key;
    const k2 = secondPoll.events.find((e: any) => e.type === "info_card")._key;
    expect(k2).toBe(k1); // card keeps its identity across the rebuild
  });

  test("two idless info_cards get distinct stable keys, and a volatile card- id is pinned to the key", () => {
    const msg = R.buildAssistantMessage(
      [
        { type: "info_card", title: "A", blocks: [] },
        { type: "info_card", title: "B", blocks: [] },
      ],
      STREAM
    );
    const cards = msg.events.filter((e: any) => e.type === "info_card");
    expect(cards.map((c: any) => c._key)).toEqual(["info_card:1", "info_card:2"]);
    // idless card ids were `card-<now>` (identical + volatile); now pinned to the key.
    expect(cards[0].cardId).toBe("info_card:1");
    expect(cards[1].cardId).toBe("info_card:2");
    expect(cards[0].cardId).not.toBe(cards[1].cardId);
  });

  test("a connector-supplied info_card id is preserved (only card-<n> autogen is pinned)", () => {
    const msg = R.buildAssistantMessage(
      [{ type: "info_card", id: "enrich-42", title: "A", blocks: [] }],
      STREAM
    );
    expect(msg.events[0].cardId).toBe("enrich-42");
    expect(msg.events[0]._key).toBe("info_card:1");
  });
});
