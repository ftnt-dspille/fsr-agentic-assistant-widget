'use strict';
// A tier-4 approval must not look like a tier-2 one.
//
// `tier` and `requires_step_up` ride every recorded approval -- five captures on
// two boxes -- and the widget read neither, so the most destructive class of
// action asked for consent in exactly the same words, with the same two buttons,
// as the mildest. P2 says a state-changing action is gated on what the analyst
// can actually see.
//
// Both branches are asserted, because a badge on every approval is a badge
// nobody reads: the tier-4 fixture shows the step-up notice, and the tier-3
// containment fixture -- the shape every capture actually has -- does not.
//
// &fastmock=1 collapses fixture delays to ~30ms.

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
  await page.locator('[data-testid="chat-input"]').fill('contain this host');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.locator(`[data-testid="approval-card-${approvalId}"]`)
    .waitFor({ state: 'visible', timeout: 15000 });
  return errors;
}

test.describe('approval tier and step-up', () => {

  test('a tier-4 action says so, in its own line', async ({ page }) => {
    const errors = await boot(page, 'approval_step_up', 'ap-stepup-1');

    const stepUp = page.locator('[data-testid="approval-stepup-ap-stepup-1"]');
    await expect(stepUp).toBeVisible();
    await expect(stepUp).toContainText('Step-up authorisation');

    await expect(page.locator('[data-testid="approval-tier-ap-stepup-1"]'))
      .toContainText('High impact');

    expect(errors).toEqual([]);
  });

  test('a tier-3 approval shows the tier and NO step-up notice', async ({ page }) => {
    // The silencing case, and the one every capture actually shows: tier 3,
    // requires_step_up false. If the notice fired here it would be on every
    // real approval on a box, which is the same as not having it.
    await boot(page, 'approval_containment', 'ap-containment-1');

    await expect(page.locator('[data-testid="approval-tier-ap-containment-1"]'))
      .toContainText('Changes data');
    await expect(page.locator('[data-testid="approval-stepup-ap-containment-1"]'))
      .toHaveCount(0);
  });
});
