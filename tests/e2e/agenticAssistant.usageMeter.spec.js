'use strict';
// Topbar usage meter. The multi_tool fixture carries one usage round
// (2,100 in, 480 out, $0.0158). The meter must read that round exactly once:
// the live feed and the committed transcript both carry it, and an earlier
// build double-counted or showed only the last round. The tooltip spells the
// split out in words.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function gotoMultiTool(page) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder',
      defaultIntent: 'build', maxTurns: 10, showUsage: true
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=multi_tool`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
  return errors;
}

test('the header meter counts the turn once and the tooltip names the split', async ({ page }) => {
  const errors = await gotoMultiTool(page);

  await page.locator('[data-testid="chat-input"]').fill('Build me a ping playbook');
  await page.locator('[data-testid="chat-send"]').click();
  await page.waitForFunction(
    () => window.__agenticAssistant__ && window.__agenticAssistant__.state === 'idle',
    null, { timeout: 15000 });

  const meter = page.locator('[data-testid="usage-panel"]');
  await expect(meter).toBeVisible();
  // 2,100 + 480 = 2,580 once, not twice and not just the last round.
  await expect(meter).toContainText('2,580 tok');
  await expect(meter).toContainText('$0.0158');
  await expect(meter).toHaveAttribute('title', '2,100 in · 480 out · $0.0158');

  expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
});
