'use strict';
// "How I worked this out" + the live status line.
//
// Two user-facing pieces of the reasoning display:
//   (a) a collapsed per-turn panel folding the model's reasoning summary
//       (Anthropic summarized thinking, carried on the usage wire frame). It is
//       collapsed by default, opens on click, and never restates the answer.
//   (b) a live status line under the typing dots naming what the agent is doing
//       right now, read from the latest poll frame.
//
// (a) is deterministic in MOCK mode (chat_turn returns the transcript inline).
// (b) needs the live detached/poll path, so it stubs the connector HTTP layer
// the way liveDetached.spec does.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const INPUT = '[data-testid="chat-input"]';
const SEND = '[data-testid="chat-send"]';
const TYPING = '[data-testid="typing-indicator"]';
const STATUS = '[data-testid="typing-status"]';

// ── (a) collapsed reasoning panel, mock mode ───────────────────────────────
async function gotoReasoning(page) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'connector-fsr-agentic-assistant',
      defaultIntent: 'triage', maxTurns: 10, showUsage: true
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=reasoning_panel`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
  return errors;
}

test('reasoning panel: collapsed by default, folds both rounds, never restates the answer', async ({ page }) => {
  const errors = await gotoReasoning(page);

  await page.locator(INPUT).fill('What happened here and how bad is it?');
  await page.locator(SEND).click();
  await page.waitForFunction(
    () => window.__agenticAssistant__ && window.__agenticAssistant__.state === 'idle',
    null, { timeout: 15000 });

  const panel = page.locator('.pb-reasoning');
  await expect(panel).toBeVisible();
  // The toggle is present; the body is collapsed until clicked.
  await expect(page.locator('.pb-reasoning-toggle')).toContainText('How I worked this out');
  await expect(page.locator('.pb-reasoning-body')).toHaveCount(0);

  // The reasoning text must NOT appear while collapsed (it is not inline prose).
  await expect(panel).not.toContainText('rests on endpoint telemetry');

  // Open it: both rounds show, in order, labelled as steps.
  await page.locator('.pb-reasoning-toggle').click();
  const body = page.locator('.pb-reasoning-body');
  await expect(body).toBeVisible();
  await expect(body).toContainText('look at the host in FortiEDR first');
  await expect(body).toContainText('rests on endpoint telemetry');
  await expect(body.locator('.pb-reasoning-step')).toHaveCount(2);
  await expect(body).toContainText('Step 1');
  await expect(body).toContainText('Step 2');

  // Collapses again.
  await page.locator('.pb-reasoning-toggle').click();
  await expect(page.locator('.pb-reasoning-body')).toHaveCount(0);

  expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
});

// ── (b) live status line, detached/poll path ───────────────────────────────
const CONTRACT = '2.8.0';
const envelope = (operation, data) => ({ operation, status: 'Success', message: 'ok', data });
const frame = (type, extra) => Object.assign({ type }, extra || {});
const ackData = (turn) => ({
  ok: true, accepted: true, session_id: 'sess-status', turn,
  turn_id: 'turn-' + turn, stop_reason: 'accepted', contract_version: CONTRACT
});

function connectorsBody() {
  return { data: [{
    name: 'connector-fsr-agentic-assistant', version: CONTRACT,
    configuration: [{ name: 'fsr-live', config_id: 'cfg-1', default: true }]
  }] };
}

// start -> a tool_use that lingers (so the tool label is assertable) -> prose
// begins -> authoritative terminal with the reasoning-bearing transcript.
function pollScript(turn) {
  const tid = 'turn-' + turn;
  const base = { ok: true, contract_version: CONTRACT, turn, done: false };
  return [
    Object.assign({ cursor: 1 }, base, { frames: [frame('turn_start', { turn, turn_id: tid })] }),
    Object.assign({ cursor: 2 }, base, { frames: [
      frame('tool_use', { id: 'tu-1', name: 'edr_host', input: { host: 'The-Flame' },
                          label: 'Checked the host in FortiEDR' })] }),
    // linger on the tool so the status line is stable to assert
    Object.assign({ cursor: 2 }, base, { frames: [] }),
    Object.assign({ cursor: 3 }, base, { frames: [
      frame('tool_result', { tool_use_id: 'tu-1', tool: 'edr_host',
                             content: JSON.stringify({ ok: true }) }),
      frame('text', { text: 'The host is compromised.' })] }),
    // linger on the prose phase
    Object.assign({ cursor: 3 }, base, { frames: [] }),
    { ok: true, contract_version: CONTRACT, turn, cursor: 99, done: true, frames: [
      frame('stream_end', { turn, turn_id: tid, ok: true, stop_reason: 'end_turn', transcript: [
        frame('tool_use', { id: 'tu-1', name: 'edr_host', input: { host: 'The-Flame' },
                            label: 'Checked the host in FortiEDR' }),
        frame('tool_result', { tool_use_id: 'tu-1', tool: 'edr_host',
                               content: JSON.stringify({ ok: true }) }),
        frame('usage', { input_tokens: 1200, output_tokens: 300, cost_usd: 0.01,
                         thinking: 'I will check the host, then weigh the evidence.' }),
        frame('text', { text: 'The host is compromised and should be isolated.' })
      ] })] }
  ];
}

async function stubConnector(page) {
  const state = { polls: 0, script: null, turn: 1 };
  await page.route(/\/api\/integration\/connectors\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(connectorsBody()) }));
  await page.route(/\/api\/integration\/execute\//, async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* */ }
    const op = body.operation;
    let data;
    if (op === 'chat_turn') { state.script = pollScript(state.turn); data = ackData(state.turn); }
    else if (op === 'chat_poll') {
      const seq = state.script || pollScript(state.turn);
      data = seq[Math.min(state.polls, seq.length - 1)];
      state.polls++;
    } else { data = { ok: true }; }
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(envelope(op, data)) });
  });
}

async function bootLive(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'connector-fsr-agentic-assistant', defaultIntent: 'triage',
      maxTurns: 10, showUsage: true, seedFromEntity: false, mockMode: 'real',
      detachedTimeoutMs: 15000
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mode=live`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 });
  await expect(page.locator(INPUT)).toBeEnabled({ timeout: 15000 });
}

test('live status line names the current activity, then the answer phase', async ({ page }) => {
  await stubConnector(page);
  await bootLive(page);

  await page.locator(INPUT).fill('What happened here and how bad is it?');
  await expect(page.locator(SEND)).toBeEnabled();
  await page.locator(SEND).click();

  await expect(page.locator(TYPING)).toBeVisible({ timeout: 5000 });
  // While the tool runs, the status names it (the connector's own label).
  await expect(page.locator(STATUS)).toContainText('Checked the host in FortiEDR', { timeout: 6000 });
  // Once prose starts streaming, it switches to the answer phase.
  await expect(page.locator(STATUS)).toContainText('Writing the answer', { timeout: 6000 });

  // The turn commits and leaves the sending state; the reasoning panel lands.
  await page.waitForFunction(
    () => window.__agenticAssistant__ && window.__agenticAssistant__.state === 'idle',
    null, { timeout: 20000 });
  await expect(page.locator(TYPING)).toHaveCount(0);
  await expect(page.locator('.pb-reasoning')).toBeVisible();
});
