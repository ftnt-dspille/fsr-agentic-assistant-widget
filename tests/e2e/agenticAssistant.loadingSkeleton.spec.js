'use strict';
// Drawer panels (History, Scheduled, Scheduled runs, Tools) show skeleton rows
// shaped like the list that is on its way, not a bare "Loading..." line.
//
// Drives the real path: the connector HTTP layer is stubbed, the panel is
// opened from the menu, and the panel's list call is held open so the loading
// state stays on screen while the spec reads it.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const CONTRACT = '2.8.0';
const envelope = (operation, data) => ({ operation, status: 'Success', message: 'ok', data });
const TASK = { name: 'nightly-sweep', cron: '0 2 * * *', prompt: 'Sweep new alerts', intent: 'triage' };

async function stubConnector(page, holdOp) {
  await page.route(/\/api\/integration\/connectors\//, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: [{ name: 'connector-fsr-agentic-assistant', version: CONTRACT,
      configuration: [{ name: 'fsrpb-live', config_id: 'cfg-live-1', default: true }] }] })
  }));
  await page.route(/\/api\/integration\/execute\//, async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* */ }
    const op = body.operation;
    if (op === holdOp) return new Promise(() => {});   // the list never arrives
    const data = op === 'list_scheduled_tasks' ? { ok: true, tasks: [TASK] } : { ok: true };
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(envelope(op, data)) });
  });
}

async function boot(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fsr-playbook-builder', defaultIntent: 'build',
      maxTurns: 10, showUsage: true, seedFromEntity: false, mockMode: 'real'
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mode=live`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true', { timeout: 25000 });
}

async function openMenuItem(page, testid) {
  await page.locator('[data-testid="overflow-menu"]').click();
  await page.locator('[data-testid="overflow-dropdown"]').waitFor();
  await page.locator(`[data-testid="${testid}"]`).click();
}

const PANELS = [
  { name: 'history', hold: 'list_sessions', testid: 'history-loading', rows: 4,
    open: (page) => openMenuItem(page, 'open-history') },
  { name: 'scheduled', hold: 'list_scheduled_tasks', testid: 'scheduled-loading', rows: 3,
    open: (page) => openMenuItem(page, 'open-scheduled-tasks') },
  { name: 'scheduled runs', hold: 'list_scheduled_task_runs', testid: 'scheduled-runs-loading', rows: 3,
    open: async (page) => {
      await openMenuItem(page, 'open-scheduled-tasks');
      await page.locator('[data-testid="scheduled-history"]').first().click();
    } },
  { name: 'tools', hold: 'list_agent_tools', testid: 'tools-loading', rows: 5,
    open: (page) => openMenuItem(page, 'open-tools') },
];

test.describe('drawer panels load with skeleton rows', () => {
  for (const p of PANELS) {
    test(`${p.name}: skeleton rows, no bare Loading text`, async ({ page }) => {
      await stubConnector(page, p.hold);
      await boot(page);
      await p.open(page);
      const box = page.locator(`[data-testid="${p.testid}"]`);
      await expect(box).toBeVisible();
      await expect(box).toHaveAttribute('role', 'status');
      await expect(box).toHaveAttribute('aria-label', /^Loading /);
      await expect(box.locator('.sk-row')).toHaveCount(p.rows);
      expect((await box.innerText()).trim()).toBe('');
      // The bars are painted, not zero-size placeholders.
      const bar = await box.locator('.sk-bar').first().boundingBox();
      expect(bar.width).toBeGreaterThan(40);
      expect(bar.height).toBeGreaterThan(5);
    });
  }
});
