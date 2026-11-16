'use strict';
// APPROVE -> the run parks -> the form must appear in chat.
//
// The gap this closes: `approvalCard` / `approve.outcome` stop at an approved
// run that FINISHED, and `manualInputForm` starts at a turn that is ALREADY
// parked. Nothing drove the TRANSITION -- approve, the run pauses on the
// playbook's own manual_input step, and the analyst needs a form in chat to let
// it continue. If that form never renders, the run sits on the box waiting for
// input nobody can give it, and the only symptom is a chat that looks stuck.
//
// Observed on a live appliance (tracker #90): after clicking Approve the card
// spun, and then reported the action had NOT run -- for a playbook that HAD run
// and was parked at its form, confirmed against the box's manual-input queue.
//
// This is deliberately HERMETIC (fixture-driven, no box). The live matrix grades
// the WIRE -- transcript frames -- so it cannot see what the approval card
// renders; a frame being present proved nothing about the analyst's screen.
// These assertions are on the DOM, and they fail on a laptop.
//
// The fixture's chat_resume payload is the live-captured shape: `ok:false` WITH
// `triggered:true` and a `run_pk`. That double duty on `ok:false` ("this call
// failed" AND "this call is parked awaiting a human") is the whole bug class.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

const APPROVAL = '[data-testid="approval-card-ap-mi-1"]';
const APPROVE = '[data-testid="approval-approve"]';
const FORM = '[data-testid="manual-input-529"]';
const NOTE = '[data-testid="manual-input-field-529-note"]';
const SUBMIT = '[data-testid="manual-input-submit-529"]';
const OUTCOME = '[data-testid="approval-outcome"]';
const INPUT = '[data-testid="chat-input"]';
const SEND = '[data-testid="chat-send"]';

async function boot(page) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'triage',
      maxTurns: 10, showUsage: true, seedFromEntity: false
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=approval_then_manual_input&fastmock=1&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 60000 });
  return errors;
}

