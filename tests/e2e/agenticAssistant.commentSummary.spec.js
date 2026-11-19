'use strict';
// Header model badge and "Save summary to comments" (DOM, mock tier).
//
// The badge names where the chat is being sent: the model off the turn's usage
// frame. The summary strip appears over a record whose module takes comments,
// builds its preview from the cards on screen, and POSTs the analyst's edited
// text to the comments endpoint linked to the record. The POST is stubbed in
// the browser; nothing reaches a box.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const IRI = '/api/3/alerts/d39ecc9a-2968-42d5-948d-ce96fd76b227';

async function boot(page, scenario, record) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((args) => {
    localStorage.setItem('harness:config:' + args.id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'triage',
      maxTurns: 10, seedFromEntity: false
    }));
    localStorage.setItem('harness.widget', args.id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
    window.__fsrPbEntity__ = args.record;
  }, { id: WIDGET_ID, record });
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=${scenario}&fastmock=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && window.__agenticAssistant__.state === 'idle', null, { timeout: 25000 });
  return errors;
}

async function ask(page, text) {
  await page.locator('[data-testid="chat-input"]').fill(text);
  await page.locator('[data-testid="chat-input"]').press('Enter');
}

test.describe('model badge', () => {
  test('names the model and provider from the turn, and nothing before it', async ({ page }) => {
    const errors = await boot(page, 'summary_comment', { '@id': IRI, name: 'Beacon' });
    // Mock mode has no connector configuration to name, so it starts hidden.
    await expect(page.locator('[data-testid="model-badge"]')).toHaveCount(0);
    await ask(page, 'triage this');
    const badge = page.locator('[data-testid="model-badge-label"]');
    await expect(badge).toHaveText('Model: claude-haiku-5-5 via Anthropic');
    const shown = await page.locator('[data-testid="model-badge"]').innerText();
    expect(shown).not.toMatch(/\u2014|\u2013|\{|\}/);
    // The icon is a CSS mask, not an emoji or an image.
    await expect(page.locator('[data-testid="model-badge"] i.ic.ic-model')).toHaveCount(1);
    expect(errors, errors.join(' | ')).toEqual([]);
  });
});

test.describe('save summary to comments', () => {
  test('preview comes from the cards, is editable, and Save posts it linked to the record', async ({ page }) => {
    const posts = [];
    await page.route('**/api/3/comments', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ '@id': '/api/3/comments/c-1' }) });
    });
    const errors = await boot(page, 'summary_comment', { '@id': IRI, name: 'Beacon', comments: [] });
    // Not offered before the conversation starts.
    await expect(page.locator('[data-testid="comment-summary"]')).toHaveCount(0);
    await ask(page, 'triage this');
    await page.locator('[data-testid="action-confirm-card-sc-block"]').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('[data-testid="action-confirm-card-sc-block"]').click();
    await expect(page.locator('[data-testid="chat-input"]')).toBeEnabled({ timeout: 15000 });

    await expect(page.locator('[data-testid="comment-summary"]')).toBeVisible();
    await page.locator('[data-testid="comment-summary-open"]').click();
    const box = page.locator('[data-testid="comment-summary-text"]');
    const preview = await box.inputValue();
    expect(preview).toContain('Verdict: Suspicious (High severity, 78% confidence)');
    expect(preview).toContain('The host is beaconing to a known bad address.');
    expect(preview).toContain('- The host contacted 198.51.100.9 twice in ten minutes');
    expect(preview).toContain('- Whether any data left the network');
    expect(preview).toMatch(/- Approved: Block 198\.51\.100\.9 on the edge firewall \(\d{4}-\d\d-\d\d \d\d:\d\d UTC\)/);
    expect(preview).not.toMatch(/card-sc-block|block_ip|fortigate|\u2014|\u2013|[{}]/);

    await box.fill(preview + '\n\nNote: confirmed with the network team.');
    await page.locator('[data-testid="comment-summary-save"]').click();
    await expect(page.locator('[data-testid="comment-summary-saved"]')).toBeVisible();
    await expect(page.locator('[data-testid="comment-summary-refresh"]')).toBeVisible();

    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0]).sort()).toEqual(['alerts', 'content']);
    expect(posts[0].alerts).toEqual([IRI]);
    expect(posts[0].content).toContain('<p>Assistant summary');
    expect(posts[0].content).toContain('Note: confirmed with the network team.</p>');
    expect(posts[0].content).toContain('Approved: Block 198.51.100.9 on the edge firewall');
    expect(errors, errors.join(' | ')).toEqual([]);
  });

  test('cancel leaves nothing posted', async ({ page }) => {
    const posts = [];
    await page.route('**/api/3/comments', (route) => { posts.push(1); route.fulfill({ status: 201, body: '{}' }); });
    await boot(page, 'summary_comment', { '@id': IRI, comments: [] });
    await ask(page, 'triage this');
    await page.locator('[data-testid="comment-summary-open"]').click();
    await expect(page.locator('[data-testid="comment-summary-text"]')).toBeVisible();
    await page.locator('[data-testid="comment-summary-cancel"]').click();
    await expect(page.locator('[data-testid="comment-summary-text"]')).toHaveCount(0);
    expect(posts).toHaveLength(0);
  });

  test('disabled when the conversation has nothing to summarize', async ({ page }) => {
    await boot(page, 'summary_comment_plain', { '@id': IRI, comments: [] });
    await ask(page, 'what is an alert?');
    await expect(page.locator('[data-testid="comment-summary"]')).toBeVisible();
    await expect(page.locator('[data-testid="comment-summary-open"]')).toBeDisabled();
    await expect(page.locator('[data-testid="comment-summary-empty"]')).toContainText('Nothing to summarize');
  });

  test('not offered over a record whose module has no comments', async ({ page }) => {
    await boot(page, 'summary_comment', { '@id': '/api/3/keys/k-1', name: 'A key' });
    await ask(page, 'triage this');
    await expect(page.locator('[data-testid="chat-input"]')).toBeEnabled({ timeout: 15000 });
    await expect(page.locator('[data-testid="comment-summary"]')).toHaveCount(0);
  });
});
