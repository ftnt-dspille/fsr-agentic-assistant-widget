'use strict';
// LIVE end-to-end UI proof (gated, MUTATING) -- "ask to build -> created a real
// playbook through the UI only".
//
// Unlike every other e2e here this does NOT stub the connector: it runs the
// widget in mode=live against the real Agentic Assistant connector on the box in
// .env (FSR_BASE_URL), drives the agent to author a playbook, takes whichever
// delivery path the agent actually uses, then independently verifies the
// workflow exists on the box via the SOAR API and DELETES it (cleanup in
// finally). This exercises the exact detached streaming/poll path that was
// hanging.
//
// There are TWO delivery paths and this spec must accept either:
//   a) YAML lands in the editor pane  -> click [data-testid="yaml-push"], the
//      push result shows up on `window.__agenticAssistant__.pushResult`.
//   b) The agent emits a `playbook_offer` card -> the offer must be ACCEPTED,
//      and the push result then arrives only as a `playbook_pushed` info_card
//      in the transcript.
// (b) is what the live agent normally does, and the pushed card carries the
// designer DEEP LINK (`url` / a link block), NOT the `workflow_uuids` array
// this spec used to read. Those uuid arrays were never on the wire for the
// offer path, so the old premise -- "YAML appears, then click Create Playbook"
// -- could not pass at all. Same fix as liveSweep row 4.
//
// Gated on FSRPB_LIVE_UI=1 (real agent run + real SOAR mutation). Run:
//   FSRPB_LIVE_UI=1 make test-e2e-spec SPEC="tests/e2e/agenticAssistant.createPlaybookLive.spec.js"
// Needs FSR_BASE_URL/FSR_USERNAME/FSR_PASSWORD in the harness .env.
//
// @covers-card-live: playbook_offer
// NARROW -- it clicks accept and verifies the workflow on the box; it does not
// assert the card's full render (draft steps, editable title, decline). See
// fortisoar-widget-harness/docs/CARD_DOM_COVERAGE.md.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');
const { makeClient } = require('../../../../fortisoar-widget-harness/tests/live/lib/soarClient');

const LIVE = process.env.FSRPB_LIVE_UI === '1';
const d = LIVE ? test.describe : test.describe.skip;

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { if (LIVE) WIDGET_ID = await resolveWidgetId(request); });

const BUILD_PROMPT =
  'Build a simple playbook that blocks a malicious IP address using FortiGate. '
  + 'One block-IP action is enough. Produce the playbook YAML.';

// Single read of everything the two delivery paths can produce.
async function probe(page) {
  return page.evaluate(() => {
    const p = window.__agenticAssistant__;
    if (!p) return null;
    let offerId = null, pushOk = null, wfUuids = null, collUuid = null;
    const lastEventTypes = [];
    for (const m of (p.messages || [])) for (const ev of (m.events || [])) {
      lastEventTypes.push(ev.type);
      if (ev.type === 'playbook_offer' && !ev._resolved) offerId = ev.offerId || ev.id;
      if (ev.type === 'info_card' && ev.variant === 'playbook_pushed') {
        pushOk = true;
        wfUuids = ev.workflow_uuids || null;
        collUuid = ev.collection_uuid || null;
        if (!wfUuids) {
          // The offer-accept path names the playbook only by its designer link.
          const link = ev.url || (ev.blocks || []).reduce(
            (acc, b) => acc || (b && b.kind === 'link' ? b.url : null), null);
          const m2 = link && String(link).match(/\/playbooks\/([0-9a-f-]{36})/i);
          if (m2) wfUuids = [m2[1]];
        }
      }
    }
    return {
      state: p.state, msgCount: p.messageCount,
      yamlLen: (p.currentYaml || '').length, push: p.pushResult || null,
      lastTurnText: (p.lastTurn && (p.lastTurn.content || p.lastTurn.text) || '').slice(0, 240),
      offerId, pushOk, wfUuids, collUuid,
      lastEventTypes: lastEventTypes.slice(-10)
    };
  });
}

