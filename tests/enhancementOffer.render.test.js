// enhancement_offer -- the enhance-mode write path, at the render layer.
//
// Enhance mode had no write path. `verify_enhancement` returned
// ready_to_push:true and the only way an edit reached the analyst's playbook
// was _extractLastYamlFence() scraping the model's prose. Live that lost the
// edit outright: the model verified one document, then re-typed three
// progressively different ones into chat, and the scrape applied the last --
// text no gate had ever seen -- while the transcript showed a green verify.
// The analyst asked three times; the step never landed.
//
// These tests cover the render half of the fix: the card carries the verified
// bytes and OUTRANKS any prose fence in the same turn.

const R = require("../widget/widgetAssets/js/fsrPbRender");

const CLOCK = { now: () => 1700000000000, collapseThreshold: 600 };

const FINAL_YAML = [
  "collection: C",
  "playbooks:",
  "- name: BGP Flap Response",
  "  steps:",
  "  - {name: Prompt Block IP, type: manual_input}",
  "",
].join("\n");

function offerEvent(over) {
  return Object.assign({
    type: "enhancement_offer",
    id: "enh-1",
    summary: "Adds an approval gate before the block.",
    verified_id: "0a86f7c1b0c9d221",
    final_yaml: FINAL_YAML,
    ops_summary: [{ label: "Prompt Block IP", step_type: "manual_input" },
                  { label: "Block IP", step_type: "connector" }],
    steps_added: ["Prompt Block IP"],
    steps_removed: [],
    steps_modified: ["Block IP"],
    warnings: [{ message: "param 'ip' needs ip_type", path: "steps[0].params.ip" }],
  }, over || {});
}

function render(transcript) {
  const msgs = R.normalizeTranscript
    ? R.normalizeTranscript(transcript, CLOCK)
    : R.buildAssistantMessage(transcript, CLOCK);
  return msgs;
}

function findCard(transcript) {
  const msgs = render(transcript);
  const list = Array.isArray(msgs) ? msgs : [msgs];
  for (const m of list) {
    for (const ev of (m.events || [])) {
      if (ev.type === "enhancement_offer") return ev;
    }
  }
  return null;
}

