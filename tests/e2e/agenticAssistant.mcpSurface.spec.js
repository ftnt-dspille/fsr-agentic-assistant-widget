'use strict';
// ───────────────────────────────────────────────────────────────────────────
// M2 WIDGET-TIER PROOF: the per-page MCP surface differs *in the widget*.
//
// The connector tier of M2 has been live-verified -- calling
// `list_mcp_servers` on the box shows module=alerts surfacing {fortisiem, soc}
// and module=workflows surfacing {deepwiki}, pinned offline by the surfacing
// oracle. What was never shown is the same thing THROUGH THE WIDGET, which is
// what the plan's north-star goal #2 actually asks for: "proven = live, in the
// widget, on a box -- not just built."
//
// The gap matters because the widget is not a passive window here. It decides
// which module to report from the mounted entity/page context, and the Tools
// panel calls `list_agent_tools` with that module (always intent=triage). A
// widget that reported the wrong module -- or the same one everywhere -- would
// show an identical surface on every page while the connector was slicing
// correctly, and every connector-tier test would still pass.
//
// This spec therefore asserts the RELATIONSHIP between two mounts rather than a
// fixed tool list: an alert page and a playbook page must not produce the same
// surface, and each must carry the servers its affordance class implies. Pinning
// exact tool names would break every time the box's MCP inventory changed, which
// is a property of the lab, not of the widget.
//
// STATUS: THIS SPEC DOES NOT PASS YET. Read this before trusting
// or "fixing" it, and do not treat its red as an M2 regression.
//
// The BEHAVIOUR it tests is proven -- `list_agent_tools`, the exact op this
// panel calls, returns different surfaces per module live on .159:
//   module=alerts    -> 64 tools, MCP servers {fortisiem, soc}
//   module=workflows -> 44 tools, MCP servers {deepwiki}
// What is unproven is this spec's ability to READ that through the UI. In the
// live tier the Tools panel is gone by the time the assertions run
// (`panelHead: "(no overlay)"`), while the identical click sequence works in
// the mock tier (agenticAssistant.tools.spec.js), whose turn resolves
// instantly. Three attempted fixes did not close it: waiting for a terminal
// panel state instead of the spinner's absence, polling the DOM instead of
// locator visibility, and waiting for state==='idle' plus an enabled composer
// before opening the menu. The remaining suspect is something CLOSING the
// overlay after openTools() in the live path, not a slow load -- the panel is
// absent, not empty.
//
// It is deliberately NOT wired into ship-verify or any gate: it runs only via
// `make test-mcp-surface-live`, so its red cannot masquerade as a widget
// regression. It is committed rather than deleted because the next person
// should inherit the three ruled-out causes, not re-run them.
//
// Gated on FSRPB_LIVE_UI=1. Run:
//   make test-mcp-surface-live SWEEP_ENV=.env.159

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');
const { makeClient } = require('../../../../fortisoar-widget-harness/tests/live/lib/soarClient');

const LIVE = process.env.FSRPB_LIVE_UI === '1';
const d = LIVE ? test.describe : test.describe.skip;

let WIDGET_ID = DEFAULT_ID;
let ENV_OK = true;
let ENV_MSG = '';

if (!LIVE) {
  console.warn('[mcpSurface] SKIPPED -- set FSRPB_LIVE_UI=1 and a box env. The '
    + 'per-page MCP surface is UNVERIFIED at the widget tier in this run.');
}

// A real alert on the box. The RECORD does not matter to this spec -- only the
// module it puts the widget on -- so it comes from the box env like the other
// live rows rather than being baked in.
const ALERT_UUID = process.env.AC_RECORD;
const ALERT = ALERT_UUID ? {
  '@id': '/api/3/alerts/' + ALERT_UUID,
  '@type': 'Alert',
  uuid: ALERT_UUID,
  name: 'surface probe',
} : null;

