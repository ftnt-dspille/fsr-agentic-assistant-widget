'use strict';
// ───────────────────────────────────────────────────────────────────────────
// LIVE scheduled-tasks history drawer (plan section 8.4). Drives the REAL
// widget against the REAL connector on the box in .env (FSR_BASE_URL).
//
// Verifies the full UI path that the hermetic mock e2e can only exercise
// through injection seams:
//   1. Open the scheduled-tasks panel (live list_scheduled_tasks)
//   2. Click the History button on a task
//   3. The history drawer loads real runs (live list_scheduled_task_runs)
//   4. A run row shows a verdict snippet + outcome badge + View button
//   5. Clicking View hands the session to the chat (loadSession handoff)
//
// Gated on FSRPB_LIVE_UI=1. Run:
//   FSRPB_LIVE_UI=1 make test-e2e-spec \
//     SPEC="tests/e2e/agenticAssistant.liveScheduled.spec.js"

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');
const { makeClient } = require('../../../../fortisoar-widget-harness/tests/live/lib/soarClient');

const LIVE = process.env.FSRPB_LIVE_UI === '1';
const d = LIVE ? test.describe : test.describe.skip;

const TASK_NAME = 'Bandwidth Spike Alert';

let WIDGET_ID = DEFAULT_ID;
let ENV_OK = true;
let ENV_MSG = '';

test.beforeAll(async ({ request }) => {
  if (!LIVE) return;
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
  test.skip(LIVE && !ENV_OK, 'ENV: connector/LLM backend unavailable -- ' + ENV_MSG);
});

// ── Per-test error capture ──────────────────────────────────────────────────
function attachCapture(page) {
  const cap = { consoleErrors: [], pageErrors: [], apiFailures: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (/favicon|ResizeObserver loop/i.test(t)) return;
      cap.consoleErrors.push(t.slice(0, 400));
    }
  });
  page.on('pageerror', (err) => cap.pageErrors.push(String(err && err.message || err).slice(0, 400)));
  page.on('response', (resp) => {
    try {
      const u = resp.url();
      const s = resp.status();
      if (s >= 400 && /\/api\//.test(u)) {
        cap.apiFailures.push(s + ' ' + u.replace(/https?:\/\/[^/]+/, '').slice(0, 160));
      }
    } catch (_) { /* ignore */ }
  });
  return cap;
}

