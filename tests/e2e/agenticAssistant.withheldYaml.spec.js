'use strict';
// A playbook typed into the reply is NOT loaded: only a verified offer card
// fills the YAML pane Save compiles. The reply-text playbook is offered back
// behind the "written, but not loaded" notice (DOM wiring; the rule itself is
// covered by tests/yaml.readonly.withhold.test.js and friends).
//
// `validate_errors` is a reply-text-only build turn (its draft fails verify,
// so the connector attaches no offer card): exactly the case the notice is for.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const NOTICE = '[data-testid="withheld-yaml-notice"]';
const UNVERIFIED = '[data-testid="withheld-yaml-unverified"]';

async function boot(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fsr-playbook-builder', defaultIntent: 'build',
      maxTurns: 10, showUsage: true, seedFromEntity: false
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=validate_errors&fastmock=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 });
}

async function sendAndSettle(page, text) {
  await page.locator('[data-testid="chat-input"]').fill(text);
  await page.locator('[data-testid="chat-send"]').click();
  await page.waitForFunction(
    () => window.__agenticAssistant__.messageCount >= 2
          && window.__agenticAssistant__.state === 'idle',
    null, { timeout: 10000 });
}

test.describe('Reply-text playbook is held, not loaded', () => {
  test('the notice explains it was not checked; the pane stays empty', async ({ page }) => {
    await boot(page);
    await sendAndSettle(page, 'Draft a broken playbook');

    await expect(page.locator(NOTICE)).toBeVisible();
    await expect(page.locator(NOTICE)).toContainText('A playbook was written, but not loaded');
    await expect(page.locator(UNVERIFIED)).toHaveText(
      'It is in the reply but was not checked, so your current YAML is untouched.');
    const yaml = await page.evaluate(() => window.__agenticAssistant__.currentYaml);
    expect(yaml).toBeFalsy();
  });

  test('"Load it anyway" loads the reply-text playbook and clears the notice', async ({ page }) => {
    await boot(page);
    await sendAndSettle(page, 'Draft a broken playbook');

    await page.locator('[data-testid="apply-withheld-yaml"]').click();
    await expect(page.locator(NOTICE)).toHaveCount(0);
    const yaml = await page.evaluate(() => window.__agenticAssistant__.currentYaml);
    expect(yaml).toContain('name: Broken Example');
  });

  test('"Dismiss" clears the notice and loads nothing', async ({ page }) => {
    await boot(page);
    await sendAndSettle(page, 'Draft a broken playbook');

    await page.locator('[data-testid="dismiss-withheld-yaml"]').click();
    await expect(page.locator(NOTICE)).toHaveCount(0);
    const yaml = await page.evaluate(() => window.__agenticAssistant__.currentYaml);
    expect(yaml).toBeFalsy();
  });
});
