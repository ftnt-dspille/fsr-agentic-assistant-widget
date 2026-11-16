/**
 * A tool row's heading says what the call did. It used to read "Used tool
 * search_module_records" -- the model's function name, not the analyst's words.
 */
const R = require("../widget/widgetAssets/js/fsrPbRender");

describe("toolCallLabel", () => {
  test.each([
    ["run_op", { connector: "fortisiem", operation: "query_events" }, "Ran fortisiem: query events"],
    ["execute_action", { connector: "fortigate-firewall", operation: "block_ip_new" }, "Ran fortigate-firewall: block ip new"],
    ["search_module_records", { module: "indicators", search: "198.51.100.9" }, "Searched indicators for 198.51.100.9"],
    ["search_module_records", {}, "Searched records"],
    ["search_module_records", { module: "alerts", q: "198.51.100.11" }, "Searched alerts for 198.51.100.11"],
    ["get_record", { module: "assets", uuid: "x" }, "Read a record from assets"],
    ["get_record", {}, "Read the record"],
    ["run_playbook", { playbook: "Synch Device" }, 'Started playbook "Synch Device"'],
    ["run_playbook", {}, "Started a playbook"],
    ["find", { kind: "containment_action", query: "ip" }, "Looked up containment action: ip"],
    ["verify_enhancement", {}, "Checked the edit"],
    ["fortisiem.run_query", {}, "fortisiem: run query"],
    ["find_jinja_filter", {}, "Find jinja filter"],
    ["mcp_soc__get_alert", {}, "SOC Framework: get alert"],
    ["mcp_soc__update_alert_ai_analysis", {}, "SOC Framework: update alert AI analysis"],
    ["mcp_fortisiem__run_query", {}, "FortiSIEM: run query"],
    ["mcp_connector:aws__list_instances", {}, "aws: list instances"],
    ["mcp_newserver__do_thing", {}, "newserver: do thing"],
  ])("%s %j -> %s", (name, input, want) => {
    expect(R.toolCallLabel(name, input)).toBe(want);
  });

  // Live shapes. run_op's argument is `op`; the cases above use `operation`,
  // which only execute_action sends, so every live connector call read "Run op".
  test("a live run_op names the connector and the operation", () => {
    const live = { connector: "fortinet-fortiedr", op: "get_collector_list", params: { ips: "192.0.2.39" } };
    expect(R.toolCallLabel("run_op", live)).toBe("Ran fortinet-fortiedr: get collector list");
  });

  test("the connector's label names a tool the local table never heard of", () => {
    expect(R.toolCallLabel("edr_host", { host: "The-Flame" }, "Checked the host in FortiEDR"))
      .toBe("Checked the host in FortiEDR");
    // Without one, the raw name is all there is: what the analyst saw live.
    expect(R.toolCallLabel("edr_host", { host: "The-Flame" })).toBe("Edr host");
  });

  test("argument-aware labels still beat the connector's static one", () => {
    expect(R.toolCallLabel("get_record", { module: "assets" }, "Read the record"))
      .toBe("Read a record from assets");
  });

  test("the rendered row takes the label off the tool_use frame", () => {
    const msg = R.buildAssistantMessage([
      { type: "tool_use", id: "e", name: "edr_host", input: { host: "The-Flame" },
        label: "Checked the host in FortiEDR" },
    ], { now: () => 1 });
    expect(msg.events[0]).toMatchObject({ name: "edr_host", label: "Checked the host in FortiEDR" });
  });

  test("an unknown or missing name still reads as words", () => {
    expect(R.toolCallLabel("")).toBe("Tool call");
    expect(R.toolCallLabel(undefined)).toBe("Tool call");
  });

  test("a long argument is clipped, never a wall of text", () => {
    const label = R.toolCallLabel("search_module_records", { module: "alerts", search: "x".repeat(300) });
    expect(label.length).toBeLessThanOrEqual(90);
    expect(label.endsWith("…")).toBe(true);
  });

  test("the rendered row carries the label and keeps the raw name", () => {
    const msg = R.buildAssistantMessage([
      { type: "tool_use", id: "a", name: "get_record", input: { module: "alerts" } },
    ], { now: () => 1 });
    expect(msg.events[0]).toMatchObject({ name: "get_record", label: "Read a record from alerts" });
  });
});

