"use strict";

// ─── Contract completeness guard ─────────────────────────────────────────────
//
// This is the test that would have caught `playbook_offer` shipping unrendered.
// It enumerates EVERY transcript event type (contract §5) and EVERY terminal
// `stop_reason` (contract §3) and asserts the widget actually handles each one —
// the render pipeline maps every gating/display card to a known render event,
// and the controller exposes a resume handler for every `awaiting_*` card.
//
// It is intentionally a hard-coded checklist, not a passive replay: when the
// contract bumps and adds an event type or stop_reason, THIS test must be
// updated (add the case), which forces a conscious "did the widget implement
// it?" review instead of the gap slipping through silently.

const fs = require("fs");
const path = require("path");
const R = require("../widget/widgetAssets/js/fsrPbRender.js");

const CLOCK = { now: () => 1700000000000, collapseThreshold: 600 };
const WIDGET_DIR = path.resolve(__dirname, "../widget");
const CONTRACT_MD = path.resolve(
  __dirname,
  "../../../fortisoar-widget-harness/FSR_PLAYBOOK_BUILDER_CONNECTOR_CONTRACT.md"
);
// The contract markdown was dropped in the backend repo reorg and not migrated
// here. The tests that cross-check the widget against the *checklist* (event
// types, awaiting_* handlers, version pin) still run — those guard real widget
// behaviour. Only the three checks that parse the contract DOCUMENT itself are
// gated on the file's presence, so its absence reports as a clear SKIP (infra
// gap) instead of a perma-red that hides genuine regressions. They auto-re-arm
// the moment the doc is restored at this path.
const HAVE_CONTRACT = fs.existsSync(CONTRACT_MD);
const contractTest = HAVE_CONTRACT ? test : test.skip;
if (!HAVE_CONTRACT) {
  // eslint-disable-next-line no-console
  console.warn(
    "[contract.completeness] SKIP doc cross-checks — contract markdown not found at "
    + CONTRACT_MD + " (reorg gap; restore it to re-enable).");
}

// One representative payload per contract §5 event type, plus how the render
// pipeline is expected to surface it:
//   render:  buildAssistantMessage emits exactly one event of `type`
//   absorbed: intentionally NOT rendered inline (usage → topbar meter)
//   text:    folds into msg.text (or an interleaved text event)
const EVENT_CASES = [
  { type: "text", payload: { type: "text", text: "hi" }, expect: "text" },
  { type: "tool_use", payload: { type: "tool_use", id: "tu1", name: "run_op", input: {} }, expect: "render", as: "tool_call" },
  { type: "tool_result", payload: { type: "tool_result", tool_use_id: "tu1", tool: "run_op", content: "{}" }, expect: "render", as: "tool_call" },
  { type: "choice_card", payload: { type: "choice_card", id: "c1", prompt: "p", options: [] }, expect: "render", as: "choice_card" },
  { type: "capability_gap", payload: { type: "capability_gap", id: "g1", missing: "x", fix_steps: ["s"], resume: { label: "r", value: "v" } }, expect: "render", as: "capability_gap" },
  { type: "action_card", payload: { type: "action_card", id: "a1", connector: "fw", operation: "block_ip", summary: "s", args: { ip: "1.1.1.1" }, editable_fields: ["ip"] }, expect: "render", as: "action_card" },
  { type: "manual_input", payload: { type: "manual_input", id: "m1", question: "q", fields: [] }, expect: "render", as: "manual_input" },
  { type: "playbook_offer", payload: { type: "playbook_offer", id: "o1", summary: "s", ops_summary: [{ connector: "fw", operation: "block", label: "b" }] }, expect: "render", as: "playbook_offer" },
  { type: "info_card", payload: { type: "info_card", id: "i1", title: "t", blocks: [] }, expect: "render", as: "info_card" },
  { type: "status_card", payload: { type: "status_card", id: "s1", title: "t", summary: "x" }, expect: "render", as: "info_card" },
  { type: "ioc_card", payload: { type: "ioc_card", id: "ic1", title: "t", blocks: [] }, expect: "render", as: "info_card" },
  { type: "activity", payload: { type: "activity", phase: "classify", message: "Classified as C2/exfil" }, expect: "render", as: "activity" },
  { type: "usage", payload: { type: "usage", input_tokens: 1, output_tokens: 2 }, expect: "absorbed" },
  { type: "error", payload: { type: "error", message: "boom" }, expect: "render", as: "error" },
  { type: "approval_request", payload: { type: "approval_request", tool: "run_op", args: {} }, expect: "render", as: "approval_request" },
];

