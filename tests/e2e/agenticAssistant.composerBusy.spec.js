'use strict';
// Composer while a reply is in flight. The analyst can keep typing; Send is
// disabled with a visible reason; Enter does not send over an open turn. The
// textarea's data-idle attribute is the one "turn finished" signal the specs wait on.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

test('while a turn runs the analyst can type; Send is disabled and says why', async ({ page }) => {
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
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=composer_busy`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });

  const input = page.locator('[data-testid="chat-input"]');
  const send = page.locator('[data-testid="chat-send"]');
  await input.fill('Summarise the case');
  await send.click();

  // The turn is in flight: the composer is not locked, Send is disabled with a reason.
  await expect(input).toHaveAttribute('data-idle', 'false');
  await expect(input).toBeEnabled();
  await expect(send).toBeDisabled();
  await expect(send).toHaveAttribute('title', /Waiting for the reply/);

  // Typing during the turn is kept, and Enter does not send over the open turn.
  await input.fill('Also list the affected hosts');
  await input.press('Enter');
  await expect(input).toHaveValue('Also list the affected hosts');

  // When the turn settles the draft is still there and Send is available again.
  await expect(input).toHaveAttribute('data-idle', 'true', { timeout: 20000 });
  await expect(send).toHaveAttribute('title', '');
  expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
});
