'use strict';
// Direct coverage for fsrPbTranscriptService (replay-echo guard) and
// fsrPbCardsService (card payload helpers). Both were moved out of
// view.controller.js; the controller suites cover them end to end.

global.jasmine = global.jasmine || {};
require('angular');
require('angular-mocks');
angular.module('cybersponse', []); // eslint-disable-line no-undef
require('../widget/widgetAssets/js/fsrPbTranscript.service.js');
require('../widget/widgetAssets/js/fsrPbCards.service.js');

function svc(name) {
  window.angular.mock.module('cybersponse');   // eslint-disable-line no-undef
  let out;
  window.angular.mock.inject(['$injector', ($injector) => { out = $injector.get(name); }]);
  return out;
}

describe('fsrPbTranscriptService.isStaleReplay', () => {
  const onScreen = [
    { role: 'assistant', text: 'Alert A1 is malicious.', events: [
      { type: 'tool_call', _toolUseId: 'tu-1' },
      { type: 'approval_request', inputId: 'ap-1' }
    ] }
  ];

  test('a transcript that only repeats what is on screen is stale', () => {
    const t = svc('fsrPbTranscriptService');
    const repeat = [{ type: 'tool_use', id: 'tu-1' }, { type: 'text', text: 'Alert A1 is malicious.' }];
    expect(t.isStaleReplay(repeat, onScreen)).toBe(true);
  });

  test('a new tool call makes the transcript fresh', () => {
    const t = svc('fsrPbTranscriptService');
    expect(t.isStaleReplay([{ type: 'tool_use', id: 'tu-99' }], onScreen)).toBe(false);
  });

  test('a new human-actionable card is fresh even when every tool call repeats', () => {
    const t = svc('fsrPbTranscriptService');
    const replay = [{ type: 'tool_use', id: 'tu-1' }, { type: 'manual_input', id: 'mi-new' }];
    expect(t.isStaleReplay(replay, onScreen)).toBe(false);
  });

  test('the pending-card vocabulary is exposed for the controller', () => {
    const t = svc('fsrPbTranscriptService');
    expect(t.PENDING_CARD_TYPES.manual_input).toBe(1);
    expect(t.PENDING_CARD_TYPES.text).toBeUndefined();
  });
});

describe('fsrPbCardsService', () => {
  test('collapseManualValues drops helper keys and rebuilds dynamic lists', () => {
    const c = svc('fsrPbCardsService');
    const out = c.collapseManualValues({
      values: { host: 'h1', 'x__group': 'g', 'x__item': 'i', 'y__item': 'z' },
      fields: [{ name: 'x', control: 'dynamic_list' }, { name: 'y', control: 'dynamic_list' }]
    });
    expect(out.host).toBe('h1');
    expect(out).not.toHaveProperty('x__group');
    expect(out.x).toEqual(['g', 'i']);
    expect(out.y).toEqual([]);
  });

  test('collectOfferEdits returns null when nothing was edited', () => {
    const c = svc('fsrPbCardsService');
    expect(c.collectOfferEdits({ opsSummary: [], draftSteps: [] })).toBeNull();
  });

  test('collectOfferEdits carries edited prompts and branch labels', () => {
    const c = svc('fsrPbCardsService');
    const edits = c.collectOfferEdits({
      opsSummary: [{ label: 'Ask', needsInput: true, promptDraft: 'Which host?' }],
      draftSteps: [{ kind: 'fork', node: 'n1', branches: [{ key: 'yes', keyDraft: 'Yes, go' }] }]
    });
    expect(edits.manual_input_prompts).toEqual({ Ask: 'Which host?' });
    expect(edits.branch_labels).toEqual({ n1: { yes: 'Yes, go' } });
  });

  test('findApprovalRequest returns the last approval_request in the events', () => {
    const c = svc('fsrPbCardsService');
    const found = c.findApprovalRequest([
      { type: 'tool_use' },
      { type: 'approval_request', name: 'first' },
      { type: 'approval_request', name: 'second' }
    ]);
    expect(found && found.name).toBe('second');
  });
});
