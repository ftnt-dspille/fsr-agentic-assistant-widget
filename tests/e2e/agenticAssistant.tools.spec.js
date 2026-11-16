'use strict';
// Overflow (⋯) menu + read-only Tools panel.
//
// The low-frequency top-bar actions (History, Export, Settings) now live behind
// a single overflow menu, which also hosts a new "Tools" item. Tools opens a
// read-only panel listing what the agent can do on the mounted module (always
// triage intent). This exercises the menu → tools flow against the happy_path
// list_agent_tools fixture.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function gotoWidget(page) {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder',
      defaultIntent: 'build', maxTurns: 10, showUsage: true
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ &&
          typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
  return errors;
}

test.describe('FSR Agentic Assistant — overflow menu + tools', () => {

  test('top bar shows only the overflow button + New (History/Export/Settings folded in)', async ({ page }) => {
    await gotoWidget(page);
    // The individual action buttons are no longer in the top bar directly.
    await expect(page.locator('[data-testid="overflow-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="new-conversation"]')).toBeVisible();
    await expect(page.locator('[data-testid="overflow-dropdown"]')).toHaveCount(0);

    // Opening the menu reveals all four items.
    await page.locator('[data-testid="overflow-menu"]').click();
    await expect(page.locator('[data-testid="overflow-dropdown"]')).toBeVisible();
    for (const id of ['open-tools', 'open-history', 'open-export', 'open-settings']) {
      await expect(page.locator(`[data-testid="${id}"]`)).toBeVisible();
    }
  });

  test('backdrop click closes the menu without opening anything', async ({ page }) => {
    await gotoWidget(page);
    await page.locator('[data-testid="overflow-menu"]').click();
    await expect(page.locator('[data-testid="overflow-dropdown"]')).toBeVisible();
    await page.locator('[data-testid="overflow-backdrop"]').click();
    await expect(page.locator('[data-testid="overflow-dropdown"]')).toHaveCount(0);
  });

  test('Tools item opens the panel and lists the agent tools with tier + write markers', async ({ page }) => {
    const errors = await gotoWidget(page);

    await page.locator('[data-testid="overflow-menu"]').click();
    await page.locator('[data-testid="open-tools"]').click();

    await expect(page.locator('[data-testid="tools-overlay"]')).toBeVisible();
    // Opening a panel closes the menu it came from.
    await expect(page.locator('[data-testid="overflow-dropdown"]')).toHaveCount(0);

    const items = page.locator('[data-testid="tools-item"]');
    await expect(items).toHaveCount(3);
    await expect(page.locator('[data-testid="tools-name"]').first()).toHaveText('get_record');

    // The tier-3 write tool carries the ✏ write marker; the reads do not.
    const writeMarks = page.locator('[data-testid="tools-write"]');
    await expect(writeMarks).toHaveCount(1);

    await expect(page.locator('[data-testid="tools-count"]')).toContainText('3 tools');

    // Tier badges render as labelled chips (t1/t3), not bare numbers, and the
    // tier-3 write chip carries the amber `tier-write` class.
    const tiers = page.locator('[data-testid="tools-tier"]');
    await expect(tiers.first()).toHaveText('t1');
    await expect(page.locator('[data-testid="tools-tier"].tier-write')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('the tier legend explains t0–t4 and the dynamic run_op tier', async ({ page }) => {
    const errors = await gotoWidget(page);

    await page.locator('[data-testid="overflow-menu"]').click();
    await page.locator('[data-testid="open-tools"]').click();
    await expect(page.locator('[data-testid="tools-overlay"]')).toBeVisible();

    // Legend is collapsed by default.
    await expect(page.locator('[data-testid="tools-legend"]')).toHaveCount(0);

    // Toggle reveals one row per tier (dynamic + 0..4 = 6 rows).
    await page.locator('[data-testid="tools-legend-toggle"]').click();
    await expect(page.locator('[data-testid="tools-legend"]')).toBeVisible();
    await expect(page.locator('[data-testid="tools-legend-row"]')).toHaveCount(6);

    // The dynamic (run_op) tier and the write tiers are all explained.
    const legend = page.locator('[data-testid="tools-legend"]');
    await expect(legend).toContainText('dyn');
    await expect(legend).toContainText('run_op');
    await expect(legend).toContainText('FSR write');
    await expect(legend).toContainText('Remediation');

    // Toggling again hides it.
    await page.locator('[data-testid="tools-legend-toggle"]').click();
    await expect(page.locator('[data-testid="tools-legend"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the search box filters the tool list by name and updates the count', async ({ page }) => {
    const errors = await gotoWidget(page);

    await page.locator('[data-testid="overflow-menu"]').click();
    await page.locator('[data-testid="open-tools"]').click();
    await expect(page.locator('[data-testid="tools-overlay"]')).toBeVisible();
    await expect(page.locator('[data-testid="tools-item"]')).toHaveCount(3);

    // Filter to the one create tool.
    await page.locator('[data-testid="tools-search"]').fill('create');
    await expect(page.locator('[data-testid="tools-item"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="tools-name"]').first()).toHaveText('create_record');
    await expect(page.locator('[data-testid="tools-count"]')).toContainText('1 of 3 tools');

    // A no-match filter shows the empty state, not the list.
    await page.locator('[data-testid="tools-search"]').fill('zzz-nope');
    await expect(page.locator('[data-testid="tools-list"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="tools-filter-empty"]')).toBeVisible();

    // Clearing restores the full list.
    await page.locator('[data-testid="tools-search-clear"]').click();
    await expect(page.locator('[data-testid="tools-item"]')).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test('Done and backdrop dismiss the tools panel', async ({ page }) => {
    await gotoWidget(page);
    await page.locator('[data-testid="overflow-menu"]').click();
    await page.locator('[data-testid="open-tools"]').click();
    await expect(page.locator('[data-testid="tools-overlay"]')).toBeVisible();

    await page.locator('[data-testid="tools-done"]').click();
    await expect(page.locator('[data-testid="tools-overlay"]')).toHaveCount(0);

    // Reopen and dismiss via the backdrop.
    await page.locator('[data-testid="overflow-menu"]').click();
    await page.locator('[data-testid="open-tools"]').click();
    await page.locator('[data-testid="tools-backdrop"]').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('[data-testid="tools-overlay"]')).toHaveCount(0);
  });
});
