'use strict';
// needs_config help panel (LIVE path) -- a broken active config must NOT crash
// the widget or silently fall back; it surfaces a diagnose+grade+override panel.
//
// Every mock spec resolves a healthy connector implicitly. This one stubs the
// FortiSOAR connector HTTP layer (page.route on /api/integration/{connectors,
// execute}) so the connector RESOLVES but its starred-default config
// (fsrpb-frank) fails its health_check (unreachable egress), while a non-default
// config (fsrpb-live) probes healthy. Asserts: the panel renders with a specific
// diagnosis + per-config grades, the composer is gated, and adopting the healthy
// config for the session clears the panel and shows the visible override banner.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const HELP     = '[data-testid="connector-help"]';
const MESSAGE  = '[data-testid="connector-help-message"]';
const GRADE_FR = '[data-testid="config-grade-fsrpb-frank"]';
const GRADE_LV = '[data-testid="config-grade-fsrpb-live"]';
const USE_LIVE = '[data-testid="use-config-fsrpb-live"]';
const RECHECK  = '[data-testid="connector-help-recheck"]';
const BANNER   = '[data-testid="connector-override-banner"]';
const INPUT    = '[data-testid="chat-input"]';

const CONTRACT = '2.8.0';

// Two configs: the starred DEFAULT (frank) is broken; live is healthy.
function connectorsBody() {
  return {
    data: [{
      name: 'connector-fsr-agentic-assistant',
      version: CONTRACT,
      configuration: [
        { name: 'fsrpb-frank', config_id: 'cfg-frank', default: true },
        { name: 'fsrpb-live',  config_id: 'cfg-live',  default: false }
      ]
    }]
  };
}
const envelope = (operation, data) => ({ operation, status: 'Success', message: 'ok', data });

const HEALTH = {
  'cfg-frank': { ok: false, llm_key_configured: true, llm_reachable: false,
                 llm_error: 'APIConnectionError: Connection refused', llm_provider: 'openai' },
  'cfg-live':  { ok: true, llm_key_configured: true, llm_reachable: true,
                 llm_probe: '12 models', llm_error: null, llm_provider: 'openai' }
};

// The SOAR execute body carries the selected config id in `config` (fall back to
// a couple of alternate keys defensively). Health is keyed off it.
function configOf(body) {
  return body.config || body.config_id || body.configId || null;
}

// A health map that answers differently per CALL, so a config can fail the gate
// probe and pass the grade probe -- an intermittent endpoint, which is the only
// way to reproduce the latched panel. `seq[config]` is consumed left to right;
// the last entry repeats forever.
function sequencedHealth(seq) {
  const calls = {};
  return (cfg) => {
    const list = seq[cfg];
    if (!list) return { ok: false, llm_key_configured: false };
    const i = calls[cfg] = (calls[cfg] || 0);
    calls[cfg] = i + 1;
    return list[Math.min(i, list.length - 1)];
  };
}

async function stubConnector(page, healthFn) {
  const health = healthFn || ((cfg) => HEALTH[cfg] || { ok: false, llm_key_configured: false });
  await page.route(/\/api\/integration\/connectors\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(connectorsBody()) })
  );
  await page.route(/\/api\/integration\/execute\//, async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* */ }
    const op = body.operation;
    let data;
    if (op === 'health_check') {
      data = health(configOf(body));
    } else {
      data = { ok: true };
    }
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(envelope(op, data)) });
  });
}

