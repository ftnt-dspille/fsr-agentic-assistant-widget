"use strict";

// Live, a severity change staged a card that printed four ids to the analyst:
// the title "Update alerts/e94dc2dc", the module key "alerts", the record's full
// uuid, and the new value as "/api/3/picklists/<uuid>". Its tool row meanwhile
// read "Updated the record" with a "running" chip, while nothing had run.
//
// The connector now resolves labels and titles. These cover the widget's half:
// what it prints, including from an older connector that still sends ids.

const fs = require("fs");
const path = require("path");
const R = require("../widget/widgetAssets/js/fsrPbRender.js");
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };

const ALERT = "e94dc2dc-23c0-4b8f-a13f-02a1bb147c5f";
const PICK = "58d0753f-f7e4-403b-953c-b0f521eab759";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function msg(extra, before) {
  return R.buildAssistantMessage((before || []).concat([Object.assign({
    type: "action_card", id: "card-1", connector: "", operation: "",
    args: { severity: `/api/3/picklists/${PICK}` },
  }, extra)]), OPTS);
}
const cardOf = (m) => m.events.find((e) => e.type === "action_card");

// Every string the record-write block prints from the card.
function printed(c) {
  const out = [c.summary, c.target && c.target.label, c.target && c.target.name];
  (c.changes || []).forEach((ch) => out.push(JSON.stringify(ch.before), JSON.stringify(ch.after)));
  return out.filter((x) => x != null).join(" | ");
}

describe("an older connector's ids never reach the analyst", () => {
  const OLD = {
    summary: "Update alerts/e94dc2dc",
    target: { module: "alerts", uuid: ALERT, name: "High Severity IPS Exploit" },
    changes: [{ field: "severity", before: "High", after: `/api/3/picklists/${PICK}` },
              { field: "owner", before: `/api/3/people/${ALERT}`, after: "Analyst One" }],
  };

  test.each([
    ["the title", (c) => c.summary],
    ["the target label", (c) => c.target.label],
    ["every change value", (c) => c.changes.map((x) => `${x.before} ${x.after}`).join(" ")],
  ])("%s carries no uuid, short id or IRI", (_name, pick) => {
    const s = pick(cardOf(msg(OLD)));
    expect(s).not.toMatch(UUID_RE);
    expect(s).not.toMatch(/\/[0-9a-f]{8}\b/);
    expect(s).not.toContain("/api/3/");
  });

  test("the values say what kind of value they are", () => {
    const c = cardOf(msg(OLD));
    expect(c.summary).toBe("Update this alert");
    expect(c.target.label).toBe("Alert");
    expect(c.changes[0]).toMatchObject({ before: "High", after: "an unknown picklist option" });
    expect(c.changes[1]).toMatchObject({ before: "an unknown related record", after: "Analyst One" });
  });

  test("the args that execute keep the IRI", () => {
    expect(cardOf(msg(OLD)).args).toEqual({ severity: `/api/3/picklists/${PICK}` });
  });
});

describe("a resolved card from a current connector prints as sent", () => {
  test("labels, module_label and plain values pass through", () => {
    const c = cardOf(msg({
      summary: "Update alert: High Severity IPS Exploit",
      target: { module: "alerts", module_label: "Alert", uuid: ALERT, name: "High Severity IPS Exploit" },
      changes: [{ field: "severity", before: "High", after: "Low" },
                { field: "tags", after: ["a", "b"] }],
    }));
    expect(c.summary).toBe("Update alert: High Severity IPS Exploit");
    expect(c.target.label).toBe("Alert");
    expect(c.changes.map((x) => x.after)).toEqual(["Low", ["a", "b"]]);
    expect(printed(c)).not.toMatch(UUID_RE);
  });

  test("text that only looks like a path is left alone", () => {
    const c = cardOf(msg({ summary: "Block 198.51.100.1/32 and/or deny" }));
    expect(c.summary).toBe("Block 198.51.100.1/32 and/or deny");
  });
});

describe("a call parked on an action card reads as a proposal", () => {
  const TOOL = [{ type: "tool_use", id: "tu-1", name: "update_record", input: {} }];

  test("the tool row is tied to the card and gets a proposal label", () => {
    const m = msg({ preceding_tool_use_id: "tu-1" }, TOOL);
    const call = m.events.find((e) => e.type === "tool_call");
    expect(call._awaitsCardId).toBe("card-1");
    expect(call.proposedLabel).toBe("Proposed a record update");
    expect(call.resultStatus).toBe("pending");
  });

  test("a card not tied to a call leaves the row alone", () => {
    const m = msg({}, TOOL);
    const call = m.events.find((e) => e.type === "tool_call");
    expect(call._awaitsCardId).toBeUndefined();
  });
});

describe("the template prints labels, not ids", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "widget", "view.html"), "utf8");
  test("the target line prints label and name, never module or uuid", () => {
    const block = html.slice(html.indexOf('class="write-target"'), html.indexOf("write-context-warn", html.indexOf('class="write-target"')));
    expect(block).toContain("{{ev.target.label}}");
    expect(block).not.toContain("{{ev.target.module}}");
    expect(block).not.toContain("{{ev.target.uuid}}");
  });
  test("the tool row swaps to the proposal while its card waits", () => {
    expect(html).toContain("toolCardDecision(ev, msg) ? ev.proposedLabel");
    expect(html).toContain("toolCardDecision(ev, msg) ? toolDecisionChip(toolCardDecision(ev, msg))");
  });
});

describe("a record-write title keeps its dots", () => {
  test("an IP in the title survives (no connector.operation to rewrite)", () => {
    const c = cardOf(msg({ summary: "Update alert: IPS Exploit from 198.51.100.2 to 173.243.138.31" }));
    expect(c.summary).toBe("Update alert: IPS Exploit from 198.51.100.2 to 173.243.138.31");
  });
});
