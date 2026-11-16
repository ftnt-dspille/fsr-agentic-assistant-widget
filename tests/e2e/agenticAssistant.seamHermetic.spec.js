'use strict';
// Seam C (stability plan Phase 0.4) — the box-free real-widget ↔ real-connector
// turn. The other e2e specs mock the ENTIRE /api/integration/execute response,
// so the widget never exercises the real operations.py; the live matrix runs the
// real connector but needs a box. This spec closes that gap: the REAL widget
// controller drives a real chat_turn, and the outgoing execute call is FORWARDED
// to the hermetic local-connector sidecar (FSRPB_SIDECAR_HERMETIC=1 → real
// operations.py + FAKE LLM + CASSETTE reads). No box, no LLM credits, yet the
// full connector pipeline runs: persona resolution, prompt assembly, tool
// slicing, envelope shaping. A wrong envelope shape or a broken widget↔connector
// contract fails HERE, box-free.
//
// The sidecar URL comes from FSRPB_SEAMC_URL (make turn-hermetic starts it and
// sets this); default matches the make target's port.
const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const SIDECAR = process.env.FSRPB_SEAMC_URL || 'http://127.0.0.1:4778/execute';

// The fake LLM the hermetic sidecar installs emits this single end_turn text
// (local_turn._install_fake_provider). Its appearance in the timeline proves the
// real connector envelope flowed all the way through to the rendered widget.
const FAKE_MARKER = 'spine assembled';

// Forward every execute call to the hermetic sidecar and relay its response
// verbatim; stub connector resolution so real=1 can resolve name/version/config.
async function installRoutes(page, seen) {
  await page.route(/\/api\/integration\/connectors\//, route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: [{
        name: 'connector-fsr-agentic-assistant', version: '1.0.0',
        configuration: [{ name: 'fsrpb-live', config_id: 'cfg-0001', default: true }]
      }] })
    })
  );
  await page.route(/\/api\/integration\/execute\//, async (route) => {
    const raw = route.request().postData() || '{}';
    let op = '';
    try { op = (JSON.parse(raw).operation) || ''; } catch (e) { /* noop */ }
    seen.push(op);
    let resp;
    try {
      const r = await fetch(SIDECAR, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw
      });
      resp = await r.text();
    } catch (e) {
      // Surface an unreachable sidecar as a connector-shaped failure so the
      // assertion fails with a clear message rather than a silent hang.
      resp = JSON.stringify({ status: 'Failed', data: { ok: false, error: {
        code: 'seamc_sidecar_unreachable',
        message: `hermetic sidecar not reachable at ${SIDECAR}: ${e && e.message}. ` +
          'Start it via `make turn-hermetic` (FSRPB_SIDECAR_HERMETIC=1).' } } });
    }
    route.fulfill({ contentType: 'application/json', body: resp });
  });
}

async function boot(page, ctx) {
  ctx = ctx || 'alert';
  await page.addInitScript(([id, c]) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', maxTurns: 10,
      seedFromEntity: false
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', c);
    localStorage.setItem('harness.id', c === 'alert' ? 'alert-1' : '');
  }, [WIDGET_ID, ctx]);
  // real=1 forces chat_turn down the LIVE connector wire path so our route
  // interception (→ hermetic sidecar) serves it.
  await page.goto(`/?widget=${WIDGET_ID}&context=${ctx}&opener=1&real=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ &&
      typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
}

// This spec needs the hermetic sidecar (real operations.py + fake LLM) running
// at FSRPB_SEAMC_URL. `make turn-hermetic` starts it and sets that env var; the
// general mock-e2e gate (`test-e2e-widget` / ship-verify) does NOT, so without
// the env var we'd forward chat_turn to an unreachable sidecar and fail on a
// `seamc_sidecar_unreachable` error card. Skip there — this tier is exercised by
// `make turn-hermetic`, not the mock gate.
test.describe('Seam C — real widget ↔ real connector (hermetic sidecar)', () => {
  test.skip(!process.env.FSRPB_SEAMC_URL,
    'Seam C hermetic tier — run via `make turn-hermetic` (needs the sidecar + FSRPB_SEAMC_URL)');
  test('a real chat_turn renders the connector transcript, box-free', async ({ page }) => {
    const seen = [];
    await installRoutes(page, seen);
    await boot(page);

    await page.locator('[data-testid="chat-input"]').fill('triage this alert');
    await page.locator('[data-testid="chat-send"]').click();

    // The real operations.chat_turn ran in the sidecar and its rendered text
    // reached the widget timeline.
    await expect(page.locator('[data-testid="messages"]'))
      .toContainText(FAKE_MARKER, { timeout: 15000 });
    expect(seen).toContain('chat_turn');
  });

  // §2.4 build-completion salvage, widget-level + box-free. The designer mount
  // (context=playbook, no open playbook id → nothing seeded) sends a BUILD turn.
  // The hermetic fake narrates a verified YAML fence but never calls
  // emit_playbook_offer; the connector's _salvage_build_offer must synthesize
  // the deploy card, so a playbook-offer renders in the timeline — the analyst
  // gets a Deploy button instead of a prose dead-end.
  test('a build turn narrating YAML lands on a rendered deploy offer', async ({ page }) => {
    const seen = [];
    await installRoutes(page, seen);
    await boot(page, 'playbook');

    // Confirm the widget entered build intent (designer mount).
    await expect.poll(
      () => page.evaluate(() => window.__agenticAssistant__ &&
        window.__agenticAssistant__.intent), { timeout: 15000 }
    ).toBe('build');

    await page.locator('[data-testid="chat-input"]').fill('design a block-IP playbook');
    await page.locator('[data-testid="chat-send"]').click();

    // The salvaged playbook_offer card renders — the Deploy affordance the raw
    // prose turn lacked.
    await expect(page.locator('[data-testid^="playbook-offer-"]').first())
      .toBeVisible({ timeout: 15000 });
    expect(seen).toContain('chat_turn');
  });
});
