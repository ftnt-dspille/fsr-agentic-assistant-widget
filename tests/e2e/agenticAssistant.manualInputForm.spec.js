'use strict';
// The awaiting-form manual_input card: a run_playbook/resume_playbook pause is
// rendered as an interactive form. Drives the manual_input_form fixture and
// asserts the widget:
//   - renders a dynamic_list as two dependent selects (group → item)
//   - populates the item select only after a group is picked
//   - renders a checkbox and a text field
//   - on submit resolves the card and surfaces the resumed turn
//
// The dynamic_list is a GENERIC two-level picker -- the fixture uses neutral
// "Group A / a-one" data on purpose; the widget must not assume any domain.

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
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'triage',
      maxTurns: 10, showUsage: true, seedFromEntity: false
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=manual_input_form&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 });

  // The form is reached the way a box reaches it: run_playbook is a gated call,
  // so the turn ends on an approval and the parked form arrives on the RESUME.
  // The fixture used to hand the manual_input card straight back from the first
  // chat_turn -- a shape #104's captures show the connector never sends. Driving
  // the approval here costs two clicks and buys the whole arc.
  await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true', { timeout: 25000 });
  await page.locator('[data-testid="chat-input"]').fill('collect a note for this run');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.locator('[data-testid="approval-card-ap-1"]')
    .waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-testid="approval-approve"]').click();
  return errors;
}

const CARD = '[data-testid="manual-input-126"]';
const group = '[data-testid="manual-input-field-126-pick-group"]';
const item = '[data-testid="manual-input-field-126-pick-item"]';
const verbose = '[data-testid="manual-input-field-126-verbose"]';

test.describe('manual_input awaiting-form card', () => {
  test('overflow menu is clickable where it overlaps a manual-input card', async ({ page }) => {
    // Regression: the topbar's backdrop-filter made it a stacking context that
    // TRAPPED the overflow menu (z-index 211) inside it, so the later-in-DOM
    // manual-input card painted OVER the open menu -- its items (Tools/History/
    // Settings) weren't clickable where they overlapped the card.
    await boot(page);
    await expect(page.locator(CARD)).toBeVisible();
    await page.locator('[data-testid="overflow-menu"]').click();
    await expect(page.locator('[data-testid="overflow-dropdown"]')).toBeVisible();
    // The menu item sits above the card region. If the card were on top, this
    // click would fail Playwright's actionability check (pointer intercepted).
    // Clicking History opens the panel -- proof the item received the event.
    await page.locator('[data-testid="open-history"]').click();
    await expect(page.locator('[data-testid="history-overlay"]')).toBeVisible();
  });

  test('renders dependent selects + checkbox; item enables after group pick', async ({ page }) => {
    const errors = await boot(page);
    await expect(page.locator(CARD)).toBeVisible();

    const g = page.locator(group);
    const it = page.locator(item);
    await expect(g).toBeVisible();
    expect(await g.evaluate(el => el.tagName.toLowerCase())).toBe('select');
    // item select is disabled until a group is chosen
    await expect(it).toBeDisabled();

    // pick Group A → item select enables and offers only that group's items
    await g.selectOption('Group A');
    await expect(it).toBeEnabled();
    const opts = await it.locator('option').allTextContents();
    expect(opts).toEqual(['-- Select --', 'a-one', 'a-two']);

    // checkbox present
    await expect(page.locator(verbose)).toBeVisible();
    expect(await page.locator(verbose).evaluate(el => el.type)).toBe('checkbox');

    expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('switching group resets the item selection', async ({ page }) => {
    await boot(page);
    await expect(page.locator(CARD)).toBeVisible();
    await page.locator(group).selectOption('Group A');
    await page.locator(item).selectOption('a-two');
    await expect(page.locator(item)).toHaveValue('a-two');
    // change group → item cleared, and now offers Group B's items
    await page.locator(group).selectOption('Group B');
    await expect(page.locator(item)).toHaveValue('');
    const opts = await page.locator(item).locator('option').allTextContents();
    expect(opts).toEqual(['-- Select --', 'b-one']);
  });

  test('submit is gated until the required field is filled', async ({ page }) => {
    await boot(page);
    await expect(page.locator(CARD)).toBeVisible();
    const submit = page.locator('[data-testid="manual-input-submit-126"]');
    // `pick` is required → submit disabled + hint shown on load.
    await expect(submit).toBeDisabled();
    await expect(page.locator('[data-testid="manual-input-invalid-126"]')).toBeVisible();
    // a partial pick (group only) is still incomplete.
    await page.locator(group).selectOption('Group A');
    await expect(submit).toBeDisabled();
    // both levels chosen → submit enables, hint gone.
    await page.locator(item).selectOption('a-one');
    await expect(submit).toBeEnabled();
    await expect(page.locator('[data-testid="manual-input-invalid-126"]')).toHaveCount(0);
  });

  test('submit resolves the card and surfaces the resumed turn', async ({ page }) => {
    await boot(page);
    await expect(page.locator(CARD)).toBeVisible();
    await page.locator(group).selectOption('Group A');
    await page.locator(item).selectOption('a-one');
    await page.locator(verbose).check();
    await page.locator('[data-testid="manual-input-submit-126"]').click();

    // card consumed: submit button gone, resolution footer shown
    await expect(page.locator('[data-testid="manual-input-submit-126"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="manual-input-resolution-126"]')).toBeVisible();
    // the resumed turn renders
    await expect(page.locator('.fsr-pb-widget')).toContainText('resumed with your selection');
  });

  test('prompt reads as body copy (not shouty caps) and seeds field defaults', async ({ page }) => {
    await boot(page);
    await expect(page.locator(CARD)).toBeVisible();

    // The prompt is human-authored instruction text: rendered sentence-case, NOT
    // uppercased, and the connector's \n\n between title and detail is preserved.
    // The prompt renders as markdown, so that break is a paragraph boundary.
    const prompt = page.locator(CARD + ' .card-prompt');
    await expect(prompt).toBeVisible();
    expect(await prompt.evaluate(el => getComputedStyle(el).textTransform)).toBe('none');
    await expect(prompt.locator('.md-p')).toHaveText(
      ['Choose a group and an item', 'Pick a group, then a dependent item.']);
    // original mixed-case title survives (would be gone under text-transform:uppercase)
    await expect(prompt).toContainText('Choose a group and an item');

    // A field default (native FSR shows a YAML prefill in the textarea) is seeded.
    const params = page.locator('[data-testid="manual-input-field-126-params"]');
    await expect(params).toHaveValue('input:\n  lo_name:');
    // and a defaulted checkbox is pre-checked.
    await expect(page.locator(verbose)).toBeChecked();
  });
});
