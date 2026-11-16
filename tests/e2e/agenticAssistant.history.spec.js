'use strict';
const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');

const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => {
  WIDGET_ID = await resolveWidgetId(request);
});

async function gotoWidget(page) {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder',
      defaultIntent: 'build', maxTurns: 10, showUsage: true
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

// History/Export/Settings now live behind the overflow (⋯) menu.
async function openMenuItem(page, testid) {
  await page.locator('[data-testid="overflow-menu"]').click();
  await page.locator('[data-testid="overflow-dropdown"]').waitFor();
  await page.locator(`[data-testid="${testid}"]`).click();
}

test.describe('FSR Agentic Assistant — history browser', () => {

  test('History button opens the panel; empty store shows the empty state', async ({ page }) => {
    const errors = await gotoWidget(page);

    await expect(page.locator('[data-testid="overflow-menu"]')).toBeVisible();
    await openMenuItem(page, 'open-history');

    await expect(page.locator('[data-testid="history-overlay"]')).toBeVisible();
    // Mock mode never hits the connector, so the list comes back empty.
    await expect(page.locator('[data-testid="history-empty"]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('renders injected sessions, marks the current one, and reopens on click', async ({ page }) => {
    await gotoWidget(page);

    // The session this tab is on — inject it so the "current" badge shows.
    const current = await page.evaluate(() => window.__agenticAssistant__.sessionId);

    await openMenuItem(page, 'open-history');
    await expect(page.locator('[data-testid="history-overlay"]')).toBeVisible();

    const nowSec = Math.floor(Date.now() / 1000);
    await page.evaluate(([cur, now]) => {
      window.__agenticAssistant__.injectSessions([
        { session_id: cur, title: 'this conversation', entries: 3, last_activity: now, started_at: now },
        { session_id: 'sess-prior-1', title: 'block 1.2.3.4 at the edge', entries: 6, last_activity: now - 86400, started_at: now - 86400 },
        { session_id: 'sess-prior-2', title: 'triage the phishing alert', entries: 2, last_activity: now - 86400 * 10, started_at: now - 86400 * 10 },
      ]);
    }, [current, nowSec]);

    const items = page.locator('[data-testid="history-item"]');
    await expect(items).toHaveCount(3);
    await expect(page.locator('[data-testid="history-item-title"]').first()).toContainText('this conversation');

    // Each row carries a human-readable conversation date (newest is "Today").
    const dates = page.locator('[data-testid="history-item-date"]');
    await expect(dates).toHaveCount(3);
    await expect(dates.first()).toContainText('Today');
    await expect(dates.nth(1)).toContainText('Yesterday');

    // Exactly one item is flagged current, and it's the active session row.
    const currentRow = page.locator(`[data-testid="history-item"][data-session="${current}"]`);
    await expect(currentRow).toHaveClass(/is-current/);
    await expect(currentRow.locator('.history-current-badge')).toBeVisible();

    // Clicking a prior session closes the panel (the reopen path).
    await page.locator('[data-testid="history-item"][data-session="sess-prior-1"]').click();
    await expect(page.locator('[data-testid="history-overlay"]')).toHaveCount(0);
    const open = await page.evaluate(() => window.__agenticAssistant__.historyOpen);
    expect(open).toBe(false);
  });

  test('header lays out with title left and a square close button at the right edge', async ({ page }) => {
    await gotoWidget(page);
    await openMenuItem(page, 'open-history');
    await expect(page.locator('[data-testid="history-overlay"]')).toBeVisible();

    const header = page.locator('.history-panel .modal-header');
    const title = page.locator('.history-panel .modal-title');
    const close = page.locator('[data-testid="history-close"]');

    const [hb, tb, cb] = await Promise.all([
      header.boundingBox(), title.boundingBox(), close.boundingBox(),
    ]);

    // Title sits to the left of the close button (not centered/overlapping).
    expect(tb.x + tb.width).toBeLessThanOrEqual(cb.x + 1);
    // Close button is hugged against the header's right edge (within the
    // header's own horizontal padding, ~18px, plus the button's box).
    expect((hb.x + hb.width) - (cb.x + cb.width)).toBeLessThan(40);
    // Close button renders as a compact, near-square control (not a stray glyph).
    expect(Math.abs(cb.width - cb.height)).toBeLessThan(6);
    expect(cb.width).toBeLessThanOrEqual(34);
  });

  test('backdrop and close button dismiss the panel', async ({ page }) => {
    await gotoWidget(page);
    await openMenuItem(page, 'open-history');
    await expect(page.locator('[data-testid="history-overlay"]')).toBeVisible();
    await page.locator('[data-testid="history-close"]').click();
    await expect(page.locator('[data-testid="history-overlay"]')).toHaveCount(0);
  });

  test('history rows show the session initiator; replay shows the real author', async ({ page }) => {
    await gotoWidget(page);

    // History browser: each row surfaces who STARTED the session (list_sessions.initiator).
    await openMenuItem(page, 'open-history');
    const now = Math.floor(Date.now() / 1000);
    await page.evaluate((now) => {
      window.__agenticAssistant__.injectSessions([
        { session_id: 'sess-wendy', title: 'triage the phishing alert', entries: 4,
          last_activity: now, started_at: now, initiator: { name: 'Wendy Smith' } },
      ]);
    }, now);
    await expect(page.locator('[data-testid="history-item-owner"]').first())
      .toHaveText('Wendy Smith');
    await page.locator('[data-testid="history-close"]').click();

    // Replaying a stored turn shows the REAL sender, not the current viewer.
    await page.evaluate((past) => {
      window.__agenticAssistant__.replayTurns([
        { user: 'who started this?', author: { name: 'Wendy Smith' }, ts: past },
      ]);
    }, now - 3600);
    await expect(page.locator('[data-testid="chat-author-0"]')).toHaveText('Wendy Smith');
  });

  test('a keyword runs a content search across sessions and renders match snippets', async ({ page }) => {
    await gotoWidget(page);
    await openMenuItem(page, 'open-history');
    const now = Math.floor(Date.now() / 1000);
    await page.evaluate((now) => {
      window.__agenticAssistant__.injectSessions([
        { session_id: 'sess-a', title: 'block an ip on the firewall', entries: 4, last_activity: now, started_at: now },
        { session_id: 'sess-b', title: 'triage the phishing alert', entries: 2, last_activity: now - 100, started_at: now - 100 },
      ]);
    }, now);
    await expect(page.locator('[data-testid="history-item"]')).toHaveCount(2);

    // Typing a keyword runs the backend content search (grep transcript text
    // across ALL sessions). In mock the connector returns nothing, so the panel
    // first shows the no-match state — proving the search fired and replaced the
    // recent list rather than filtering it client-side.
    await page.locator('[data-testid="history-search"]').fill('FIXME');
    await expect(page.locator('[data-testid="history-nomatch"]')).toBeVisible();

    // Simulate the connector's content-search hit: a session that MENTIONS the
    // keyword (not in its title), carrying a match snippet.
    await page.evaluate(() => {
      window.__agenticAssistant__.injectSearchResults([
        { session_id: 'sess-x', title: 'old buried conversation', snippet: '… left a FIXME in the step …',
          entries: 3, last_activity: 1, started_at: 1, initiator: { name: 'Avery' } },
      ]);
    });
    await expect(page.locator('[data-testid="history-item"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="history-item-title"]').first()).toContainText('old buried conversation');
    await expect(page.locator('[data-testid="history-item-snippet"]').first()).toContainText('FIXME');

    // Clearing the keyword returns to the recent list.
    await page.locator('[data-testid="history-search"]').fill('');
    await expect(page.locator('[data-testid="history-item"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="history-item-snippet"]')).toHaveCount(0);
  });

  test('thumbs up/down flags a session and the Flagged chip narrows to it', async ({ page }) => {
    await gotoWidget(page);
    await openMenuItem(page, 'open-history');
    const now = Math.floor(Date.now() / 1000);
    await page.evaluate((now) => {
      window.__agenticAssistant__.injectSessions([
        { session_id: 'sess-a', title: 'block an ip', entries: 4, last_activity: now, started_at: now, rating: null },
        { session_id: 'sess-b', title: 'triage alert', entries: 2, last_activity: now - 100, started_at: now - 100, rating: null },
      ]);
    }, now);

    // Thumbs-down the first row; it becomes active and doesn't open the session.
    const rowA = page.locator('[data-testid="history-item"][data-session="sess-a"]');
    await rowA.locator('[data-testid="history-rate-down"]').click();
    await expect(rowA.locator('[data-testid="history-rate-down"]')).toHaveClass(/is-active/);
    await expect(page.locator('[data-testid="history-overlay"]')).toBeVisible();  // still open

    // The Flagged chip narrows the list to the rated session only.
    await page.locator('[data-testid="history-chip-flagged"]').click();
    await expect(page.locator('[data-testid="history-item"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="history-item"]')).toHaveAttribute('data-session', 'sess-a');
  });

  test('the live-session rating appears after an assistant turn and toggles', async ({ page }) => {
    await gotoWidget(page);

    // Hidden on an empty conversation — nothing to rate yet.
    await expect(page.locator('[data-testid="live-rate"]')).toHaveCount(0);

    // Give the session an assistant turn; the control now surfaces in the header.
    const now = Math.floor(Date.now() / 1000);
    await page.evaluate((ts) => {
      window.__agenticAssistant__.replayTurns([
        { user: 'triage this alert', ts: ts - 60 },
        { transcript: [{ type: 'text', text: 'here is the summary' }], ts: ts },
      ]);
    }, now);

    const up = page.locator('[data-testid="live-rate-up"]');
    const down = page.locator('[data-testid="live-rate-down"]');
    await expect(page.locator('[data-testid="live-rate"]')).toBeVisible();

    // Thumbs-up flags it (mock mode resolves the rate_session write locally).
    await up.click();
    await expect(up).toHaveClass(/is-active/);
    await expect(down).not.toHaveClass(/is-active/);

    // Clicking the active rating clears it.
    await up.click();
    await expect(up).not.toHaveClass(/is-active/);
  });
});
