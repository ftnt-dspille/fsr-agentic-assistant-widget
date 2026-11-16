'use strict';
// Layout uniformity: tool rows and every boxed chat card (verdict, status,
// capability gap, playbook offer) must share the same left and right edges, and
// the verdict's next-step buttons must be a stacked, left-aligned, equal-width
// column (a long label must not center its text or shrink its button).
// Drives the mock `uniform_cards` fixture.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page, extra) {
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
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=uniform_cards&fastmock=1&opener=1${extra || ''}`,
    { waitUntil: 'domcontentloaded' }
  );
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 }
  );
  await page.locator('.pb-card.verdict-card').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('.pb-card.capability-gap-card').waitFor({ state: 'visible', timeout: 10000 });
}

const BOXES = ['.tool-call', '.pb-card.verdict-card', '.pb-card.status-card',
  '.pb-card.capability-gap-card', '.pb-card.playbook-offer-card'];

async function edges(page) {
  return page.evaluate((sels) => {
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) { out[s] = null; continue; }
      const r = el.getBoundingClientRect();
      out[s] = { left: Math.round(r.left), right: Math.round(r.right) };
    }
    return out;
  }, BOXES);
}

for (const theme of ['dark', 'light']) {
  test(`boxed chat blocks share left and right edges (${theme})`, async ({ page }) => {
    await boot(page);
    if (theme === 'light') {
      await page.evaluate(() => document.querySelector('.fsr-pb-widget').classList.add('theme-light'));
    }
    const e = await edges(page);
    for (const s of BOXES) expect(e[s], s + ' rendered').not.toBeNull();
    const ref = e['.tool-call'];
    for (const s of BOXES) {
      expect(e[s].left, s + ' left edge vs tool row').toBe(ref.left);
      expect(e[s].right, s + ' right edge vs tool row').toBe(ref.right);
    }
  });
}

test('next-step buttons are a stacked, left-aligned, equal-width column', async ({ page }) => {
  await boot(page);
  const info = await page.evaluate(() => {
    const card = document.querySelector('.pb-card.verdict-card');
    const cr = card.getBoundingClientRect();
    return [...card.querySelectorAll('.verdict-action-btn')].map(b => {
      const r = b.getBoundingClientRect();
      return { align: getComputedStyle(b).textAlign, left: Math.round(r.left), width: Math.round(r.width),
               top: Math.round(r.top), cardW: Math.round(cr.width) };
    });
  });
  expect(info.length).toBeGreaterThanOrEqual(3);
  for (const b of info) expect(b.align).toBe('left');
  expect(new Set(info.map(b => b.width)).size, 'equal widths').toBe(1);
  expect(new Set(info.map(b => b.left)).size, 'same left edge').toBe(1);
  expect(new Set(info.map(b => b.top)).size, 'stacked, one per row').toBe(info.length);
  expect(info[0].width).toBeGreaterThan(info[0].cardW * 0.8);
});
