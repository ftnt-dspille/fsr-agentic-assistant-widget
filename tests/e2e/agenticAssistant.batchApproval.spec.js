'use strict';
// Batched approval, in the DOM.
//
// A profile build is several writes proposed together. The connector puts
// them on ONE action card, and one click approves them all -- so before that
// click the analyst must see every write, each identifiable (the connector's
// summary is the same "Create <module>" line for all of them), and the button
// must say how much it approves.
//
// &fastmock=1 collapses fixture delays to ~30ms.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page) {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', e => errors.push(String(e)));
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
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=batch_approval&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
  await page.locator('[data-testid="chat-input"]').fill('set up this profile');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.locator('[data-testid="action-card-appr-batch"]')
    .waitFor({ state: 'visible', timeout: 15000 });
  return errors;
}

test.describe('batched approval card', () => {
  test('every write on the card is listed, by name, before approving', async ({ page }) => {
    const errors = await boot(page);
    const list = page.locator('[data-testid="action-batch-appr-batch"]');
    await expect(list).toBeVisible();
    await expect(list).toContainText('also covers 2 more changes');
    await expect(page.locator('[data-testid="action-batch-item-appr-batch-0"]'))
      .toContainText('Upgrade Firmware 7.6.8');
    await expect(page.locator('[data-testid="action-batch-item-appr-batch-1"]'))
      .toContainText('Post-Upgrade System Status');
    // The lead write still reads as its own change list.
    await expect(page.locator('[data-testid="action-change-appr-batch-name"]'))
      .toContainText('Pre-Upgrade System Status');
    expect(errors).toEqual([]);
  });

  test('the button says how much one click approves, and one click resolves it', async ({ page }) => {
    await boot(page);
    const confirm = page.locator('[data-testid="action-confirm-appr-batch"]');
    await expect(confirm).toHaveText('Approve all 3');
    await confirm.click();
    await expect(page.locator('text=All three steps were created.')).toBeVisible({ timeout: 15000 });
    // One decision, one resume -- not one per write.
    const events = await page.evaluate(() => window.__agenticAssistant__.events.slice());
    const resumes = events.filter(e => e.type === 'action_call' && e.payload.action === 'chat_resume');
    expect(resumes.length).toBe(1);
    expect(JSON.stringify(resumes[0].payload)).toContain('appr-batch');
  });
});
