'use strict';
// ───────────────────────────────────────────────────────────────────────────
// LIVE forticloud UI bug-hunt sweep (gated, NON-destructive except the build
// test which auto-cleans). Drives the REAL widget against the REAL
// `connector-fsr-agentic-assistant` on the box in .env (FSR_BASE_URL), through the
// UI only, across the four scenario classes that show the "sometimes errors /
// inconsistency" the user reported:
//   1. entity-context triage   (real incident, real alert, drawer re-open)
//   2. hunt chain              (seeded wendy.smith → C2 alert)
//   3. direct containment      ("block IP …" → action card + gating)
//   4. playbook build/save     (build → Create Playbook → verify on box → delete)
//
// Every test captures, per scenario: browser console errors, uncaught page
// exceptions, failing /api responses (>=400), the widget error-banner text, and
// the final view state. Each test prints a single  [[SWEEP]] {json}  line so the
// run can be triaged from the make output. Assertions are SOFT -- a scenario that
// errors still finishes and reports, so one bug never masks the rest.
//
// Gated on FSRPB_LIVE_UI=1 (real agent runs on the owner's OpenAI key + a real,
// auto-cleaned SOAR mutation in the build test). Run:
//   FSRPB_LIVE_UI=1 make test-e2e-spec SPEC="tests/e2e/agenticAssistant.liveSweep.spec.js"
// Needs FSR_BASE_URL/FSR_USERNAME/FSR_PASSWORD in the harness .env.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');
const { makeClient, FIREWALL_CONNECTORS, SIEM_CONNECTORS } = require('../../../../fortisoar-widget-harness/tests/live/lib/soarClient');

const LIVE = process.env.FSRPB_LIVE_UI === '1';
const d = LIVE ? test.describe : test.describe.skip;

let WIDGET_ID = DEFAULT_ID;

// Gateway preflight (D): a HARD connector/LLM-backend outage (box down, health
// not ok, no LLM key) should read as an ENV-SKIP, not a wall of widget FAILs --
// so an upstream 502 storm isn't mistaken for a widget regression. Intermittent
// per-request blips are NOT gated here: the widget's poll-retry now survives
// those, and that resilience is exactly what we want the sweep to exercise.
let ENV_OK = true;
let ENV_MSG = '';
// Per-scenario CAPABILITY preflight, distinct from the hard-outage gate above.
// The box being up does not mean every scenario is gradable on it: a
// containment row needs a firewall connector, and where none is configured the
// agent's CORRECT behaviour is to ask for the missing config instead of
// inventing an action card. That is an environment gap, not a widget bug --
// but the sweep had only two verdicts (whole-suite ENV-SKIP, or FAIL), so an
// unconfigured FortiGate was reported as "[[SWEEP-FAIL]] ... widget
// regression". The live matrix already drew this distinction
// (`tests/live/lib/matrixDriver.js`: "the backend is missing a capability, the
// widget is fine"); the sweep now draws it too.
//
// `null` = could not determine, and it deliberately does NOT skip -- a probe
// that fails open into a skip would disarm the assertion it guards.
let CONTAINMENT_CAP = null;   // true | false | null(indeterminate)
let CONTAINMENT_WHY = 'not configured';
// Row 5 investigates through the SIEM; same three-valued contract.
let SIEM_CAP = null;
test.beforeAll(async ({ request }) => {
  if (!LIVE) return;
  WIDGET_ID = await resolveWidgetId(request);
  try {
    const soar = await makeClient();
    const h = await soar.exec('health_check', {}, { timeoutMs: 30000 });
    if (!h || h.ok === false || h.llm_key_configured === false) {
      ENV_OK = false;
      ENV_MSG = 'connector health_check not ok: ' + JSON.stringify(h).slice(0, 200);
    }
    // Resolve the rows' records on THIS box by name (create when absent). The
    // IRIs below came from another instance; on .159 none existed, so the
    // triage rows investigated a not_found record and passed on shape alone.
    if (ENV_OK) {
      for (const rec of [C2_ALERT, CLEARTEXT_ALERT, INTRUSION_INCIDENT]) {
        const { iri } = await soar.ensureRecord(rec.module, {
          name: rec.name, description: rec.description, source: rec.source,
          sourceIp: rec.sourceIp, destinationIp: rec.destinationIp,
          userName: rec.userName });
        rec['@id'] = iri;
      }
    }
    if (ENV_OK) CONTAINMENT_CAP = await soar.connectorConfigured(FIREWALL_CONNECTORS);
    // Configured is not enough: a Disconnected firewall offers the agent
    // nothing to stage either. Only a definite unhealthy verdict demotes it.
    if (CONTAINMENT_CAP === true) {
      const healthy = await soar.connectorHealthy(FIREWALL_CONNECTORS);
      if (healthy === false) { CONTAINMENT_CAP = false; CONTAINMENT_WHY = 'configured but not Available'; }
    }
    if (ENV_OK) SIEM_CAP = await soar.connectorConfigured(SIEM_CONNECTORS);
    if (SIEM_CAP === true && await soar.connectorHealthy(SIEM_CONNECTORS) === false) SIEM_CAP = false;
  } catch (e) {
    ENV_OK = false;
    ENV_MSG = 'connector health_check threw: ' + String((e && e.message) || e).slice(0, 200);
  }
  if (!ENV_OK) console.warn('[[SWEEP-ENV-SKIP]] ' + ENV_MSG);
});

