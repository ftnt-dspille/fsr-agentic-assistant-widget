"use strict";

// The awaiting-form manual_input card renders a run_playbook/resume_playbook
// pause as an interactive form. A dynamicList field is a GENERIC two-level
// FortiSOAR dependent picker (group → item), NOT anything domain-specific — the
// renderer must stay agnostic to what the groups/items happen to be.

const R = require("../widget/widgetAssets/js/fsrPbRender.js");
const OPTS = { now: () => 1700000000000, collapseThreshold: 600 };

const AWAITING = {
  type: "manual_input",
  id: "126",
  question: "Choose one\n\ndescription",
  workflow_run_iri: "/wf/api/workflows/2971/",
  fields: [
    { name: "pick", label: "Pick", type: "dynamic_list",
      groups: [
        { value: "Group A", options: ["a1", "a2"] },
        { value: "Group B", options: ["b1"] },
      ] },
    { name: "flag", label: "Flag", type: "checkbox" },
    { name: "note", label: "Note", type: "text" },
  ],
};

describe("manual_input dynamicList card", () => {
  test("normalizeManualFields assigns control kinds and keeps groups", () => {
    const fields = R.normalizeManualFields(AWAITING.fields);
    expect(fields.map((f) => f.control)).toEqual([
      "dynamic_list", "checkbox", "text",
    ]);
    expect(fields[0].groups).toHaveLength(2);
  });

  test("seedFieldValues seeds dependent helper keys + checkbox default false", () => {
    const fields = R.normalizeManualFields(AWAITING.fields);
    const v = R.seedFieldValues(fields);
    expect(v).toEqual({
      pick__group: "", pick__item: "", flag: false, note: "",
    });
  });

  test("dynamicListItems returns the picked group's items, [] otherwise", () => {
    const field = R.normalizeManualFields(AWAITING.fields)[0];
    expect(R.dynamicListItems(field, "Group A")).toEqual(["a1", "a2"]);
    expect(R.dynamicListItems(field, "Group B")).toEqual(["b1"]);
    expect(R.dynamicListItems(field, "")).toEqual([]);
    expect(R.dynamicListItems(field, "nope")).toEqual([]);
  });

  test("the card renders through buildAssistantMessage as a manual_input event", () => {
    const msg = R.buildAssistantMessage([AWAITING], OPTS);
    const card = msg.events.find((e) => e.type === "manual_input");
    expect(card).toBeTruthy();
    expect(card.inputId).toBe("126");
    expect(card.workflowRunIri).toBe("/wf/api/workflows/2971/");
    expect(card.fields[0].control).toBe("dynamic_list");
    expect(card.values.pick__group).toBe("");
  });
});

// Required-field validation — parity with the action_card submit gate. A card's
// submit button is enabled only when every REQUIRED field is satisfied; optional
// fields never block. (manual_input WIP completion — see
// docs/plans/agentic-assistant-ui-gaps.md A3.)
describe("manual_input required-field validation (manualInputComplete)", () => {
  test("normalizeManualFields carries the required flag (default false)", () => {
    const fields = R.normalizeManualFields([
      { name: "must", type: "text", required: true },
      { name: "opt", type: "text" },
    ]);
    expect(fields.map((f) => f.required)).toEqual([true, false]);
  });

  function card(fields, values) {
    return { fields: R.normalizeManualFields(fields), values: values || {} };
  }

  test("all-optional card is always valid", () => {
    expect(R.manualInputComplete(card([{ name: "note", type: "text" }], {}))).toBe(true);
  });

  test("required text field: empty/whitespace invalid, filled valid", () => {
    const fields = [{ name: "reason", type: "text", required: true }];
    expect(R.manualInputComplete(card(fields, { reason: "" }))).toBe(false);
    expect(R.manualInputComplete(card(fields, { reason: "   " }))).toBe(false);
    expect(R.manualInputComplete(card(fields, { reason: "ok" }))).toBe(true);
  });

  test("required dynamic_list needs BOTH group and item", () => {
    const fields = [{ name: "pick", type: "dynamic_list", required: true,
      groups: [{ value: "G", options: ["i1"] }] }];
    expect(R.manualInputComplete(card(fields, { pick__group: "", pick__item: "" }))).toBe(false);
    expect(R.manualInputComplete(card(fields, { pick__group: "G", pick__item: "" }))).toBe(false);
    expect(R.manualInputComplete(card(fields, { pick__group: "G", pick__item: "i1" }))).toBe(true);
  });

  test("required checkbox must be checked", () => {
    const fields = [{ name: "consent", type: "checkbox", required: true }];
    expect(R.manualInputComplete(card(fields, { consent: false }))).toBe(false);
    expect(R.manualInputComplete(card(fields, { consent: true }))).toBe(true);
  });

  test("a required field blocks even when other fields are filled", () => {
    const fields = [
      { name: "a", type: "text", required: true },
      { name: "b", type: "text", required: true },
    ];
    expect(R.manualInputComplete(card(fields, { a: "x", b: "" }))).toBe(false);
    expect(R.manualInputComplete(card(fields, { a: "x", b: "y" }))).toBe(true);
  });
});
