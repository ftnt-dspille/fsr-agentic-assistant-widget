/**
 * Versions used to be pinned as prose in the README table, and prose drifts: in
 * Aug 2026 every row was wrong at once (widget 1.2.61 vs 1.2.68, connector
 * 0.5.125 vs 0.5.164, fsr_playbooks 0.6.23 vs 0.6.58). Rather than keep
 * hand-syncing that table on every bump, the README no longer carries version
 * numbers at all -- so there is nothing to drift.
 *
 * What a bump CAN still get wrong is real and silent: the Angular controller
 * name embeds the version (`agenticAssistant<version>DevCtrl`), and if a
 * hand bump touches info.json but not the controller, the widget fails to boot.
 * That invariant is derived entirely from source -- no README prose -- so a
 * routine bump never needs a README edit.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

test('the controller name tracks the info.json version', () => {
  const v = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'widget', 'info.json'), 'utf8')).version;
  const slug = 'agenticAssistant' + v.replace(/\./g, '') + 'DevCtrl';
  const view = fs.readFileSync(path.join(ROOT, 'widget', 'view.controller.js'), 'utf8');
  const edit = fs.readFileSync(path.join(ROOT, 'widget', 'edit.controller.js'), 'utf8');
  expect(view).toContain("controller('" + slug + "'");
  expect(edit).toContain("controller('edit" + slug[0].toUpperCase() + slug.slice(1) + "'");
});

test('the README does not re-pin versions (so there is nothing to drift)', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  // A bare semver inside a bold README table cell is exactly the hand-maintained
  // pin this suite exists to keep out. Catch a regression that re-adds one.
  const badRows = readme.split('\n').filter(
    (l) => l.startsWith('| **') && /\*\*\d+\.\d+\.\d+\*\*/.test(l));
  expect(badRows).toEqual([]);
});