// Skip (not fail) every scenario when the backend is hard-down.
test.beforeEach(() => {
  test.skip(LIVE && !ENV_OK, 'ENV: connector/LLM backend unavailable -- ' + ENV_MSG);
});

// ── Sweep records. `@id` is a placeholder: beforeAll resolves each by name on
// the target box (creating it if absent) and overwrites it. ───────────────────
const C2_ALERT = {
  '@id': '/api/3/alerts/d39ecc9a-2968-42d5-948d-ce96fd76b227',
  module: 'alerts',
  name: 'Outbound C2 traffic - smithDesktop',
  severity: { itemValue: 'Critical' }, status: { itemValue: 'Open' },
  source: 'FortiSIEM', type: 'Exfiltration',
  description: 'smithDesktop (198.51.100.4 / wendy.smith) beaconing to 203.0.113.42 after 7ogger.exe drop. MITRE T1041.',
  // The structured IOC fields a SIEM-ingested alert carries. Without them the
  // IOCs live only in prose and row 5's trace-built playbook has no field to
  // wire them to -- every SIEM step bakes this alert's literals.
  sourceIp: '198.51.100.4', destinationIp: '203.0.113.42', userName: 'wendy.smith'
};
const CLEARTEXT_ALERT = {
  '@id': '/api/3/alerts/17206168-f927-4133-ad8e-9786574ef2e3',
  module: 'alerts',
  name: 'Outbound cleartext password usage from non guest host',
  severity: { itemValue: 'High' }, status: { itemValue: 'Open' },
  source: 'FortiSIEM', type: 'Credential Access',
  description: 'Cleartext credential egress observed from an internal host.'
};
const INTRUSION_INCIDENT = {
  '@id': '/api/3/incidents/527ed222-d9d1-4995-b03b-5cdc0ea4c7ea',
  module: 'incidents',
  name: 'Detected intrusion traffic attempts from 192.x',
  severity: { itemValue: 'High' }, status: { itemValue: 'Open' },
  source: 'FortiSIEM', type: 'Intrusion',
  description: 'Detected intrusion traffic attempts from an external source.'
};

