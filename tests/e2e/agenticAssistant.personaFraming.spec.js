'use strict';
// Persona-aware opener framing (DOM). Mounted over a ztpf_templates record with
// an authoring persona (resolved via the mock `resolve_persona` action), the
// drawer must drop SOC-triage clothing: greeting reads "Authoring …", the deck
// is the persona's authoring actions, the placeholder is template-oriented, and
// the SOC "Investigate this case" deck + "Build playbook" handoff never appear.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { waitForWidgetIdle } = require('../../../../fortisoar-widget-harness/tests/e2e/_waitForWidgetIdle');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const TEMPLATE = {
  '@id': '/api/3/ztpf_templates/tpl-1',
  '@type': 'ZtpfTemplate',
  name: 'Branch Onboarding',
  description: 'Zero-touch provisioning template for branch FortiGates.',
  id: 501, uuid: 'tpl-0000-1111-2222-333344445555',
};

test('persona: authoring framing replaces SOC triage over a ztpf_templates record', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.addInitScript((args) => {
    const { id, entity } = args;
    localStorage.setItem('harness:config:' + id, JSON.stringify({ maxTurns: 10, showUsage: true, seedFromEntity: true }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
    window.__fsrPbEntity__ = entity;
  }, { id: WIDGET_ID, entity: TEMPLATE });

  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=persona_ztpf_author&fastmock=1`, { waitUntil: 'domcontentloaded' });
  await waitForWidgetIdle(page, '__agenticAssistant__');

  // Greeting card in the persona voice.
  const card = page.locator('[data-testid="info-card-entity-501"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Authoring');
  await expect(card).toContainText('Branch Onboarding');
  await expect(card).not.toContainText('Triaging');

  // Persona deck present with its label + actions; SOC deck absent.
  const personaDeck = page.locator('[data-testid="persona-quick-actions"]');
  await expect(personaDeck).toBeVisible();
  await expect(personaDeck.locator('.qa-label')).toHaveText('ZTPF Template Author');
  await expect(page.locator('[data-testid="persona-quick-action-explain"]')).toBeVisible();
  await expect(page.locator('[data-testid="quick-actions"]')).toHaveCount(0);

  // Composer placeholder is template-oriented, not the FortiSOC-summary line.
  const input = page.locator('[data-testid="chat-input"]');
  await expect(input).toHaveAttribute('placeholder', /render, check, or edit this template/);

  // No SOC "Build playbook" handoff.
  await expect(page.locator('[data-testid="triage-handoff"]')).toHaveCount(0);

  // Pull-context button carries the persona's pullLabel (proves ui.pullLabel /
  // ui.pullHint survive the service whitelist end-to-end — they used to be
  // stripped, so this override never reached the DOM).
  const pull = page.locator('[data-testid="pull-page-details"]');
  await expect(pull).toContainText('This template');
  await expect(pull).toHaveAttribute('title', /Pull in this template's fields/);

  expect(errors, 'no errors: ' + errors.join(' | ')).toEqual([]);
});

test('persona: empty-hero copy is persona-voiced, not SOC triage (unseeded)', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  // seedFromEntity:false ⇒ no seed card ⇒ the empty-hero renders (the state in
  // the reported screenshot: hero + persona deck, no messages yet).
  await page.addInitScript((args) => {
    const { id, entity } = args;
    localStorage.setItem('harness:config:' + id, JSON.stringify({ maxTurns: 10, showUsage: true, seedFromEntity: false }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
    window.__fsrPbEntity__ = entity;
  }, { id: WIDGET_ID, entity: TEMPLATE });

  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=persona_ztpf_author&fastmock=1`, { waitUntil: 'domcontentloaded' });
  await waitForWidgetIdle(page, '__agenticAssistant__');

  const heading = page.locator('[data-testid="empty-hero-heading"]');
  await expect(heading).toBeVisible();
  // Persona greeting drives the heading; no "Triaging" SOC clothing.
  await expect(heading).toContainText('Authoring');
  await expect(heading).not.toContainText('Triaging');
  // Subtitle is the persona's ui.subtitle, not the SOC containment line.
  const sub = heading.locator('xpath=following-sibling::div[contains(@class,"sub")]');
  await expect(sub).toContainText('render, lint, or edit this template');
  await expect(sub).not.toContainText('containment');
  await expect(sub).not.toContainText('block, isolate, disable');

  expect(errors, 'no errors: ' + errors.join(' | ')).toEqual([]);
});
