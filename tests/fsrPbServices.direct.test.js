'use strict';
// Direct coverage for the pure helper services split out of view.controller.js:
// fsrPbHtmlService, fsrPbEntityCardsService and fsrPbYamlService. The controller
// suites exercise them end to end; these pin each service's public contract.

global.jasmine = global.jasmine || {};
require('angular');
require('angular-mocks');
angular.module('cybersponse', []); // eslint-disable-line no-undef
require('../widget/widgetAssets/js/fsrPbHtml.service.js');
require('../widget/widgetAssets/js/fsrPbEntityCards.service.js');
require('../widget/widgetAssets/js/fsrPbYaml.service.js');

// Resolve a registered service by name through the real injector.
function svc(name) {
  window.angular.mock.module('cybersponse');   // eslint-disable-line no-undef
  let out;
  window.angular.mock.inject(['$injector', ($injector) => { out = $injector.get(name); }]);
  return out;
}

describe('fsrPbHtmlService', () => {
  test('stripHtml removes tags and keeps the text', () => {
    const s = svc('fsrPbHtmlService');
    expect(s.stripHtml('<p>Hello <b>there</b></p>')).toContain('Hello');
    expect(s.stripHtml('<p>Hello <b>there</b></p>')).not.toContain('<b>');
  });

  test('sanitizeHtml keeps only bare allow-listed formatting tags', () => {
    const s = svc('fsrPbHtmlService');
    const out = s.sanitizeHtml('<script>x</script><b>ok</b><a href="y">l</a>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<a');
    expect(out).toContain('<b>ok</b>');
  });

  test('sanitizeHtml is a no-op on empty input', () => {
    const s = svc('fsrPbHtmlService');
    expect(s.sanitizeHtml(null)).toBe('');
  });

  test('truncate caps long strings and leaves short ones alone', () => {
    const s = svc('fsrPbHtmlService');
    expect(s.truncate('short', 50)).toBe('short');
    expect(s.truncate('x'.repeat(200), 20).length).toBeLessThan(200);
  });
});

describe('fsrPbEntityCardsService', () => {
  test('singularize drops the plural suffix of a module name', () => {
    const s = svc('fsrPbEntityCardsService');
    expect(s.singularize('alerts')).toBe('alert');
  });

  test('entityHeadline uses the persona greeting when one is set', () => {
    const s = svc('fsrPbEntityCardsService');
    expect(s.entityHeadline({ greeting: 'Look at {module}: {name}' }, 'Alert', 'A1'))
      .toBe('Look at Alert: A1');
    expect(s.entityHeadline({}, 'Alert', 'A1')).toBe('Working on Alert: A1');
    expect(s.entityHeadline(null, 'Alert', 'A1')).toBe('Triaging Alert: A1');
  });

  test('buildEntityFields returns a field map and drops denylisted keys', () => {
    const s = svc('fsrPbEntityCardsService');
    const fields = s.buildEntityFields({ name: 'Host A', severity: 'high', '@id': '/api/3/x' });
    expect(fields && typeof fields).toBe('object');
    expect(Object.keys(fields)).not.toContain('@id');
    expect(Object.keys(fields)).toContain('severity');
  });

  test('recordHasFields is false for an empty record and true for a populated one', () => {
    const s = svc('fsrPbEntityCardsService');
    expect(s.recordHasFields({})).toBe(false);
    expect(s.recordHasFields({ name: 'x' })).toBe(true);
  });
});

describe('fsrPbYamlService', () => {
  test('extractLastYamlFence returns the body of the last closed fence', () => {
    const s = svc('fsrPbYamlService');
    const text = '```yaml\nname: first\n```\nprose\n```yaml\nname: second\n```';
    expect(s.extractLastYamlFence(text).yaml).toBe('name: second');
    expect(s.extractLastYamlFence(text).truncated).toBe(false);
  });

  test('extractLastYamlFence flags an unclosed fence as truncated', () => {
    const s = svc('fsrPbYamlService');
    const r = s.extractLastYamlFence('```yaml\nname: cut');
    expect(r.truncated).toBe(true);
    expect(r.yaml).toContain('name: cut');
  });

  test('isTruncated recognises the length-limit stop reasons only', () => {
    const s = svc('fsrPbYamlService');
    expect(s.isTruncated('max_tokens')).toBe(true);
    expect(s.isTruncated('length')).toBe(true);
    expect(s.isTruncated('end_turn')).toBe(false);
    expect(s.isTruncated(undefined)).toBe(false);
  });

  test('stepIdOf and yamlVal normalise step ids and scalars', () => {
    const s = svc('fsrPbYamlService');
    expect(s.stepIdOf('Enrich  Alert')).toBe('enrich_alert');
    expect(s.yamlVal('  "quoted"  ')).toBe('quoted');
  });

  test('toPatch marks a unique literal as applicable and a repeated one as not', () => {
    const s = svc('fsrPbYamlService');
    const yaml = 'a: foo\nb: foo\nc: bar';
    expect(s.toPatch({ before: 'bar', after: 'baz' }, yaml).applicable).toBe(true);
    expect(s.toPatch({ before: 'foo', after: 'x' }, yaml).applicable).toBe(false);
    expect(s.occurrences(yaml, 'foo')).toBe(2);
  });
});
