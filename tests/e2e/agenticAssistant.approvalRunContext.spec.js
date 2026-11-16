'use strict';
// What has this playbook been doing lately? -- in the DOM.
//
// The connector has carried the run history structurally on every recorded
// run_playbook approval (five captures, two boxes) since the feature existed,
// and the widget read none of it. It reached the analyst only because the
// connector ALSO appends a slice to the summary text -- with a comment in
// operations.py saying that append exists precisely because no card layout
// rendered the structured form.
//
// Both branches are asserted. "Ran 16 times, last finished cleanly" and "never
// run before" are different decisions, and the card that cannot tell them apart
// is the one that was shipping.
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
  await page.locator('[data-testid="chat-input"]').fill('run the ztpf playbook');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.locator(`[data-testid="approval-card-${approvalId}"]`)
    .waitFor({ state: 'visible', timeout: 15000 });
  return errors;
}

test.describe('approval run history', () => {

  test('the card says what the playbook has been doing', async ({ page }) => {
    const errors = await boot(page, 'approval_run_playbook_new', 'ap-pb-1');
    const ctx = page.locator('[data-testid="approval-runcontext-ap-pb-1"]');

    await expect(ctx).toBeVisible();
    await expect(ctx).toContainText('Ran 16 times');
    await expect(ctx).toContainText('1 in the last 24h');
    await expect(ctx).toContainText('2026-08-10 (21h ago)');
    await expect(page.locator('[data-testid="approval-last-status-ap-pb-1"]'))
      .toContainText('finished');

    // Not twice. The connector appends the same facts to the summary for older
    // widgets; now that they render properly, the duplicate is stripped.
    await expect(page.locator('[data-testid="approval-summary"]'))
      .not.toContainText('Last run:');

    expect(errors).toEqual([]);
  });

  test('a first-ever run says so, instead of a count', async ({ page }) => {
    await boot(page, 'approval_never_run', 'ap-neverrun-1');
    await expect(page.locator('[data-testid="approval-never-run-ap-neverrun-1"]'))
      .toContainText('Never run before');
    // The silencing half: no invented history alongside it.
    await expect(page.locator('[data-testid="approval-runcontext-ap-neverrun-1"]'))
      .not.toContainText('Ran 0 times');
  });

  test('an approval with no run context shows no history line at all', async ({ page }) => {
    // A containment approval carries no `context`. Rendering an empty history
    // row there would be the widget asserting something the connector never
    // said.
    await boot(page, 'approval_containment', 'ap-containment-1');
    await expect(page.locator('[data-testid="approval-runcontext-ap-containment-1"]'))
      .toHaveCount(0);
  });
});
