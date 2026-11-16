'use strict';
// Screenshots for docs/USER_GUIDE.md, taken from the hermetic mock fixtures so
// they are reproducible and carry no box details. Opt-in, because each run
// rewrites the committed images:
//
//   DOCS_SHOTS=1 make test-e2e-spec SPEC=widgets-src/agenticAssistant/tests/e2e/agenticAssistant.docsScreenshots.spec.js
//
// Each shot also asserts the thing it is meant to show, so a renamed testid
// fails here instead of committing a picture of an empty panel.

const path = require('path');
const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

const OUT = path.resolve(__dirname, '../../docs/images');
let WIDGET_ID = DEFAULT_ID;

test.skip(!process.env.DOCS_SHOTS, 'set DOCS_SHOTS=1 to regenerate the user-guide screenshots');
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });
test.use({ viewport: { width: 1280, height: 1000 } });

const ALERT = {
  '@id': '/api/3/alerts/3f2a9c10-0000-4000-8000-000000000001',
  name: 'Outbound connections to known C2 address 203.0.113.45',
  severity: 'High',
  status: 'Open',
  type: 'Malware',
  sourceIp: '198.51.100.5',
  destinationIp: '203.0.113.45',
  description: 'Host WS-FIN-07 made repeated outbound connections to an address on a threat feed.'
};

async function boot(page, { mock, ctx = 'dashboard', intent = 'triage', entity, opener = true, seed = true, extraLs = {} }) {
  await page.addInitScript((a) => {
    localStorage.setItem('harness:config:' + a.id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder',
      defaultIntent: a.intent, maxTurns: 10, showUsage: false, seedFromEntity: a.seed && !!a.entity
    }));
    localStorage.setItem('harness.widget', a.id);
    localStorage.setItem('harness.ctx', a.ctx);
    Object.keys(a.extraLs).forEach((k) => localStorage.setItem(k, a.extraLs[k]));
    localStorage.removeItem('fsrPbSession');
    localStorage.removeItem('fsrPbSession:build');
    if (a.entity) window.__fsrPbEntity__ = a.entity;
  }, { id: WIDGET_ID, ctx, intent, entity: entity || null, seed, extraLs });
  const q = mock ? `&mock=${mock}` : '';
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard${q}&fastmock=1${opener ? '&opener=1' : ''}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 30000 });
}

async function shot(page, name, locator) {
  const target = locator || page.locator('#widget-host');
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300); // let transitions settle
  await target.screenshot({ path: path.join(OUT, name) });
}

test('quick starts over an alert', async ({ page }) => {
  await boot(page, { mock: 'playbook_soc_demo', entity: ALERT, opener: false, seed: false });
  await page.waitForFunction(() => window.__agenticAssistant__.state === 'idle');
  const grid = page.locator('[data-testid="quick-actions"]');
  await expect(grid).toBeVisible({ timeout: 15000 });
  await shot(page, 'chat-quick-actions.png');
});

test('verdict card', async ({ page }) => {
  await boot(page, { mock: 'verdict_triage' });
  const card = page.locator('[data-testid="verdict-card-vc-001"]');
  await expect(card).toBeVisible({ timeout: 15000 });
  await shot(page, 'chat-verdict-card.png', card);
});

test('action card with runs-on picker', async ({ page }) => {
  await boot(page, { mock: 'action_runs_on', opener: true });
  await page.locator('[data-testid="chat-input"]').fill('block it');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  const picker = page.locator('[data-testid="action-runs-on-select-ro-agent"]');
  await expect(picker).toBeVisible({ timeout: 15000 });
  await shot(page, 'chat-action-card.png');
});

test('save as playbook offer', async ({ page }) => {
  await boot(page, { mock: 'playbook_draft_branching', intent: 'build' });
  const card = page.locator('[data-testid="playbook-offer-pb-offer-c2-draft"]');
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.locator('[data-testid="playbook-offer-review-pb-offer-c2-draft"]').click();
  await expect(card.locator('[data-testid="playbook-offer-draft-pb-offer-c2-draft"]')).toBeVisible();
  await shot(page, 'chat-save-as-playbook.png', card);
});

test('playbook designer quick starts', async ({ page }) => {
  // The designer asks for the open playbook's steps; the mock scenario has no
  // answer for that, so stub it rather than let it reach the network.
  await page.route('**/api/integration/execute/**', (route) => {
    const op = (JSON.parse(route.request().postData() || '{}') || {}).operation;
    if (op !== 'decompile_playbook') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ data: { ok: false, error: { code: 'not_found', message: 'stub' } } }) });
  });
  await boot(page, { mock: 'happy_path', ctx: 'playbook', intent: 'build', opener: false,
                     extraLs: { 'harness.id': 'wf-9' } });
  const grid = page.locator('[data-testid="playbook-quick-actions"]');
  await expect(grid).toBeVisible({ timeout: 15000 });
  await shot(page, 'designer-quick-actions.png');
});

// ── User-guide "System Guide" card shots (docs/images, one per card state) ──

