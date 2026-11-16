'use strict';
// Track U (U1-U4): the playbook offer card for basic users. Driven by stored
// offers (fixtures playbook_offer_{block_ip,readonly,traced,student}.json,
// captured from recorded sessions). Collapsed text is what the analyst reads
// first; Details (steps, YAML) is closed by default.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page, mock) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build',
      maxTurns: 10, showUsage: false, seedFromEntity: false
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=${mock}&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' }
  );
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 }
  );
}

const CARD = '.playbook-offer-card';
const BLOCK_ID = 'offer_block_malicious_ip_fortigate';
const READONLY_ID = 'pbo_outbound_c2_triage';
const TRACED_ID = 'offer-playbook-excessive-end-user-mail-investigation-block';
const STUDENT_ID = 'pb_student_investigation';

// Words the analyst should never read on the collapsed card: field keys,
// step ids, template markup. Each pattern names what leaked.
const LEAKS = {
  snake_case: /\b[a-z0-9]+_[a-z0-9_]+\b/,
  camelCase: /\b[a-z]+[A-Z][A-Za-z0-9]*\b/,
  template: /\{\{|\}\}/,
  id: /\b(?:toolu|call|offer|pb|pbo)_[A-Za-z0-9_]+|\b[0-9a-f]{8}-[0-9a-f]{4}-/
};
function leaksIn(text) {
  return Object.keys(LEAKS).filter((k) => LEAKS[k].test(text)).map((k) => k + ': ' + text.match(LEAKS[k])[0]);
}

