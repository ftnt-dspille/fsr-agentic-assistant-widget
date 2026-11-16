'use strict';
// ─── Apply-patch affordance (Track C3 — one-click compiler auto-fixes) ───────
//
// The YAML pane's "Check & fix" button runs validate_yaml; when the compiler
// returns corrected_yaml + auto_fixes, the widget shows a reviewable patch panel
// with an Apply button that swaps the corrected text into the pane. This drives
// the whole DOM flow against the harness with the live connector routes mocked.
const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

// validate_yaml responses: default returns a corrected_yaml + one auto_fix;
// pass {clean:true} to simulate nothing-to-fix.
async function installRoutes(page, opts) {
  opts = opts || {};
  await page.route(/\/api\/integration\/connectors\//, route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: [{
        name: 'connector-fsr-agentic-assistant', version: '1.0.0',
        configuration: [{ name: 'fsrpb-live', config_id: 'cfg-0001', default: true }]
      }] })
    })
  );
  await page.route(/\/api\/integration\/execute\//, route => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* noop */ }
    const op = body.operation || '';
    let data = { ok: true };
    if (op === 'validate_yaml') {
      const yaml = (body.params && body.params.yaml) || '';
      data = opts.clean
        ? { ok: true }
        : { ok: true,
            corrected_yaml: yaml + '\n# auto-fixed: stop -> end\n',
            auto_fixes: [{ code: 'stop_to_end', line: 3, message: '`stop` step type renamed to `end`' }],
            auto_fix_note: 'adopt corrected_yaml as your working copy' };
    }
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'Success', operation: op, data })
    });
  });
}

async function gotoWithYaml(page, opts) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', maxTurns: 10 }));
    localStorage.setItem('harness.widget', id);
    // This is a build YAML-pane authoring aid, so it mounts where build lives:
    // the playbook designer (ctx 'playbook' -> $state main.playbookDetail).
    // `config.defaultIntent='build'` used to open a DASHBOARD straight into
    // build and was retired — build assumes an open playbook to author
    // against. See docs/plans/build-persona-validation-plan.md.
    localStorage.setItem('harness.ctx', 'playbook');
    localStorage.setItem('harness.id', 'wf-9');
  }, WIDGET_ID);
  await installRoutes(page, opts);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
  await page.locator('[data-testid="chat-input"]').fill('Draft a ping playbook');
  await page.locator('[data-testid="chat-send"]').click();
  await page.waitForFunction(
    () => window.__agenticAssistant__ && window.__agenticAssistant__.currentYaml,
    null, { timeout: 8000 });
}

test.describe('FSR Agentic Assistant — apply-patch (C3)', () => {

  test('Check & fix surfaces a patch panel with the auto-fixes; Apply swaps the YAML', async ({ page }) => {
    await gotoWithYaml(page);
    const before = await page.evaluate(() => window.__agenticAssistant__.currentYaml);

    await page.locator('[data-testid="yaml-check-fix"]').click();
    await expect(page.locator('[data-testid="yaml-patch"]')).toBeVisible();
    await expect(page.locator('[data-testid="patch-fix-0"]')).toContainText('stop');

    await page.locator('[data-testid="patch-apply"]').click();
    // Panel closes and the corrected text lands in the pane.
    await expect(page.locator('[data-testid="yaml-patch"]')).toHaveCount(0);
    const after = await page.evaluate(() => window.__agenticAssistant__.currentYaml);
    expect(after).not.toBe(before);
    expect(after).toContain('auto-fixed: stop -> end');
  });

  test('Dismiss drops the patch panel without changing the YAML', async ({ page }) => {
    await gotoWithYaml(page);
    const before = await page.evaluate(() => window.__agenticAssistant__.currentYaml);
    await page.locator('[data-testid="yaml-check-fix"]').click();
    await expect(page.locator('[data-testid="yaml-patch"]')).toBeVisible();
    await page.locator('[data-testid="patch-dismiss"]').click();
    await expect(page.locator('[data-testid="yaml-patch"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__agenticAssistant__.currentYaml)).toBe(before);
  });

  test('Check & fix on clean YAML shows the no-fixes acknowledgement, no panel', async ({ page }) => {
    await gotoWithYaml(page, { clean: true });
    await page.locator('[data-testid="yaml-check-fix"]').click();
    await expect(page.locator('[data-testid="yaml-check-fix"]')).toContainText('No fixes needed');
    await expect(page.locator('[data-testid="yaml-patch"]')).toHaveCount(0);
  });
});
