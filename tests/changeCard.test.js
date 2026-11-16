'use strict';
// U6: the change card (enhancement_offer) in the same shape as the offer and
// troubleshoot cards. Inputs are the recorded-shape fixture and the framework's
// name-list-only payload; every diff row and every step name is asserted.
const fs = require('fs');
const path = require('path');
const R = require('../widget/widgetAssets/js/fsrPbRender');

const FIX = path.join(__dirname, '..', 'widget', 'widgetAssets', 'fixtures');
function fixtureOffer(name) {
  const d = JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'));
  const turn = d.responses.find(r => r.action === 'chat_turn').response;
  return turn.transcript.find(e => e.type === 'enhancement_offer');
}
function card(ev) {
  const msg = R.buildAssistantMessage([ev], { now: () => 1700000000000, collapseThreshold: 600 });
  return msg.events.find(e => e.type === 'enhancement_offer');
}
const lineTexts = (c, kind) => c.changeLines.filter(l => l.kind === kind).map(l => l.text);

describe('change card lines (U6)', () => {
  const ev = fixtureOffer('enhancement_change_card');
  const c = card(ev);

  test('every diff row has exactly one line, in the right group, with the exact wording', () => {
    expect(ev.changes.length).toBe(3);
    expect(c.changeLines).toEqual([
      { kind: 'add', text: 'Adds the step "Prompt Block IP" (asks you to confirm or choose).' },
      { kind: 'mod', text: 'Changes the step "Block IP": its inputs and what runs next. '
        + 'IP is now {{ vars.input.records[0].destinationIp }} (was {{ vars.input.records[0].sourceIp }}).' },
      { kind: 'del', text: 'Removes the step "Old Note".' }
    ]);
  });

  test('Adds and Removes lines name exactly the steps the diff adds and removes', () => {
    const added = ev.changes.filter(r => r.kind === 'added').map(r => r.step);
    const removed = ev.changes.filter(r => r.kind === 'removed').map(r => r.step);
    const modified = ev.changes.filter(r => r.kind === 'modified').map(r => r.step);
    expect(lineTexts(c, 'add').length).toBe(added.length);
    expect(lineTexts(c, 'del').length).toBe(removed.length);
    expect(lineTexts(c, 'mod').length).toBe(modified.length);
    added.forEach(n => expect(lineTexts(c, 'add').join('\n')).toContain('"' + n + '"'));
    removed.forEach(n => expect(lineTexts(c, 'del').join('\n')).toContain('"' + n + '"'));
    modified.forEach(n => expect(lineTexts(c, 'mod').join('\n')).toContain('"' + n + '"'));
  });

  test('each Details row carries the New / Changed / Removed tag for its kind', () => {
    expect(c.changes.map(r => [r.step, r.tag])).toEqual([
      ['Prompt Block IP', 'New'], ['Block IP', 'Changed'], ['Old Note', 'Removed']
    ]);
    ev.changes.forEach((raw, i) => {
      expect(c.changes[i].beforeText !== '' || c.changes[i].afterText !== '').toBe(true);
    });
  });

  test('the safety line says how to undo and that nothing runs', () => {
    expect(c.safetyLine.text).toMatch(/nothing runs when you apply it/);
    expect(c.safetyLine.text).toMatch(/To undo, restore the previous version from the Versions tab/);
    expect(c.safetyLine.text).toMatch(/restore point is saved first/);
  });

  test('the changed expression is in the Changes line, as written', () => {
    expect(lineTexts(c, 'mod')).toEqual([
      'Changes the step "Block IP": its inputs and what runs next. '
      + 'IP is now {{ vars.input.records[0].destinationIp }} (was {{ vars.input.records[0].sourceIp }}).'
    ]);
  });

  test('collapsed text never shows a connector id, an operation id or an em dash', () => {
    const collapsed = JSON.stringify({ s: c.plainSummary, l: c.changeLines, sf: c.safetyLine, k: c.thingsToKnow });
    expect(collapsed).not.toMatch(/fortigate-firewall|block_ip/);
    expect(collapsed).not.toMatch(/\u2014|\u2013/);
    // Details: the expressions and configuration are shown, the connector id is not
    const details = JSON.stringify(c.changes);
    expect(details).toMatch(/destinationIp/);
    expect(details).not.toMatch(/fortigate-firewall/);
    expect(c.finalYaml).toMatch(/fortigate-lab-1/);
  });

  test('only the edit-own warnings are collapsed, as plain sentences', () => {
    expect(c.thingsToKnow).toEqual(['The destination IP may be empty when the alert has none.']);
    expect(c.otherWarnings.map(w => w.step)).toEqual(['Notify Team']);
  });
});