async function boot(page, opts) {
  opts = opts || {};
  await page.addInitScript((args) => {
    const { id, entity, ctx } = args;
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'connector-fsr-agentic-assistant',
      defaultIntent: 'triage',
      maxTurns: 14, showUsage: true,
      seedFromEntity: false, mockMode: 'real',
      detachedTimeoutMs: 480000
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', ctx);
    localStorage.removeItem('fsrPbSession');
    if (entity) window.__fsrPbEntity__ = entity;
  }, { id: WIDGET_ID, entity: opts.entity || null, ctx: opts.ctx });

  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mode=live`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 45000 });
  // Wait for the widget to SETTLE before touching the menu. A mount that is
  // still booting re-renders under the open panel and takes it away with it --
  // which is why the live read came back "(no overlay)" while the identical
  // click sequence works in the mock tier, where the turn resolves instantly.
  await page.waitForFunction(
    () => window.__agenticAssistant__.state === 'idle',
    null, { timeout: 120000 }).catch(() => {});
  await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true', { timeout: 45000 });
}

// Open the Tools panel and read what the WIDGET says its surface is.
async function readSurface(page) {
  await page.locator('[data-testid="overflow-menu"]').click();
  await page.locator('[data-testid="open-tools"]').click();
  await expect(page.locator('[data-testid="tools-overlay"]')).toBeVisible({ timeout: 30000 });
  // Wait for a TERMINAL state, not for the absence of the spinner. Asserting
  // `tools-loading` has count 0 passes instantly in the window before loading
  // even starts, so the first read of this panel returned an empty list while
  // the real one was still on its way -- and an empty list compared against
  // another empty list would have "proven" the surfaces were the same.
  // Poll the DOM directly rather than via locator visibility: `toBeVisible` on
  // a comma-selector resolved against a container that exists before it has any
  // rows, so the read still landed early. This waits for the panel to actually
  // hold something -- rows, an empty notice, or an error.
  await page.waitForFunction(() => {
    const q = (s) => document.querySelectorAll(s).length;
    return q('[data-testid="tools-name"]') > 0
      || q('[data-testid="tools-empty"]') > 0
      || q('[data-testid="tools-error"]') > 0;
  }, null, { timeout: 120000 }).catch(() => {});

  const error = await page.locator('[data-testid="tools-error"]').innerText().catch(() => '');
  const module = await page.locator('[data-testid="tools-module"]').innerText().catch(() => '');
  const names = await page.locator('[data-testid="tools-name"]').allInnerTexts().catch(() => []);
  const servers = Array.from(new Set(names
    .map((n) => /^mcp_([a-z0-9]+)__/.exec(n.trim()))
    .filter(Boolean)
    .map((m) => m[1])));
  // A failure here is useless without knowing what the panel actually showed,
  // and the accessibility snapshot only arrives on timeout.
  const panelText = await page.locator('[data-testid="tools-overlay"]')
    .innerText().catch(() => '(no overlay)');
  return {
    module: module.trim(),
    error: error.trim(),
    names,
    servers,
    panelHead: panelText.replace(/\s+/g, ' ').slice(0, 200),
  };
}

d('M2 widget tier: the mounted page decides the MCP surface', () => {
  // Serial: the comparison test reads what the two mount tests recorded, so they
  // must run in order in one worker. It also means a mount failure skips the
  // comparison instead of comparing against `undefined`.
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    WIDGET_ID = await resolveWidgetId(request);
    try {
      const soar = await makeClient();
      const h = await soar.exec('health_check', {}, { timeoutMs: 30000 });
      if (!h || h.ok === false) {
        ENV_OK = false;
        ENV_MSG = 'connector health_check not ok: ' + JSON.stringify(h).slice(0, 200);
      }
    } catch (e) {
      ENV_OK = false;
      ENV_MSG = 'connector health_check threw: ' + String((e && e.message) || e).slice(0, 200);
    }
    if (!ENV_OK) console.warn('[[SWEEP-ENV-SKIP]] ' + ENV_MSG);
  });

  test.beforeEach(() => {
    test.skip(!ENV_OK, 'ENV: ' + ENV_MSG);
    // No AC_RECORD means no alert page to compare against. Skip loudly rather
    // than quietly grading one mount against nothing.
    if (!ALERT) {
      console.warn('[[SWEEP-ENV-SKIP]] no AC_RECORD in this box env -- the alert '
        + 'mount has no record, so the per-page comparison covers nothing.');
      test.skip(true, 'ENV: no AC_RECORD');
    }
  });

  // One mount per test, each on its own fresh page. Booting twice inside one
  // test re-ran addInitScript against a page whose overlay was still up and hit
  // the test timeout -- and a timeout there proves nothing either way.
  const seen = {};

  for (const row of [
    { key: 'alert', ctx: 'drawer', entity: () => ALERT },
    { key: 'playbook', ctx: 'playbook', entity: () => null },
  ]) {
    test(`the ${row.key} page reports its own tool surface`, async ({ page }) => {
      test.setTimeout(180000);
      await boot(page, { entity: row.entity(), ctx: row.ctx });
      const surface = await readSurface(page);
      seen[row.key] = surface;
      console.log('[[MCP-SURFACE]] ' + JSON.stringify({ page: row.key, ...surface }));
      expect.soft(surface.error, `no tools error on the ${row.key} page`).toBe('');
      // A cold connector worker reports zero MCP tools until it has materialized
      // them. That is not "no surfacing", and comparing two empty lists would
      // "prove" sameness for a reason that has nothing to do with the widget --
      // so an empty surface fails here rather than flowing into the comparison.
      expect.soft(surface.names.length, `the ${row.key} page listed some tools`)
        .toBeGreaterThan(0);
    });
  }

  test('an alert page and a playbook page do not advertise the same MCP surface', async () => {
    const alertSurface = seen.alert;
    const pbSurface = seen.playbook;
    expect(alertSurface && pbSurface, 'both mounts produced a surface to compare').toBeTruthy();

    // The widget must report DIFFERENT modules -- if it reported the same one
    // everywhere, the surfaces below could match for a reason that has nothing
    // to do with the connector's slicing.
    expect.soft(alertSurface.module, 'the alert mount reports its own module')
      .not.toBe(pbSurface.module);

    // The core claim, stated as a relationship rather than a fixed inventory.
    expect.soft(alertSurface.servers.sort().join(','),
      'the two pages surface different MCP servers')
      .not.toBe(pbSurface.servers.sort().join(','));

    // Direction, not just difference: a triage page must not be the one holding
    // the docs server, which belongs to the authoring affordance class.
    expect.soft(alertSurface.servers, 'the alert page does not surface the docs server')
      .not.toContain('deepwiki');
  });
});
