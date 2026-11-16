'use strict';
// The live playbook approval (ZTPF automation action): it read
// "Approval required: run_playbook  tier 3", "Record /api/3/...", "Follow true",
// "Timeout 180", and sat in a box inside another box.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

test('a playbook approval reads in plain words, in one box', async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', maxTurns: 10 }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path&fastmock=1`,
                  { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 });
  await page.evaluate(() => window.__agenticAssistant__.replayTurns([
    { user: 'render it' },
    { transcript: [{ type: 'approval_request', approval_id: 'ap-pb', tool: 'run_playbook', tier: 3,
      summary: 'Run playbook: Render Script Payload - Action',
      preview: { tool: 'run_playbook', args: {
        playbook: 'Render Script Payload - Action',
        record: '/api/3/ztpf_automation_actions/cc33ee85-1836-458e-8f01-8b6bf9bf03c8',
        follow: true, timeout: 180 } } }] },
  ]));

  const card = page.locator('[data-testid="approval-card-ap-pb"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.approval-card-head')).toContainText('Run playbook');
  await expect(card).not.toContainText('run_playbook');
  await expect(card).not.toContainText('tier 3');
  await expect(card).not.toContainText('/api/3/');
  await expect(card.locator('[data-testid="approval-tier-ap-pb"]')).toHaveText('Changes data');
  await expect(card.locator('[data-testid="approval-arg-record"]')).toContainText('Ztpf automation actions record');
  await expect(card.locator('[data-testid="approval-arg-follow"]')).toHaveCount(0);
  await expect(card.locator('[data-testid="approval-arg-timeout"]')).toHaveCount(0);
  // One box: the step row around the card draws no border of its own.
  const stepBorder = await card.evaluate((el) =>
    getComputedStyle(el.closest('.pb-step')).borderTopWidth);
  expect(stepBorder).toBe('0px');
  if (process.env.APPROVAL_SHOT) await card.screenshot({ path: process.env.APPROVAL_SHOT });
});
