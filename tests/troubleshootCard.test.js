'use strict';
// U7: the troubleshoot card renders from a why_did_playbook_fail result.
// The inputs are the recorded failed-run fixtures (the framework's return shape).
const fs = require('fs');
const path = require('path');
const R = require('../widget/widgetAssets/js/fsrPbRender');

const FIX = path.join(__dirname, '..', 'widget', 'widgetAssets', 'fixtures');
function recordedResult(name) {
  const d = JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'));
  const turn = d.responses.find(r => r.action === 'chat_turn').response;
  return turn.transcript.find(e => e.type === 'tool_result').content;
}

describe('troubleshootFromResult (U7)', () => {
  test('a template input that came out empty: the failing step in words, a playbook change needed', () => {
    const c = R.troubleshootFromResult(recordedResult('playbook_failed_run'), { cardId: 'ts-1' });
    expect(c).not.toBeNull();
    expect(c.type).toBe('troubleshoot_card');
    expect(c.cardId).toBe('ts-1');
    expect(c.headline).toBe('Why "Block Malicious IP on FortiGate" failed');
    expect(c.whatHappened.map(s => s.text)).toEqual([
      'Set Inputs: failed, an input came out empty.',
      'Block IP on FortiGate: failed, an input could not be filled in.',
      'Check Containment Target: inputs filled in'
    ]);
    expect(c.failingStep).toBe('Set Inputs');
    expect(c.safety.tone).toBe('warn');
    expect(c.safety.text).toMatch(/^Playbook change needed\./);
    expect(c.fix[0]).toBe('Fix the input of step "Set Inputs" so it gets a value.');
    expect(c.primary.label).toBe('Fix the playbook');
    expect(c.primary.ask).toMatch(/Set Inputs/);
  });

  test('every input filled in but the run failed: no playbook change, primary is Run again', () => {
    const c = R.troubleshootFromResult(recordedResult('playbook_failed_connection'));
    expect(c).not.toBeNull();
    expect(c.whatHappened[c.whatHappened.length - 1].text)
      .toMatch(/^The run ended as failed, but no step has a bad input/);
    expect(c.safety.tone).toBe('safe');
    expect(c.safety.text).toMatch(/^No playbook change needed\./);
    expect(c.primary.label).toBe('Run again');
    expect(c.failingStep).toBe('');
  });

  test('the safety line says the diagnosis ran nothing and changed nothing', () => {
    const run = R.troubleshootFromResult(recordedResult('playbook_failed_run'));
    const conn = R.troubleshootFromResult(recordedResult('playbook_failed_connection'));
    expect(run.safety.text).toMatch(/nothing was run or changed by it/);
    expect(conn.safety.text).toMatch(/nothing was run or changed by it/);
  });

  test('the collapsed card carries no raw codes or error text; they stay in Details', () => {
    const c = R.troubleshootFromResult(recordedResult('playbook_failed_run'));
    const collapsed = JSON.stringify({ h: c.headline, s: c.sub, w: c.whatHappened, f: c.fix,
      sf: c.safety, p: c.primary });
    expect(collapsed).not.toMatch(/render_error|empty_render|render_threw/);
    expect(collapsed).not.toMatch(/dict object/);
    expect(c.rawError).toMatch(/dict object/);
    expect(c.runLog.find(r => r.step === 'Block IP on FortiGate').detail).toMatch(/render_error/);
    expect(JSON.stringify(c)).not.toMatch(/—|–/);   // no em or en dashes
  });

  test('no card when nothing failed or the diagnosis could not run', () => {
    expect(R.troubleshootFromResult({ ok: false, code: 'no_failed_runs', message: 'none' })).toBeNull();
    expect(R.troubleshootFromResult({ ok: true, run_status: 'finished', step_diagnostics: [] })).toBeNull();
    expect(R.troubleshootFromResult('not json')).toBeNull();
    expect(R.troubleshootFromResult(null)).toBeNull();
  });

  test('a JSON string result is parsed the same way', () => {
    const str = recordedResult('playbook_failed_run');
    expect(R.troubleshootFromResult(str).failingStep).toBe('Set Inputs');
  });
});

describe('the transcript builds a troubleshoot card from the tool result (U7)', () => {
  test('a why_did_playbook_fail tool_result becomes a troubleshoot_card on that tool call', () => {
    const transcript = [
      { type: 'tool_use', id: 'tu-w', name: 'why_did_playbook_fail', input: {} },
      { type: 'tool_result', tool_use_id: 'tu-w', tool: 'why_did_playbook_fail',
        content: recordedResult('playbook_failed_run') },
    ];
    const msg = R.buildAssistantMessage(transcript);
    const card = msg.events.find(e => e.type === 'troubleshoot_card');
    expect(card).toBeDefined();
    expect(card.failingStep).toBe('Set Inputs');
    expect(card.cardId).toBe('troubleshoot-tu-w');
  });

  test('another tool returning the same content builds no troubleshoot card', () => {
    const transcript = [
      { type: 'tool_result', tool_use_id: 'tu-x', tool: 'list_playbook_runs',
        content: recordedResult('playbook_failed_run') },
    ];
    const msg = R.buildAssistantMessage(transcript);
    expect(msg.events.some(e => e.type === 'troubleshoot_card')).toBe(false);
  });
});
