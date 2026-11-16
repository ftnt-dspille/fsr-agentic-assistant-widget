'use strict';
// A playbook pause with a choice of buttons, reached through "Approve & always
// allow" on the run card. Drives the manual_input_choice fixture, whose resume
// entries only match when the wire carries the right value (the fallback reply
// says WRONG), and asserts:
//   - the run card offers "Approve & always allow" and it sends remember
//   - the pause renders its own buttons, not Approve & Continue / Reject
//   - the prompt renders as markdown: bold, and the data as a code block
//   - the chosen button's label reaches respond_manual_input as `option`

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'triage',
      maxTurns: 10, showUsage: true, seedFromEntity: false
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=manual_input_choice&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 });
  await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true', { timeout: 25000 });
  await page.locator('[data-testid="chat-input"]').fill('validate this metadata source');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.locator('[data-testid="approval-card-ap-1"]').waitFor({ state: 'visible', timeout: 15000 });
  return errors;
}

const CARD = '[data-testid="manual-input-652"]';

test.describe('manual_input choice of buttons', () => {
  test('always allow, then the pause shows its own buttons and sends the chosen one', async ({ page }) => {
    const errors = await boot(page);
    const always = page.locator('[data-testid="approval-always-allow-ap-1"]');
    await expect(always).toHaveText('Approve & always allow');
    await expect(page.locator('[data-testid="approval-approve"]')).toBeVisible();
    await always.click();

    await expect(page.locator(CARD)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=WRONG')).toHaveCount(0);

    const prompt = page.locator('[data-testid="manual-input-prompt-652"]');
    await expect(prompt.locator('strong')).toHaveText('Metadata Results');
    await expect(prompt.locator('pre.md-code')).toContainText('"available"');

    const ok = page.locator('[data-testid="manual-input-option-652-0"]');
    const save = page.locator('[data-testid="manual-input-option-652-1"]');
    await expect(ok).toHaveText('Ok');
    await expect(ok).toHaveClass(/primary/);
    await expect(save).toHaveText('Save Example');
    await expect(page.locator('[data-testid="manual-input-submit-652"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="manual-input-reject-652"]')).toHaveCount(0);

    await save.click();
    await expect(page.locator('text=Saved the collected data as an example.')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=WRONG')).toHaveCount(0);
    await expect(page.locator(CARD + ' .pb-outcome')).toHaveText('Save Example');
    expect(errors).toEqual([]);
  });

  test('plain Approve does not grant', async ({ page }) => {
    await boot(page);
    await page.locator('[data-testid="approval-approve"]').click();
    await expect(page.locator('text=WRONG: the approval arrived without remember.')).toBeVisible({ timeout: 15000 });
  });
});
