'use strict';
// Every editable field on an action card paints with the widget's palette.
// The theme rule covered text inputs, selects and textareas only, so a number
// field (an integer device id) kept the browser's white background while the
// dark platform theme made its text white: the analyst approved a value they
// could not read.
//
// The spec applies a dark theme plus a platform-style rule that whitens input
// text, then checks each control type against the themed text input on the
// same card.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const CARD = 'card-block-new';
const arg = (name) => `[data-testid="action-arg-${CARD}-${name}"]`;

async function boot(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder',
      defaultIntent: 'triage', maxTurns: 10, showUsage: true, seedFromEntity: false
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=conditional_block_ip&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.locator(`[data-testid="action-card-${CARD}"]`).waitFor({ state: 'visible', timeout: 30000 });
  await page.addStyleTag({ content: `:root {
    --default-body-bg-color: #02071A; --panel-default-bg: rgba(255, 255, 255, 0.04);
    --font-primary-color: #FFFFFF; --active-color: #497AD4;
  }
  input, select, textarea { color: #FFFFFF; }` });
  await page.evaluate(() => {
    const root = window.angular.element(document.querySelector('.fsr-pb-widget')).injector().get('$rootScope');
    root.$apply(() => { root.theme = { id: 'deepSea' }; });
  });
}

// Background and text only: the border animates on focus, so a mid-transition
// read would compare timing, not the palette.
const paint = (loc) => loc.evaluate((el) => {
  const s = getComputedStyle(el);
  return { bg: s.backgroundColor, fg: s.color };
});

test('every action card field type reads in the dark theme', async ({ page }) => {
  await boot(page);
  // The integer field shows on the Custom Time branch.
  await page.locator(arg('time_to_live')).selectOption('Custom Time');
  const number = page.locator(arg('duration'));
  await expect(number).toHaveAttribute('type', 'number');

  const text = page.locator(arg('ip_addresses'));
  await expect(text).toHaveAttribute('type', 'text');
  const want = await paint(text);
  expect(want.bg).not.toBe(want.fg);
  expect(want.bg).not.toBe('rgb(255, 255, 255)');

  // No fixture carries a password parameter; a password control is the same
  // row markup with type="password".
  await page.evaluate((sel) => {
    const src = document.querySelector(sel);
    const pw = src.cloneNode();
    pw.type = 'password';
    pw.setAttribute('data-testid', 'contrast-password');
    src.parentNode.appendChild(pw);
  }, arg('ip_addresses'));

  const controls = {
    number,
    select: page.locator(arg('time_to_live')),
    password: page.locator('[data-testid="contrast-password"]'),
  };
  for (const [kind, loc] of Object.entries(controls)) {
    const got = await paint(loc);
    expect(got, `${kind} paints like the text input`).toEqual(want);
  }
});
