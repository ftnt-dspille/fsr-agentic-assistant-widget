'use strict';
// Module LIST mount (DOM). With no record open but a module on the page, the
// drawer used to show nothing but the generic SOC opener. It now works in the
// listed module: a list deck ("Create new <record>", ...) and a "Working in
// <module>" hero, and never the record decks that need a record open.
// `?listModule=` stands in for the router's main.modules.list state.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { waitForWidgetIdle } = require('../../../../fortisoar-widget-harness/tests/e2e/_waitForWidgetIdle');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

test('list page: module deck replaces the record decks', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({ maxTurns: 10, seedFromEntity: true }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);

  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path&fastmock=1&listModule=alerts`,
    { waitUntil: 'domcontentloaded' });
  await waitForWidgetIdle(page, '__agenticAssistant__');

  const deck = page.locator('[data-testid="list-quick-actions"]');
  await expect(deck).toBeVisible();
  await expect(deck.locator('.qa-label')).toContainText(/alerts/i);
  await expect(page.locator('[data-testid="list-quick-action-list_create"]')).toContainText(/Create new alert/i);
  await expect(page.locator('[data-testid="list-quick-action-list_attention"]')).toBeVisible();

  // Record decks need a record open -- never shown over a list.
  await expect(page.locator('[data-testid="quick-actions"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="persona-quick-actions"]')).toHaveCount(0);

  // A card sends a turn and the deck collapses once the conversation starts.
  await page.locator('[data-testid="list-quick-action-list_summary"]').click();
  await expect(deck).toHaveCount(0);

  expect(errors, 'no errors: ' + errors.join(' | ')).toEqual([]);
});
