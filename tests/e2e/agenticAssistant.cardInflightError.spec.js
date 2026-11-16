'use strict';
// ─── A1/A2 -- interactive-card in-flight feedback + error recovery (DOM) ───────
//
// Drives a manual_input card whose first resume FAILS (fixture returns a 503),
// then succeeds on retry. Asserts the DOM contract:
//   A1 -- while the resume is in flight the submit button is disabled and shows a
//        spinner (the card does NOT vanish).
//   A2 -- on failure the card stays on screen with an inline error, and the SAME
//        buttons let the analyst retry in place → the retry resolves the card.
//
// The manual_input_error fixture has a deliberate 350ms respond_manual_input
// delay so the in-flight state is observable.

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
  // NB: no fastmock -- we want the fixture's 350ms resume delay to stand.
  await page.goto(
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=manual_input_error&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 });

  // run_playbook is a gated call, so the parked form arrives on the RESUME, not
  // on the first turn. The fixture used to hand the card straight back; #104's
  // captures show the connector never does that, so the approval is driven here
  // -- which also means this spec now exercises the same arc a box does.
  await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true', { timeout: 25000 });
  await page.locator('[data-testid="chat-input"]').fill('collect a note for this run');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.locator('[data-testid="approval-card-ap-1"]')
    .waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('[data-testid="approval-approve"]').click();
  return errors;
}

const CARD = '[data-testid="manual-input-126"]';
const submit = '[data-testid="manual-input-submit-126"]';
const spinner = '[data-testid="manual-input-submitting-126"]';
const err = '[data-testid="manual-input-error-126"]';
const resolution = '[data-testid="manual-input-resolution-126"]';

test.describe('A1/A2 -- manual_input in-flight + error recovery', () => {
  test('in-flight disables submit + shows spinner; failure keeps the card actionable; retry resolves it', async ({ page }) => {
    const errors = await boot(page);
    await expect(page.locator(CARD)).toBeVisible();

    // The form's one field is REQUIRED, so submit is gated until it is filled --
    // the same gate `manualInputForm` pins. Filling it here keeps this spec
    // about what it is for (in-flight + error recovery) instead of silently
    // depending on a form that happened to be submittable empty.
    await page.locator('[data-testid="manual-input-field-126-note"]').fill('checked, proceeding');

    // Click submit → A1 in-flight: spinner shows, submit disabled, card stays.
    await page.locator(submit).click();
    await expect(page.locator(spinner)).toBeVisible();
    await expect(page.locator(submit)).toBeDisabled();
    await expect(page.locator(CARD)).toBeVisible();

    // A2 -- the resume fails (503): inline error appears, card NOT resolved, and
    // the submit button is live again for a retry.
    await expect(page.locator(err)).toBeVisible();
    await expect(page.locator(err)).toContainText('unavailable');
    await expect(page.locator(resolution)).toHaveCount(0);
    await expect(page.locator(submit)).toBeEnabled();

    // Retry from the same card → resolves; error clears, resolution footer shows.
    await page.locator(submit).click();
    await expect(page.locator(spinner)).toBeVisible();
    await expect(page.locator(resolution)).toBeVisible();
    await expect(page.locator(err)).toHaveCount(0);
    await expect(page.locator(submit)).toHaveCount(0);
    await expect(page.locator('.fsr-pb-widget')).toContainText('Retried');

    // The 503 shows in the global banner too, but it is not a JS console error.
    expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
  });
});
