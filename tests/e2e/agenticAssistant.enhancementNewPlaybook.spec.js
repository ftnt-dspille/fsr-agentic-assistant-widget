'use strict';
// An edit that adds a reusable child playbook. Apply SAVES the child (the
// designer canvas holds one playbook), so the card must say so before the
// click -- an analyst who discards the canvas afterwards would otherwise not
// know the new playbook exists.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

test('the edit card names the playbook Apply will save', async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build', maxTurns: 10
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
    localStorage.removeItem('fsrPbSession:build');
  }, WIDGET_ID);
  await page.goto(
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=enhancement_new_playbook&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  const card = page.locator('[data-testid="enhancement-offer-enh-child-1"]');
  await expect(card).toBeVisible({ timeout: 30000 });
  const note = page.locator('[data-testid^="enhancement-offer-line-enh-child-1-add"]')
    .filter({ hasText: 'Block One IP' });
  await expect(note).toBeVisible();
  await expect(note).toContainText('Adds the playbook "Block One IP"');
  await expect(note).toContainText('Apply saves it too');
  await expect(page.locator('[data-testid="enhancement-offer-trigger-enh-child-1"]'))
    .toHaveText('Runs when an alert is created');
});
