'use strict';
// Consolidates rendering-focused single-scenario tests:
//   - alertCard: Jinja stripped from alert description, severity badge correct
//   - detailView: entity seed renders as info_card, build/triage toggle round-trips
//   - infoCards: info_cards fixture renders all card variants without errors

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { waitForWidgetIdle } = require('../../../../fortisoar-widget-harness/tests/e2e/_waitForWidgetIdle');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

// ─── Alert card rendering ────────────────────────────────────────────────────

const ALERT = {
  '@id': '/api/3/alerts/deadbeef-1111-2222-3333-444455556666',
  '@type': 'Alert',
  name: 'Immediate Action Required: Password Reset Notice',
  description: '{{vars.input.records[0].eventTime }}',   // unrendered Jinja
  source: 'User Reported',
  severity: { '@type': 'Picklist', itemValue: 'Critical' },
  status: { '@type': 'Picklist', itemValue: 'Pending' },
  recordTags: ['Phishing'],
  id: 777, uuid: 'deadbeef-1111-2222-3333-444455556666'
};

test('alert: jinja stripped, badge shows real severity not ERROR', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((args) => {
    const { id, entity } = args;
    localStorage.setItem('harness:config:' + id, JSON.stringify({ connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build', maxTurns: 10, showUsage: true, seedFromEntity: true }));
    localStorage.setItem('harness.widget', id); localStorage.setItem('harness.ctx', 'dashboard'); localStorage.removeItem('fsrPbSession');
    window.__fsrPbEntity__ = entity;
  }, { id: WIDGET_ID, entity: ALERT });
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=incident_smtp_intrusion&fastmock=1`, { waitUntil: 'domcontentloaded' });
  await waitForWidgetIdle(page, '__agenticAssistant__');

  const card = page.locator('[data-testid="info-card-entity-777"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.status-sev-tag')).toHaveText('Critical');
  await expect(card).not.toContainText('{{');
  await expect(card).not.toContainText('vars.input');
  await expect(card.locator('.status-row-label', { hasText: 'Status' })).toBeVisible();
  await page.screenshot({ path: '/tmp/alert_card.png' });
  expect(errors, 'no errors: ' + errors.join(' | ')).toEqual([]);
});

// ─── Detail-view / entity seed ───────────────────────────────────────────────

const INCIDENT_DETAIL = {
  '@id': '/api/3/incidents/a0668705-9dc8-4797-a2c8-8f1e1f34942a',
  '@type': 'Incident',
  name: 'Detected intrusion traffic attempts from 198.51.100.7 to 12.62.213.134',
  incidentsummary: 'Internal host 198.51.100.7 sent unusually large volumes of outbound email traffic to external server 12.62.213.134 on 27 May 2026, flagged as a traffic anomaly.',
  description: 'A series of bidirectional netflow logs indicate excessive outbound SMTP traffic...',
  sourceIP: '198.51.100.7',
  destinationIP: '12.62.213.134',
  mitreattackid: 'T1041 - Exfiltration Over Command and Control Channel',
  source: 'Fortinet FortiSIEM',
  severity: { '@type': 'Picklist', itemValue: 'Medium' },
  status: { '@type': 'Picklist', itemValue: 'Open' },
  phase: { '@type': 'Picklist', itemValue: 'Detection' },
  recordTags: ['Collection', 'Excessive Mail', 'Outbound Email', 'Suspicious IP', 'Traffic Anomaly'],
  id: 558, uuid: 'a0668705-9dc8-4797-a2c8-8f1e1f34942a'
};

test('detail-view entity seed renders as a structured card; no manual build toggle', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((args) => {
    const { id, entity } = args;
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build', maxTurns: 10, showUsage: true, seedFromEntity: true }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
    window.__fsrPbEntity__ = entity;
  }, { id: WIDGET_ID, entity: INCIDENT_DETAIL });
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=incident_smtp_intrusion&fastmock=1`, { waitUntil: 'domcontentloaded' });
  await waitForWidgetIdle(page, '__agenticAssistant__');

  const card = page.locator('[data-testid="info-card-entity-558"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.status-title')).toContainText('Detected intrusion');
  await expect(card.locator('.status-row-label', { hasText: 'Source IP' })).toBeVisible();
  await expect(card.locator('.status-row-label', { hasText: 'Dest IP' })).toBeVisible();
  await expect(card.locator('.status-row-label', { hasText: 'MITRE' })).toBeVisible();
  await expect(card.locator('.status-tag').first()).toBeVisible();

  expect(await page.evaluate(() => window.__agenticAssistant__.intent)).toBe('triage');
  // No manual build toggle over a record -- build intent is only reachable
  // via the earned triage->playbook handoff, never a raw switch.
  await expect(page.locator('[data-testid="switch-to-build"]')).toHaveCount(0);

  await page.screenshot({ path: '/tmp/detail_view.png', fullPage: true });
  expect(errors, 'no errors: ' + errors.join(' | ')).toEqual([]);
});

// ─── Playbook-editor mount (main.playbookDetail) ─────────────────────────────

