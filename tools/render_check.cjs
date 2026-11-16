#!/usr/bin/env node
"use strict";

/**
 * render_check.cjs — replay a connector chat transcript through the widget's
 * framework-free render pipeline (fsrPbRender.buildAssistantMessage) and report
 * whether it produces a well-formed render model.
 *
 * This is the node bridge the Python tuning loop (FSRPlaybookYaml
 * python/evals/chat_drive.py) shells out to so a `fsrpb chat-drive` run can
 * answer "would the widget actually render this transcript?" without a browser.
 * The render vocabulary (event types, block kinds, severities, tool statuses)
 * comes from tools/render_contract.json, the same file that
 * tests/render.pipeline.test.ts reads, so the two cannot drift apart.
 * tests/renderCheck.contract.test.js runs this tool over the fixtures.
 *
 * Usage:
 *   node render_check.cjs <transcript.json>     # path to a JSON file
 *   node render_check.cjs -                     # read transcript JSON from stdin
 *
 * Input: either a bare transcript array `[ {type:...}, ... ]`, or an object
 * carrying one under `.transcript` (the chat_turn response shape), or an object
 * with `.responses[].response.transcript` (the widget fixture shape) — every
 * transcript found is validated.
 *
 * Output (stdout): JSON `{ ok, transcripts, events, violations: [...] }`.
 * Exit code: 0 when ok (no violations), 1 otherwise, 2 on a usage/parse error.
 */

const fs = require("fs");
const path = require("path");

// Resolve the render module relative to this file (tools/ -> widget/...).
const RENDER_PATH = path.resolve(
  __dirname, "../widget/widgetAssets/js/fsrPbRender.js");

let R;
try {
  R = require(RENDER_PATH);
} catch (e) {
  process.stdout.write(JSON.stringify(
    { ok: false, violations: [`cannot load fsrPbRender at ${RENDER_PATH}: ${e.message}`] }));
  process.exit(2);
}

// Fixed clock → deterministic ids/timestamps (matches render.pipeline.test.js).
const CLOCK = { now: () => 1700000000000, collapseThreshold: 600 };

// ── Contract: shared with tests/render.pipeline.test.ts via render_contract.json ──
const CONTRACT = JSON.parse(fs.readFileSync(
  path.join(__dirname, "render_contract.json"), "utf8"));
const RENDER_EVENT_TYPES = new Set(CONTRACT.renderEventTypes);
const BLOCK_KINDS = new Set(CONTRACT.blockKinds);
const SEVERITIES = new Set(CONTRACT.severities);
const TOOL_STATUSES = CONTRACT.toolStatuses;

function readInput() {
  const arg = process.argv[2];
  if (!arg) {
    process.stdout.write(JSON.stringify(
      { ok: false, violations: ["usage: render_check.cjs <transcript.json|->"] }));
    process.exit(2);
  }
  const raw = arg === "-"
    ? fs.readFileSync(0, "utf8")
    : fs.readFileSync(arg, "utf8");
  return JSON.parse(raw);
}

// Pull every transcript array out of whatever shape we were handed.
function collectTranscripts(data) {
  const out = [];
  if (Array.isArray(data)) {
    out.push({ where: "transcript", t: data });
  } else if (data && Array.isArray(data.transcript)) {
    out.push({ where: "transcript", t: data.transcript });
  } else if (data && Array.isArray(data.responses)) {
    data.responses.forEach((r, i) => {
      const t = r && r.response && r.response.transcript;
      if (Array.isArray(t)) out.push({ where: `responses[${i}](${r.action})`, t });
    });
  }
  return out;
}

// Validate one render-model event; push human-readable strings into `bad`.
function validateEvent(ev, where, j, bad) {
  if (!RENDER_EVENT_TYPES.has(ev.type)) {
    bad.push(`${where} ev[${j}]: unknown render type "${ev.type}"`);
  }
  if (ev.type === "info_card") {
    if (!SEVERITIES.has(ev.severity)) bad.push(`${where} ev[${j}]: bad severity ${ev.severity}`);
    (ev.blocks || []).forEach((b, k) => {
      if (!BLOCK_KINDS.has(b.kind)) bad.push(`${where} ev[${j}].blocks[${k}]: bad kind ${b.kind}`);
    });
    if (!ev.cardId) bad.push(`${where} ev[${j}]: info_card missing cardId`);
  }
  if (ev.type === "action_card") {
    if (!ev.cardId) bad.push(`${where} ev[${j}]: action_card missing cardId`);
    if (typeof ev.args !== "object") bad.push(`${where} ev[${j}]: action_card args not object`);
    if (!Array.isArray(ev.editableFields)) bad.push(`${where} ev[${j}]: editableFields not array`);
  }
  if (ev.type === "choice_card") {
    if (!ev.choiceId) bad.push(`${where} ev[${j}]: choice_card missing choiceId`);
    if (!Array.isArray(ev.options)) bad.push(`${where} ev[${j}]: choice options not array`);
  }
  if (ev.type === "manual_input") {
    if (!ev.inputId) bad.push(`${where} ev[${j}]: manual_input missing inputId`);
    if (typeof ev.values !== "object") bad.push(`${where} ev[${j}]: manual_input values not object`);
  }
  if (ev.type === "capability_gap") {
    if (!ev.choiceId) bad.push(`${where} ev[${j}]: capability_gap missing choiceId`);
    if (!ev.missing) bad.push(`${where} ev[${j}]: capability_gap missing 'missing'`);
    if (!Array.isArray(ev.fixSteps)) bad.push(`${where} ev[${j}]: capability_gap fixSteps not array`);
    if (!ev.resume || !ev.resume.value) bad.push(`${where} ev[${j}]: capability_gap missing resume.value`);
  }
  if (ev.type === "playbook_offer") {
    if (!ev.offerId) bad.push(`${where} ev[${j}]: playbook_offer missing offerId`);
    if (!ev.summary) bad.push(`${where} ev[${j}]: playbook_offer missing summary`);
    if (!Array.isArray(ev.opsSummary)) bad.push(`${where} ev[${j}]: playbook_offer opsSummary not array`);
  }
  if (ev.type === "tool_call") {
    if (!TOOL_STATUSES.includes(ev.resultStatus)) {
      bad.push(`${where} ev[${j}]: bad resultStatus ${ev.resultStatus}`);
    }
  }
}

function main() {
  let data;
  try {
    data = readInput();
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, violations: [`input parse error: ${e.message}`] }));
    process.exit(2);
  }

  const transcripts = collectTranscripts(data);
  if (transcripts.length === 0) {
    process.stdout.write(JSON.stringify(
      { ok: false, transcripts: 0, events: 0, violations: ["no transcript array found in input"] }));
    process.exit(1);
  }

  const violations = [];
  let eventCount = 0;
  for (const { where, t } of transcripts) {
    let msg;
    try {
      msg = R.buildAssistantMessage(t, CLOCK);
    } catch (e) {
      violations.push(`${where}: buildAssistantMessage threw ${e.message}`);
      continue;
    }
    if (msg.role !== "assistant") violations.push(`${where}: role=${msg.role}`);
    if (typeof msg.text !== "string") violations.push(`${where}: text not string`);
    if (!Array.isArray(msg.events)) { violations.push(`${where}: events not array`); continue; }
    eventCount += msg.events.length;
    msg.events.forEach((ev, j) => validateEvent(ev, where, j, violations));
  }

  const ok = violations.length === 0;
  process.stdout.write(JSON.stringify(
    { ok, transcripts: transcripts.length, events: eventCount, violations }));
  process.exit(ok ? 0 : 1);
}

main();