// ── Per-test error capture ──────────────────────────────────────────────────
function attachCapture(page) {
  const cap = { consoleErrors: [], pageErrors: [], apiFailures: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      // Ignore the benign favicon / ResizeObserver noise the SOAR shell emits.
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

async function boot(page, opts) {
  opts = opts || {};
  await page.addInitScript((args) => {
    const { id, entity, intent } = args;
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'connector-fsr-agentic-assistant',
      defaultIntent: intent || 'triage',
      maxTurns: 14, showUsage: true,
      seedFromEntity: !!entity, mockMode: 'real',
      detachedTimeoutMs: 480000
    }));
    localStorage.setItem('harness.widget', id);
    // build intent requires the playbook designer context (main.playbookDetail)
    // so _inPlaybookEditor() returns true -- the widget retired defaultIntent='build'.
    const ctx = intent === 'build' ? 'playbook' : (entity ? 'drawer' : 'dashboard');
    localStorage.setItem('harness.ctx', ctx);
    localStorage.removeItem('fsrPbSession');
    if (entity) window.__fsrPbEntity__ = entity;
  }, { id: WIDGET_ID, entity: opts.entity || null, intent: opts.intent || null });

  await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mode=live${opts.extra || ''}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 45000 });
}

async function probe(page) {
  return page.evaluate(() => {
    const p = window.__agenticAssistant__;
    if (!p) return null;
    // Scan messages for a playbook_offer event or a push result.
    let offerId = null, pushOk = null, wfUuids = null, collUuid = null;
    let offer = null;   // shape of the LATEST playbook_offer, resolved or not
    let lastEventTypes = [];
    for (const m of (p.messages || [])) for (const ev of (m.events || [])) {
      lastEventTypes.push(ev.type);
      if (ev.type === 'playbook_offer' && !ev._resolved) offerId = ev.offerId || ev.id;
      if (ev.type === 'playbook_offer') {
        const ops = ev.opsSummary || [];
        offer = {
          id: ev.offerId || ev.id, steps: ev.stepCount || 0,
          verified: ops.filter((o) => o.verified).length,
          needsInput: ops.filter((o) => o.needsInput).length,
          ops: ops.map((o) => o.connector + '.' + o.operation),
          // A trace-built offer carries no YAML; hand-authored YAML means the
          // wiring is the model's guess, not the investigation's observed outputs.
          handAuthored: !!ev.finalYaml,
          resolved: !!ev._resolved, outcome: ev._outcome || null
        };
      }
      if (ev.type === 'info_card' && ev.variant === 'playbook_pushed') {
        pushOk = true;
        // The card the offer-accept path actually emits carries the designer
        // deep link (`url`, and a link block), NOT the uuid arrays this row
        // used to read. Those were never on the wire, so the row saw a push
        // it could not name and skipped its own box verification -- passing
        // over the one assertion that proves the playbook exists.
        wfUuids = ev.workflow_uuids || null;
        collUuid = ev.collection_uuid || null;
        if (!wfUuids) {
          const link = ev.url || (ev.blocks || []).reduce(
            (acc, b) => acc || (b && b.kind === 'link' ? b.url : null), null);
          const m2 = link && String(link).match(/\/playbooks\/([0-9a-f-]{36})/i);
          if (m2) wfUuids = [m2[1]];
        }
      }
    }
    return {
      state: p.state, intent: p.intent, msgCount: p.messageCount,
      yamlLen: (p.currentYaml || '').length, push: p.pushResult || null,
      lastTurnRole: p.lastTurn && p.lastTurn.role,
      lastTurnText: (p.lastTurn && (p.lastTurn.content || p.lastTurn.text) || '').slice(0, 240),
      entityIri: p.entity && p.entity.iri,
      offerId, pushOk, wfUuids, collUuid, offer,
      lastEventTypes: lastEventTypes.slice(-10)
    };
  });
}

// Wait for the widget to return to idle (turn settled) OR until timeout.
async function waitIdle(page, timeoutMs, minMsgs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe(page);
    if (last && last.state === 'idle' && (!minMsgs || last.msgCount >= minMsgs)) return last;
    await page.waitForTimeout(2500);
  }
  return last; // soft -- caller records the (possibly stuck) state
}