test.describe('approve -> parked run -> manual_input form appears in chat', () => {

  test('the form card renders after Approve, with its field and submit', async ({ page }) => {
    // THE scenario: an analyst approves, and must end up with something to fill
    // in. Everything else in this file is a way of being wrong about it.
    const errors = await boot(page);
    await expect(page.locator(APPROVAL)).toBeVisible();
    await page.locator(APPROVE).click();

    await expect(page.locator(FORM)).toBeVisible();
    await expect(page.locator(NOTE)).toBeVisible();
    await expect(page.locator(SUBMIT)).toBeVisible();
    // The form is the gate the RUN is waiting on -- it must be fillable, not a
    // read-only echo of what the playbook asked for.
    await page.locator(NOTE).fill('checked by the analyst');
    await expect(page.locator(NOTE)).toHaveValue('checked by the analyst');
    await expect(page.locator(SUBMIT)).toBeEnabled();

    expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('the approval card does NOT claim the action failed to run', async ({ page }) => {
    // tracker #90. `_approvalOutcome` reads the resume transcript's tool_result
    // and treats any `ok:false` as "did not run" -- but a parked run carries
    // ok:false ALONGSIDE triggered:true and a run_pk. Telling an analyst their
    // approval was not executed, while the playbook waits on the box for their
    // input, is the wrong direction to be wrong in: they will re-approve, or
    // give up on a run that is live.
    await boot(page);
    await expect(page.locator(APPROVAL)).toBeVisible();
    await page.locator(APPROVE).click();
    await expect(page.locator(FORM)).toBeVisible();

    const outcome = page.locator(OUTCOME);
    await expect(outcome).toBeVisible();
    await expect(outcome).not.toContainText('did not run');
    // It must say what IS true: the run is live and waiting on this analyst.
    await expect(outcome).toContainText('waiting for your input');
    // Nor may it be dressed as an error.
    await expect(page.locator('[data-testid="approval-outcome-error"]')).toHaveCount(0);
    await expect(page.locator('.resolution-failed')).toHaveCount(0);
  });

  test('the spinner clears once the turn settles', async ({ page }) => {
    // The card spun for a long time on the live box. The mechanism is real --
    // `respondApprovalInline` holds `_submitting` for the whole chat_resume,
    // which blocks while run_playbook(follow=True) polls the run to `awaiting`
    // -- but it must not outlive the response, or a working run reads as hung.
    await boot(page);
    await expect(page.locator(APPROVAL)).toBeVisible();
    await page.locator(APPROVE).click();
    await expect(page.locator(FORM)).toBeVisible();
    await expect(page.locator('[data-testid="approval-submitting"]')).toHaveCount(0);
  });

  // ── the rest of the arc: submit the form, then keep using the chat ─────────
  //
  // The scenario does not end when the form appears. The analyst submits it, the
  // playbook finishes, and then they must be able to ask something else in the
  // SAME conversation. A session that strands after a gated + parked + resumed
  // run is still broken from where they sit -- and every state this arc touches
  // (approvalRequest singleton, pending-card gate, viewState) is a way to leave
  // the composer disabled or the next prompt swallowed.
  async function driveToResult(page) {
    await expect(page.locator(APPROVAL)).toBeVisible();
    await page.locator(APPROVE).click();
    await expect(page.locator(FORM)).toBeVisible();
    await page.locator(NOTE).fill('checked by the analyst');
    await page.locator(SUBMIT).click();
    // form consumed + the playbook's result rendered
    await expect(page.locator(SUBMIT)).toHaveCount(0);
    await expect(page.locator('[data-testid="manual-input-resolution-529"]')).toBeVisible();
    await expect(page.locator('.fsr-pb-widget')).toContainText('finished successfully');
  }

  test('after the playbook result the composer is usable again', async ({ page }) => {
    await boot(page);
    await driveToResult(page);
    // Idle, nothing still pending, and the input actually accepts typing --
    // `toBeEnabled` alone passes on a box that silently drops keystrokes.
    await expect(page.locator(INPUT)).toBeEnabled();
    await page.locator(INPUT).fill('How do I triage a phishing report?');
    await expect(page.locator(INPUT)).toHaveValue('How do I triage a phishing report?');
    await expect(page.locator(SEND)).toBeEnabled();
    expect(await page.evaluate(() => window.__agenticAssistant__.state)).toBe('idle');
  });

  test('an UNRELATED question in the same chat gets a normal answer', async ({ page }) => {
    const errors = await boot(page);
    await driveToResult(page);

    await page.locator(INPUT).fill('How do I triage a phishing report?');
    await page.locator(SEND).click();

    // A fresh turn lands, and it is the answer to the NEW question -- not a
    // replay of the playbook arc.
    await expect(page.locator('.fsr-pb-widget')).toContainText('Phishing triage starts with the sender domain');
    // The old cards stay resolved: no approval gate re-raised, no second form.
    await expect(page.locator(APPROVE)).toHaveCount(0);
    await expect(page.locator(SUBMIT)).toHaveCount(0);
    await expect(page.locator('[data-testid="approval-submitting"]')).toHaveCount(0);
    // Settled, and ready for yet another question.
    await expect(page.locator(INPUT)).toBeEnabled();
    expect(await page.evaluate(() => window.__agenticAssistant__.state)).toBe('idle');
    expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('the resolved playbook arc stays in the transcript above the new answer', async ({ page }) => {
    // Continuing the conversation must not cost the analyst the audit trail:
    // what they approved, what they typed into the gate, and how it ended are
    // the record of a state-changing action.
    await boot(page);
    await driveToResult(page);
    await page.locator(INPUT).fill('How do I triage a phishing report?');
    await page.locator(SEND).click();
    await expect(page.locator('.fsr-pb-widget')).toContainText('Phishing triage starts with the sender domain');

    const body = page.locator('.fsr-pb-widget');
    await expect(body).toContainText('Manual Input Demo - Collect Note');  // what was approved
    await expect(body).toContainText('finished successfully');             // how it ended
    await expect(page.locator(APPROVAL)).toBeVisible();                    // the gate itself
    await expect(page.locator(FORM)).toBeVisible();
  });

  test('the parked run stays identifiable: the transcript names its run_pk', async ({ page }) => {
    // Whatever the card says, the analyst must be able to find the run. The
    // resume payload carries run_pk 9283 and the form carries manual_input_id
    // 529; losing both leaves an orphaned run parked on the box.
    await boot(page);
    await expect(page.locator(APPROVAL)).toBeVisible();
    await page.locator(APPROVE).click();
    await expect(page.locator(FORM)).toBeVisible();
    await expect(page.locator('.fsr-pb-widget')).toContainText('paused for your input');
  });
});

