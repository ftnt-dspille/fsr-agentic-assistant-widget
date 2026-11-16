'use strict';
// Approval card -- the guardrail surface a human actually reads before
// authorising a change. Two defects are locked in here:
//
//   1. Args rendered as a raw JSON.stringify dump in a <pre>. They now render
//      as a labelled table (indicator / indicator type / collector ID), with the
//      raw payload behind a "show raw" toggle.
//   2. The footer claimed "Approved" on any 200 from chat_resume, even when the
//      approved tool never ran -- so a containment action that silently failed
//      looked successful. The footer now states the OUTCOME.
//
// All scenarios append &fastmock=1 so fixture delays collapse to ~30ms.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page, scenario, approvalId) {
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
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=${scenario}&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });

  // Send anything -- the fixture drives the scripted turn.
  await page.locator('[data-testid="chat-input"]').fill('block 198.51.100.3');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.locator(`[data-testid="approval-card-${approvalId}"]`)
    .waitFor({ state: 'visible', timeout: 15000 });
  return errors;
}

test.describe('approval card', () => {

  test('args render as a labelled table, not a raw JSON dump', async ({ page }) => {
    const errors = await boot(page, 'approval_containment', 'ap-containment-1');
    const card = page.locator('[data-testid="approval-card-ap-containment-1"]');

    // The human-readable summary heads the card.
    await expect(page.locator('[data-testid="approval-summary"]'))
      .toContainText('Block 198.51.100.3 at the perimeter.');
    // The header names the action in words, not the wire name.
    await expect(page.locator('[data-testid="approval-title-ap-containment-1"]'))
      .toHaveText('SOC Framework: block indicator');
    await expect(card.locator('.approval-card-head')).not.toContainText('mcp_soc__');

    // Labelled rows -- what is being changed, at a glance.
    const table = page.locator('[data-testid="approval-argtable"]');
    await expect(table).toBeVisible();
    await expect(page.locator('[data-testid="approval-arg-indicator"]'))
      .toContainText('198.51.100.3');
    await expect(page.locator('[data-testid="approval-arg-indicator_type"]'))
      .toContainText('IP Address');
    await expect(table).toContainText('Indicator type');   // humanized key
    await expect(table).toContainText('Collector ID');     // acronym preserved

    // The brace-matched blob is NOT what greets the analyst.
    await expect(page.locator('[data-testid="approval-raw"]')).toHaveCount(0);
    await expect(card).not.toContainText('"indicator_type":');

    expect(errors).toEqual([]);
  });

  test('raw arguments are available behind a toggle', async ({ page }) => {
    await boot(page, 'approval_containment', 'ap-containment-1');

    const toggle = page.locator('[data-testid="approval-raw-toggle"]');
    await expect(toggle).toBeVisible();
    await toggle.click();

    const raw = page.locator('[data-testid="approval-raw"]');
    await expect(raw).toBeVisible();
    await expect(raw).toContainText('"indicator_type"');
    await expect(raw).toContainText('Quarantine Based');   // nested object survives

    await toggle.click();
    await expect(raw).toHaveCount(0);
  });

  test('an executed action reports Approved and executed', async ({ page }) => {
    await boot(page, 'approval_containment', 'ap-containment-1');

    await page.locator('[data-testid="approval-approve"]').click();
    const outcome = page.locator('[data-testid="approval-outcome"]');
    await expect(outcome).toBeVisible({ timeout: 15000 });
    await expect(outcome).toContainText('Approved and executed');
  });

  test('an approved action that never ran does NOT read as successful', async ({ page }) => {
    // The production defect: 200 from chat_resume, tool absent from REGISTRY.
    await boot(page, 'approval_never_ran', 'ap-containment-2');

    await page.locator('[data-testid="approval-approve"]').click();
    const outcome = page.locator('[data-testid="approval-outcome"]');
    await expect(outcome).toBeVisible({ timeout: 15000 });
    await expect(outcome).toContainText('did not run');
    await expect(outcome).not.toContainText('Approved and executed');

    // The reason is surfaced, not swallowed.
    await expect(page.locator('[data-testid="approval-outcome-error"]'))
      .toContainText('unknown tool');
  });

  test('an approval that expired says so in plain words, not connector plumbing', async ({ page }) => {
    await boot(page, 'approval_expired', 'ap-containment-2');

    await page.locator('[data-testid="approval-approve"]').click();
    const outcome = page.locator('[data-testid="approval-outcome"]');
    await expect(outcome).toHaveText('Expired -- nothing ran', { timeout: 15000 });
    const detail = page.locator('[data-testid="approval-outcome-error"]');
    await expect(detail).toContainText('approvals last 10 minutes');
    await expect(detail).not.toContainText('suspended session');
    await expect(detail).not.toContainText('ap-containment-2');
  });
});
