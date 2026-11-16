'use strict';
// The assistant's palette follows the analyst's FortiSOAR theme. Every 8.0
// theme declares its page background, text and accent as CSS variables on
// :root (--default-body-bg-color, --font-primary-color, --active-color); the
// widget's surfaces, text and accent derive from them. A hard-coded neutral
// grey palette sat as a visibly different box inside the Deep Sea (navy)
// designer.
//
// The values below are the four themes' own :root declarations, read from the
// platform's css/themes/*.css. The spec injects one theme's variables, mounts
// the widget, and checks what the browser actually resolved.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

// `panel` is --panel-default-bg; `surface` is what the widget should paint:
// the panel color where it is opaque (SOAR's own modals use it), the page
// color on Deep Sea, whose panel color is a translucent overlay.
const THEMES = [
  { id: 'deepSea', bg: '#02071A', panel: 'rgba(255, 255, 255, 0.04)', surface: '#02071A', fg: '#FFFFFF', accent: '#497AD4' },
  { id: 'dark', bg: '#000000', panel: '#161616', surface: '#161616', fg: '#EFEFEF', accent: '#2cafc3' },
  { id: 'steel', bg: '#0d1218', panel: '#1b2430', surface: '#1b2430', fg: '#FFFFFF', accent: '#22a6af' },
  { id: 'light', bg: '#f2f2f2', panel: '#FFFFFF', surface: '#FFFFFF', fg: '#151515', accent: '#4676b2' },
];

// Set the active theme the way SOAR does: $rootScope.theme.id.
function setThemeId(page, id) {
  return page.evaluate((themeId) => {
    const inj = window.angular.element(document.querySelector('.fsr-pb-widget')).injector();
    const root = inj.get('$rootScope');
    root.$apply(() => { root.theme = { id: themeId }; });
  }, id);
}

function rgb(hex) {
  const h = hex.replace('#', '');
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
}

async function boot(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fsr-playbook-builder', defaultIntent: 'build',
      maxTurns: 10, showUsage: true, seedFromEntity: false
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path&fastmock=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.fsr-pb-widget');
}

// The resolved color of `value` as painted inside the widget root.
function resolved(page, value) {
  return page.evaluate((v) => {
    const root = document.querySelector('.fsr-pb-widget');
    const probe = document.createElement('span');
    probe.style.color = v;
    root.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, value);
}

test.describe('palette follows the FortiSOAR theme', () => {
  for (const t of THEMES) {
    test(`${t.id}: surface, text and accent come from the theme`, async ({ page }) => {
      await boot(page);
      await page.addStyleTag({ content: `:root {
        --default-body-bg-color: ${t.bg};
        --panel-default-bg: ${t.panel};
        --font-primary-color: ${t.fg};
        --active-color: ${t.accent};
      }` });
      await setThemeId(page, t.id);
      const bg = await page.evaluate(
        () => getComputedStyle(document.querySelector('.fsr-pb-widget')).backgroundColor);
      expect(bg).toBe(rgb(t.surface));
      expect(await resolved(page, 'var(--text)')).toBe(rgb(t.fg));
      expect(await resolved(page, 'var(--accent)')).toBe(rgb(t.accent));
      // Accent-as-text is the theme accent, not a fixed teal.
      expect(await resolved(page, 'var(--accent-text)')).not.toBe(rgb('#5eead4'));
    });
  }

  test('outside SOAR (no theme variables) the standalone palette applies', async ({ page }) => {
    await boot(page);
    const bg = await page.evaluate(
      () => getComputedStyle(document.querySelector('.fsr-pb-widget')).backgroundColor);
    expect(bg).toBe(rgb('#111317'));
    expect(await resolved(page, 'var(--accent)')).toBe(rgb('#14b8a6'));
  });
});
