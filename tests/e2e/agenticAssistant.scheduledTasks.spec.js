'use strict';
const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');

const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => {
  WIDGET_ID = await resolveWidgetId(request);
});

// The scheduled tasks panel + per-task run history drawer (scheduled-agent-tasks
// plan). The panel manages cron-driven agent runs; the history drawer (plan
// §8.4) lists each fire's outcome and hands a parked (HITL-gated) run to the
// chat history path (loadSession). Hermetic: the two read ops short-circuit to
// empty in mock mode, so the rows are driven through the injection seams
// (injectScheduledTasks / injectScheduledTaskRuns) exactly as injectSessions
// drives the history browser.

async function gotoWidget(page) {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder',
      defaultIntent: 'triage', maxTurns: 10, showUsage: true
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ &&
          typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
  return errors;
}

async function openMenuItem(page, testid) {
  await page.locator('[data-testid="overflow-menu"]').click();
  await page.locator('[data-testid="overflow-dropdown"]').waitFor();
  await page.locator(`[data-testid="${testid}"]`).click();
}

const TASKS = [
  { name: 'Bandwidth watch', cron: '0 9 * * 1', intent: 'triage',
    prompt: 'Check FortiGate interfaces in FortiManager; alert if bandwidth spiked.',
    schedule_enabled: true, total_run_count: 3, last_run_at: '2026-08-14T09:00Z' },
  { name: 'Weekly IOC sweep', cron: '0 9 * * 1', intent: 'triage',
    prompt: 'Review escalated alerts; flag IOC overlap.', schedule_enabled: false },
];