describe('change card without diff rows (older framework)', () => {
  test('lines come from the step-name lists; snake_case ids read as words', () => {
    const c = card({ type: 'enhancement_offer', id: 'e', summary: 'Added error handling steps.',
      final_yaml: 'x', steps_added: ['Log Failure Linking', 'log_end'], steps_removed: ['Old Note'],
      steps_modified: ['Link Similar Alerts To Parent'] });
    expect(c.changes).toEqual([]);
    expect(lineTexts(c, 'add')).toEqual(['Adds the step "Log Failure Linking".', 'Adds the step "Log end".']);
    expect(lineTexts(c, 'mod')).toEqual(['Changes the step "Link Similar Alerts To Parent".']);
    expect(lineTexts(c, 'del')).toEqual(['Removes the step "Old Note".']);
  });

  test('a card with no changes at all has no lines', () => {
    expect(card({ type: 'enhancement_offer', id: 'e2', final_yaml: 'x' }).changeLines).toEqual([]);
  });

  test('an added playbook is a line, and the safety line says to delete it to undo', () => {
    const c = card(fixtureOffer('enhancement_new_playbook'));
    expect(lineTexts(c, 'add')).toEqual([
      'Adds the step "Call Block".',
      'Adds the playbook "Block One IP", which this playbook calls. Apply saves it too.'
    ]);
    expect(c.safetyLine.text).toMatch(/The new playbook is saved too; delete it to undo that part\./);
  });

  test('a technical warning sentence stays out of the collapsed card', () => {
    const c = card({ type: 'enhancement_offer', id: 'e3', final_yaml: 'x', steps_added: ['A'],
      warnings: [{ message: '`button_label:` not set on start -- defaulting to playbook name', step_name: 'Start' }] });
    expect(c.thingsToKnow).toEqual([]);
    expect(c.warnings).toHaveLength(1);
  });
});

describe('connector naming and changed values (U6 naming rule)', () => {
  const row = (kind, before, after, extra) => Object.assign({
    playbook: 'P', step: 'Look up IP', kind, type: 'connector', before, after
  }, extra || {});
  const conn = (connector, config, params) => ({
    type: 'connector', arguments: { connector, operation: 'lookup_ip', config, params }, next: 'End'
  });
  const ID = 'fortinet-fortiguard-threat-intelligence';
  const LABEL = 'FortiGuard Threat Intelligence';
  const build = (changes, extra) => card(Object.assign(
    { type: 'enhancement_offer', id: 'n1', final_yaml: 'x', changes }, extra || {}));

  test('an added connector step shows the catalog label and the configuration, never the id', () => {
    const c = build([row('added', null, conn(ID, 'ti-prod', { ip: '{{vars.ip}}' }))],
      { connector_labels: { [ID]: LABEL } });
    expect(lineTexts(c, 'add')).toEqual([
      'Adds the step "Look up IP" (runs an action on ' + LABEL + ', using configuration ti-prod).'
    ]);
    const all = JSON.stringify({ l: c.changeLines, d: c.changes });
    expect(all).not.toContain(ID);
    expect(c.changes[0].afterText).toContain('Runs lookup ip on ' + LABEL);
    expect(c.changes[0].afterText).toContain('Configuration: ti-prod');
  });

  test('a label on the step arguments is used when there is no map', () => {
    const after = conn(ID, 'ti-prod', {});
    after.arguments.connector_label = LABEL;
    const c = build([row('added', null, after)]);
    expect(lineTexts(c, 'add')[0]).toContain(LABEL);
    expect(JSON.stringify({ l: c.changeLines, d: c.changes })).not.toContain(ID);
  });

  test('with no label anywhere the id is humanized, never raw', () => {
    const c = build([row('removed', conn(ID, 'ti-prod', {}), null)]);
    const all = JSON.stringify({ l: c.changeLines, d: c.changes });
    expect(all).not.toContain(ID);
    expect(c.changes[0].beforeText).toContain('Fortinet Fortiguard Threat Intelligence');
  });

  test('a changed configuration and a changed connector read as values, the connector by label', () => {
    const other = 'fortinet-fortisandbox';
    const c = build([row('modified', conn(ID, 'ti-old', {}), conn(other, 'ti-new', {}),
      { changed_fields: ['arguments'] })],
      { connector_labels: { [ID]: LABEL, [other]: 'FortiSandbox' } });
    const line = lineTexts(c, 'mod')[0];
    expect(line).toContain('Configuration is now ti-new (was ti-old)');
    expect(line).toContain('Connector is now FortiSandbox (was ' + LABEL + ')');
    expect(line).not.toContain(ID);
    expect(line).not.toContain(other);
    expect(c.changes[0].beforeText).toContain('Connector: ' + LABEL);
  });

  test('a modified step with many changed values lists three and counts the rest', () => {
    const p1 = { a: '1', b: '2', c: '3', d: '4', e: '5' };
    const p2 = { a: '{{vars.a}}', b: '{{vars.b}}', c: '{{vars.c}}', d: '{{vars.d}}', e: '{{vars.e}}' };
    const c = build([row('modified', conn(ID, 'x', p1), conn(ID, 'x', p2), { changed_fields: ['arguments'] })]);
    const line = lineTexts(c, 'mod')[0];
    expect(line).toContain('{{vars.a}}');
    expect(line).toContain('and 2 more');
    expect(line).not.toContain('{{vars.e}}');
  });
});