describe("enhancement_offer card", () => {
  test("renders as its own gating card type", () => {
    const card = findCard([offerEvent()]);
    expect(card).not.toBeNull();
    expect(card.type).toBe("enhancement_offer");
    expect(card.offerId).toBe("enh-1");
    expect(card._resolved).toBe(false);
    expect(card._open).toBe(true);
  });

  test("carries the verified bytes verbatim", () => {
    // The analyst's Apply writes exactly this. If the render layer ever
    // reformats/trims it, "verified" stops describing what ships.
    const card = findCard([offerEvent()]);
    expect(card.finalYaml).toBe(FINAL_YAML);
    expect(card.verifiedId).toBe("0a86f7c1b0c9d221");
  });

  test("summarises the change rather than the whole playbook", () => {
    const card = findCard([offerEvent()]);
    expect(card.stepsAdded).toEqual(["Prompt Block IP"]);
    expect(card.stepsModified).toEqual(["Block IP"]);
    expect(card.stepsRemoved).toEqual([]);
    expect(card.changeCount).toBe(2);
  });

  test("flags which steps the edit touches", () => {
    const card = findCard([offerEvent()]);
    const byLabel = {};
    card.opsSummary.forEach((o) => { byLabel[o.label] = o; });
    expect(byLabel["Prompt Block IP"].added).toBe(true);
    expect(byLabel["Prompt Block IP"].changed).toBe(true);
    expect(byLabel["Block IP"].added).toBe(false);
    expect(byLabel["Block IP"].changed).toBe(true);
  });

  test("surfaces non-blocking warnings to the human", () => {
    // ready_to_push tolerates warnings, so this card is the last place an
    // analyst sees "this compiles but the connector will reject it".
    const card = findCard([offerEvent()]);
    expect(card.warnings).toHaveLength(1);
    expect(card.warnings[0].message).toMatch(/ip_type/);
    // The JSON path is the model's to read, not the analyst's.
    expect(card.warnings[0]).not.toHaveProperty("path");
  });

  test("leads with the edit's own warnings and folds the playbook's old ones", () => {
    // verify_playbook lints the whole document: live, a one-step edit carried
    // ~20 warnings about steps it never touched.
    const card = findCard([offerEvent({
      warnings: [
        { message: "Jinja reference vars.nope in step 'extra': ...", path: "playbooks[0].steps[3].arguments.x",
          plain: "vars.nope is never set before this step, so it will be empty when the playbook runs.",
          step_name: "Extra", in_change: true },
        { message: "Jinja reference vars.alert_metadata in step 'enrich_ip': ...",
          plain: "vars.alert_metadata is never set before this step, so it will be empty when the playbook runs.",
          step_name: "Enrich IP", in_change: false },
        { message: "x", plain: "y", step_name: "Note It", in_change: false },
      ],
    })]);
    expect(card.warnings).toEqual([{
      message: "vars.nope is never set before this step, so it will be empty when the playbook runs.",
      step: "Extra", inChange: true,
    }]);
    expect(card.otherWarnings.map((w) => w.step)).toEqual(["Enrich IP", "Note It"]);
    expect(card._otherWarningsOpen).toBe(false);
  });

  // #126 -- the card leads with a diff. The three name lists say WHICH steps
  // changed; before this the only answer to "changed HOW?" was a 200-line YAML
  // dump behind a toggle, which is an Apply button over something nobody read.
  test("turns the wire's changes into readable before/after rows", () => {
    const card = findCard([offerEvent({
      changes: [{
        playbook: "BGP Flap Response", step: "Block IP", kind: "modified",
        type: "connector", changed_fields: ["arguments"],
        before: { type: "connector", arguments: { ip: "{{ old }}" }, next: "End" },
        after: { type: "connector", arguments: { ip: "{{ new }}" }, next: "End" },
      }],
    })]);
    expect(card.changes).toHaveLength(1);
    const row = card.changes[0];
    expect(row.kind).toBe("modified");
    expect(row.badge).toBe("mod");
    expect(row.step).toBe("Block IP");
    expect(row.changedFieldsText).toBe("arguments");
    expect(row.beforeText).toMatch(/\{\{ old \}\}/);
    expect(row.afterText).toMatch(/\{\{ new \}\}/);
    // Both sides present, and they are not the same text -- a diff whose panes
    // match is a diff that explains nothing.
    expect(row.beforeText).not.toBe(row.afterText);
  });

  test("an added step has an after side only, and a removed step a before", () => {
    const card = findCard([offerEvent({
      changes: [
        { step: "Prompt Block IP", kind: "added", type: "manual_input",
          before: null, after: { type: "manual_input", next: "Block IP" } },
        { step: "Old Note", kind: "removed", type: "set_variable",
          before: { type: "set_variable", arguments: { note: "x" } }, after: null },
      ],
    })]);
    const [added, removed] = card.changes;
    expect(added.beforeText).toBe("");
    expect(added.afterText).toBe("Then: Block IP");
    expect(added.afterText).not.toMatch(/manual_input/);   // no enum values
    expect(added.badge).toBe("add");
    expect(removed.afterText).toBe("");
    expect(removed.beforeText).toMatch(/note/);
    expect(removed.badge).toBe("del");
  });

  test("reads changes off diff_summary when they were not hoisted", () => {
    // Older connectors send the diff only inside diff_summary. The card still
    // has to draw it -- a version skew must not silently cost the analyst the
    // explanation.
    const card = findCard([offerEvent({
      diff_summary: { steps_modified: ["Block IP"], changes: [
        { step: "Block IP", kind: "modified", type: "connector",
          before: { type: "connector" }, after: { type: "connector", next: "End" } },
      ] },
    })]);
    expect(card.changes).toHaveLength(1);
    expect(card.changes[0].step).toBe("Block IP");
  });

  test("empty projection keys are dropped rather than printed as nulls", () => {
    const card = findCard([offerEvent({
      changes: [{ step: "S", kind: "modified",
        before: { type: "connector", next: null, branches: {}, for_each: "" },
        after: { type: "connector", next: "End", branches: {}, for_each: "" } }],
    })]);
    // A modified step prints only what changed; an unset side says so.
    expect(card.changes[0].beforeText).toBe("Then: (not set)");
    expect(card.changes[0].afterText).toBe("Then: End");
  });

  // Live (fsr159): moving one `next` link printed both FULL projections of a
  // VirusTotal step, including a 21k-char stored mock_result of escaped WHOIS
  // text -- the one changed line was unreadable under it.
  test("a modified step shows only the changed values, not the whole step", () => {
    const blob = JSON.stringify({ data: { whois: "Registrar: x\r\n".repeat(2000) } });
    const card = findCard([offerEvent({
      changes: [{ step: "Get Source IP Reputation", kind: "modified", type: "connector",
        changed_fields: ["next"],
        before: { type: "connector", arguments: { mock_result: blob, params: { ip: "1.2.3.4" } },
                  next: "is_malicious_ip" },
        after: { type: "connector", arguments: { mock_result: blob, params: { ip: "1.2.3.4" } },
                 next: "set_reviewed_by_ai" } }],
    })]);
    const row = card.changes[0];
    expect(row.beforeText).toBe("Then: Is malicious IP");
    expect(row.afterText).toBe("Then: Set reviewed by AI");
  });

  test("a nested change names its path", () => {
    const card = findCard([offerEvent({
      changes: [{ step: "Block IP", kind: "modified",
        before: { type: "connector", arguments: { params: { ip_addresses: "198.51.100.10", method: "Q" } } },
        after: { type: "connector", arguments: { params: { ip_addresses: "203.0.113.99", method: "Q" } } } }],
    })]);
    expect(card.changes[0].beforeText).toBe("IP addresses: 198.51.100.10");
    expect(card.changes[0].afterText).toBe("IP addresses: 203.0.113.99");
  });

  test("an added step reads as plain lines with long strings cut to one line", () => {
    const card = findCard([offerEvent({
      changes: [{ step: "Set reviewed_by_ai", kind: "added", type: "set_variable", before: null,
        after: { type: "set_variable",
                 arguments: { arg_list: [{ name: "reviewed_by_ai", value: true },
                                         { name: "note", value: "y".repeat(500) }] },
                 next: "is_malicious_ip" } }],
    })]);
    const lines = card.changes[0].afterText.split("\n");
    expect(lines[0]).toBe("Saves reviewed_by_ai as Yes");
    expect(lines[1]).toMatch(/^Saves note as y+… \(500 chars\)$/);
    expect(lines[2]).toBe("Then: Is malicious IP");
    expect(lines).toHaveLength(3);
  });

  test("added steps read like the designer, not like YAML", () => {
    // The shape a live classroom edit produced: a button trigger, a variable,
    // a connector call. Every line asserted, so a regression to `type:` /
    // `arguments:` / `next:` keys fails here.
    const card = findCard([offerEvent({
      changes: [
        { step: "Start", kind: "added", type: "start", before: null,
          after: { type: "start", arguments: { module: "alerts", button_label: "Suspend AI Access" },
                   next: "read_key_id" } },
        { step: "Read Key Id", kind: "added", type: "set_variable", before: null,
          after: { type: "set_variable",
                   arguments: { arg_list: [{ name: "key_id", value: "{{ vars.input.records[0].sourcedata | from_json }}" }] },
                   next: "revoke_key" } },
        { step: "Revoke Key", kind: "added", type: "connector", before: null,
          after: { type: "connector",
                   arguments: { connector: "fortinet-fortiaigate", operation: "revoke_virtual_key",
                                config: "student19 FortiAIGate",
                                params: { key_id: "{{ vars.key_id }}", reason: "Suspended" } } } },
      ],
    })]);
    const text = card.changes.map((c) => c.afterText);
    expect(text).toEqual([
      "Button: Suspend AI Access\nOn: alerts\nThen: Read key ID",
      "Saves key_id as {{ vars.input.records[0].sourcedata | from_json }}\nThen: Revoke key",
      "Runs revoke virtual key on Fortinet Fortiaigate\nConfiguration: student19 FortiAIGate\n"
        + "Key ID: {{ vars.key_id }}\nReason: Suspended",
    ]);
    text.forEach((t) => expect(t).not.toMatch(/^(type|arguments|next|params):/m));
  });

  test("object and list inputs read as plain text, never as JSON", () => {
    const card = findCard([offerEvent({
      changes: [{ step: "Ask Model", kind: "added", type: "connector", before: null,
        after: { type: "connector",
                 arguments: { connector: "fortinet-fortiaigate", operation: "chat_completion",
                              params: {
                                messages: [{ role: "user", content: "Summarize the triggering alert" },
                                           { role: "system", content: "Be brief" }],
                                options: { max_tokens: 50, stream: false },
                                stringified: "[{\"role\": \"user\", \"content\": \"hi\"}]",
                                template: "{{ vars.input.records[0].name }}" } } } }],
    })]);
    const lines = card.changes[0].afterText.split("\n");
    expect(lines).toContain("Messages: user: Summarize the triggering alert; system: Be brief");
    expect(lines).toContain("Options: Max tokens: 50, Stream: No");
    expect(lines).toContain("Stringified: user: hi");
    expect(lines).toContain("Template: {{ vars.input.records[0].name }}");
    card.changes[0].afterText.split("\n").forEach((ln) => expect(ln).not.toMatch(/[\[\]]?\{"|":\s|\[\{/));
  });

  test("record IRIs and uuids never reach the card text, however they are nested", () => {
    const U = "3b5241f0-0355-483f-b253-9472de08a675";
    const card = findCard([offerEvent({
      changes: [
        { step: "Link It", kind: "added", type: "connector", before: null,
          after: { type: "connector",
                   arguments: { connector: "c", operation: "do_it", config: U,
                                params: { owner: "/api/3/people/" + U,
                                          owners: ["/api/3/people/" + U, "/api/3/teams/" + U],
                                          note: "see /api/3/alerts/" + U + " and " + U,
                                          wrapped: JSON.stringify([{ id: "/api/3/people/" + U }]) } } } },
        { step: "Edit It", kind: "modified", before: { type: "connector", arguments: { params: { owner: "/api/3/people/" + U } } },
          after: { type: "connector", arguments: { params: { owner: "/api/3/teams/" + U } } } },
      ],
    })]);
    const text = card.changes.map((c) => (c.beforeText || "") + "\n" + (c.afterText || "")).join("\n");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(text).not.toMatch(/\/api\/3\//);
    const lines = card.changes[0].afterText.split("\n");
    expect(lines).toContain("Configuration: an item");
    expect(lines).toContain("Owner: People record");
    expect(lines).toContain("Owners: People record; Teams record");
    expect(lines).toContain("Note: see Alerts record and an item");
    expect(lines).toContain("Wrapped: ID: People record");
  });

  test("a modified row never shows a JSON path or a raw step id", () => {
    const card = findCard([offerEvent({
      changes: [{ step: "Branchy", kind: "modified",
        before: { type: "decision", arguments: { params: { owner_email: "a@x.test" } },
                  branches: [{ target: "block_ip" }], next: "end_step" },
        after: { type: "decision", arguments: { params: { owner_email: "b@x.test" } },
                 branches: [{ target: "notify_team" }], next: "wrap_up" } }],
    })]);
    const both = card.changes[0].beforeText + "\n" + card.changes[0].afterText;
    expect(both).not.toMatch(/arguments|params|branches\[|[a-z]_[a-z]/);
    expect(card.changes[0].afterText.split("\n")).toEqual(
      expect.arrayContaining(["Owner email: b@x.test", "Branches 1 target: Notify team", "Then: Wrap up"]));
  });

  test("a change row with neither side is not rendered at all", () => {
    const card = findCard([offerEvent({
      changes: [{ step: "Ghost", kind: "modified", before: null, after: null }],
    })]);
    expect(card.changes).toEqual([]);
  });

  test("a card with no changes still renders -- the YAML toggle is the fallback", () => {
    const card = findCard([offerEvent()]);
    expect(card.changes).toEqual([]);
    expect(card.finalYaml).toBe(FINAL_YAML);
    expect(card.changeCount).toBe(2);
  });

  test("tolerates a minimal card", () => {
    const card = findCard([{ type: "enhancement_offer", id: "e2",
                             final_yaml: "playbooks: []\n" }]);
    expect(card.changeCount).toBe(0);
    expect(card.warnings).toEqual([]);
    expect(card.otherWarnings).toEqual([]);
    expect(card.opsSummary).toEqual([]);
    expect(card.summary).toBeTruthy(); // defaulted, never blank
  });
});

describe("enhancement_offer -- playbooks the edit adds", () => {
  // Analyst sim: a reusable child playbook is SAVED by Apply (the canvas holds
  // one playbook), so the card has to say so before the click.
  test("lists the new playbooks", () => {
    const card = findCard([offerEvent({ playbooks_added: ["Block One IP"] })]);
    expect(card.playbooksAdded).toEqual(["Block One IP"]);
  });

  test("an older connector's card has none", () => {
    expect(findCard([offerEvent()]).playbooksAdded).toEqual([]);
  });

  test("drops anything that is not a name", () => {
    const card = findCard([offerEvent({ playbooks_added: ["X", null, 3, ""] })]);
    expect(card.playbooksAdded).toEqual(["X"]);
  });
});