test.describe('FSR Agentic Assistant -- scheduled tasks panel + history drawer', () => {

  test('panel opens from the overflow menu and shows the empty state', async ({ page }) => {
    const errors = await gotoWidget(page);
    await openMenuItem(page, 'open-scheduled-tasks');

    await expect(page.locator('[data-testid="scheduled-overlay"]')).toBeVisible();
    // Mock mode short-circuits listScheduledTasks to empty.
    await expect(page.locator('[data-testid="scheduled-empty"]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('injected tasks render name, cron, prompt, and the intent badge', async ({ page }) => {
    await gotoWidget(page);
    await openMenuItem(page, 'open-scheduled-tasks');
    await page.evaluate((tasks) => {
      window.__agenticAssistant__.injectScheduledTasks(tasks);
    }, TASKS);

    const items = page.locator('[data-testid="scheduled-item"]');
    await expect(items).toHaveCount(2);
    await expect(page.locator('[data-testid="scheduled-item"]').first())
      .toContainText('Bandwidth watch');
    await expect(page.locator('[data-testid="scheduled-item"]').first())
      .toContainText('FortiGate interfaces');
    // Second task is paused (schedule_enabled false).
    await expect(page.locator('[data-testid="scheduled-item"]').nth(1))
      .toContainText('paused');
  });

  test('backdrop and close button dismiss the panel', async ({ page }) => {
    await gotoWidget(page);
    await openMenuItem(page, 'open-scheduled-tasks');
    await expect(page.locator('[data-testid="scheduled-overlay"]')).toBeVisible();
    await page.locator('[data-testid="scheduled-close"]').click();
    await expect(page.locator('[data-testid="scheduled-overlay"]')).toHaveCount(0);
  });

  test('the cron preview renders a human-readable schedule', async ({ page }) => {
    await gotoWidget(page);
    await openMenuItem(page, 'open-scheduled-tasks');
    await page.locator('[data-testid="scheduled-new"]').click();
    await page.locator('[data-testid="scheduled-field-cron"]').fill('0 9 * * 1');
    const preview = page.locator('[data-testid="scheduled-cron-preview"]');
    await expect(preview).toContainText(/Monday/i);
    await expect(preview).toContainText('09:00');
  });

  test('History button opens the per-task run drawer; injected runs render', async ({ page }) => {
    await gotoWidget(page);
    await openMenuItem(page, 'open-scheduled-tasks');
    await page.evaluate((tasks) => {
      window.__agenticAssistant__.injectScheduledTasks(tasks);
    }, TASKS);

    // Open the history drawer for the first task.
    await page.locator('[data-testid="scheduled-item"]').first()
      .locator('[data-testid="scheduled-history"]').click();
    await expect(page.locator('[data-testid="scheduled-history-overlay"]')).toBeVisible();
    await expect(page.locator('[data-testid="scheduled-history-overlay"] .modal-title'))
      .toContainText('Bandwidth watch');

    const now = Math.floor(Date.now() / 1000);
    await page.evaluate((now) => {
      window.__agenticAssistant__.injectScheduledTaskRuns([
        { session_id: 'sched:Bandwidth watch:u1', title: 'run me',
          verdict: 'Bandwidth spiked on port3;FortiGate bgp flap likely cause',
          stop_reason: 'end_turn', parked: false, entries: 4, last_activity: now },
        { session_id: 'sched:Bandwidth watch:u2', title: 'run me',
          verdict: 'Gate open: block_ip pending approval',
          stop_reason: 'awaiting_action_card', parked: true, entries: 3,
          last_activity: now - 3600 },
      ]);
    }, now);

    const runs = page.locator('[data-testid="scheduled-run-item"]');
    await expect(runs).toHaveCount(2);
    await expect(runs.first()).toContainText('Bandwidth spiked');
    // The parked run shows a "Resume" button; the completed run shows "View".
    await expect(runs.first().locator('[data-testid="scheduled-run-open"]'))
      .toHaveText('View');
    await expect(runs.nth(1).locator('[data-testid="scheduled-run-open"]'))
      .toHaveText('Resume');
    await expect(runs.nth(1).locator('[data-testid="scheduled-run-badge"]'))
      .toContainText('parked');
  });

  test('history drawer backdrops and close dismiss it', async ({ page }) => {
    await gotoWidget(page);
    await openMenuItem(page, 'open-scheduled-tasks');
    await page.evaluate((t) => window.__agenticAssistant__.injectScheduledTasks(t), TASKS);
    await page.locator('[data-testid="scheduled-item"]').first()
      .locator('[data-testid="scheduled-history"]').click();
    await expect(page.locator('[data-testid="scheduled-history-overlay"]')).toBeVisible();
    await page.locator('[data-testid="scheduled-history-close"]').click();
    await expect(page.locator('[data-testid="scheduled-history-overlay"]')).toHaveCount(0);
  });

  test('Resume hands the parked run session to the chat and closes both drawers', async ({ page }) => {
    await gotoWidget(page);
    await openMenuItem(page, 'open-scheduled-tasks');
    await page.evaluate((t) => window.__agenticAssistant__.injectScheduledTasks(t), TASKS);
    await page.locator('[data-testid="scheduled-item"]').first()
      .locator('[data-testid="scheduled-history"]').click();

    await page.evaluate(() => {
      window.__agenticAssistant__.injectScheduledTaskRuns([
        { session_id: 'sched:Bandwidth watch:u2', title: 'run me',
          verdict: 'gate open', stop_reason: 'awaiting_action_card',
          parked: true, entries: 3, last_activity: Math.floor(Date.now() / 1000) - 3600 },
      ]);
    });

    const before = await page.evaluate(() => window.__agenticAssistant__.sessionId);
    await page.locator('[data-testid="scheduled-run-open"]').click();

    // Both drawers closed.
    await expect(page.locator('[data-testid="scheduled-history-overlay"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scheduled-overlay"]')).toHaveCount(0);
    // The chat switched to the parked run's session (the resume handoff).
    const after = await page.evaluate(() => window.__agenticAssistant__.sessionId);
    expect(after).toBe('sched:Bandwidth watch:u2');
    expect(after).not.toBe(before);
  });

  test('history drawer shows the empty state for a task with no runs', async ({ page }) => {
    await gotoWidget(page);
    await openMenuItem(page, 'open-scheduled-tasks');
    await page.evaluate((t) => window.__agenticAssistant__.injectScheduledTasks(t), TASKS);
    await page.locator('[data-testid="scheduled-item"]').first()
      .locator('[data-testid="scheduled-history"]').click();
    // Mock mode short-circuits listScheduledTaskRuns to {ok, runs:[]}.
    await expect(page.locator('[data-testid="scheduled-runs-empty"]')).toBeVisible();
  });
});
