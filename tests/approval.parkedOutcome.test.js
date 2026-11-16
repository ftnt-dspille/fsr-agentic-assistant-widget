'use strict';
// The approval card's PARKED outcome, and the one thing that keeps it honest:
// its code list must not drift from the shared grading vocabulary.
//
// `verdict-vocabulary.json` (widget harness) is the canonical list of payload
// shapes that look like failures but are not. The widget cannot read JSON at
// runtime (it ships as standalone AngularJS), so tools/gen_verdict_vocab.cjs
// emits widgetAssets/js/fsrPbVerdictVocab.js from it, and the controller reads
// the generated list. This file guards the generated copy: add
// `code: "awaiting_resource"` to the canonical vocabulary and this fails until
// the asset is regenerated.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const gen = require('../tools/gen_verdict_vocab.cjs');

const CONTROLLER = path.join(__dirname, '..', 'widget', 'view.controller.js');

function loadVocabAsset() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(gen.ASSET, 'utf8'), sandbox);
  return sandbox.window.FsrPbVerdictVocab;
}

describe('approval card parked-outcome codes', () => {
  test('the generated asset is exactly what the canonical vocabulary renders to', () => {
    const canonical = gen.canonicalPath();
    if (!fs.existsSync(canonical)) {
      // House convention for a guard blocked on an external artifact: warn and
      // skip rather than sit perma-red, but never pass silently.
      console.warn('verdict-vocabulary.json not reachable -- parked-code parity '
                   + 'UNVERIFIED in this run (set FSR_WIDGET_HARNESS)');
      return;
    }
    const vocab = JSON.parse(fs.readFileSync(canonical, 'utf8'));
    expect(fs.readFileSync(gen.ASSET, 'utf8')).toBe(gen.render(vocab));
    expect(loadVocabAsset().parkedCodes.slice().sort())
      .toEqual((vocab.notAnError.codes || []).slice().sort());
  });

  test('awaiting_input is present -- the case that shipped the bug', () => {
    // Pinned independently of the vocabulary so the regression that started
    // #90 can never come back even if the shared file is unreachable.
    expect(loadVocabAsset().parkedCodes).toContain('awaiting_input');
  });

  test('the controller reads the generated list, not a hand-kept copy', () => {
    const src = fs.readFileSync(CONTROLLER, 'utf8');
    expect(src).not.toMatch(/_PARKED_CODES/);
    expect(src).toMatch(/\$window\.FsrPbVerdictVocab\.parkedCodes\.indexOf\(r\.code\)/);
  });

  test('the parked branch is checked BEFORE the ok:false failure branch', () => {
    // Ordering IS the fix: a parked payload carries ok:false, so a
    // parked-check placed after the failure check would never be reached.
    const src = fs.readFileSync(CONTROLLER, 'utf8');
    const fn = src.slice(src.indexOf('function _approvalOutcome'));
    const parked = fn.indexOf('FsrPbVerdictVocab.parkedCodes');
    const failed = fn.indexOf('r.ok === false || r.error');
    expect(parked).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(-1);
    expect(parked).toBeLessThan(failed);
  });

  test('the template renders a parked outcome distinctly from failed', () => {
    const html = fs.readFileSync(
      path.join(__dirname, '..', 'widget', 'view.html'), 'utf8');
    expect(html).toContain('ng-switch-when="parked"');
    // and it must not inherit the red failure styling
    expect(html).toMatch(/resolution-failed'?: ev\._outcome === 'failed'/);
  });
});
