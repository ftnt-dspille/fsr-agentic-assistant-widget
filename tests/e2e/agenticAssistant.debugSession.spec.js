'use strict';
// ─── Interactive debug drawer (Track C3) ─────────────────────────────────────
//
// The YAML pane's Debug toggle opens a panel that drives the connector's
// stateful debug session (start_debug_session → step/continue/stop). This
// exercises the DOM flow against the harness with the debug tool calls mocked:
// open, start, step (trace grows), breakpoint toggle, continue-to-done, stop.
const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

// A tiny in-route state machine for the debug session: start → paused at
// "trigger"; each step appends a trace record and advances; continue finishes.
function debugStatus(over) {
  return Object.assign({
    session_id: 'dbg-e2e', playbook: 'FSRPB Create Alert', done: false,
    paused_at: 'trigger', steps_advanced: 0, trace_len: 0,
    first_error: null, breakpoints: [], trace: []
  }, over || {});
}

async function installRoutes(page) {
  await page.route(/\/api\/integration\/connectors\//, route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: [{
        name: 'connector-fsr-agentic-assistant', version: '1.0.0',
        configuration: [{ name: 'fsrpb-live', config_id: 'cfg-0001', default: true }]
      }] })
    })
  );
  let advanced = 0;
  const traceUpTo = (n) => Array.from({ length: n }, (_, i) => ({
    step_id: i === 0 ? 'trigger' : 'create_alert',
    name: i === 0 ? 'trigger' : 'Create alert',
    type: i === 0 ? 'start' : 'create_record',
    status: 'simulated', output_top_keys: i === 0 ? [] : ['id', 'name']
  }));
  await page.route(/\/api\/integration\/execute\//, route => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* noop */ }
    const op = body.operation || '';
    const tool = (body.params && body.params.tool) || '';
    let data = { ok: true };
    if (op === 'call_mcp_tool') {
      if (tool === 'start_debug_session') {
        advanced = 0;
        data = { ok: true, status: debugStatus() };
      } else if (tool === 'step_debug_session') {
        advanced = Math.min(advanced + 1, 2);
        data = { ok: true, advanced: true, status: debugStatus({
          steps_advanced: advanced, paused_at: advanced >= 2 ? null : 'create_alert',
          done: advanced >= 2, trace_len: advanced, trace: traceUpTo(advanced) }) };
      } else if (tool === 'continue_debug_session') {
        advanced = 2;
        data = { ok: true, advanced: 2, stop_reason: 'done', status: debugStatus({
          steps_advanced: 2, paused_at: null, done: true, trace_len: 2, trace: traceUpTo(2) }) };
      } else if (tool === 'stop_debug_session') {
        data = { ok: true, status: debugStatus({ done: true }) };
      }
    }
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'Success', operation: op, data })
    });
  });
}

async function gotoWithYaml(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', maxTurns: 10 }));
    localStorage.setItem('harness.widget', id);
    // This is a build YAML-pane authoring aid, so it mounts where build lives:
    // the playbook designer (ctx 'playbook' -> $state main.playbookDetail).
    // `config.defaultIntent='build'` used to open a DASHBOARD straight into
    // build and was retired — build assumes an open playbook to author
    // against. See docs/plans/build-persona-validation-plan.md.
    localStorage.setItem('harness.ctx', 'playbook');
    localStorage.setItem('harness.id', 'wf-9');
  }, WIDGET_ID);
  await installRoutes(page);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
  await page.locator('[data-testid="chat-input"]').fill('Draft a ping playbook');
  await page.locator('[data-testid="chat-send"]').click();
  await page.waitForFunction(
    () => window.__agenticAssistant__ && window.__agenticAssistant__.currentYaml,
    null, { timeout: 8000 });
}

test.describe('FSR Agentic Assistant — interactive debug drawer (C3)', () => {

  test('Debug toggle opens the panel; Start pauses at the first step', async ({ page }) => {
    await gotoWithYaml(page);
    await page.locator('[data-testid="yaml-debug-toggle"]').click();
    await expect(page.locator('[data-testid="yaml-debug"]')).toBeVisible();
    await page.locator('[data-testid="debug-start"]').click();
    await expect(page.locator('[data-testid="debug-state"]')).toContainText('paused at trigger');
    await expect(page.locator('[data-testid="debug-step"]')).toBeVisible();
  });

  test('Step advances the session and grows the trace', async ({ page }) => {
    await gotoWithYaml(page);
    await page.locator('[data-testid="yaml-debug-toggle"]').click();
    await page.locator('[data-testid="debug-start"]').click();
    await page.locator('[data-testid="debug-step"]').click();
    await expect(page.locator('[data-testid="debug-trace"]')).toBeVisible();
    await expect(page.locator('[data-testid="debug-trace-row"]')).toHaveCount(1);
    await page.locator('[data-testid="debug-step"]').click();
    await expect(page.locator('[data-testid="debug-trace-row"]')).toHaveCount(2);
    // Terminal: step control disabled once done.
    await expect(page.locator('[data-testid="debug-step"]')).toBeDisabled();
  });

  test('Breakpoint toggles visually and Continue runs to done', async ({ page }) => {
    await gotoWithYaml(page);
    await page.locator('[data-testid="yaml-debug-toggle"]').click();
    await page.locator('[data-testid="debug-start"]').click();
    const bp = page.locator('[data-testid="debug-bp-create_alert"]');
    await bp.click();
    await expect(bp).toHaveClass(/on/);
    await page.locator('[data-testid="debug-continue"]').click();
    await expect(page.locator('[data-testid="debug-state"]')).toContainText('done');
    await expect(page.locator('[data-testid="debug-trace-row"]')).toHaveCount(2);
  });

  test('Stop ends the session; Start is offered again', async ({ page }) => {
    await gotoWithYaml(page);
    await page.locator('[data-testid="yaml-debug-toggle"]').click();
    await page.locator('[data-testid="debug-start"]').click();
    await expect(page.locator('[data-testid="debug-step"]')).toBeVisible();
    await page.locator('[data-testid="debug-stop"]').click();
    await expect(page.locator('[data-testid="debug-start"]')).toBeVisible();
  });
});
