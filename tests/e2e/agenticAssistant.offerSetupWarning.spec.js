'use strict';
// Offer cards for a connector the analyst cannot use yet show an amber setup
// notice (message + ordered steps) and keep Accept enabled: a warning, not a gate.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page, mock) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build', maxTurns: 10
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
    localStorage.removeItem('fsrPbSession:build');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=${mock}&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
}

for (const [mock, prefix, id] of [
  ['playbook_offer_setup', 'playbook-offer', 'pb-offer-c2-1-setup'],
  ['enhancement_offer_setup', 'enhancement-offer', 'enh-child-1-setup'],
]) {
  test(`${prefix} shows the setup notice and keeps accept enabled`, async ({ page }) => {
    await boot(page, mock);
    const first = page.locator(`[data-testid="${prefix}-setup-${id}-0"]`);
    const second = page.locator(`[data-testid="${prefix}-setup-${id}-1"]`);
    await expect(first).toBeVisible({ timeout: 30000 });
    await expect(first).toContainText('which is not set up yet');
    await expect(first.locator('ol li')).toHaveText(['Open Connectors and add FortiEDR.', 'Enter the server address and credentials.']);
    await expect(second).toContainText('not shared with your team');
    await expect(second.locator('ol li')).toHaveCount(1);
    await expect(first).not.toContainText(/not_configured|fortiedr/);
    await expect(second).not.toContainText(/not_shared/);
    await expect(page.locator(`[data-testid="${prefix}-accept-${id}"]`)).toBeEnabled();
  });
}