// Fill + click was fire-and-forget. In the Playbook Editor context the widget
// finishes initializing after the input enables, and that reset cleared the
// typed text between fill and click: the click landed on a disabled Send, no
// turn was ever sent, and row 4 waited out its 5 min and failed as if the
// agent had delivered nothing (no session reached the box). Confirm the
// message landed; re-send once if it did not.
async function send(page, text) {
  const count = () => page.evaluate(() =>
    ((window.__agenticAssistant__ || {}).messages || []).length);
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await count();
    await page.locator('[data-testid="chat-input"]').fill(text);
    await page.locator('[data-testid="chat-send"]').click();
    const landed = await page.waitForFunction(
      (n) => ((window.__agenticAssistant__ || {}).messages || []).length > n,
      before, { timeout: 10000 }).then(() => true).catch(() => false);
    if (landed) return;
  }
  throw new Error('send(): the message never reached the transcript (input reset?)');
}

async function errorBannerText(page) {
  return page.locator('[data-testid="error-banner"]').textContent({ timeout: 1000 })
    .then(t => (t || '').trim()).catch(() => '');
}

// Read the pushed playbook back from the box (the card is not proof it exists),
// then delete it so the sweep leaves nothing behind.
async function verifyOnBoxAndDelete(pushRes) {
  let verified = null, cleanup = null, stepCount = null;
  const wfUuid = (pushRes.workflow_uuids && pushRes.workflow_uuids[0])
    || (pushRes.workflows && pushRes.workflows[0] && pushRes.workflows[0].uuid) || null;
  const collUuid = pushRes.collection_uuid
    || (pushRes.collection_iri ? String(pushRes.collection_iri).split('/').pop() : null);
  const soar = await makeClient();
  try {
    if (wfUuid) {
      const rec = await soar.get(`/api/3/workflows/${wfUuid}`);
      verified = !!(rec && (rec.uuid === wfUuid || rec['@id']));
      if (rec && Array.isArray(rec.steps)) stepCount = rec.steps.length;
    } else if (collUuid) {
      const rec = await soar.get(`/api/3/workflow_collections/${collUuid}`);
      verified = !!(rec && (rec.uuid === collUuid || rec['@id']));
    }
  } catch (e) { verified = 'verify-error:' + e.message; }
  try {
    if (collUuid) { const dd = await soar.del(`/api/3/workflow_collections/${collUuid}`); cleanup = 'coll ' + dd.status; }
    else if (wfUuid) { const dd = await soar.del(`/api/3/workflows/${wfUuid}`); cleanup = 'wf ' + dd.status; }
    else cleanup = 'NO-UUID-CHECK-BOX';
  } catch (e) { cleanup = 'cleanup-error:' + e.message; }
  return { verified, cleanup, stepCount };
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

d('LIVE forticloud UI sweep', () => {
  test.describe.configure({ mode: 'serial' });

  // 1a -- entity-context triage on a real INCIDENT
  test('1a triage seeds on a real incident + follow-up answers', async ({ page }) => {
    test.setTimeout(300000);
    const cap = attachCapture(page);
    await boot(page, { entity: INTRUSION_INCIDENT, intent: 'triage' });
    await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true', { timeout: 45000 });

    // Triage card should auto-seed (a turn appears without the user typing).
    const seeded = await waitIdle(page, 180000, 1);
    const bannerAfterSeed = await errorBannerText(page);

    // Follow-up question through the UI.
    await send(page, 'What is the severity and what should I check first?');
    const afterAsk = await waitIdle(page, 180000, (seeded ? seeded.msgCount : 0) + 1);
    const banner = await errorBannerText(page);

    const r = report('1a-incident-triage', cap, {
      seededState: seeded && seeded.state, seededMsgs: seeded && seeded.msgCount,
      finalState: afterAsk && afterAsk.state, finalMsgs: afterAsk && afterAsk.msgCount,
      entityIri: afterAsk && afterAsk.entityIri, bannerAfterSeed, banner
    });
    expect.soft(r.pageErrors, 'no uncaught JS').toEqual([]);
    expect.soft(banner, 'no error banner').toBe('');
    expect.soft(afterAsk && afterAsk.msgCount, 'chat advanced').toBeGreaterThan(seeded ? seeded.msgCount : 0);
  });

  // 1b -- entity-context triage on a real ALERT + drawer RE-OPEN (the dead-chat race)
  test('1b triage on a real alert, then re-open (entity re-detect)', async ({ page }) => {
    test.setTimeout(300000);
    const cap = attachCapture(page);
    await boot(page, { entity: CLEARTEXT_ALERT, intent: 'triage' });
    await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true', { timeout: 45000 });
    const firstSeed = await waitIdle(page, 180000, 1);

    // Simulate a drawer re-open: reload with the same entity (the path where the
    // triage card sometimes failed to re-seed → dead chat).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
      null, { timeout: 45000 });
    await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true', { timeout: 45000 });
    const afterReopen = await waitIdle(page, 120000, 0);
    const banner = await errorBannerText(page);

    const r = report('1b-alert-triage-reopen', cap, {
      firstSeedMsgs: firstSeed && firstSeed.msgCount, firstState: firstSeed && firstSeed.state,
      reopenState: afterReopen && afterReopen.state, reopenMsgs: afterReopen && afterReopen.msgCount,
      entityIri: afterReopen && afterReopen.entityIri, banner
    });
    expect.soft(r.pageErrors, 'no uncaught JS').toEqual([]);
    expect.soft(afterReopen && afterReopen.entityIri, 'entity re-detected after reopen')
      .toBe(CLEARTEXT_ALERT['@id']);
    // Composer must be usable after reopen (not dead).
    await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true');
  });

  // 2 -- hunt chain on the seeded C2 alert
  test('2 hunt chain pivots across the seeded C2 indicators', async ({ page }) => {
    test.setTimeout(360000);
    const cap = attachCapture(page);
    await boot(page, { entity: C2_ALERT, intent: 'triage' });
    await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true', { timeout: 45000 });
    await waitIdle(page, 120000, 0);

    await send(page, 'Investigate this alert end to end: pivot on the host, the user, '
      + 'and the destination IP, and tell me if this is a real C2 beacon.');
    const done = await waitIdle(page, 300000, 2);
    const banner = await errorBannerText(page);

    // Count tool calls rendered in the transcript (the hunt actually did work).
    const toolCalls = await page.locator('[data-testid^="tool-call-head-"]').count().catch(() => 0);
    const messagesText = await page.locator('[data-testid="messages"]').innerText().catch(() => '');

    // B2: an investigation ends in a structured verdict whose evidence chips
    // resolve to real tool calls in this transcript (and a click reaches them).
    const verdictCards = await page.locator('[data-testid^="verdict-card-"]').count().catch(() => 0);
    const chips = page.locator('[data-testid^="evidence-"]');
    const evidenceChips = await chips.count().catch(() => 0);
    const resolvedChips = page.locator('[data-testid^="evidence-"]:not(.missing)');
    const evidenceResolved = await resolvedChips.count().catch(() => 0);
    // B3a: a source this box can't reach (no connector / no config / failing
    // health) ends in a fix-it card, not a pivot the assistant has no tool
    // for. Reported, not asserted -- whether one is due depends on the box.
    const capabilityGapCards = await page.locator('[data-testid^="capability-gap-card-"]')
      .count().catch(() => 0);
    let evidenceClickReached = null;
    if (evidenceResolved > 0) {
      const first = resolvedChips.first();
      // The chip shows a readable name for the call it cites; the call's id
      // rides on data-evidence-id. Reading the visible text as the id failed
      // once chips stopped printing raw ids.
      const id = (await first.getAttribute('data-evidence-id')) || '';
      await first.click();
      evidenceClickReached = await page.locator(`[data-tool-use-id="${id}"]`).count() > 0;
    }

    const r = report('2-hunt-chain', cap, {
      finalState: done && done.state, finalMsgs: done && done.msgCount,
      toolCalls, banner,
      mentionsIp: /203\.0\.113\.42/.test(messagesText),
      mentionsHost: /smithDesktop|wendy\.smith/i.test(messagesText),
      verdictCards, evidenceChips, evidenceResolved, evidenceClickReached,
      capabilityGapCards
    });
    expect.soft(r.pageErrors, 'no uncaught JS').toEqual([]);
    expect.soft(banner, 'no error banner').toBe('');
    expect.soft(toolCalls, 'hunt invoked at least one tool').toBeGreaterThan(0);
    expect.soft(verdictCards, 'investigation ended in a verdict card').toBeGreaterThan(0);
    expect.soft(evidenceResolved, 'a verdict finding cites a tool call in this transcript')
      .toBeGreaterThan(0);
    expect.soft(evidenceClickReached, 'clicking evidence reaches its tool call').toBe(true);
  });

  // 3 -- direct containment → action card + gating
  test('3 direct containment emits an action card (not a silent run_op)', async ({ page }) => {
    test.setTimeout(300000);
    // This row's prompt names FortiGate, so FortiGate is its precondition. With
    // none configured the agent correctly answers "I need ip_block_policy and
    // ip_group_name" -- a question, not a card -- and grading that as a widget
    // regression blames the widget for the box being incomplete. Only a
    // definite `false` skips; `null` (indeterminate) still runs the assertions.
    if (LIVE && CONTAINMENT_CAP === false) {
      const msg = 'no usable firewall connector on this box ('
        + CONTAINMENT_WHY + '; looked for: '
        + FIREWALL_CONNECTORS.join(', ') + ') -- a containment card cannot be '
        + 'produced here, so this row grades the environment rather than the '
        + 'widget.';
      console.warn('[[SWEEP-ENV-SKIP]] ' + msg);
      test.skip(true, 'ENV: ' + msg);
    }
    const cap = attachCapture(page);
    await boot(page, { intent: 'triage' });
    await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true', { timeout: 45000 });

    await send(page, 'Block the IP 203.0.113.42 on FortiGate.');
    const done = await waitIdle(page, 240000, 2);
    const banner = await errorBannerText(page);

    const actionCards = await page.locator('[data-testid^="action-card-"]').count().catch(() => 0);
    // Approvals render as an INLINE transcript card; the blocking modal is gone.
    // This counter still looked for `approval-modal`, a testid that no longer
    // exists anywhere in view.html, so it was permanently 0 -- an
    // approval-gated containment (exactly what a tier-3 block produces) failed
    // this assertion even when the gate surfaced correctly.
    const approvalModal = await page.locator('[data-testid^="approval-card-"]').count().catch(() => 0);
    const messagesText = await page.locator('[data-testid="messages"]').innerText().catch(() => '');

    const r = report('3-direct-containment', cap, {
      finalState: done && done.state, finalMsgs: done && done.msgCount,
      actionCards, approvalModal, banner,
      mentionsBlock: /block|fortigate|isolat/i.test(messagesText)
    });
    expect.soft(r.pageErrors, 'no uncaught JS').toEqual([]);
    expect.soft(banner, 'no error banner').toBe('');
    // Either an action card or an approval gate must appear -- never a silent end.
    expect.soft(actionCards + approvalModal, 'a containment card/gate surfaced').toBeGreaterThan(0);
  });

  // 4 -- playbook build / save (mutating, auto-cleanup)
  test('4 build a playbook → Create Playbook → verify on box → delete', async ({ page }) => {
    test.setTimeout(420000);
    const cap = attachCapture(page);
    await boot(page, { intent: 'build' });
    await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true', { timeout: 45000 });

    await send(page, 'Build a simple playbook that blocks a malicious IP address using '
      + 'FortiGate. One block-IP action is enough. Produce the playbook YAML.');

    // Wait for authored YAML OR a playbook_offer card. The agent delivers a
    // playbook_offer (not YAML editor content) when it finishes authoring --
    // the offer must be accepted to push. Also handle the budget-ask choice
    // card if the agent hits MAX_TOOL_TURNS.
    const deadline = Date.now() + 300000;
    let withYaml = null;
    let budgetAskHit = false;
    let offerAccepted = false;
    while (Date.now() < deadline) {
      const s = await probe(page);
      if (s && s.state === 'idle' && s.yamlLen > 0) { withYaml = s; break; }
      // Handle the budget-ask choice card.
      if (!budgetAskHit) {
        const deliverBtn = page.locator('[data-testid="choice-_budget_ask-deliver"]');
        if (await deliverBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          budgetAskHit = true;
          await deliverBtn.click();
        }
      }
      // Accept a playbook_offer if one appeared.
      if (!offerAccepted && s && s.offerId) {
        const acceptBtn = page.locator(`[data-testid="playbook-offer-accept-${s.offerId}"]`);
        if (await acceptBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          offerAccepted = true;
          await acceptBtn.click();
        }
      }
      // After accepting, wait for the push result in the transcript.
      if (offerAccepted && s && s.pushOk) {
        withYaml = s; break;
      }
      await page.waitForTimeout(3000);
    }
    const banner1 = await errorBannerText(page);

    let pushRes = null, verified = null, cleanup = null;
    // If the agent delivered YAML in the editor, push via the YAML push button.
    if (withYaml && withYaml.yamlLen > 0) {
      const createBtn = page.locator('[data-testid="yaml-push"]');
      if (await createBtn.isVisible().catch(() => false)) {
        await createBtn.click();
        const pd = Date.now() + 120000;
        while (Date.now() < pd) {
          const s = await probe(page);
          if (s && s.push) { pushRes = s.push; break; }
          await page.waitForTimeout(2500);
        }
      }
    }
    // If the offer was accepted, the push result is in the transcript.
    if (withYaml && withYaml.wfUuids) {
      pushRes = { ok: true, workflow_uuids: withYaml.wfUuids,
                  collection_uuid: withYaml.collUuid };
    }

    // Independent verify + cleanup on the box.
    if (pushRes) ({ verified, cleanup } = await verifyOnBoxAndDelete(pushRes));

    // What the turn actually produced. Without this the row reports four
    // nulls, and "the agent delivered nothing" is indistinguishable from "it
    // delivered an offer this row failed to see" -- the #84 ambiguity, which
    // cost a day of diagnosis the first time.
    const last = await probe(page);
    const r = report('4-playbook-build', cap, {
      yamlLen: withYaml && withYaml.yamlLen, banner1,
      budgetAsk: budgetAskHit, offerAccepted,
      pushOk: pushRes && pushRes.ok, verified, cleanup,
      pushKeys: pushRes ? Object.keys(pushRes) : null,
      finalState: last && last.state, finalMsgs: last && last.msgCount,
      eventTypes: last && last.lastEventTypes,
      offerIdSeen: last && last.offerId,
      lastTurnText: last && last.lastTurnText
    });
    expect.soft(r.pageErrors, 'no uncaught JS').toEqual([]);
    expect.soft(withYaml, 'agent delivered (YAML or offer accepted)').toBeTruthy();
    expect.soft(pushRes && pushRes.ok, 'push succeeded').not.toBe(false);
    expect.soft(verified, 'workflow verified on box').toBe(true);
  });

  // 5 -- P4 on the live box: investigate through the SIEM, then "save that as a
  // playbook". P4 is the COMPOSE path (the roadmap un-advertises trace-build:
  // usable trace ~0.7% of builds), so the offer may be model-composed YAML; what
  // the gate proves is that Accept SAVES a real playbook and it reads back on the
  // box. Offline, the same arc passed 2/2 while every Accept failed to save
  // (#164) -- so this row reads the playbook back from the box, not the card.
  test('5 investigate, save that as a playbook, Accept, verify on box, delete', async ({ page }) => {
    test.setTimeout(600000);
    if (LIVE && SIEM_CAP === false) {
      const msg = 'no usable SIEM connector on this box (looked for: '
        + SIEM_CONNECTORS.join(', ') + ') -- there is no investigation to bottle.';
      console.warn('[[SWEEP-ENV-SKIP]] ' + msg);
      test.skip(true, 'ENV: ' + msg);
    }
    const cap = attachCapture(page);
    await boot(page, { entity: C2_ALERT, intent: 'triage' });
    await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true', { timeout: 45000 });
    const seeded = await waitIdle(page, 120000, 0);

    await send(page, 'Investigate this alert: search FortiSIEM for events from the '
      + 'source host and the destination IP, and tell me whether it is malicious.');
    const triaged = await waitIdle(page, 300000, ((seeded && seeded.msgCount) || 0) + 2);
    const toolCalls = await page.locator('[data-testid^="tool-call-head-"]').count().catch(() => 0);

    // Count from just BEFORE this send, not from `triaged`: the triage turn's
    // forced verdict card can land after waitIdle returned, so `triaged` was one
    // short and the loop broke on the idle state BEFORE the save turn started
    // (live: offer:null, last turn = the user's message, while the box session
    // shows the save turn delivered its offer).
    const preSave = await probe(page);
    await send(page, 'Save that as a playbook.');
    let offered = null;
    const od = Date.now() + 240000;
    while (Date.now() < od) {
      const s = await probe(page);
      if (s && s.offerId) { offered = s; break; }
      if (s && s.state === 'idle' && s.lastTurnRole !== 'user'
          && s.msgCount >= ((preSave && preSave.msgCount) || 0) + 2) { offered = s; break; }
      await page.waitForTimeout(2500);
    }
    const offer = offered && offered.offer;

    let accepted = false, saved = null, saveError = null;
    if (offered && offered.offerId) {
      const acceptBtn = page.locator(`[data-testid="playbook-offer-accept-${offered.offerId}"]`);
      if (await acceptBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        accepted = true;
        await acceptBtn.click();
        const ad = Date.now() + 180000;
        while (Date.now() < ad) {
          const s = await probe(page);
          if (s && s.pushOk) { saved = s; break; }
          const text = await page.locator('[data-testid="messages"]').innerText().catch(() => '');
          const m = text.match(/Could not save playbook[^\n]*/i);
          if (m) { saveError = m[0].slice(0, 240); break; }
          await page.waitForTimeout(2500);
        }
      }
    }

    let box = { verified: null, cleanup: null, stepCount: null };
    if (saved && saved.wfUuids) {
      box = await verifyOnBoxAndDelete({ ok: true, workflow_uuids: saved.wfUuids,
                                         collection_uuid: saved.collUuid });
    }
    const banner = await errorBannerText(page);
    const last = await probe(page);
    const r = report('5-save-investigation-as-playbook', cap, {
      toolCalls, offer, accepted, saveError,
      pushOk: !!(saved && saved.pushOk), verified: box.verified,
      boxSteps: box.stepCount, cleanup: box.cleanup, banner,
      finalState: last && last.state, eventTypes: last && last.lastEventTypes,
      lastTurnText: last && last.lastTurnText
    });
    expect.soft(r.pageErrors, 'no uncaught JS').toEqual([]);
    expect.soft(banner, 'no error banner').toBe('');
    expect.soft(toolCalls, 'the investigation ran tools').toBeGreaterThan(0);
    expect.soft(offer, 'save request produced a playbook offer').toBeTruthy();
    // P4 success is the COMPOSE path, not trace-build. The roadmap un-advertises
    // build_playbook_from_trace (usable traces are rare); compose/Guided is the ratified path. An investigation run over native
    // MCP has no connector-action trace to bottle, so the model composes the
    // playbook (hand-authored YAML is expected here, not a defect). The gate is
    // that the composed offer is a REAL playbook: it has steps, Accept saves it,
    // and it reads back on the box -- proven below, not by the offer's provenance.
    expect.soft(offer && offer.steps, 'the offer carries composed steps').toBeGreaterThan(0);
    expect.soft(saveError, 'Accept did not answer "Could not save"').toBe(null);
    expect.soft(box.verified, 'saved playbook exists on the box').toBe(true);
  });
});
