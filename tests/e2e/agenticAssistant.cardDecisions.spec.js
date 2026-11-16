'use strict';
// A card answered somewhere else comes back answered (live: a second analyst
// saw Confirm & Execute on an update the first had already approved). The
// history's card decisions close the card, name who answered it, and leave
// no live buttons; a card nobody answered keeps its buttons.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', maxTurns: 10, showUsage: true
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path&fastmock=1`,
                  { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 });
}

const TURNS = [
  { user: 'update the output template json' },
  { transcript: [
    { type: 'text', text: 'Here is the change.' },
    { type: 'action_card', id: 'card-done', approval_id: 'card-done', tool: 'update_record',
      summary: 'Update the template', args: { outputTemplateJSON: '[]' },
      target: { module: 'ztpf_automation_actions', uuid: 'a1' } },
    { type: 'action_card', id: 'card-open', approval_id: 'card-open', tool: 'update_record',
      summary: 'Update the status template', args: { outputStatusTemplate: 'ok' },
      target: { module: 'ztpf_automation_actions', uuid: 'a1' } },
  ] },
];

test('a card answered by another analyst replays answered, with no buttons', async ({ page }) => {
  await boot(page);
  await page.evaluate((turns) => window.__agenticAssistant__.replayTurns(turns, [
    { card_id: 'card-done', decision: 'approve', actor: 'Lead Analyst', decided_at: 1791918300 },
  ]), TURNS);

  await expect(page.locator('[data-testid="action-confirm-card-done"]')).toHaveCount(0);
  const footer = page.locator('[data-testid="action-resolution-card-done"]');
  await expect(footer).toContainText('Approved');
  await expect(footer).toContainText('Lead Analyst');
  // Nobody answered this one: its buttons stay.
  await expect(page.locator('[data-testid="action-confirm-card-open"]')).toBeVisible();
});

test('a decision that arrives while the card is open closes it', async ({ page }) => {
  await boot(page);
  await page.evaluate((turns) => window.__agenticAssistant__.replayTurns(turns, []), TURNS);
  await expect(page.locator('[data-testid="action-confirm-card-open"]')).toBeVisible();
  await page.evaluate(() => window.__agenticAssistant__.applyCardDecisions([
    { card_id: 'card-open', decision: 'reject', actor: 'Monitor queue', decided_at: 1791918400 },
  ]));
  await expect(page.locator('[data-testid="action-confirm-card-open"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="action-resolution-card-open"]')).toContainText('Rejected');
  await expect(page.locator('[data-testid="action-resolution-card-open"]')).toContainText('Monitor queue');
});