async function boot(page) {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'connector-fsr-agentic-assistant',
      defaultIntent: 'triage', maxTurns: 14, showUsage: true,
      mockMode: 'real', detachedTimeoutMs: 480000
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);

  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mode=live`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 45000 });
}

async function openMenuItem(page, testid) {
  await page.locator('[data-testid="overflow-menu"]').click();
  await page.locator('[data-testid="overflow-dropdown"]').waitFor();
  await page.locator(`[data-testid="${testid}"]`).click();
}

function report(label, cap, extra) {
  const summary = Object.assign({
    scenario: label,
    consoleErrors: cap.consoleErrors,
    pageErrors: cap.pageErrors,
    apiFailures: cap.apiFailures.slice(0, 12)
  }, extra || {});
  console.log('[[SWEEP]] ' + JSON.stringify(summary));
  return summary;
}

d('LIVE scheduled-tasks history drawer', () => {
  test.describe.configure({ mode: 'serial' });

  test('scheduled panel lists the task from the live box', async ({ page }) => {
    test.setTimeout(120000);
    const cap = attachCapture(page);
    await boot(page);

    // Open the scheduled-tasks panel.
    await openMenuItem(page, 'open-scheduled-tasks');
    await expect(page.locator('[data-testid="scheduled-overlay"]')).toBeVisible({ timeout: 15000 });

    // Wait for the live list_scheduled_tasks to resolve (at least one item).
    await page.locator('[data-testid="scheduled-item"]').first().waitFor({ timeout: 30000 });
    const items = page.locator('[data-testid="scheduled-item"]');
    const count = await items.count();

    const r = report('scheduled-panel-live', cap, { taskCount: count });
    expect.soft(r.pageErrors, 'no uncaught JS').toEqual([]);
    expect(count, 'at least one scheduled task from the live box').toBeGreaterThan(0);
  });

  test('history drawer loads real runs with verdict + badge', async ({ page }) => {
    test.setTimeout(120000);
    const cap = attachCapture(page);
    await boot(page);
    await openMenuItem(page, 'open-scheduled-tasks');

    // Wait for the task list to load.
    await page.locator('[data-testid="scheduled-item"]').first().waitFor({ timeout: 30000 });

    // Find the "Bandwidth Spike Alert" task row and click its History button.
    const taskRow = page.locator('[data-testid="scheduled-item"]', { hasText: TASK_NAME });
    await expect(taskRow).toHaveCount(1, { timeout: 10000 });
    await taskRow.locator('[data-testid="scheduled-history"]').click();

    // The history drawer opens.
    await expect(page.locator('[data-testid="scheduled-history-overlay"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="scheduled-history-overlay"] .modal-title'))
      .toContainText(TASK_NAME);

    // Wait for runs to load (at least one run row, or the empty state).
    // The run we triggered earlier should appear.
    const runItem = page.locator('[data-testid="scheduled-run-item"]');
    const emptyState = page.locator('[data-testid="scheduled-runs-empty"]');

    // Race: either runs appear or the empty state shows.
    let hasRuns = false;
    try {
      await runItem.first().waitFor({ timeout: 30000 });
      hasRuns = true;
    } catch (_) {
      await expect(emptyState).toBeVisible({ timeout: 5000 });
    }

    let runCount = 0, verdictText = '', badgeText = '';
    if (hasRuns) {
      runCount = await runItem.count();
      verdictText = await runItem.first().textContent().then(t => t.slice(0, 200));
      badgeText = await runItem.first().locator('[data-testid="scheduled-run-badge"]').textContent().catch(() => '');
    }

    const r = report('history-drawer-live', cap, {
      hasRuns, runCount, verdictSnippet: verdictText, badgeText
    });
    expect.soft(r.pageErrors, 'no uncaught JS').toEqual([]);
    if (hasRuns) {
      expect(runCount, 'at least one run from the live box').toBeGreaterThan(0);
      // The run row should have a badge (completed/parked/failed).
      expect(badgeText.length, 'badge text present').toBeGreaterThan(0);
    }

    // Close the drawer.
    await page.locator('[data-testid="scheduled-history-close"]').click();
    await expect(page.locator('[data-testid="scheduled-history-overlay"]')).toHaveCount(0);
  });

  test('View button hands the run session to the chat', async ({ page }) => {
    test.setTimeout(120000);
    const cap = attachCapture(page);
    await boot(page);
    await openMenuItem(page, 'open-scheduled-tasks');
    await page.locator('[data-testid="scheduled-item"]').first().waitFor({ timeout: 30000 });

    const taskRow = page.locator('[data-testid="scheduled-item"]', { hasText: TASK_NAME });
    await expect(taskRow).toHaveCount(1, { timeout: 10000 });
    await taskRow.locator('[data-testid="scheduled-history"]').click();
    await expect(page.locator('[data-testid="scheduled-history-overlay"]')).toBeVisible({ timeout: 10000 });

    // Wait for runs.
    let hasRuns = false;
    try {
      await page.locator('[data-testid="scheduled-run-item"]').first().waitFor({ timeout: 30000 });
      hasRuns = true;
    } catch (_) {
      // No runs -- skip the View test.
    }

    if (!hasRuns) {
      report('view-handoff-skipped', cap, { reason: 'no runs on the live box' });
      test.skip(true, 'no runs to View on the live box');
      return;
    }

    // Click the View/Resume button on the first run.
    const before = await page.evaluate(() => window.__agenticAssistant__.sessionId);
    await page.locator('[data-testid="scheduled-run-open"]').first().click();

    // Both drawers closed.
    await expect(page.locator('[data-testid="scheduled-history-overlay"]')).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('[data-testid="scheduled-overlay"]')).toHaveCount(0, { timeout: 10000 });

    // The chat switched to the run's session.
    const after = await page.evaluate(() => window.__agenticAssistant__.sessionId);
    expect(after, 'session switched to the run').not.toBe(before);
    expect(after.startsWith('sched:'), 'session is a sched: session').toBe(true);

    report('view-handoff-live', cap, { beforeSession: before, afterSession: after });
  });
});
