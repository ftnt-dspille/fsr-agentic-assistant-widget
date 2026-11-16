'use strict';
// ─── C1/C2 -- render robustness (DOM) ─────────────────────────────────────────
//
// C1: an info_card block with an UNKNOWN kind no longer collapses to an empty
//     rows block (blank); its text content still renders.
// C2: capability_gap tips/alternatives/resume sent as BARE STRINGS still render
//     (tips assumed tip.text; alternatives assumed alt.label/.value) and a
//     bare-string alternative resumes with the string value.
//
// Drives the render_robustness fixture (an info_card with a callout block + a
// bare-string capability_gap).

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
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'triage', maxTurns: 10
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=render_robustness&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 });
  return errors;
}

const CARD = '[data-testid="capability-gap-card-capgap-bare-1"]';

test.describe('C1/C2 -- render robustness', () => {
  test('C1: unknown info_card block renders its text (not blank); known block still renders', async ({ page }) => {
    const errors = await boot(page);
    const info = page.locator('[data-testid="info-card-ic-robust-1"]');
    await expect(info).toBeVisible();
    await expect(info).toContainText('Unknown-kind block still shows this text');
    await expect(info).toContainText('smithDesktop');   // the known rows block still works
    expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('C3: a ragged info_card table pads short rows and clips long ones to columns.length', async ({ page }) => {
    const errors = await boot(page);
    const table = page.locator('[data-testid="info-card-ic-robust-1"] table.status-table');
    await expect(table).toBeVisible();
    // 3 headers → every body row must have exactly 3 cells.
    await expect(table.locator('thead th')).toHaveCount(3);
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('td')).toHaveCount(3);   // short row padded
    await expect(rows.nth(1).locator('td')).toHaveCount(3);   // long row clipped
    // clipped cell is gone; padded cell is blank
    await expect(table).not.toContainText('EXTRA-CLIPPED');
    await expect(rows.nth(0).locator('td').nth(0)).toHaveText('short');
    await expect(rows.nth(0).locator('td').nth(2)).toHaveText('');
    expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('C4: error renders in its dedicated frame and known cards never double-render as raw JSON', async ({ page }) => {
    await boot(page);
    const widget = page.locator('.fsr-pb-widget');
    // the error event draws its own .step-error frame (not the catch-all)
    const errFrame = widget.locator('.step-error');
    await expect(errFrame).toHaveCount(1);
    await expect(errFrame.locator('.step-name')).toContainText('error');
    await expect(widget.locator('.step-name', { hasText: /^playbook_offer/ })).toHaveCount(0);
  });

  test('C2: bare-string tips + alternatives render; the alternative resumes with its value', async ({ page }) => {
    await boot(page);
    const card = page.locator(CARD);
    await expect(card).toBeVisible();

    // tips: two bare strings → two visible, non-blank list items
    await expect(card.locator('.capgap-tips li')).toHaveCount(2);
    await expect(card.locator('.capgap-tips li').first()).toContainText('Keep a response connector healthy');

    // resume: bare string → label used on the button
    await expect(card.locator('[data-testid="capgap-resume-capgap-bare-1"]')).toContainText('recheck');

    // alternative: bare string → label AND value both "escalate_t2"
    const alt = card.locator('[data-testid="capgap-alt-capgap-bare-1-escalate_t2"]');
    await expect(alt).toBeVisible();
    await expect(alt).toContainText('escalate_t2');

    // clicking it resumes with value "escalate_t2" → the matched turn renders
    await alt.click();
    await expect(page.locator('[data-testid="capgap-resolution-capgap-bare-1"]')).toBeVisible();
    await expect(page.locator('.fsr-pb-widget')).toContainText('Escalated to tier 2');
  });
});