async function boot(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      defaultIntent: 'triage', maxTurns: 10, seedFromEntity: false, mockMode: 'real'
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  // ?mode=live forces the real wire path (no mock track) so the health gate runs.
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mode=live`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 });
}

test.describe('needs_config help panel -- broken default config', () => {
  test('renders a specific diagnosis + per-config grades and gates the composer', async ({ page }) => {
    await stubConnector(page);
    await boot(page);

    await expect(page.locator(HELP)).toBeVisible({ timeout: 15000 });
    // Specific fault (unreachable egress), not a generic error.
    await expect(page.locator(HELP)).toHaveAttribute('data-fault', 'unreachable');
    await expect(page.locator(MESSAGE)).toContainText(/unreachable/i);
    // Every config graded: frank unhealthy, live healthy.
    await expect(page.locator(GRADE_FR)).toContainText(/unhealthy/i);
    await expect(page.locator(GRADE_LV)).toContainText(/healthy/i);
    // Composer stays gated until a healthy config is in play.
    await expect(page.locator(INPUT)).toBeDisabled();
    // The healthy, non-active config is offered for a temp override.
    await expect(page.locator(USE_LIVE)).toBeVisible();
    await expect(page.locator(RECHECK)).toBeVisible();
  });

  test('adopting the healthy config for the session clears the panel + shows the override banner', async ({ page }) => {
    await stubConnector(page);
    await boot(page);
    await expect(page.locator(HELP)).toBeVisible({ timeout: 15000 });

    await page.locator(USE_LIVE).click();

    // Panel gone, visible session-override banner up, composer usable.
    await expect(page.locator(HELP)).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator(BANNER)).toBeVisible();
    await expect(page.locator(BANNER)).toContainText('fsrpb-live');
    await expect(page.locator(INPUT)).toBeEnabled();
  });
});

// The panel that would not let go of its own alarm. Reported from a real box:
// the banner said the active config was unreachable while the list below it
// graded that SAME config healthy -- and offered no button, because a temp
// override onto the config you are already using is meaningless. A dead end.
//
// Cause: the gate probe timed out once (an intermittent endpoint), and nothing
// afterwards ever re-examined the gate. `connectorHelp` was only ever assigned
// on the way IN. The connector now retries a transient probe, which makes this
// rare -- these tests hold the widget's half, which must not depend on that.
test.describe('needs_config help panel -- one bad probe on a healthy config', () => {
  test('clears itself when the ACTIVE config re-grades healthy, with no click', async ({ page }) => {
    // frank fails the gate probe, then answers normally: exactly one bad call.
    await stubConnector(page, sequencedHealth({
      'cfg-frank': [
        { ok: false, llm_key_configured: true, llm_reachable: false,
          llm_error: 'APITimeoutError: Request timed out.', llm_provider: 'openai' },
        { ok: true, llm_key_configured: true, llm_reachable: true,
          llm_probe: '126 models (after 1 retry)', llm_error: null, llm_provider: 'openai' }
      ],
      'cfg-live': [HEALTH['cfg-live']]
    }));
    await boot(page);

    // The panel is allowed to appear -- the gate probe really did fail. What it
    // may NOT do is stay up once the grade pass contradicts it.
    await expect(page.locator(HELP)).toHaveCount(0, { timeout: 20000 });
    await expect(page.locator(INPUT)).toBeEnabled();
    // Self-cleared, NOT overridden onto another config: the analyst keeps the
    // config they chose, so no override banner.
    await expect(page.locator(BANNER)).toHaveCount(0);
  });

  test('a config that stays down keeps the panel up -- the clear is not unconditional', async ({ page }) => {
    // The silencing case. Without it, "the panel disappeared" would pass for a
    // widget that simply never gates, which is the bug in the other direction.
    await stubConnector(page, sequencedHealth({
      'cfg-frank': [
        { ok: false, llm_key_configured: true, llm_reachable: false,
          llm_error: 'APITimeoutError: Request timed out.', llm_provider: 'openai' }
      ],
      'cfg-live': [HEALTH['cfg-live']]
    }));
    await boot(page);

    await expect(page.locator(HELP)).toBeVisible({ timeout: 15000 });
    // A timeout is its own fault: "did not answer in time" is a different
    // instruction to the analyst than "unreachable", which reads as misconfigured.
    await expect(page.locator(HELP)).toHaveAttribute('data-fault', 'timeout');
    await expect(page.locator(MESSAGE)).toContainText(/in time/i);
    await expect(page.locator(INPUT)).toBeDisabled();
  });
});
