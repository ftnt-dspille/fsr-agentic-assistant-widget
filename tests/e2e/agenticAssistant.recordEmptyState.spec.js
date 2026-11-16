'use strict';
// Record-aware empty state (DOM). Over a record the opening state is about that
// record. Triage modules keep the SOC investigation deck; every other module
// gets "Working on <name>" copy and a three-start record deck named for the
// module. Iterates every module type the widget distinguishes.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const TRIAGE = ['alerts', 'incidents', 'warrooms'];
const OTHER = ['indicators', 'assets', 'tasks', 'keys', 'vulnerabilities'];

async function open(page, module, seed) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  const entity = { '@id': '/api/3/' + module + '/rec-1', name: 'Record One' };
  await page.addInitScript((args) => {
    localStorage.setItem('harness:config:' + args.id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build',
      maxTurns: 10, seedFromEntity: args.seed
    }));
    localStorage.setItem('harness.widget', args.id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
    window.__fsrPbEntity__ = args.entity;
  }, { id: WIDGET_ID, entity, seed });
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path&fastmock=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && window.__agenticAssistant__.state === 'idle', null, { timeout: 25000 });
  return errors;
}

for (const module of OTHER) {
  test(`${module} record: names the record and offers three starts`, async ({ page }) => {
    const errors = await open(page, module, false);
    const heading = page.locator('[data-testid="empty-hero-heading"]');
    await expect(heading).toContainText('Working on');
    await expect(heading).toContainText('Record One');
    await expect(heading).not.toContainText('Triaging');
    await expect(page.locator('.empty-hero .sub')).not.toContainText(/containment|isolate/i);

    const deck = page.locator('[data-testid="record-quick-actions"]');
    await expect(deck).toBeVisible();
    await expect(page.locator('[data-testid^="record-quick-action-"]')).toHaveCount(3);
    await expect(page.locator('[data-testid="quick-actions"]')).toHaveCount(0);
    const text = await deck.innerText();
    expect(text).not.toMatch(/\/api\/3\/|run_op|get_record|—|–/);

    await page.locator('[data-testid="record-quick-action-record_summary"]').click();
    await expect(deck).toHaveCount(0);
    expect(errors, errors.join(' | ')).toEqual([]);
  });
}

for (const module of TRIAGE) {
  test(`${module} record: keeps the investigation deck, no record deck`, async ({ page }) => {
    const errors = await open(page, module, false);
    await expect(page.locator('[data-testid="empty-hero-heading"]')).toContainText('Triaging');
    await expect(page.locator('[data-testid="quick-actions"]')).toBeVisible();
    await expect(page.locator('[data-testid="record-quick-actions"]')).toHaveCount(0);
    expect(errors, errors.join(' | ')).toEqual([]);
  });
}

test('a non-triage record seeds a "Working on" card, not a "Triaging" one', async ({ page }) => {
  const errors = await open(page, 'keys', true);
  await expect(page.locator('[data-testid="record-quick-actions"]')).toBeVisible();
  const body = await page.locator('[data-testid="messages"]').innerText();
  expect(body).toContain('Working on');
  expect(body).not.toContain('Triaging');
  expect(errors, errors.join(' | ')).toEqual([]);
});
