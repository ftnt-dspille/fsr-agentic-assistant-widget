'use strict';
// U6: the change card for an edit to the open playbook. Drives the recorded-shape
// change fixture and asserts the DOM: What changes as Adds / Changes / Removes
// lines that match the diff, nothing else changes, the safety line, Apply change
// and Not now, and the tags and before/after only inside Details.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'widget', 'widgetAssets', 'fixtures', 'enhancement_change_card.json'), 'utf8'));
const OFFER = FIXTURE.responses.find(r => r.action === 'chat_turn').response.transcript
  .find(e => e.type === 'enhancement_offer');
const ID = OFFER.id;

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build', maxTurns: 10
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
    localStorage.removeItem('fsrPbSession:build');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=enhancement_change_card&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await expect(page.locator(`[data-testid="enhancement-offer-${ID}"]`)).toBeVisible({ timeout: 30000 });
  return errors;
}

// The card's text with the Details block removed: what the analyst reads first.
const collapsedText = (card) => card.evaluate(el => {
  const clone = el.cloneNode(true);
  const d = clone.querySelector('.po-draft');
  if (d) d.querySelectorAll('.po-details').forEach(n => n.remove());
  return clone.textContent;
});

test('collapsed card: Adds / Changes / Removes lines match the diff, nothing else changes, safety, actions', async ({ page }) => {
  const errors = await boot(page);
  const card = page.locator(`[data-testid="enhancement-offer-${ID}"]`);

  const lines = card.locator(`[data-testid^="enhancement-offer-line-${ID}-"]`);
  const texts = (await lines.allTextContents()).map(t => t.trim());
  const rows = OFFER.changes;
  const expectedAdds = rows.filter(r => r.kind === 'added').map(r => r.step);
  const expectedDels = rows.filter(r => r.kind === 'removed').map(r => r.step);
  const expectedMods = rows.filter(r => r.kind === 'modified').map(r => r.step);
  expect(texts.length).toBe(rows.length);
  expect(texts.filter(t => t.startsWith('Adds')).length).toBe(expectedAdds.length);
  expect(texts.filter(t => t.startsWith('Removes')).length).toBe(expectedDels.length);
  expect(texts.filter(t => t.startsWith('Changes')).length).toBe(expectedMods.length);
  expectedAdds.forEach(n => expect(texts.filter(t => t.startsWith('Adds')).join('\n')).toContain('"' + n + '"'));
  expectedDels.forEach(n => expect(texts.filter(t => t.startsWith('Removes')).join('\n')).toContain('"' + n + '"'));
  expectedMods.forEach(n => expect(texts.filter(t => t.startsWith('Changes')).join('\n')).toContain('"' + n + '"'));
  expect(texts).toEqual([
    'Adds the step "Prompt Block IP" (asks you to confirm or choose).',
    'Changes the step "Block IP": its inputs and what runs next. '
      + 'IP is now {{ vars.input.records[0].destinationIp }} (was {{ vars.input.records[0].sourceIp }}).',
    'Removes the step "Old Note".'
  ]);
  await expect(card.locator(`[data-testid="enhancement-offer-nothing-else-${ID}"]`))
    .toHaveText('Nothing else in the playbook changes.');
  await expect(card.locator(`[data-testid="enhancement-offer-safety-${ID}"]`))
    .toContainText('To undo, restore the previous version from the Versions tab');
  await expect(card.locator(`[data-testid="enhancement-offer-trigger-${ID}"]`)).toHaveText('Runs when an alert is created');
  await expect(card.locator(`[data-testid="enhancement-offer-accept-${ID}"]`)).toHaveText('Apply change');
  await expect(card.locator(`[data-testid="enhancement-offer-decline-${ID}"]`)).toHaveText('Not now');

  // Collapsed: the changed expression is shown as written; a connector id never is.
  const text = await collapsedText(card);
  expect(text).toContain('{{ vars.input.records[0].destinationIp }}');
  expect(text).not.toMatch(/fortigate-firewall/);
  expect(text).not.toMatch(/[a-z]+_[a-z_]+/);
  // The diff panes and tags are behind Details until it is opened.
  await expect(card.locator(`[data-testid="enhancement-offer-diff-${ID}"]`)).toHaveCount(0);
  expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
});

test('Details: New / Changed / Removed tags and before/after for every step; warnings and YAML live here', async ({ page }) => {
  const errors = await boot(page);
  const card = page.locator(`[data-testid="enhancement-offer-${ID}"]`);
  await card.locator(`[data-testid="enhancement-offer-review-${ID}"]`).click();
  const tagFor = { added: 'New', modified: 'Changed', removed: 'Removed' };
  for (let i = 0; i < OFFER.changes.length; i++) {
    const row = OFFER.changes[i];
    const step = card.locator(`[data-testid="enhancement-offer-diff-step-${ID}-${i}"]`);
    await expect(step.locator(`[data-testid="enhancement-offer-tag-${ID}-${i}"]`)).toHaveText(tagFor[row.kind]);
    await expect(step).toContainText(row.step);
    // An added step has only an After pane, a removed one only a Before pane.
    await expect(step.locator(`[data-testid="enhancement-before-${ID}-${i}"]`)).toHaveCount(row.before ? 1 : 0);
    await expect(step.locator(`[data-testid="enhancement-after-${ID}-${i}"]`)).toHaveCount(row.after ? 1 : 0);
  }
  await expect(card.locator(`[data-testid="enhancement-after-${ID}-1"]`)).toContainText('{{ vars.input.records[0].destinationIp }}');
  await expect(card.locator(`[data-testid="enhancement-offer-diff-${ID}"]`)).not.toContainText('fortigate-firewall');
  await expect(card.locator(`[data-testid="enhancement-offer-warnings-${ID}"]`)).toContainText('Block IP');
  await card.locator(`[data-testid="enhancement-offer-yaml-toggle-${ID}"]`).click();
  await expect(card.locator(`[data-testid="enhancement-offer-yaml-${ID}"]`)).toContainText('fortigate-lab-1');
  expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
});

test('Not now resolves the card without applying anything', async ({ page }) => {
  const errors = await boot(page);
  const card = page.locator(`[data-testid="enhancement-offer-${ID}"]`);
  const writes = [];
  page.on('request', r => { if (/chat_resume/.test(r.postData() || '') && /accept/.test(r.postData() || '')) writes.push(r.url()); });
  await card.locator(`[data-testid="enhancement-offer-decline-${ID}"]`).click();
  await expect(card.locator(`[data-testid="enhancement-offer-resolution-${ID}"]`)).toContainText('Not applied');
  await expect(card.locator(`[data-testid="enhancement-offer-accept-${ID}"]`)).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
});
