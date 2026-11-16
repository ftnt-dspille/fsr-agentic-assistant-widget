'use strict';
// ─── Diagnose & fix panel (Track C3 — value-level render patches) ────────────
//
// The YAML pane's "Diagnose & fix" button drives analyze_playbook →
// suggest_fix_for_diagnostic (both over call_mcp_tool / /api/integration/execute)
// and renders each structured fix as a reviewable before→after proposal. A fix
// whose `before` value is unique in the YAML gets a one-click Apply; an
// ambiguous one gets a "Send to chat" escape hatch. This exercises the DOM
// wiring against the harness with the connector routes mocked; the swap
// algorithm itself is unit-covered in valuePatch.controller.test.js.
const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

function urlFor(scenario) {
  return `/?widget=${WIDGET_ID}&context=Dashboard&mock=${scenario || 'happy_path'}`;
}

// `diagnostics` and `fixes` are stashed on the page so each test can script the
// analyze_playbook + suggest_fix_for_diagnostic responses independently.
async function installConnectorRoutes(page, diagnostics, fixes) {
  await page.route(/\/api\/integration\/connectors\//, route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: [{
        name: 'connector-fsr-agentic-assistant',
        version: '1.0.0',
        configuration: [{ name: 'fsrpb-live', config_id: 'cfg-0001', default: true }]
      }] })
    })
  );
  await page.route(/\/api\/integration\/execute\//, route => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* noop */ }
    const op = body.operation || '';
    const params = body.params || {};
    let data = { ok: true };
    if (op === 'call_mcp_tool' && params.tool === 'analyze_playbook') {
      data = { ok: true, diagnostics };
    } else if (op === 'call_mcp_tool' && params.tool === 'suggest_fix_for_diagnostic') {
      const kind = (params.args && params.args.diagnostic && params.args.diagnostic.kind) || '';
      data = fixes[kind] || { ok: false, kind, reason: 'no recipe' };
    }
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'Success', operation: op, data })
    });
  });
}

async function gotoWithYaml(page, diagnostics, fixes) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', maxTurns: 10
    }));
    localStorage.setItem('harness.widget', id);
    // Diagnose & fix lives in the build YAML pane. `config.defaultIntent='build'`
    // used to open a dashboard mount straight into build and was retired (build
    // needs something to build against). This drafts in triage and then takes the
    // earned handoff — hunt → draft → open in build → diagnose, which is the real
    // path. See docs/plans/build-persona-validation-plan.md.
    localStorage.setItem('harness.ctx', 'dashboard');
  }, WIDGET_ID);
  await installConnectorRoutes(page, diagnostics, fixes);
  await page.goto(urlFor('happy_path'), { waitUntil: 'domcontentloaded' });
  // Boot wait, not a behaviour assertion: this heavy (monaco) widget can take
  // >30s to reach its first state string under full-suite 2-worker CPU
  // contention (ship-verify). 60s only extends the wait before failing; green
  // runs are unaffected.
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 60000 });
  await page.locator('[data-testid="chat-input"]').fill('Draft a ping playbook');
  await page.locator('[data-testid="chat-send"]').click();
  await page.waitForFunction(
    () => window.__agenticAssistant__ && window.__agenticAssistant__.currentYaml,
    null, { timeout: 8000 });
  // The handoff is gated on hasTriageDraft() = triage + idle + a draft, so the
  // turn must have settled before we can open the draft in build.
  await page.waitForFunction(
    () => window.__agenticAssistant__.state === 'idle', null, { timeout: 8000 });
  await page.evaluate(() => window.__agenticAssistant__.openDraftInBuild());
  await page.waitForSelector('[data-testid="yaml-panel"]');
}

// A fix whose `before` is absent from the drafted YAML is unambiguously
// non-applicable → renders "Send to chat" regardless of the mock YAML content.
const AMBIGUOUS_FIX = {
  missing_key: { ok: true, kind: 'missing_key', step_id: 'Enrich',
    location: 'arguments.x', before: '__no_such_token__', after: 'title',
    confidence: 'high', explanation: 'replace key' }
};

test.describe('FSR Agentic Assistant — diagnose & fix (C3)', () => {

  test('the YAML pane exposes a Diagnose & fix button', async ({ page }) => {
    await gotoWithYaml(page, [], {});
    await expect(page.locator('[data-testid="yaml-diagnose-fix"]')).toBeVisible();
  });

  test('a diagnostic with a fix renders a before→after proposal', async ({ page }) => {
    await gotoWithYaml(page, [{ kind: 'missing_key' }], AMBIGUOUS_FIX);
    await page.locator('[data-testid="yaml-diagnose-fix"]').click();
    await expect(page.locator('[data-testid="value-patch"]')).toBeVisible();
    await expect(page.locator('[data-testid="value-patch-0"]')).toContainText('title');
    // Non-applicable (before absent) → the Send-to-chat affordance, not Apply.
    await expect(page.locator('[data-testid="value-patch-tochat-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="value-patch-apply-0"]')).toHaveCount(0);
  });

  test('Send to chat seeds the composer with the fix instruction', async ({ page }) => {
    await gotoWithYaml(page, [{ kind: 'missing_key' }], AMBIGUOUS_FIX);
    await page.locator('[data-testid="yaml-diagnose-fix"]').click();
    await page.locator('[data-testid="value-patch-tochat-0"]').click();
    await expect(page.locator('[data-testid="chat-input"]')).toHaveValue(/change `__no_such_token__` to `title`/);
  });

  test('Dismiss drops the value-patch panel', async ({ page }) => {
    await gotoWithYaml(page, [{ kind: 'missing_key' }], AMBIGUOUS_FIX);
    await page.locator('[data-testid="yaml-diagnose-fix"]').click();
    await expect(page.locator('[data-testid="value-patch"]')).toBeVisible();
    await page.locator('[data-testid="value-patch-dismiss"]').click();
    await expect(page.locator('[data-testid="value-patch"]')).toHaveCount(0);
  });

  test('no diagnostics flips the button to a clean acknowledgement', async ({ page }) => {
    await gotoWithYaml(page, [], {});
    await page.locator('[data-testid="yaml-diagnose-fix"]').click();
    await expect(page.locator('[data-testid="yaml-diagnose-fix"]')).toContainText('No issues found');
    await expect(page.locator('[data-testid="value-patch"]')).toHaveCount(0);
  });
});
