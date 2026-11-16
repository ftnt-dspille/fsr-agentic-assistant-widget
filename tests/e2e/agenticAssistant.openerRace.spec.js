'use strict';
// The greeting turn ("Greet first" / ?opener=1) waits up to ~2s for the host
// record to resolve. An analyst who sends a message inside that window must
// not get the greeting afterwards as a second, unrelated assistant turn.
const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

test('a message sent before the greeting fires suppresses the greeting', async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', maxTurns: 10
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && window.__agenticAssistant__.state === 'idle',
    null, { timeout: 30000 });

  // Send straight away: on a dashboard the entity never resolves, so the
  // greeting is still waiting out its retries.
  await page.locator('[data-testid="chat-input"]').fill('block 203.0.113.45');
  await page.locator('[data-testid="chat-input"]').press('Enter');

  const replies = page.locator('.pb-message.assistant');
  await expect(replies).toHaveCount(1, { timeout: 10000 });
  // Outlast the greeting's retry window, then check nothing else arrived.
  await page.waitForTimeout(3500);
  await expect(replies).toHaveCount(1);
});