d('live UI -- create a playbook end-to-end (mutating, auto-cleanup)', () => {
  // The real agent build can take minutes; the push is a real round-trip.
  test.setTimeout(420000);

  test('ask to build -> deliver (YAML or offer) -> workflow exists on the box', async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('harness:config:' + id, JSON.stringify({
        connectorName: 'connector-fsr-agentic-assistant', defaultIntent: 'build',
        maxTurns: 12, showUsage: true, seedFromEntity: false, mockMode: 'real',
        detachedTimeoutMs: 480000
      }));
      localStorage.setItem('harness.widget', id);
      // build intent requires the playbook designer context (main.playbookDetail)
      // so _inPlaybookEditor() returns true -- the widget retired defaultIntent='build'.
      localStorage.setItem('harness.ctx', 'playbook');
      localStorage.removeItem('fsrPbSession');
    }, WIDGET_ID);

    await page.goto(`/?widget=${WIDGET_ID}&context=Dashboard&mode=live`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
      null, { timeout: 40000 });
    // Composer enabled ⇒ the connector resolved against the live box.
    await expect(page.locator('[data-testid="chat-input"]')).toHaveAttribute('data-idle', 'true', { timeout: 40000 });

    // Ask the agent to build (detached live turn -- the path that was hanging).
    await page.locator('[data-testid="chat-input"]').fill(BUILD_PROMPT);
    await page.locator('[data-testid="chat-send"]').click();

    // Wait for EITHER delivery path. Also clear the budget-ask choice card if
    // the agent hits MAX_TOOL_TURNS, which otherwise parks the turn forever.
    const deadline = Date.now() + 300000;
    let delivered = null, budgetAskHit = false, offerAccepted = false;
    while (Date.now() < deadline) {
      const s = await probe(page);
      if (s && s.state === 'idle' && s.yamlLen > 0) { delivered = s; break; }
      if (!budgetAskHit) {
        const deliverBtn = page.locator('[data-testid="choice-_budget_ask-deliver"]');
        if (await deliverBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          budgetAskHit = true;
          await deliverBtn.click();
        }
      }
      if (!offerAccepted && s && s.offerId) {
        const acceptBtn = page.locator(`[data-testid="playbook-offer-accept-${s.offerId}"]`);
        if (await acceptBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          offerAccepted = true;
          await acceptBtn.click();
        }
      }
      if (offerAccepted && s && s.pushOk) { delivered = s; break; }
      await page.waitForTimeout(3000);
    }
    console.log('[live-ui] DELIVERED:', JSON.stringify({
      budgetAskHit, offerAccepted,
      yamlLen: delivered && delivered.yamlLen,
      pushOk: delivered && delivered.pushOk,
      wfUuids: delivered && delivered.wfUuids,
      eventTypes: delivered && delivered.lastEventTypes,
      lastTurnText: delivered && delivered.lastTurnText
    }));
    expect(delivered, 'agent delivered YAML or an accepted playbook_offer').toBeTruthy();

    // Path (a): YAML in the editor -> click the UI's "Create Playbook"
    // (a real compile_yaml -> push_playbook mutation).
    let res = null;
    if (delivered.yamlLen > 0 && !delivered.pushOk) {
      const createBtn = page.locator('[data-testid="yaml-push"]');
      await expect(createBtn).toBeVisible({ timeout: 15000 });
      await createBtn.click();
      const pd = Date.now() + 120000;
      while (Date.now() < pd) {
        const s = await probe(page);
        if (s && s.push) { res = s.push; break; }
        await page.waitForTimeout(2500);
      }
      // The widget rendered the success handoff.
      await expect(page.locator('.fsr-pb-widget')).toContainText('Created playbook in FortiSOAR');
    } else {
      // Path (b): the accepted offer already pushed; the transcript card is the
      // only carrier of the result.
      res = { ok: true, workflow_uuids: delivered.wfUuids, collection_uuid: delivered.collUuid };
    }

    console.log('[live-ui] PUSH RESULT:', JSON.stringify(res));
    expect(res, 'a push result surfaced').toBeTruthy();
    expect(res.ok).not.toBe(false);

    // ── Independent verification on the box + cleanup ──────────────────────
    const wfUuid = (res.workflow_uuids && res.workflow_uuids[0])
      || (res.workflows && res.workflows[0] && res.workflows[0].uuid) || null;
    const collUuid = res.collection_uuid
      || (res.collection_iri ? String(res.collection_iri).split('/').pop() : null);

    const soar = await makeClient();
    let verified = false;
    try {
      // soar.get() returns the record JSON directly (or null on a non-2xx body).
      if (wfUuid) {
        const rec = await soar.get(`/api/3/workflows/${wfUuid}`);
        console.log(`[live-ui] GET workflows/${wfUuid} -> uuid=${rec && rec.uuid} name="${rec && rec.name}"`);
        verified = !!(rec && (rec.uuid === wfUuid || rec['@id']));
      } else if (collUuid) {
        const rec = await soar.get(`/api/3/workflow_collections/${collUuid}`);
        console.log(`[live-ui] GET workflow_collections/${collUuid} -> uuid=${rec && rec.uuid}`);
        verified = !!(rec && (rec.uuid === collUuid || rec['@id']));
      }
      // A push we cannot NAME is not a verified push -- never let the missing
      // uuid quietly skip the one assertion that proves the playbook exists.
      expect(verified, 'workflow verified on the box').toBe(true);
    } finally {
      // Always clean up so the demo box stays tidy, even if an assert failed.
      try {
        if (collUuid) {
          const dd = await soar.del(`/api/3/workflow_collections/${collUuid}`);
          console.log(`[live-ui] cleanup DELETE workflow_collections/${collUuid} -> ${dd.status}`);
        } else if (wfUuid) {
          const dd = await soar.del(`/api/3/workflows/${wfUuid}`);
          console.log(`[live-ui] cleanup DELETE workflows/${wfUuid} -> ${dd.status}`);
        } else {
          console.warn('[live-ui] no uuid in push result -- CHECK BOX MANUALLY:', JSON.stringify(res));
        }
      } catch (e) {
        console.warn('[live-ui] cleanup failed -- remove manually:', e.message);
      }
    }
  });
});
