'use strict';
// Where an approved action runs, on the card (agent-bound configs).
//
// The card used to carry no connector configuration, so every approval ran on
// the connector's default. Asked live to block an address through a
// FortiSOAR-agent config, the chat staged a card without it and the block ran
// on the master instead -- and nothing on the card could have told the analyst.
// Now the card names its config, offers a picker when there is more than one,
// and says an agent run is slower. The picker's value is what Approve sends.
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
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=action_runs_on&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
  await page.locator('[data-testid="chat-input"]').fill('block it');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.locator('[data-testid="action-runs-on-ro-agent"]')
    .waitFor({ state: 'visible', timeout: 15000 });
  return errors;
}

async function approvePayload(page, cardId) {
  await page.locator(`[data-testid="action-confirm-${cardId}"]`).click();
  await page.waitForFunction((id) => window.__agenticAssistant__.events.some(
    e => e.type === 'action_call' && e.payload.action === 'chat_resume' && e.payload.card_id === id),
    cardId, { timeout: 15000 });
  const events = await page.evaluate(() => window.__agenticAssistant__.events.slice());
  return events.find(e => e.type === 'action_call' && e.payload.action === 'chat_resume'
    && e.payload.card_id === cardId).payload;
}

test.describe('action card: runs on', () => {

  test('the agent config is preselected and the slower result is called out', async ({ page }) => {
    const errors = await boot(page);
    const select = page.locator('[data-testid="action-runs-on-select-ro-agent"]');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('agt-1');
    await expect(select.locator('option')).toHaveText(
      ['fortigate-lab', 'Lab FortiGate (on agent edge-agent)']);
    await expect(page.locator('[data-testid="action-runs-on-agent-note-ro-agent"]'))
      .toContainText('FortiSOAR agent');
    expect(errors).toEqual([]);
  });

  test('a single config is a plain line: no picker, no agent note', async ({ page }) => {
    await boot(page);
    await expect(page.locator('[data-testid="action-runs-on-select-ro-single"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="action-runs-on-value-ro-single"]')).toHaveText('FortiEDR');
    await expect(page.locator('[data-testid="action-runs-on-agent-note-ro-single"]')).toHaveCount(0);
  });

  test('approve sends the preselected config', async ({ page }) => {
    await boot(page);
    expect((await approvePayload(page, 'ro-agent')).config).toBe('agt-1');
  });

  test('switching to the local config drops the agent note and is what approve sends', async ({ page }) => {
    await boot(page);
    await page.locator('[data-testid="action-runs-on-select-ro-agent"]').selectOption('loc-1');
    await expect(page.locator('[data-testid="action-runs-on-agent-note-ro-agent"]')).toHaveCount(0);
    expect((await approvePayload(page, 'ro-agent')).config).toBe('loc-1');
    // Once decided the picker becomes the line it ran on.
    await expect(page.locator('[data-testid="action-runs-on-value-ro-agent"]')).toHaveText('fortigate-lab');
  });
});
