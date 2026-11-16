'use strict';
// A record write that changes a long template shows the changed lines, not the
// whole old and new values (live: a 3,000-character Jinja template struck
// through, an arrow, the whole new template, under "outputtemplatejson").

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const OLD = [
  "{%- set ints = data.dvmdb_ints | default([]) -%}",
  "{%- set table = [] -%}",
  "{%- for d in ints %}",
  "{%- set ip_addr = d.ip[0] -%}",
  "{%- set ip_mask = d.ip[1] -%}",
  "{%- set ip = (ip_addr ~ '/' ~ ip_mask) | ipaddr('host/prefix') -%}",
  "{%- set network = (ip_addr ~ '/' ~ ip_mask) | ipaddr('network/prefix') -%}",
  "{%- do table.append({'name': d.name, 'ip': ip, 'ip_network': network}) -%}",
  "{%- endfor %}",
  "{{ table | tojson }}",
].join("\n");
const NEW = OLD.replace("{%- set ip = (ip_addr ~ '/' ~ ip_mask) | ipaddr('host/prefix') -%}",
                        "{%- set ip = ip_addr -%}");

test('a long template change shows its changed lines under a summary', async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', maxTurns: 10 }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path&fastmock=1`,
                  { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 });
  await page.evaluate(([before, after]) => window.__agenticAssistant__.replayTurns([
    { user: 'make ip host only' },
    { transcript: [{ type: 'action_card', id: 'tpl', approval_id: 'tpl', tool: 'update_record',
      summary: 'Update Get DeviceDB Config - Interfaces', args: { outputTemplateJSON: after },
      target: { module: 'ztpf_automation_actions', uuid: 'a1', name: 'Get DeviceDB Config - Interfaces' },
      changes: [{ field: 'outputTemplateJSON', before: before, after: after }] }] },
  ]), [OLD, NEW]);

  const row = page.locator('[data-testid="action-change-tpl-outputTemplateJSON"]');
  await expect(row).toContainText('Output template JSON');
  await expect(page.locator('[data-testid="action-change-toggle-tpl-outputTemplateJSON"]'))
    .toHaveText(/1 line changed: 1 added, 1 removed/);
  const diff = page.locator('[data-testid="action-change-diff-tpl-outputTemplateJSON"]');
  await expect(diff.locator('.dl-del')).toHaveText(["-{%- set ip = (ip_addr ~ '/' ~ ip_mask) | ipaddr('host/prefix') -%}"]);
  await expect(diff.locator('.dl-add')).toHaveText(['+{%- set ip = ip_addr -%}']);
  await expect(diff.locator('.dl-gap').first()).toHaveText('3 unchanged lines');
  // Only the changed region: the first statement is folded away.
  await expect(diff).not.toContainText('dvmdb_ints');
  // The values are not repeated in an open form under the diff.
  await expect(page.locator('[data-testid="action-arg-tpl-outputTemplateJSON"]')).toHaveCount(0);
  // Collapses and reopens.
  await page.locator('[data-testid="action-change-toggle-tpl-outputTemplateJSON"]').click();
  await expect(diff).toHaveCount(0);
  await page.locator('[data-testid="action-change-toggle-tpl-outputTemplateJSON"]').click();
  await expect(diff).toBeVisible();
  if (process.env.DIFF_SHOT) {
    await page.locator('[data-testid="action-change-tpl-outputTemplateJSON"]').locator('xpath=ancestor::div[contains(@class,"action-card")]')
      .screenshot({ path: process.env.DIFF_SHOT });
  }
});
