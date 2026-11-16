'use strict';
// Which surface does a tool-only approval get?
//
// This file used to render `approval_run_playbook_new` as an ACTION card and
// keep the screenshot as evidence that the conversion was wrong: an action_card
// body is built from connector param metadata, so a run_playbook card showed no
// arguments and headed with a bare ".".
//
// That question is settled -- approval_request is the surface -- and #104's
// captures then retired the premise: the fixture was modelling an `action_card`
// the connector does not send, and now carries the wire shape
// (tool_use, tool_result, tool_use, approval_request). So the comparison is
// gone and what remains is the positive assertion it existed to justify: the
// approval surface names the playbook and shows what is being approved.
// Screenshots still land in test-results/ for eyeballing.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page, scenario, testid) {
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
  await page.locator('[data-testid="chat-input"]').fill('add a step to this device');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.locator(testid).waitFor({ state: 'visible', timeout: 15000 });
  return errors;
}

test('legacy approval_request rendering for run_playbook', async ({ page }) => {
  const errors = await boot(page, 'approval_run_playbook_old',
    '[data-testid="approval-card-ap-pb-1"]');
  const card = page.locator('[data-testid="approval-card-ap-pb-1"]');
  await card.screenshot({ path: 'test-results/pb-approval-old.png' });
  console.log('OLD card text:\n' + (await card.innerText()));

  // The playbook link: opens in a new tab so the pending approval survives.
  const link = card.locator('[data-testid="approval-playbook-link"]');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  expect(await link.getAttribute('href')).toContain('/playbooks/3ebf17b8');
  expect(errors).toEqual([]);
});

// The positive form of the old comparison: the surface a tool-only approval
// actually gets, and the two things it must show.
test('a tool-only approval renders as an approval card that names what it runs',
  async ({ page }) => {
    const errors = await boot(page, 'approval_run_playbook_new',
      '[data-testid="approval-card-ap-pb-1"]');
    const card = page.locator('[data-testid="approval-card-ap-pb-1"]');
    await card.screenshot({ path: 'test-results/pb-approval-new.png' });
    const txt = await card.innerText();

    // The playbook being run -- the single fact an analyst needs. An action_card
    // could not show it, which is why that conversion was abandoned.
    expect(txt).toContain('Add Step from Action to Device');
    // And it does NOT render as the bare "." an action_card produced for a
    // tool-only approval (no connector, no operation to head with).
    expect(txt.trim().startsWith('.')).toBe(false);
    expect(errors).toEqual([]);
  });