describe("assistant prose polish", () => {
  test("spaced em and en dashes read as commas, code is untouched", () => {
    expect(R.plainDashes("Yes \u2014 this alert is likely malicious.")).toBe("Yes, this alert is likely malicious.");
    expect(R.plainDashes("Malicious \u2013 high confidence")).toBe("Malicious, high confidence");
    expect(R.plainDashes("see `a \u2014 b` and\n```\nx \u2014 y\n```")).toBe("see `a \u2014 b` and\n```\nx \u2014 y\n```");
    expect(R.plainDashes("2019\u20132024")).toBe("2019-2024"); // unspaced range -> hyphen
    expect(R.plainDashes("elevated Jun\u2013Sep")).toBe("elevated Jun-Sep"); // the rehearsal's leaked en dash
    expect(R.plainDashes("see `a\u2013b`\n```\nx\u2013y\n```")).toBe("see `a\u2013b`\n```\nx\u2013y\n```"); // code untouched
  });

  test("a paragraph the model wrote twice in a row shows once", () => {
    // Live (gpt-5.4-mini, designer build): one round's reply was the same
    // paragraph twice, newline-joined, and the chat showed both.
    const p = "I checked the available connectors, and both are present but disconnected.";
    expect(R.dropRepeatedLines(p + "\n" + p)).toBe(p);
    expect(R.dropRepeatedLines(p + "\n\n" + p + "\nNext?")).toBe(p + "\n\nNext?");
    // Short repeated lines (list items, code) are left alone.
    expect(R.dropRepeatedLines("- ok\n- ok")).toBe("- ok\n- ok");
    expect(R.dropRepeatedLines("```\n" + p + "\n" + p + "\n```")).toBe("```\n" + p + "\n" + p + "\n```");
    const msg = R.buildAssistantMessage([{ type: "text", text: p + "\n" + p }],
      { now: () => 1, interleaveText: true });
    expect(msg.events.filter((e) => e.type === "text")[0].text).toBe(p);
  });

  test("a write-up before the verdict card folds to its first paragraph", () => {
    const msg = R.buildAssistantMessage([
      { type: "text", text: "Verdict: malicious \u2014 high confidence.\n\nWhy:\n- one\n- two" },
      { type: "verdict_card", id: "v1", disposition: "true_positive", findings: [] },
      { type: "text", text: "Want me to block it?\n\nI can stage it." },
    ], { now: () => 1, interleaveText: true });
    const texts = msg.events.filter((e) => e.type === "text");
    expect(texts[0]).toMatchObject({ _folded: true, lead: "Verdict: malicious, high confidence." });
    // Prose AFTER the card is the next step, not a restatement: it stays whole.
    expect(texts[1]._folded).toBeUndefined();
  });

  test("a turn with no verdict card never folds", () => {
    const msg = R.buildAssistantMessage([{ type: "text", text: "a\n\nb" }], { now: () => 1, interleaveText: true });
    expect(msg.events.filter((e) => e.type === "text")[0]._folded).toBeUndefined();
  });
});

