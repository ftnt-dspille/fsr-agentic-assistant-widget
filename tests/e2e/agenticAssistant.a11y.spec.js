'use strict';
// axe-core pass over the chat in each card state (WCAG 2 A/AA), scoped to the
// widget root. Each scenario boots a mock turn through the opener, waits for it
// to settle, and must come back with no violations.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');
const { default: AxeBuilder } = require('../../../../fortisoar-widget-harness/node_modules/@axe-core/playwright');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const SCENARIOS = [
  ['verdict_triage', 'triage'],
  ['approval_required', 'triage'],
  ['choice_text', 'build'],
  ['capability_gap', 'triage'],
  ['truncated_search', 'triage'],
  ['info_cards', 'triage'],
  ['manual_input_form', 'triage'],
  ['playbook_soc_demo', 'build'],
];

// Both themes: the light palette is a separate set of tokens and fails
// contrast on its own terms.
for (const theme of ['dark', 'light']) for (const [mock, intent] of SCENARIOS) {
  test(`no axe violations: ${mock} (${theme})`, async ({ page }) => {
    await page.addInitScript(([id, intent, theme]) => {
      localStorage.setItem('harness.theme', theme);
      localStorage.setItem('harness:config:' + id, JSON.stringify({
        connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: intent,
        maxTurns: 10, showUsage: true, seedFromEntity: false
      }));
      localStorage.setItem('harness.widget', id);
      localStorage.setItem('harness.ctx', 'dashboard');
      localStorage.removeItem('fsrPbSession');
    }, [WIDGET_ID, intent, theme]);
    await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=${mock}&fastmock=1&opener=1`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
      null, { timeout: 25000 });
    // Settled: the turn has rendered at least one assistant message.
    await page.locator('.pb-message').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(500);
    const res = await new AxeBuilder({ page })
      .include('.fsr-pb-widget')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    const found = res.violations.map(v => ({
      id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.slice(0, 4).map(n => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(0, 2).join(' ')),
      count: v.nodes.length,
    }));
    if (found.length) console.log('[a11y] ' + mock + ' ' + theme + ' ' + JSON.stringify(found, null, 1));
    expect(found, JSON.stringify(found, null, 1)).toEqual([]);
  });
}
