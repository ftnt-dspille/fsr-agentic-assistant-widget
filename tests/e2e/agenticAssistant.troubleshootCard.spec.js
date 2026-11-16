'use strict';
// U7: the troubleshoot card for a failed playbook run. Drives two recorded
// failed-run fixtures through the chat and asserts the DOM: the failing step in
// words, the safety line, one primary action, and no raw code above Details.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function gotoFailedRun(page, scenario) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'triage', maxTurns: 10
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=${scenario}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
  await page.locator('[data-testid="chat-input"]').fill('Why did Block Malicious IP fail?');
  await page.locator('[data-testid="chat-send"]').click();
  await page.waitForFunction(
    () => window.__agenticAssistant__ && window.__agenticAssistant__.state === 'idle',
    null, { timeout: 15000 });
  return errors;
}

test('a failed run with a bad template input: failing step in words, playbook change, Fix the playbook', async ({ page }) => {
  const errors = await gotoFailedRun(page, 'playbook_failed_run');
  const card = page.locator('[data-testid^="troubleshoot-card-"]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Why "Block Malicious IP on FortiGate" failed');
  await expect(card.locator('[data-testid="troubleshoot-steps"]')).toContainText('Set Inputs: failed, an input came out empty.');
  await expect(card.locator('[data-testid="troubleshoot-fix"]')).toContainText('Fix the input of step "Set Inputs"');
  await expect(card.locator('[data-testid="troubleshoot-safety"]')).toContainText('Playbook change needed');
  await expect(card.locator('[data-testid="troubleshoot-safety"]')).toContainText('nothing was run or changed');

  // One primary action, and it matches the fix.
  await expect(card.locator('[data-testid="troubleshoot-primary"]')).toHaveText('Fix the playbook');
  await card.locator('[data-testid="troubleshoot-primary"]').click();
  await expect(page.locator('[data-testid="chat-input"]')).toHaveValue(/Fix the input of step "Set Inputs"/);

  // Raw codes and error text are not above Details.
  const collapsed = await card.evaluate(el => {
    const clone = el.cloneNode(true);
    clone.querySelector('[data-testid="troubleshoot-details"]').remove();
    return clone.textContent;
  });
  expect(collapsed).not.toMatch(/render_error|empty_render|dict object/);
  await expect(card.locator('[data-testid="troubleshoot-raw-error"]')).toContainText('dict object');
  expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
});

test('a failed run where every input filled in: no playbook change, Run again', async ({ page }) => {
  const errors = await gotoFailedRun(page, 'playbook_failed_connection');
  const card = page.locator('[data-testid^="troubleshoot-card-"]');
  await expect(card).toHaveCount(1);
  await expect(card.locator('[data-testid="troubleshoot-steps"]')).toContainText('The run ended as failed');
  await expect(card.locator('[data-testid="troubleshoot-safety"]')).toContainText('No playbook change needed');
  await expect(card.locator('[data-testid="troubleshoot-primary"]')).toHaveText('Run again');
  await expect(card.locator('[data-testid="troubleshoot-details"] summary')).toContainText('Details');
  expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
});