// Every `awaiting_*` stop_reason (contract §3) pairs with a gating card the
// analyst resolves via a $scope handler. We assert the controller source wires
// a handler for each (a structural grep — cheap and version-stable).
const AWAITING_HANDLERS = [
  { stop_reason: "awaiting_choice", handlers: ["pickChoice", "submitMultiChoice", "resumeCapabilityGap"] },
  { stop_reason: "awaiting_action_card", handlers: ["confirmActionCard", "cancelActionCard"] },
  { stop_reason: "awaiting_manual_input", handlers: ["submitManualInput", "rejectManualInput"] },
  { stop_reason: "awaiting_playbook_offer", handlers: ["acceptPlaybookOffer", "declinePlaybookOffer"] },
];

describe("contract completeness — every §5 event type renders", () => {
  test("each event type maps to its expected render surface (none silently dropped)", () => {
    const failures = [];
    for (const c of EVENT_CASES) {
      const msg = R.buildAssistantMessage([JSON.parse(JSON.stringify(c.payload))], CLOCK);
      const inlineTypes = (msg.events || []).map((e) => e.type);
      if (c.expect === "render") {
        if (!inlineTypes.includes(c.as)) {
          failures.push(`${c.type}: expected a "${c.as}" render event, got [${inlineTypes.join(",") || "none"}] — UNHANDLED EVENT TYPE`);
        }
      } else if (c.expect === "absorbed") {
        if (inlineTypes.length !== 0) failures.push(`${c.type}: expected absorption (0 inline events), got [${inlineTypes.join(",")}]`);
      } else if (c.expect === "text") {
        if (msg.text !== "hi") failures.push(`${c.type}: expected text fold into msg.text, got "${msg.text}"`);
      }
    }
    expect(failures).toEqual([]);
  });

  contractTest("the checklist covers exactly the event types the contract documents", () => {
    // Parse the §5 event-type headings out of the contract markdown so a NEW
    // event type added to the contract (a new `### \`foo\`` heading) trips this
    // test until someone adds it to EVENT_CASES above.
    const md = fs.readFileSync(CONTRACT_MD, "utf8");
    const section = md.split("## 5.")[1].split("\n## ")[0];
    const documented = new Set();
    const re = /^###\s+`([a-z_]+)`/gm;
    let m;
    while ((m = re.exec(section)) !== null) documented.add(m[1]);
    // `tool_use`/`tool_result` share one heading; ensure both are in our list.
    const covered = new Set(EVENT_CASES.map((c) => c.type));
    const missing = [...documented].filter((t) => !covered.has(t));
    expect({ documented: [...documented].sort(), missing }).toEqual({
      documented: [...documented].sort(),
      missing: [],
    });
  });
});

describe("contract completeness — every awaiting_* stop_reason has a resume handler", () => {
  const ctrlSrc = fs.readFileSync(path.join(WIDGET_DIR, "view.controller.js"), "utf8");

  test.each(AWAITING_HANDLERS)("$stop_reason wires its handlers", ({ handlers }) => {
    const missing = handlers.filter((h) => !new RegExp(`\\$scope\\.${h}\\s*=`).test(ctrlSrc));
    expect(missing).toEqual([]);
  });

  contractTest("the awaiting_* checklist matches the stop_reasons the contract documents", () => {
    const md = fs.readFileSync(CONTRACT_MD, "utf8");
    // The stop_reason table in §3 lists each terminal reason in a `| ` cell.
    const documented = new Set();
    const re = /^\|\s*`(awaiting_[a-z_]+)`/gm;
    let m;
    while ((m = re.exec(md)) !== null) documented.add(m[1]);
    const covered = new Set(AWAITING_HANDLERS.map((a) => a.stop_reason));
    const missing = [...documented].filter((s) => !covered.has(s));
    expect({ documented: [...documented].sort(), missing }).toEqual({
      documented: [...documented].sort(),
      missing: [],
    });
  });
});

describe("contract completeness — widget version tracks the contract header", () => {
  contractTest("WIDGET_CONTRACT_VERSION matches the contract file's declared version", () => {
    const ctrlSrc = fs.readFileSync(path.join(WIDGET_DIR, "view.controller.js"), "utf8");
    const md = fs.readFileSync(CONTRACT_MD, "utf8");
    const widgetV = (ctrlSrc.match(/WIDGET_CONTRACT_VERSION\s*=\s*'([\d.]+)'/) || [])[1];
    const contractV = (md.match(/\*\*Contract version:?\s*`([\d.]+)`/) || [])[1];
    expect(widgetV).toBe(contractV);
  });
});
