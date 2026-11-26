'use strict';
// A card that needs a configuration pick: Approve is disabled with a reason
// until one is chosen, and a refused approval re-shows the picker.
// &fastmock=1 collapses fixture delays to ~30ms.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder',
      defaultIntent: 'triage', maxTurns: 10, showUsage: true, seedFromEntity: false
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
    localStorage.removeItem('fsrPbSession:build');
  }, WIDGET_ID);
  await page.goto(
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=action_config_required&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
  await page.locator('[data-testid="chat-input"]').fill('block it');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.locator('[data-testid="action-confirm-cr-flag"]').waitFor({ state: 'visible', timeout: 15000 });
}

const REASON = 'Choose which configuration to run this on before approving.';

test.describe('action card: configuration required', () => {
  test('approve is disabled with a reason until a configuration is chosen', async ({ page }) => {
    await boot(page);
    const approve = page.locator('[data-testid="action-confirm-cr-flag"]');
    await expect(approve).toBeDisabled();
    await expect(page.locator('[data-testid="action-config-required-cr-flag"]')).toHaveText(REASON);
    const select = page.locator('[data-testid="action-runs-on-select-cr-flag"]');
    await expect(select.locator('option')).toHaveText(['Choose a configuration', 'fortigate-lab', 'fortigate-dr']);
    await select.selectOption('oth-1');
    await expect(approve).toBeEnabled();
    await expect(page.locator('[data-testid="action-config-required-cr-flag"]')).toHaveCount(0);
  });

  test('a refused approval re-shows the picker with the connector choices', async ({ page }) => {
    await boot(page);
    const approve = page.locator('[data-testid="action-confirm-cr-refuse"]');
    await expect(approve).toBeEnabled();
    await expect(page.locator('[data-testid="action-runs-on-select-cr-refuse"]')).toHaveCount(0);
    await approve.click();
    const select = page.locator('[data-testid="action-runs-on-select-cr-refuse"]');
    await expect(select.locator('option')).toHaveText(['Choose a configuration', 'fortigate-lab', 'fortigate-dr']);
    await expect(page.locator('[data-testid="action-config-required-cr-refuse"]')).toHaveText(REASON);
    await expect(approve).toBeDisabled();
    await select.selectOption('loc-1');
    await expect(approve).toBeEnabled();
  });
});
