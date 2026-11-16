'use strict';
// Direct coverage for fsrPbMarkdownService (widgetAssets/js/fsrPbMarkdown.service.js).
// The controller-level markdown tests cover the same output through $scope; these
// pin the service's own public contract (render -> $sce-trusted HTML).

global.jasmine = global.jasmine || {};
require('angular');
require('angular-mocks');
angular.module('cybersponse', []); // eslint-disable-line no-undef
require('../widget/widgetAssets/js/fsrPbMarkdown.service.js');

function renderer() {
  let svc;
  window.angular.mock.module('cybersponse');   // eslint-disable-line no-undef
  window.angular.mock.inject((fsrPbMarkdownService) => { svc = fsrPbMarkdownService; });
  return svc;
}

function html(v) {
  let out;
  window.angular.mock.inject(($sce) => { out = $sce.getTrustedHtml(v); });   // eslint-disable-line no-undef
  return out;
}

describe('fsrPbMarkdownService.render', () => {
  test('empty input renders an empty trusted value', () => {
    const svc = renderer();
    expect(html(svc.render(''))).toBe('');
    expect(html(svc.render(null))).toBe('');
  });

  test('paragraphs, headings and rules are block-level', () => {
    const svc = renderer();
    const out = html(svc.render('# Title\n\nFirst para.\n\nSecond para.\n\n---'));
    expect(out).toContain('<div class="md-h md-h1">Title</div>');
    expect(out).toContain('<p class="md-p">First para.</p>');
    expect(out).toContain('<p class="md-p">Second para.</p>');
    expect(out).toContain('<hr class="md-hr"/>');
  });

  test('ordered lists keep numbering across a loose item with nested bullets', () => {
    const svc = renderer();
    const out = html(svc.render('1. one\n   - nested a\n\n2. two'));
    expect(out).toContain('<ol class="md-list">');
    expect(out).toContain('<ul class="md-list">');
    expect(out.split('<ol').length - 1).toBe(1);   // one ordered list, not two restarts
  });

  test('GFM tables render header and body cells', () => {
    const svc = renderer();
    const out = html(svc.render('| a | b |\n|---|---|\n| 1 | 2 |'));
    expect(out).toContain('<table class="md-table">');
    expect(out).toContain('<th>a</th>');
    expect(out).toContain('<td>1</td>');
  });

  test('fenced code is kept verbatim; yaml fences are dropped', () => {
    const svc = renderer();
    const out = html(svc.render('```js\nx | y\n```\n\n```yaml\nname: a\n```'));
    expect(out).toContain('<pre class="md-code">x | y\n</pre>');
    expect(out).not.toContain('name: a');
  });

  test('HTML in the source is escaped, and only root-relative or http(s) links become anchors', () => {
    const svc = renderer();
    const out = html(svc.render('<script>x</script> [ok](https://example.com/a) [bad](javascript:alert(1))'));
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('href="https://example.com/a"');
    expect(out).not.toContain('href="javascript');   // not an anchor; left as inert text
  });
});