test('playbook-editor mount forces build intent and shows playbook quick actions', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'triage', maxTurns: 10, showUsage: true, seedFromEntity: true }));
    localStorage.setItem('harness.widget', id);
    // The "Playbook Editor" context (HarnessUtils.stateForContext('playbook', ...))
    // wires the harness's $state stub (harness.module.ts) to
    // { current: { name: 'main.playbookDetail' }, params: { id: '' } } --
    // exactly what the real playbook designer state looks like (KB §18.4).
    localStorage.setItem('harness.ctx', 'playbook');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&fastmock=1`, { waitUntil: 'domcontentloaded' });
  await waitForWidgetIdle(page, '__agenticAssistant__');

  // defaultIntent config says 'triage' and there is no entity -- without the
  // main.playbookDetail override this would be 'triage'. The hard override
  // in _inPlaybookEditor() must win.
  expect(await page.evaluate(() => window.__agenticAssistant__.intent)).toBe('build');
  expect(await page.evaluate(() => window.__agenticAssistant__.inPlaybookEditor)).toBe(true);
  await expect(page.locator('[data-testid="playbook-quick-actions"]')).toBeVisible();
  await expect(page.locator('[data-testid="playbook-quick-action-explain"]')).toBeVisible();
  // "Create a playbook" is the first card in the deck.
  await expect(page.locator('[data-testid^="playbook-quick-action-"]').first())
    .toHaveAttribute('data-testid', 'playbook-quick-action-create');
  await expect(page.locator('[data-testid="playbook-quick-action-create"]')).toContainText('Create a playbook');
  // Never over an alert/case investigation chip set in this mount.
  await expect(page.locator('[data-testid="quick-actions"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="switch-to-build"]')).toHaveCount(0);

  expect(errors, 'no errors: ' + errors.join(' | ')).toEqual([]);
});

// A legacy/dashboard triage session persisted under the old un-namespaced
// A legacy `fsrPbSession` key must NOT rehydrate into the playbook-editor mount --
// investigation chats bleeding onto the playbooks page was the reported bug. Phase 1:
// the session is now RECORD/PAGE-scoped (one thread), so the designer mints its own
// session filed under a record/page key (NOT the retired per-intent `fsrPbSession:build`).
test('playbook-editor mount does not adopt a legacy triage session', async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'triage', maxTurns: 10, seedFromEntity: true }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'playbook');
    // Simulate a prior dashboard investigation persisted under the legacy key.
    localStorage.setItem('fsrPbSession', 'triage-investigation-legacy');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&fastmock=1`, { waitUntil: 'domcontentloaded' });
  await waitForWidgetIdle(page, '__agenticAssistant__');

  expect(await page.evaluate(() => window.__agenticAssistant__.intent)).toBe('build');
  const sid = await page.evaluate(() => window.__agenticAssistant__.sessionId);
  expect(sid).not.toBe('triage-investigation-legacy');
  // The designer session is filed under a record/page-scoped key, leaving the
  // legacy triage key untouched and NOT using the retired per-intent build bucket.
  const store = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out[k] = localStorage.getItem(k); }
    return out;
  });
  expect(store['fsrPbSession']).toBe('triage-investigation-legacy'); // legacy untouched
  expect(store['fsrPbSession:build']).toBeUndefined();               // per-intent bucket retired
  const filedKey = Object.keys(store).find((k) => k.startsWith('fsrPbSession:') && store[k] === sid);
  expect(filedKey).toBeTruthy(); // session filed under a record/page key
});

// ─── Card attribution: action_card visually ties to its tool_call ──────────

test('action_card with preceding_tool_use_id renders attached to its tool_call', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build', maxTurns: 10, showUsage: true }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=card_attribution&fastmock=1&opener=1`, { waitUntil: 'domcontentloaded' });
  await waitForWidgetIdle(page, '__agenticAssistant__');

  const toolCall = page.locator('.tool-call.tool-call-has-card');
  await expect(toolCall).toBeVisible();
  const card = page.locator('[data-testid="action-card-act-block-1"]');
  await expect(card).toBeVisible();
  // The attached card's step sits directly after the tool-call step with the
  // gap/border removed, rather than reading as an unrelated later box.
  await expect(card.locator('xpath=ancestor::*[contains(@class,"pb-step-attached")]')).toHaveCount(1);
  expect(errors, 'no errors: ' + errors.join(' | ')).toEqual([]);
});

// ─── Info-cards fixture (all card variants) ──────────────────────────────────

test('info_cards fixture renders all card kinds without errors', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'build', maxTurns: 10, showUsage: true }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mock=info_cards&fastmock=1&opener=1`, { waitUntil: 'domcontentloaded' });
  await waitForWidgetIdle(page, '__agenticAssistant__');

  // Backend pre-flight activity trail (contract 2.8.0) coalesces into one
  // block of bulleted phase lines, rendered ahead of the cards.
  await expect(page.locator('.pb-activity').first()).toBeVisible();
  await expect(page.locator('.pb-activity .pb-activity-line')).toHaveCount(3);
  await expect(page.locator('.pb-activity')).toContainText('Classified as C2/exfil');
  await expect(page.locator('[data-testid="info-card-status-splunk"]')).toBeVisible();
  await expect(page.locator('[data-testid="info-card-status-fortigate"]')).toBeVisible();
  await expect(page.locator('[data-testid="info-card-ioc-1234"]')).toBeVisible();
  await expect(page.locator('[data-testid="info-card-ioc-1234"] .status-score')).toBeVisible();
  await expect(page.locator('[data-testid="info-card-ioc-1234"] .status-tag').first()).toBeVisible();
  await expect(page.locator('[data-testid="info-card-ioc-1234"] .status-table')).toBeVisible();
  // playbook_pushed card renders the designer deep link as a real anchor.
  const pbLink = page.locator('[data-testid="info-card-pushed-offer1"] .status-link a');
  await expect(pbLink).toBeVisible();
  await expect(pbLink).toHaveAttribute('href', '/playbooks/wf-uuid-1');
  await expect(pbLink).toHaveAttribute('target', '_blank');
  await page.screenshot({ path: '/tmp/info_cards.png', fullPage: true });
  expect(errors, 'no console/page errors: ' + errors.join(' | ')).toEqual([]);
});
