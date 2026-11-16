'use strict';
// choice_card with allow_text -- "answer in your own words". Analyst ask: the
// "what should this playbook start from / do?" card should also take free
// text. Drives the mock `choice_text` fixture: the opener returns an
// awaiting_choice card with allow_text; typing + Send resumes with the TEXT as
// the value (the fixture only answers that exact value), and the card resolves.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build',
      maxTurns: 10, showUsage: true, seedFromEntity: true
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=choice_text&fastmock=1&opener=1`,
                  { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 });
}

const ID = 'create_playbook_scope';
const CARD = `[data-testid="choice-card-${ID}"]`;
const TEXT = `[data-testid="choice-${ID}-text"]`;
const SEND = `[data-testid="choice-${ID}-text-send"]`;

test.describe('choice card free text', () => {
  test('shows chips AND a text box; Send is disabled until something is typed', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await boot(page);
    await expect(page.locator(CARD)).toBeVisible();
    await expect(page.locator(`[data-testid="choice-${ID}-alert_start"]`)).toBeVisible();
    await expect(page.locator(TEXT)).toBeVisible();
    await expect(page.locator(SEND)).toBeDisabled();
    await page.locator(TEXT).fill('   ');
    await expect(page.locator(SEND)).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test('typing and pressing Send resumes with the text and resolves the card', async ({ page }) => {
    await boot(page);
    await page.locator(TEXT).fill('enrich alert IPs on VirusTotal');
    await expect(page.locator(SEND)).toBeEnabled();
    await page.locator(SEND).click();
    await expect(page.locator(`[data-testid="choice-resolution-${ID}"]`))
      .toContainText('enrich alert IPs on VirusTotal');
    await expect(page.locator(TEXT)).toHaveCount(0);            // box gone once answered
    await expect(page.locator('.fsr-pb-widget')).toContainText('VirusTotal enrichment');
  });

  test('Enter in the box sends', async ({ page }) => {
    await boot(page);
    await page.locator(TEXT).fill('enrich alert IPs on VirusTotal');
    await page.locator(TEXT).press('Enter');
    await expect(page.locator(`[data-testid="choice-resolution-${ID}"]`)).toBeVisible();
  });
});