// N6: a capped result is said on the row, from the result's own fields.
describe("toolPartialLabel", () => {
  test.each([
    [{ truncated: true, total: 140, showing: 25, page: 1, pages: 6 }, "25 of 140"],
    [{ truncated: true, total: 140, showing: 25, page: 3, pages: 6 }, "Page 3 of 6"],
    [{ truncated: true, count: 25, total_found: 61 }, "25 of 61"],
    [{ truncated: true, summarized: true, record: {} }, "Summarized"],
    [{ truncated: true, playbooks: [] }, "Partial"],
    [JSON.stringify({ truncated: true, total: 9, showing: 5 }), "5 of 9"],
    // The live fsr159 alerts search: 9,823 alerts, 5 read.
    [{ truncated: true, total: 9823, showing: 5, page: 1, pages: 1965 }, "5 of 9,823"],
    [{ truncated: true, total: 9823, showing: 5, page: 1200, pages: 1965 }, "Page 1,200 of 1,965"],
  ])("%j -> %s", (content, want) => {
    expect(R.toolPartialLabel(content)).toBe(want);
  });

  test.each([
    [{ truncated: false, total: 3, showing: 3 }],
    [{ ok: true, total: 140, showing: 25 }], // no flag: never inferred from counts
    [{ has_more: false, page: 6, pages: 6 }], // the last page is complete
    ["not json"], [null], [[{ truncated: true }]],
  ])("%j -> null", (content) => {
    expect(R.toolPartialLabel(content)).toBeNull();
  });

  test("the row built from a tool_result carries it; the complete one does not", () => {
    const msg = R.buildAssistantMessage([
      { type: "tool_use", id: "a", name: "search_module_records", input: { module: "alerts" } },
      { type: "tool_result", tool_use_id: "a", content: JSON.stringify({ ok: true, truncated: true, total: 140, showing: 25 }) },
      { type: "tool_use", id: "b", name: "search_module_records", input: { module: "incidents" } },
      { type: "tool_result", tool_use_id: "b", content: { ok: true, total: 3, showing: 3 } },
    ], { now: () => 1 });
    const rows = msg.events.filter((e) => e.type === "tool_call");
    expect(rows.map((r) => r.partialLabel)).toEqual(["25 of 140", null]);
  });

  test("a result with no matching call still gets its own row with the label", () => {
    const msg = R.buildAssistantMessage([
      { type: "tool_result", tool: "siem_search", content: { ok: true, truncated: true, count: 25, total_found: 80 } },
    ], { now: () => 1 });
    expect(msg.events.find((e) => e.type === "tool_call").partialLabel).toBe("25 of 80");
  });
});


// N7: the save guard's refusal, for the analyst.
describe("dropRefusalText", () => {
  test("one step, from the live path shape", () => {
    expect(R.dropRefusalText(["collection.workflows[_prewrite_wf].steps[Upd]"])).toBe(
      'Nothing was saved: this version would delete the step "Upd". If removing it is what '
      + "you want, ask me to remove it and I will apply that as a checked edit. Otherwise put "
      + "it back in the YAML and apply again.");
  });

  test("several steps plus other parts, each named once", () => {
    const t = R.dropRefusalText([
      "collection.workflows[w].steps[A]", "collection.workflows[w].steps[B]",
      "collection.workflows[w].steps[A]", "collection.workflows[w].parameters[ip]"]);
    expect(t).toContain('the steps "A" and "B", plus 1 other part of the playbook');
    expect(t).toContain("removing them");
  });

  test("no usable paths still reads as a sentence, with no internals", () => {
    expect(R.dropRefusalText(null)).toContain("would delete part of the playbook");
    expect(R.dropRefusalText(["weird"])).toContain("1 other part of the playbook");
  });
});


// Card text gets the same dash polish as prose; data fields do not.
describe("card text is de-dashed like prose", () => {
  test("action card summary, verdict claims and unknowns; ids and args untouched", () => {
    const msg = R.buildAssistantMessage([
      { type: "action_card", id: "a\u2014b", connector: "fortigate-firewall", operation: "block_ip_new",
        summary: "Block 102.220.160.21 on FGT_Edge \u2014 quarantine-based, 1 day.",
        args: { note: "x \u2014 y" } },
      { type: "verdict_card", id: "v1", disposition: "true_positive",
        summary: "C2 \u2014 confirmed.", findings: [{ claim: "Beacon \u2013 hourly", evidence: ["c1"] }],
        unknowns: ["Owner \u2014 unknown"] },
    ], { now: () => 1 });
    const card = msg.events.find((e) => e.type === "action_card");
    expect(card.summary).toBe("Block 102.220.160.21 on FGT_Edge, quarantine-based, 1 day.");
    const v = msg.events.find((e) => e.type === "verdict_card");
    expect(v.summary).toBe("C2, confirmed.");
    expect(v.findings[0].claim).toBe("Beacon, hourly");
    expect(v.unknowns[0]).toBe("Owner, unknown");
  });
});

describe("approval card title", () => {
  const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };
  const title = (tool) => R.buildAssistantMessage(
    [{ type: "approval_request", tool, approval_id: "ap-t", preview: { args: {} } }], OPTS)
    .events.find((e) => e.type === "approval_request").title;

  test("an MCP tool is named by its server and in words", () => {
    expect(title("mcp_soc__block_indicator")).toBe("SOC Framework: block indicator");
  });

  test("any other tool is named in words, not by its function name", () => {
    // Live: "Approval required: run_playbook".
    expect(title("run_op")).toBe("Run op");
    expect(title("run_playbook")).toBe("Run playbook");
  });
});