test.describe('Track U playbook offer card (simple)', () => {
  test('U1 block-IP offer has a Changes safety row that says it waits for confirm', async ({ page }) => {
    await boot(page, 'playbook_offer_block_ip');
    const card = page.locator(CARD).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    const safety = card.locator(`[data-testid="playbook-offer-safety-${BLOCK_ID}"]`);
    await expect(safety).toContainText('Changes');
    await expect(safety).toContainText('confirm');
  });

  test('U1 read-only offer says Read only and not Changes', async ({ page }) => {
    await boot(page, 'playbook_offer_readonly');
    const card = page.locator(CARD).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    const safety = card.locator(`[data-testid="playbook-offer-safety-${READONLY_ID}"]`);
    await expect(safety).toContainText('Read only');
    await expect(safety).not.toContainText('Changes');
  });

  test('U2 collapsed card text has no field keys, ids or template markup', async ({ page }) => {
    const mocks = ['playbook_offer_block_ip', 'playbook_offer_readonly', 'playbook_offer_traced', 'playbook_offer_student'];
    for (const mock of mocks) {
      await boot(page, mock);
      const card = page.locator(CARD).first();
      await expect(card).toBeVisible({ timeout: 15000 });
      const text = await card.innerText();
      expect(leaksIn(text), mock + ' collapsed text').toEqual([]);
      // Start, End and Set Inputs are plumbing, not what the playbook does.
      expect(text, mock + ' collapsed text').not.toMatch(/Set Inputs|\bEnd\b\n/);
      // Raw op ids and enum chips stay out of the collapsed card.
      expect(text, mock + ' collapsed text').not.toMatch(/\bmanual_input\b|\bset_variable\b|\bdecision\b/);
    }
  });

  test('U2 steps and YAML sit behind Details; YAML is nested in Details', async ({ page }) => {
    await boot(page, 'playbook_offer_block_ip');
    const card = page.locator(CARD).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    const details = card.locator(`[data-testid="playbook-offer-review-${BLOCK_ID}"]`);
    await expect(details).toContainText('Details');
    await expect(card.locator(`[data-testid="playbook-offer-draft-${BLOCK_ID}"]`)).toHaveCount(0);
    await details.click();
    await expect(card.locator(`[data-testid="playbook-offer-draft-${BLOCK_ID}"]`)).toBeVisible();
    const yamlToggle = card.locator(`[data-testid="playbook-offer-yaml-toggle-${BLOCK_ID}"]`);
    await expect(yamlToggle).toBeVisible();
    await expect(card.locator(`[data-testid="playbook-offer-yaml-${BLOCK_ID}"]`)).toHaveCount(0);
    await yamlToggle.click();
    await expect(card.locator(`[data-testid="playbook-offer-yaml-${BLOCK_ID}"]`)).toContainText('collection:');
  });

  test('U3 the confirm step is not an unfinished form', async ({ page }) => {
    await boot(page, 'playbook_offer_block_ip');
    const card = page.locator(CARD).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.locator(`[data-testid="playbook-offer-review-${BLOCK_ID}"]`).click();
    await expect(card.locator(`[data-testid="playbook-offer-draft-${BLOCK_ID}"]`)).toBeVisible();
    // The manual_input step is drawn as a step, with no Prompt box or gap badge.
    await expect(card.locator(`[data-testid="playbook-offer-gap-${BLOCK_ID}-Confirm Containment"]`)).toHaveCount(0);
    await expect(card.locator(`[data-testid="playbook-offer-gapbadge-${BLOCK_ID}-Confirm Containment"]`)).toHaveCount(0);
    await expect(card.locator('.po-step-gap')).toHaveCount(0);
  });

  test('U4 one clear action, rename behind a link, trigger line always shown', async ({ page }) => {
    await boot(page, 'playbook_offer_traced');
    const card = page.locator(CARD).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    // The traced offer has no trigger in the payload: the default line shows.
    await expect(card.locator(`[data-testid="playbook-offer-trigger-${TRACED_ID}"]`))
      .toHaveText('Runs when you start it');
    await expect(card.locator(`[data-testid="playbook-offer-accept-${TRACED_ID}"]`))
      .toHaveText('Save playbook');
    await expect(card.locator(`[data-testid="playbook-offer-decline-${TRACED_ID}"]`))
      .toHaveText('Not now');
    // The name is not an input until the analyst asks to rename it.
    await expect(card.locator(`[data-testid="playbook-offer-title-${TRACED_ID}"]`)).toHaveCount(0);
    await card.locator(`[data-testid="playbook-offer-rename-${TRACED_ID}"]`).click();
    await expect(card.locator(`[data-testid="playbook-offer-title-${TRACED_ID}"]`))
      .toHaveValue('Automated Excessive End User Mail Investigation & Block');
  });

  test('U4 student offer keeps the trigger line from the payload', async ({ page }) => {
    await boot(page, 'playbook_offer_student');
    const card = page.locator(CARD).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.locator(`[data-testid="playbook-offer-trigger-${STUDENT_ID}"]`))
      .toHaveText('Runs when an analyst clicks "FortiAIGate student investigation" on an alert');
  });

  test('U5 a decision reads as a check in words, not a raw label', async ({ page }) => {
    await boot(page, 'playbook_offer_block_ip');
    const card = page.locator(CARD).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.locator(`[data-testid="playbook-offer-plain-${BLOCK_ID}-0"]`))
      .toHaveText('Checks whether containment target present.');
    await expect(card.locator('.po-what')).not.toContainText('Checks: containment');
  });

  test('U5 Details uses CSS-mask icons, no glyph characters', async ({ page }) => {
    await boot(page, 'playbook_offer_block_ip');
    const card = page.locator(CARD).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.locator(`[data-testid="playbook-offer-review-${BLOCK_ID}"]`).click();
    const draft = card.locator(`[data-testid="playbook-offer-draft-${BLOCK_ID}"]`);
    await expect(draft).toBeVisible();
    await expect(draft.locator('i.ic.po-step-icon').first()).toBeVisible();
    expect(await card.locator('.po-draft-caret.ic').count()).toBeGreaterThanOrEqual(1);
    const text = await card.locator('.po-details').innerText();
    expect(text, 'Details glyphs').not.toMatch(/[\u2713\u25B2\u25B8\u27F6\u2325]/);
  });
});