test('approval request: tier-3 call suspended mid-loop', async ({ page }) => {
  // approval_containment runs two tool calls, then parks on a tier-3 block.
  await boot(page, { mock: 'approval_containment' });
  const card = page.locator('[data-testid="approval-card-ap-containment-1"]');
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator('[data-testid="approval-approve"]')).toBeVisible();
  await expect(card.locator('[data-testid="approval-reject"]')).toBeVisible();
  await shot(page, 'chat-approval-request.png', card);
});

test('capability gap: missing connector with setup steps and alternatives', async ({ page }) => {
  await boot(page, { mock: 'capability_gap', intent: 'build' });
  const card = page.locator('[data-testid="capability-gap-card-capgap-fortiedr-1"]');
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator('.capgap-title')).toContainText('FortiEDR endpoint isolation');
  await expect(card.locator('.capgap-steps li')).toHaveCount(3);
  await expect(card.locator('[data-testid="capgap-alt-capgap-fortiedr-1-block_ip"]')).toBeVisible();
  await shot(page, 'chat-capability-gap.png', card);
});

test('choice card: two chips and a free-text box', async ({ page }) => {
  await boot(page, { mock: 'choice_text', intent: 'build' });
  const ID = 'create_playbook_scope';
  const card = page.locator(`[data-testid="choice-card-${ID}"]`);
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator(`[data-testid="choice-${ID}-alert_start"]`)).toBeVisible();
  await expect(card.locator(`[data-testid="choice-${ID}-incident_start"]`)).toBeVisible();
  await expect(card.locator(`[data-testid="choice-${ID}-text"]`)).toBeVisible();
  await shot(page, 'chat-choice.png', card);
});

test('enhancement offer: proposed change with diff summary and Apply', async ({ page }) => {
  await boot(page, { mock: 'enhancement_new_playbook', intent: 'build' });
  const card = page.locator('[data-testid="enhancement-offer-enh-child-1"]');
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator('[data-testid="enhancement-offer-changes-enh-child-1"]')).toContainText('Call Block');
  await expect(card.locator('[data-testid="enhancement-offer-changes-enh-child-1"]'))
    .toContainText('Block One IP');
  await expect(card.locator('[data-testid="enhancement-offer-accept-enh-child-1"]'))
    .toHaveText('Apply change');
  await shot(page, 'chat-enhancement-offer.png', card);
});

test('info cards: connector health, IOC scorecard and saved playbook', async ({ page }) => {
  await boot(page, { mock: 'info_cards' });
  await expect(page.locator('[data-testid="info-card-status-splunk"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-testid="info-card-status-fortigate"]')).toBeVisible();
  await expect(page.locator('[data-testid="info-card-ioc-1234"]')).toContainText('Malicious');
  await expect(page.locator('[data-testid="info-card-pushed-offer1"]')).toContainText('Intrusion Traffic Triage');
  await shot(page, 'chat-info-cards.png');
});

test('save as playbook offer built from the containment steps', async ({ page }) => {
  // No mock turns a triage tool trace straight into a playbook_offer without a
  // build conversation first; this is the containment offer after the block and
  // quarantine, whose step list is the investigation's ops summary.
  await boot(page, { mock: 'playbook_offer_decline', intent: 'build' });
  const card = page.locator('[data-testid="playbook-offer-pb-offer-c2-1"]');
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-testid="playbook-offer-step-pb-offer-c2-1-0"]'))
    .toContainText('Block 102.220.160.21');
  await expect(page.locator('[data-testid="playbook-offer-step-pb-offer-c2-1-1"]'))
    .toContainText('Quarantine smithDesktop');
  await shot(page, 'chat-playbook-offer.png', card);
});

test('reasoning: collapsed tool rows with timings under "How I worked this out"', async ({ page }) => {
  await boot(page, { mock: 'reasoning_panel', opener: false });
  await page.locator('[data-testid="chat-input"]').fill('What happened here and how bad is it?');
  await page.locator('[data-testid="chat-send"]').click();
  await page.waitForFunction(
    () => window.__agenticAssistant__ && window.__agenticAssistant__.state === 'idle',
    null, { timeout: 15000 });
  await expect(page.locator('.pb-reasoning-toggle')).toContainText('How I worked this out');
  await expect(page.locator('.pb-reasoning-body')).toHaveCount(0);
  const durations = page.locator('[data-testid^="tool-call-duration-"]');
  await expect(durations.first()).toBeVisible();
  await expect(durations).toHaveCount(2);
  await shot(page, 'chat-reasoning.png');
});

test('triage turn: reputation table, summary and a block-IP action card', async ({ page }) => {
  // c2_hunt: four TI sources consolidated into one IOC card, a summary, then the
  // staged FortiGate block the analyst approves or rejects.
  await boot(page, { mock: 'c2_hunt' });
  const ioc = page.locator('[data-testid="info-card-ioc-102-220-160-21"]');
  await expect(ioc).toBeVisible({ timeout: 15000 });
  for (const src of ['VirusTotal', 'FortiGuard', 'Shodan', 'IP Quality Score']) {
    await expect(ioc).toContainText(src);
  }
  await expect(page.locator('.fsr-pb-widget')).toContainText('All four sources agree');
  await expect(page.locator('[data-testid="action-card-card-block-c2"]')).toBeVisible();
  await shot(page, 'chat-triage-full-turn.png');
});
