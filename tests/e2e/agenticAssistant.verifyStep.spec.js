'use strict';
// ─── Per-step Verify affordance (Track C3 — interactive debug UI) ────────────
//
// The YAML pane surfaces a "Verify" control per parsed step. Clicking it drives
// fsrPbAgentService.stepTest → the connector's `step_test` tool (dispatched as
// call_mcp_tool over /api/integration/execute), and renders the step's
// status/rendered_args/output_top_keys/note. A non-safe op returns
// needs_confirm and gates on a confirm dialog before re-probing. This exercises
// the whole DOM flow against the harness with the live connector routes mocked.
const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

function urlFor(scenario) {
  return `/?widget=${WIDGET_ID}&context=Dashboard&mock=${scenario || 'happy_path'}`;
}

// Serve the connector lookup + the execute dispatch. step_test responses vary by
// the step_id and the confirm flag so the needs_confirm gate can be exercised.
async function installConnectorRoutes(page) {
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
    if (op === 'call_mcp_tool' && params.tool === 'step_test') {
      const a = params.args || {};
      const stepId = a.step_id;
      if (stepId === 'create_alert') {
        // Non-safe (mutating) op — gate until confirmed.
        data = a.confirm
          ? { ok: true, step_id: stepId, status: 'executed',
              rendered_args: { module: 'alerts', name: 'demo' },
              output_top_keys: ['id', 'name'], note: 'created record' }
          : { ok: false, step_id: stepId, status: 'needs_confirm',
              needs_confirm: true, risk: 'tier-3', note: 'creates a record' };
      } else {
        // Safe op — renders immediately.
        data = { ok: true, step_id: stepId, status: 'rendered',
                 rendered_args: { note: 'start node' }, output_top_keys: ['ok'] };
      }
    }
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'Success', operation: op, data })
    });
  });
}

async function gotoWithYaml(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', maxTurns: 10,
      // The Verify panel is OFF by default (parked while the core build flow is
      // validated — see docs/plans/build-persona-validation-plan.md §P3). This
      // spec is what proves the parked feature still works when re-enabled, so
      // it opts in explicitly.
      enableStepVerify: true
    }));
    localStorage.setItem('harness.widget', id);
    // Build intent is designer-only now (`config.defaultIntent='build'` retired),
    // so the YAML pane requires a real playbook-designer mount:
    // ctx 'playbook' → $state main.playbookDetail.
    localStorage.setItem('harness.ctx', 'playbook');
    localStorage.setItem('harness.id', 'wf-9');   // $state.params.id = the open playbook
  }, WIDGET_ID);
  await installConnectorRoutes(page);
  await page.goto(urlFor('happy_path'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
  // Draft a playbook so the YAML pane (and its Verify section) render.
  await page.locator('[data-testid="chat-input"]').fill('Draft a ping playbook');
  await page.locator('[data-testid="chat-send"]').click();
  await page.waitForFunction(
    () => window.__agenticAssistant__ && window.__agenticAssistant__.currentYaml,
    null, { timeout: 8000 });
}

test.describe('FSR Agentic Assistant — per-step Verify (C3)', () => {

  test('YAML pane lists parsed steps with a Verify button each', async ({ page }) => {
    await gotoWithYaml(page);
    await expect(page.locator('[data-testid="yaml-verify"]')).toBeVisible();
    await expect(page.locator('[data-testid="verify-step-trigger"]')).toBeVisible();
    await expect(page.locator('[data-testid="verify-step-create_alert"]')).toBeVisible();
    await expect(page.locator('[data-testid="verify-btn-trigger"]')).toBeVisible();
  });

  test('Verify on a safe step renders status/args/output keys', async ({ page }) => {
    await gotoWithYaml(page);
    await page.locator('[data-testid="verify-btn-trigger"]').click();
    await expect(page.locator('[data-testid="verify-result-trigger"]')).toBeVisible();
    await expect(page.locator('[data-testid="verify-status-trigger"]')).toHaveText('rendered');
    await expect(page.locator('[data-testid="verify-args-trigger"]')).toContainText('start node');
    await expect(page.locator('[data-testid="verify-result-trigger"]')).toContainText('ok');
  });

  test('Verify on a non-safe step gates on a confirm dialog, then runs on OK', async ({ page }) => {
    await gotoWithYaml(page);
    await page.locator('[data-testid="verify-btn-create_alert"]').click();

    // Gated: confirm dialog up, no result yet.
    await expect(page.locator('[data-testid="verify-confirm"]')).toBeVisible();
    await expect(page.locator('[data-testid="verify-result-create_alert"]')).toHaveCount(0);

    await page.locator('[data-testid="verify-confirm-run"]').click();
    await expect(page.locator('[data-testid="verify-confirm"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="verify-status-create_alert"]')).toHaveText('executed');
    await expect(page.locator('[data-testid="verify-args-create_alert"]')).toContainText('alerts');
  });

  test('Cancel on the confirm dialog dismisses it without running', async ({ page }) => {
    await gotoWithYaml(page);
    await page.locator('[data-testid="verify-btn-create_alert"]').click();
    await expect(page.locator('[data-testid="verify-confirm"]')).toBeVisible();
    await page.locator('[data-testid="verify-confirm-cancel"]').click();
    await expect(page.locator('[data-testid="verify-confirm"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="verify-result-create_alert"]')).toHaveCount(0);
  });
});
