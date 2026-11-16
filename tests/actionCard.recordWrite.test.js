"use strict";

// A record-WRITE approval (create/update/delete_record) has to answer two
// questions before an analyst clicks Confirm: which record, and what changes.
// The connector has shipped `target` / `changes` / `context_match` on those
// cards since #78 -- and the widget dropped all three on the floor, so the
// analyst saw the same args dump as before. A live producer with no consumer
// reads, from either side, exactly like the feature not existing.
//
// #120 is the other half: `context_match` was "unknown" on every card because
// the connector never threaded the mounted record in. Both halves are needed for
// the warning below to ever appear.
//
// Every case here is paired with the one that must NOT fire. The load-bearing
// pair is same/different: a card that renders the same thing for "this is your
// record" and "this is some other record" is not gating anything.

const R = require("../widget/widgetAssets/js/fsrPbRender.js");
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };

const ALERT = "d39ecc9a-2968-42d5-948d-ce96fd76b227";

function card(extra) {
  return R.buildAssistantMessage([Object.assign({
    type: "action_card", id: "card-1", connector: "fsr", operation: "update_record",
    summary: "Update alerts/d39ecc9a", args: { severity: "Critical" },
  }, extra)], OPTS).events.find((e) => e.type === "action_card");
}

describe("the write target reaches the render model", () => {
  test("module, uuid and name are carried", () => {
    const c = card({ target: { module: "alerts", uuid: ALERT, name: "Phishing report" } });
    expect(c.target).toEqual({ module: "alerts", uuid: ALERT, name: "Phishing report", label: "Alert" });
  });

  test("a nameless target is fine -- the connector binds only an iri", () => {
    // The mounted record is bound as an IRI, so no name is available. An
    // invented one would be worse than none on a card whose job is telling the
    // analyst which record is about to be written.
    expect(card({ target: { module: "alerts", uuid: ALERT } }).target)
      .toEqual({ module: "alerts", uuid: ALERT, name: "", label: "Alert" });
  });

  test("a card with no target keeps rendering as before", () => {
    // Every non-record action_card (containment, enrichment) must be untouched.
    const c = card({});
    expect(c.target).toBeNull();
    expect(c.changes).toEqual([]);
    expect(c.args).toEqual({ severity: "Critical" });
  });

  test("a target with no module identifies nothing and is dropped", () => {
    expect(card({ target: { uuid: ALERT } }).target).toBeNull();
  });
});

describe("context_match: same / different / unknown", () => {
  test("'different' survives normalization -- this is the warning", () => {
    expect(card({ target: { module: "alerts", uuid: ALERT }, context_match: "different" })
      .contextMatch).toBe("different");
  });

  test("'same' survives too", () => {
    expect(card({ target: { module: "alerts", uuid: ALERT }, context_match: "same" })
      .contextMatch).toBe("same");
  });

  test("a missing value is 'unknown', never 'same'", () => {
    expect(card({ target: { module: "alerts", uuid: ALERT } }).contextMatch).toBe("unknown");
  });

  test("an UNRECOGNISED value is 'unknown', never 'same'", () => {
    // A future connector value the widget has not learned must not fall through
    // into reassurance. This is the silencing case for the whole feature: the
    // template renders nothing at all for 'unknown'.
    expect(card({ target: { module: "alerts", uuid: ALERT }, context_match: "probably" })
      .contextMatch).toBe("unknown");
    expect(card({ target: { module: "alerts", uuid: ALERT }, context_match: true })
      .contextMatch).toBe("unknown");
  });
});

describe("the per-field diff", () => {
  test("update rows keep before and after", () => {
    const c = card({ changes: [{ field: "severity", before: "Low", after: "Critical" }] });
    expect(c.changes).toEqual([{ field: "severity", label: "Severity", before: "Low", after: "Critical" }]);
  });

  test("a create row has no `before` key at all", () => {
    // The template keys the arrow on `chg.before !== undefined`. Inventing a
    // before of "" would render "" -> "x" as though we knew the prior value --
    // a claim about the record the connector never made.
    const c = card({ changes: [{ field: "name", after: "New alert" }] });
    expect("before" in c.changes[0]).toBe(false);
  });

  test("an EXPLICIT empty before is kept, and is not the same as absent", () => {
    const c = card({ changes: [{ field: "notes", before: "", after: "x" }] });
    expect("before" in c.changes[0]).toBe(true);
    expect(c.changes[0].before).toBe("");
  });

  test("junk rows are dropped rather than rendered blank", () => {
    const c = card({ changes: ["severity", null, { after: "x" }, { field: "ok", after: 1 }] });
    expect(c.changes).toEqual([{ field: "ok", label: "Ok", after: 1 }]);
  });

  test("a non-array changes value degrades to empty", () => {
    expect(card({ changes: "severity: Critical" }).changes).toEqual([]);
  });
});

describe("the args editor still works on a write card", () => {
  test("target/changes are additive -- the editable args survive", () => {
    const c = card({
      target: { module: "alerts", uuid: ALERT }, context_match: "same",
      changes: [{ field: "severity", before: "Low", after: "Critical" }],
      editable_fields: ["severity"],
    });
    expect(c.args).toEqual({ severity: "Critical" });
    expect(c.editableFields).toEqual(["severity"]);
  });
});
