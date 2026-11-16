'use strict';
// The record-write approval card, in the DOM (#78 / #120).
//
// The analyst is being asked to authorise a write. From an args blob they
// cannot see the one thing that matters most -- that the uuid is not the record
// on their screen. The connector has shipped `target` / `changes` /
// `context_match` on these cards since #78; the widget dropped all three, so
// the card looked exactly as it did before. A live producer with no consumer
// reads, from either side, like the feature not existing.
//
// Both branches are asserted in the same fixture and the same turn, because the
// pair is the property: a card that renders the same thing for "this is your
// record" and "this is some other record" is not gating anything.
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
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=record_write_target&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
  await page.locator('[data-testid="chat-input"]').fill('raise the severity');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.locator('[data-testid="action-card-rw-different"]')
    .waitFor({ state: 'visible', timeout: 15000 });
  return errors;
}

test.describe('record-write approval card', () => {

  test('a write aimed elsewhere is called out, and one on this record is not', async ({ page }) => {
    const errors = await boot(page);

    // THE WARNING. This is the whole feature: the card the analyst is about to
    // approve is not the record they have open.
    const warn = page.locator('[data-testid="action-context-different-rw-different"]');
    await expect(warn).toBeVisible();
    await expect(warn).toContainText('NOT the record you have open');

    // The silencing half, in the same turn: the card that DOES target the open
    // record carries no warning. A banner on every write is a banner nobody
    // reads.
    await expect(page.locator('[data-testid="action-context-different-rw-same"]'))
      .toHaveCount(0);
    await expect(page.locator('[data-testid="action-context-same-rw-same"]')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('the card names the record instead of hiding it in an args dump', async ({ page }) => {
    await boot(page);
    const target = page.locator('[data-testid="action-target-rw-same"]');
    await expect(target).toBeVisible();
    // The analyst reads the kind of record and its name; the module key and
    // uuid are ids and never print.
    await expect(target).toContainText('Alert');
    await expect(target).toContainText('Suspicious outbound beacon');
    await expect(target).not.toContainText('alerts');
    await expect(target).not.toContainText('d39ecc9a');
  });

  test('the change reads as before -> after, not as a value with no context', async ({ page }) => {
    await boot(page);
    const row = page.locator('[data-testid="action-change-rw-same-severity"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Severity');
    await expect(row).toContainText('Low');
    await expect(row).toContainText('Critical');
  });

  test('the args editor still works on a write card', async ({ page }) => {
    // The diff is additive. If it had replaced the editable args, approving a
    // write with a corrected value would have quietly stopped being possible.
    await boot(page);
    // The diff shows the change; the form, which repeats every value in
    // full, opens on request.
    const input = page.locator('[data-testid="action-arg-rw-same-severity"]');
    await expect(input).toHaveCount(0);
    await page.locator('[data-testid="action-edit-toggle-rw-same"]').click();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('Critical');
  });
});
